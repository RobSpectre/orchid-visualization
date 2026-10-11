// Warp: a hyperspace tunnel. The camera travels one ring per beat. Upcoming
// drum hits are placed down the tunnel at their exact beat distance, one lane
// per angular sector, so each one reaches the screen as it sounds. Loop notes
// ride the inner ring by pitch class, and stars streak with the tempo.

import { S, on } from '../state.js';
import { P, a as pa } from '../theme.js';

const TAU = Math.PI * 2;
const SIDES = 8;
const AHEAD = 12;      // beats of lookahead
const NEAR = 0.22;     // camera-plane offset so nothing projects to infinity

export function createWarp({ active }) {
  const newStar = (anyZ) => ({ x: (Math.random() - 0.5) * 2.4, y: (Math.random() - 0.5) * 2.4, z: anyZ ? NEAR + Math.random() * 16 : 16 });
  const stars = Array.from({ length: 420 }, () => newStar(true));
  const shocks = [];
  let chord = null;

  on('drum', (h) => {
    if (!active() || (h.kind !== 'kick' && h.kind !== 'snare')) return;
    shocks.push({ t0: performance.now(), max: h.kind === 'kick' ? 750 : 520, color: h.kind === 'kick' ? P.lime : P.violet, w: h.kind === 'kick' ? 4 : 2.5 });
    if (shocks.length > 12) shocks.shift();
  });
  on('key', (k) => {
    if (!active()) return;
    chord = { t0: performance.now(), pcs: (k.intervals ?? [0]).map((i) => (k.pc + i) % 12), color: k.chord ? P.lime : P.mint };
  });

  return {
    reset() { shocks.length = 0; chord = null; },
    draw(ctx, geo, now, dt) {
      const c = S.clock;
      const moving = c.transport === 'playing' || c.transport === 'count-in';
      const travel = moving ? (dt / 1000) * (c.bpm / 60) : 0; // beats travelled this frame
      const focal = geo.R * 0.62;
      const twist = S.fx.motion * 0.18;
      const r = geo.rect;
      const proj = (ang, rad, z) => {
        const s = focal / z;
        return [geo.cx + Math.cos(ang) * rad * s, geo.cy + Math.sin(ang) * rad * s];
      };

      ctx.save();
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(r.left, r.top, r.width, r.height, 12) : ctx.rect(r.left, r.top, r.width, r.height);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';

      // Stars: streak length follows the tempo.
      ctx.lineCap = 'round';
      for (const st of stars) {
        const z0 = st.z;
        st.z -= travel * 2.2 + (moving ? 0 : (dt / 1000) * 0.08);
        if (st.z < NEAR) { Object.assign(st, newStar(false)); continue; }
        const s0 = (focal * 1.6) / z0, s1 = (focal * 1.6) / st.z;
        const a = Math.min(1, (1 - st.z / 16) * 1.3);
        ctx.strokeStyle = pa(P.ink, a * 0.8);
        ctx.lineWidth = Math.min(3, 0.6 + 6 / st.z);
        ctx.beginPath();
        ctx.moveTo(geo.cx + st.x * s0, geo.cy + st.y * s0);
        ctx.lineTo(geo.cx + st.x * s1 + 0.01, geo.cy + st.y * s1);
        ctx.stroke();
      }

      // Tunnel: one octagonal ring per beat, brighter on the downbeat.
      const beat = c.beat;
      const frac = ((beat % 1) + 1) % 1;
      for (let i = 0; i < 15; i++) {
        const z = i + 1 - frac + NEAR;
        const beatNo = Math.floor(beat) + i + 1;
        const bar = beatNo % 4 === 0;
        const rot = twist + z * 0.1;
        ctx.beginPath();
        for (let k = 0; k <= SIDES; k++) {
          const [x, y] = proj(rot + (k / SIDES) * TAU, 1, z);
          k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        const fade = Math.max(0, 1 - z / 15);
        ctx.strokeStyle = bar ? pa(P.lime, 0.55 * fade + S.fx.kick * 0.3 * fade) : pa(P.violet, 0.45 * fade);
        ctx.lineWidth = bar ? 2 : 1;
        ctx.stroke();
      }
      // Longitudinal rails
      for (let k = 0; k < SIDES; k++) {
        ctx.beginPath();
        for (let z = NEAR + 0.1; z < 15; z += 0.5) {
          const [x, y] = proj(twist + z * 0.1 + (k / SIDES) * TAU, 1, z);
          z === NEAR + 0.1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = pa(P.mint, 0.12);
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Upcoming drum hits, each at its true distance in beats.
      const b = S.beat;
      if (b && c.drumPos != null) {
        const n = b.lanes.length;
        const pos = c.drumPos % b.length;
        for (const h of b.hits) {
          if (h.muted) continue;
          let ahead = h.at - pos;
          if (ahead < -0.2) ahead += b.length;
          if (ahead > AHEAD || ahead < -0.2) continue;
          const z = ahead + NEAR + 0.05;
          if (z <= NEAR * 0.6) continue;
          const lane = b.lanes[h.lane];
          const a0 = (h.lane / n) * TAU + twist + z * 0.1;
          const span = (TAU / n) * (0.3 + 0.55 * h.vel);
          ctx.beginPath();
          for (let t = 0; t <= 8; t++) {
            const [x, y] = proj(a0 + (span * t) / 8, 0.9, z);
            t ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          }
          const near = z < 0.7;
          ctx.strokeStyle = lane.color;
          ctx.globalAlpha = Math.min(1, 1.15 - z / AHEAD);
          ctx.lineWidth = Math.min(16, (1.2 + h.vel * 3) / z);
          ctx.shadowColor = lane.color;
          ctx.shadowBlur = near ? 24 : 0;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
      }

      // Loop notes on an inner ring, angle = pitch class.
      const l = S.studio?.looper;
      if (l?.running && c.loopPos != null && c.loopLen) {
        const pos = c.loopPos % c.loopLen;
        l.layers.forEach((layer, li) => {
          if (layer.muted) return;
          for (const [nb, , note, vel] of layer.notes) {
            let ahead = (nb % c.loopLen) - pos;
            if (ahead < -0.1) ahead += c.loopLen;
            if (ahead > AHEAD) continue;
            const z = ahead + NEAR + 0.05;
            const [x, y] = proj(((note % 12) / 12) * TAU - Math.PI / 2 + twist * 0.5, 0.5, z);
            ctx.fillStyle = P.layers[li % P.layers.length];
            ctx.globalAlpha = Math.min(1, 1.1 - z / AHEAD);
            const size = Math.min(14, (0.6 + (vel / 127) * 1.4) / z);
            ctx.beginPath();
            ctx.arc(x, y, size, 0, TAU);
            ctx.fill();
          }
        });
        ctx.globalAlpha = 1;
      }

      // Kick / snare shockwaves from the vanishing point.
      for (let i = shocks.length - 1; i >= 0; i--) {
        const s = shocks[i];
        const t = (now - s.t0) / s.max;
        if (t >= 1) { shocks.splice(i, 1); continue; }
        ctx.beginPath();
        ctx.arc(geo.cx, geo.cy, geo.R * (0.05 + t * 1.5), 0, TAU);
        ctx.strokeStyle = s.color;
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = s.w * (1 - t) + 0.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Chord: a polygon that flies out of the vanishing point.
      if (chord) {
        const t = (now - chord.t0) / 1800;
        if (t >= 1) chord = null;
        else {
          const z = Math.max(NEAR, 8 * (1 - t));
          ctx.beginPath();
          chord.pcs.forEach((pc, j) => {
            const [x, y] = proj((pc / 12) * TAU - Math.PI / 2, 0.75, z);
            j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          });
          ctx.closePath();
          ctx.strokeStyle = chord.color;
          ctx.globalAlpha = Math.min(1, 1.4 - t);
          ctx.lineWidth = 2 + 6 * t;
          ctx.shadowColor = chord.color;
          ctx.shadowBlur = 20;
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.shadowBlur = 0;
        }
      }

      // Vanishing-point glow
      const g = ctx.createRadialGradient(geo.cx, geo.cy, 0, geo.cx, geo.cy, geo.R * 0.35);
      g.addColorStop(0, pa(P.lime, 0.18 + S.fx.kick * 0.3));
      g.addColorStop(1, pa(P.lime, 0));
      ctx.fillStyle = g;
      ctx.fillRect(geo.cx - geo.R, geo.cy - geo.R, geo.R * 2, geo.R * 2);
      ctx.restore();
    },
  };
}
