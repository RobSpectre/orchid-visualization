// Mandala: the current bar folded into an 8-way kaleidoscope. Each drum lane
// is a ring of petals (step = angle within a wedge, velocity = petal length)
// that bloom as they play. Chords draw a spirograph whose shape comes from
// their intervals; loop notes leave sparks by pitch class. Turns a notch per bar.

import { S, on } from '../state.js';
import { P, a as pa } from '../theme.js';

const TAU = Math.PI * 2;
const FOLDS = 8;

export function createMandala({ active }) {
  const flashes = new Map();  // `${lane}:${step}` -> time
  const spiros = [];
  const sparks = [];
  let target = 0, rot = 0;

  on('drum', (h) => { if (active()) flashes.set(`${h.lane}:${h.step % 16}`, performance.now()); });
  on('bar', () => { if (active()) target += TAU / FOLDS / 2; });
  on('key', (k) => {
    if (!active()) return;
    const iv = k.intervals?.length ? k.intervals : [0, 4, 7];
    // Hypotrochoid ratios from the chord's intervals: each chord type gets its own figure.
    const a = (iv[1] ?? 4) % 12 || 4, b = (iv[2] ?? 7) % 12 || 7;
    spiros.push({ t0: performance.now(), q: 3 + (a % 5), p: b + 2, d: 0.45 + (iv.length - 2) * 0.12, color: k.chord ? P.lime : P.mint, rot: (k.pc / 12) * TAU });
    if (spiros.length > 4) spiros.shift();
  });
  on('note', (n) => {
    if (!active() || n.source !== 'loop') return;
    sparks.push({ t0: performance.now(), pc: ((n.midi % 12) + 12) % 12, color: P.layers[((n.layer ?? 1) - 1) % P.layers.length] });
    if (sparks.length > 64) sparks.shift();
  });

  function petal(ctx, ang, r0, r1, w) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const mid = (r0 + r1) / 2;
    const px = -sa * w, py = ca * w;
    ctx.beginPath();
    ctx.moveTo(ca * r0, sa * r0);
    ctx.quadraticCurveTo(ca * mid + px, sa * mid + py, ca * r1, sa * r1);
    ctx.quadraticCurveTo(ca * mid - px, sa * mid - py, ca * r0, sa * r0);
  }

  return {
    reset() { spiros.length = 0; sparks.length = 0; },
    draw(ctx, geo, now, dt) {
      const c = S.clock;
      const R = geo.R;
      rot += (target - rot) * Math.min(1, dt / 400);
      const turn = rot + S.fx.motion * 0.05;

      ctx.save();
      ctx.translate(geo.cx, geo.cy);
      ctx.rotate(turn);
      ctx.globalCompositeOperation = 'lighter';

      // Guide rings and fold lines
      ctx.strokeStyle = pa(P.ink, 0.07);
      ctx.lineWidth = 1;
      for (const f of [0.3, 0.5, 0.7, 0.9]) { ctx.beginPath(); ctx.arc(0, 0, R * f, 0, TAU); ctx.stroke(); }
      for (let f = 0; f < FOLDS; f++) {
        const a = (f / FOLDS) * TAU;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R); ctx.stroke();
      }

      // Petals from the current bar
      const b = S.beat;
      if (b) {
        const n = b.lanes.length;
        const playing = c.drumPos != null;
        const bar = playing ? Math.floor(c.drumPos / 4) % b.bars : 0;
        const inBar = playing ? (c.drumPos % 4) * 4 : -1;
        const lo = bar * 4;
        const wedge = TAU / FOLDS;
        for (const h of b.hits) {
          if (h.beat < lo || h.beat >= lo + 4 || h.muted) continue;
          const lane = b.lanes[h.lane];
          const stepF = (h.at - lo) * 4;
          const ft = flashes.get(`${h.lane}:${h.step % 16}`);
          const fl = ft ? Math.max(0, 1 - (now - ft) / 700) : 0;
          const passed = inBar >= 0 && stepF <= inBar;
          const base = R * (0.28 + (h.lane / Math.max(1, n - 1)) * 0.55);
          const len = R * (0.05 + h.vel * 0.09) * (1 + fl * 0.8);
          const local = (stepF / 16) * (wedge / 2) + wedge * 0.03; // half-wedge, mirrored
          ctx.fillStyle = lane.color;
          ctx.globalAlpha = (passed ? 0.5 : 0.18) + fl * 0.5;
          for (let f = 0; f < FOLDS; f++) {
            for (const mirror of [1, -1]) {
              const ang = f * wedge + mirror * local;
              petal(ctx, ang, base - len * 0.4, base + len, len * 0.35);
              ctx.fill();
            }
          }
        }
        ctx.globalAlpha = 1;
      }

      // Loop-note sparks on the outer ring
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        const t = (now - s.t0) / 1200;
        if (t >= 1) { sparks.splice(i, 1); continue; }
        const r = R * (0.92 + t * 0.12);
        ctx.fillStyle = s.color;
        ctx.globalAlpha = 1 - t;
        for (let f = 0; f < FOLDS; f++) {
          const a = (f / FOLDS) * TAU + (s.pc / 12) * (TAU / FOLDS);
          ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2.5 + (1 - t) * 3, 0, TAU); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // Chord spirographs draw themselves in, then fade.
      for (let i = spiros.length - 1; i >= 0; i--) {
        const sp = spiros[i];
        const age = (now - sp.t0) / 1000;
        if (age > 7) { spiros.splice(i, 1); continue; }
        const reveal = Math.min(1, age / 1.8);
        const alpha = age < 4 ? 1 : 1 - (age - 4) / 3;
        const Rr = 1, r = sp.q / sp.p, d = sp.d;
        const turns = sp.q * TAU;
        const steps = 720;
        const scale = R * 0.42 / (Rr - r + d);
        ctx.save();
        ctx.rotate(sp.rot - turn * 0.5);
        ctx.beginPath();
        for (let s = 0; s <= steps * reveal; s++) {
          const t = (s / steps) * turns;
          const x = ((Rr - r) * Math.cos(t) + d * Math.cos(((Rr - r) / r) * t)) * scale;
          const y = ((Rr - r) * Math.sin(t) - d * Math.sin(((Rr - r) / r) * t)) * scale;
          s ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.strokeStyle = sp.color;
        ctx.globalAlpha = 0.85 * alpha;
        ctx.lineWidth = 1.6;
        ctx.shadowColor = sp.color;
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      // Centre star pulses with the kick
      const k = S.fx.kick;
      ctx.beginPath();
      for (let i = 0; i <= FOLDS * 2; i++) {
        const a = (i / (FOLDS * 2)) * TAU;
        const rr = R * (i % 2 ? 0.07 : 0.16 + k * 0.06);
        i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.strokeStyle = P.lime;
      ctx.lineWidth = 2;
      ctx.shadowColor = P.lime;
      ctx.shadowBlur = 10 + k * 30;
      ctx.stroke();
      ctx.restore();
    },
  };
}
