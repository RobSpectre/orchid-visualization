// The orbit: a radial drum machine (one revolution per bar, one ring per lane),
// a chromatic pitch circle that draws chord geometry, and a particle field.
// Draws on a full-screen canvas with motion trails so particles can fly
// between panels.

import { S, on, NOTE_NAMES } from './state.js';
import { createWarp } from './treatments/warp.js';
import { createRidges } from './treatments/ridges.js';
import { createMandala } from './treatments/mandala.js';
import { P, a as pa } from './theme.js';

// Visual treatments of the centre stage. 'orbit' is drawn here; the others are modules.
export const TREATMENTS = [
  { id: 'orbit', name: 'Orbit' },
  { id: 'warp', name: 'Warp' },
  { id: 'ridges', name: 'Ridgelines' },
  { id: 'mandala', name: 'Mandala' },
];

const TAU = Math.PI * 2;
const TRANSPORT_LABELS = {
  paused: '❚❚ PAUSED IN STUDIO',
  stopped: '■ STOPPED',
  stale: '⚠ STUDIO NOT RESPONDING',
  offline: 'STUDIO OFFLINE',
  'count-in': 'COUNT-IN',
};

export function createOrbit(canvas, staticCanvas, anchorEl) {
  // Trails canvas keeps fading residue (particles, bursts); the static canvas
  // is cleared every frame so redrawn geometry doesn't accumulate brightness.
  const tctx = canvas.getContext('2d');
  const sctx = staticCanvas.getContext('2d');
  let ctx = sctx;
  let W = 0, H = 0, dpr = 1;
  let geo = { cx: 0, cy: 0, R: 100 };
  const particles = [];
  const bursts = [];
  const pitchGlow = new Float32Array(12);
  const pitchColor = new Array(12).fill(P.lime);
  const chords = []; // {pcs, at, color}
  const hitFlash = new Map(); // `${lane}:${step}` -> time
  const BINS = 128;
  const spectrum = new Float32Array(BINS);
  let spin = 0;
  let trippy = false;
  let treatment = 'orbit';
  const isOrbit = () => treatment === 'orbit';
  const modules = {
    warp: createWarp({ active: () => treatment === 'warp' }),
    ridges: createRidges({ active: () => treatment === 'ridges' }),
    mandala: createMandala({ active: () => treatment === 'mandala' }),
  };

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    if (w !== W || h !== H) {
      W = w; H = h;
      canvas.width = staticCanvas.width = W * dpr;
      canvas.height = staticCanvas.height = H * dpr;
    }
    const r = anchorEl.getBoundingClientRect();
    geo = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: Math.max(60, Math.min(r.width * 0.9, r.height) / 2 - 18), rect: r };
  }

  const laneRadius = (i, n) => {
    const { R } = geo;
    if (n <= 1) return R * 0.8;
    return R * 0.9 - (i / (n - 1)) * R * 0.42;
  };
  const stepAngle = (stepFloat) => -Math.PI / 2 + (stepFloat / 16) * TAU;
  const pitchPos = (pc, r) => {
    const a = -Math.PI / 2 + (pc / 12) * TAU;
    return [geo.cx + Math.cos(a) * r, geo.cy + Math.sin(a) * r];
  };

  function spawn(x, y, n, color, speed = 3, life = 900, size = 2, glyph = null) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const v = speed * (0.3 + Math.random());
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: size * (0.5 + Math.random()), glyph });
    }
    if (particles.length > 2500) particles.splice(0, particles.length - 2500);
  }

  // ---- reactions
  on('drum', (h) => {
    if (!S.beat || !isOrbit()) return;
    const n = S.beat.lanes.length;
    const step = h.step % 16;
    const r = laneRadius(h.lane, n);
    const a = stepAngle(h.at * 4 % 16);
    const x = geo.cx + Math.cos(a) * r, y = geo.cy + Math.sin(a) * r;
    hitFlash.set(`${h.lane}:${step}`, performance.now());
    // Energy lands in the spectrum ring where the hit sits on the clock face.
    const centre = Math.round(((h.at * 4) % 16) / 16 * BINS);
    const spread = h.kind === 'kick' ? 14 : h.kind === 'snare' ? 9 : 4;
    for (let i = -spread; i <= spread; i++) {
      const bin = (centre + i + BINS) % BINS;
      spectrum[bin] = Math.min(1.6, spectrum[bin] + h.vel * (1 - Math.abs(i) / (spread + 1)) * (h.kind === 'hat' ? 0.5 : 1));
    }
    const lane = S.beat.lanes[h.lane];
    bursts.push({ x, y, r0: 3, r1: 18 + 40 * h.vel * (h.kind === 'kick' ? 2 : 1), life: 500, max: 500, color: lane.color, w: h.kind === 'kick' ? 3 : 1.5 });
    const count = h.kind === 'kick' ? 26 : h.kind === 'snare' ? 18 : 6;
    spawn(x, y, Math.round(count * (0.4 + h.vel)), lane.color, h.kind === 'kick' ? 4.5 : 2.5, 900, h.kind === 'hat' ? 1.2 : 2);
    if (h.kind === 'kick') bursts.push({ x: geo.cx, y: geo.cy, r0: geo.R * 0.2, r1: geo.R * 1.25, life: 700, max: 700, color: P.lime, w: 2 });
  });

  on('note', (n) => {
    if (!isOrbit()) return;
    const pc = ((n.midi % 12) + 12) % 12;
    pitchGlow[pc] = Math.min(1.4, pitchGlow[pc] + 0.6 + (n.vel ?? 0.6));
    const color = n.source === 'key' ? P.lime : n.source === 'robot' ? P.hot : P.layers[((n.layer ?? 1) - 1) % P.layers.length];
    pitchColor[pc] = color;
    const [x, y] = pitchPos(pc, geo.R * 0.3);
    spawn(x, y, n.source === 'key' ? 16 : 7, color, 2.2, 1100, 1.8);
    if (n.source === 'loop') bursts.push({ x, y, r0: 2, r1: 22, life: 450, max: 450, color, w: 1 });
  });

  on('key', (k) => {
    if (!isOrbit()) return;
    const pcs = (k.intervals ?? [0]).map((i) => (k.pc + i) % 12);
    chords.push({ pcs, at: performance.now(), color: k.chord ? P.lime : P.mint, name: k.chord ? `${k.name} ${k.chord}` : k.name });
    if (chords.length > 6) chords.shift();
    bursts.push({ x: geo.cx, y: geo.cy, r0: 4, r1: geo.R * 0.32, life: 800, max: 800, color: P.lime, w: 2.5 });
  });

  on('robot-press', (p) => {
    if (p.pc == null || !isOrbit()) return;
    const [x, y] = pitchPos(p.pc, geo.R * 0.3);
    bursts.push({ x, y, r0: 4, r1: 46, life: 900, max: 900, color: P.hot, w: 2 });
    spawn(x, y, 24, P.hot, 3, 1200, 2);
  });

  // Each Token Factory response streams glyphs from the factory panel into the orbit.
  on('tokens', ({ from, count, text, colors }) => {
    const chars = (text || '01').replace(/\s+/g, '');
    const n = Math.min(90, Math.max(8, Math.round(Math.sqrt(count) * 3)));
    for (let i = 0; i < n; i++) {
      const sx = from.x + (Math.random() - 0.5) * from.w;
      const sy = from.y + (Math.random() - 0.5) * from.h;
      const tx = geo.cx + (Math.random() - 0.5) * geo.R * 0.3;
      const ty = geo.cy + (Math.random() - 0.5) * geo.R * 0.3;
      const life = 1200 + Math.random() * 900;
      particles.push({
        x: sx, y: sy, vx: (tx - sx) / (life / 16.7) * 1.3 + (Math.random() - 0.5) * 2, vy: (ty - sy) / (life / 16.7) * 1.3 + (Math.random() - 0.5) * 4,
        life, max: life, color: colors ? colors[i % colors.length] : Math.random() < 0.7 ? P.lime : P.mint, size: 10 + Math.random() * 4,
        glyph: chars[Math.floor(Math.random() * chars.length)] || '·', drag: 0.985,
      });
    }
  });

  on('bar', () => { if (isOrbit()) spin += 0.5; });

  function drawPattern(now, drumPos) {
    const b = S.beat;
    if (!b) return;
    const n = b.lanes.length;
    const playing = drumPos != null;
    const bar = playing ? Math.floor(drumPos / 4) % b.bars : 0;
    const inBar = playing ? (drumPos % 4) * 4 : null; // 0..16 steps

    // Lane rings
    for (const lane of b.lanes) {
      const r = laneRadius(lane.idx, n);
      ctx.beginPath();
      ctx.arc(geo.cx, geo.cy, r, 0, TAU);
      ctx.strokeStyle = lane.color;
      ctx.globalAlpha = lane.muted ? 0.05 : 0.14 + S.fx[lane.kind] * 0.25;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 16 step ticks
    for (let s = 0; s < 16; s++) {
      const a = stepAngle(s);
      const r0 = geo.R * 0.44, r1 = geo.R * (s % 4 === 0 ? 0.97 : 0.93);
      ctx.beginPath();
      ctx.moveTo(geo.cx + Math.cos(a) * r0, geo.cy + Math.sin(a) * r0);
      ctx.lineTo(geo.cx + Math.cos(a) * r1, geo.cy + Math.sin(a) * r1);
      ctx.strokeStyle = s % 4 === 0 ? pa(P.lime, 0.16) : pa(P.ink, 0.05);
      ctx.stroke();
    }

    // Hits for the current bar
    const lo = bar * 4, hi = lo + 4;
    for (const h of b.hits) {
      if (h.beat < lo || h.beat >= hi) continue;
      const lane = b.lanes[h.lane];
      const stepF = (h.at - lo) * 4;
      const a = stepAngle(stepF);
      const r = laneRadius(h.lane, n);
      const x = geo.cx + Math.cos(a) * r, y = geo.cy + Math.sin(a) * r;
      const flashT = hitFlash.get(`${h.lane}:${h.step % 16}`);
      const flash = flashT ? Math.max(0, 1 - (now - flashT) / 600) : 0;
      const passed = inBar != null && stepF <= inBar;
      const base = h.muted ? 0.12 : passed ? 0.75 : 0.4;
      const size = (2.5 + h.vel * 5.5) * (1 + flash * 1.4);
      ctx.globalAlpha = Math.min(1, base + flash);
      ctx.fillStyle = lane.color;
      ctx.shadowColor = lane.color;
      ctx.shadowBlur = 6 + flash * 26;
      ctx.beginPath();
      if (h.vel >= 0.75) { // accent: diamond
        ctx.moveTo(x, y - size * 1.3); ctx.lineTo(x + size * 1.3, y); ctx.lineTo(x, y + size * 1.3); ctx.lineTo(x - size * 1.3, y);
      } else {
        ctx.arc(x, y, size, 0, TAU);
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // Lane labels at 12 o'clock
    ctx.font = `${Math.max(8, geo.R * 0.026) * P.fontScale}px ${P.font}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const lane of b.lanes) {
      const r = laneRadius(lane.idx, n);
      ctx.fillStyle = lane.color;
      ctx.globalAlpha = lane.muted ? 0.25 : 0.6;
      ctx.fillText(lane.name || lane.id, geo.cx - 8, geo.cy - r);
    }
    ctx.globalAlpha = 1;

    // Arrangement ring: one segment per bar
    const segR = geo.R * 0.99;
    for (let i = 0; i < b.bars; i++) {
      const a0 = -Math.PI / 2 + (i / b.bars) * TAU + 0.02;
      const a1 = -Math.PI / 2 + ((i + 1) / b.bars) * TAU - 0.02;
      ctx.beginPath();
      ctx.arc(geo.cx, geo.cy, segR, a0, a1);
      const cur = playing && i === bar;
      ctx.strokeStyle = cur ? P.lime : i < bar && playing ? pa(P.lime, 0.35) : pa(P.ink, 0.12);
      ctx.lineWidth = cur ? 4 : 2;
      ctx.shadowColor = P.lime;
      ctx.shadowBlur = cur ? 14 : 0;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;

    // Playhead sweep with a trailing conic wedge
    if (playing) {
      const a = stepAngle(inBar);
      const held = S.clock.transport !== 'playing' && S.clock.transport !== 'count-in';
      if (held) ctx.globalAlpha = 0.35 + 0.35 * Math.sin(now / 260); // frozen where Studio paused
      if (ctx.createConicGradient && !held) {
        const g = ctx.createConicGradient(a - TAU * 0.18, geo.cx, geo.cy);
        g.addColorStop(0, pa(P.lime, 0));
        g.addColorStop(0.18, pa(P.lime, 0.22 + S.fx.kick * 0.2));
        g.addColorStop(0.1801, pa(P.lime, 0));
        g.addColorStop(1, pa(P.lime, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(geo.cx, geo.cy, geo.R * 0.97, 0, TAU);
        ctx.arc(geo.cx, geo.cy, geo.R * 0.4, 0, TAU, true);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(geo.cx + Math.cos(a) * geo.R * 0.4, geo.cy + Math.sin(a) * geo.R * 0.4);
      ctx.lineTo(geo.cx + Math.cos(a) * geo.R * 1.02, geo.cy + Math.sin(a) * geo.R * 1.02);
      ctx.strokeStyle = P.lime;
      ctx.lineWidth = 2;
      ctx.shadowColor = P.lime;
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1;
    }
  }

  function drawSpectrum(now, dt) {
    const r0 = geo.R * 1.04;
    const k = Math.exp(-dt / 260);
    const playing = S.fx.playing;
    for (let i = 0; i < BINS; i++) {
      spectrum[i] *= k;
      const m = S.fx.motion * 1000;
      const idle = 0.04 + 0.04 * Math.sin(m / 700 + i * 0.35) * Math.sin(m / 1300 - i * 0.11);
      const v = Math.max(idle, spectrum[i] + S.fx.kick * 0.25 * playing + S.fx.noteHit * 0.12);
      const a = -Math.PI / 2 + (i / BINS) * TAU;
      const len = geo.R * 0.16 * v;
      const hue = i / BINS;
      ctx.strokeStyle = hue < 0.33 ? P.lime : hue < 0.66 ? P.mint : P.violet;
      ctx.globalAlpha = 0.25 + Math.min(0.75, v);
      ctx.lineWidth = Math.max(1.5, (TAU * r0) / BINS * 0.45);
      ctx.beginPath();
      ctx.moveTo(geo.cx + Math.cos(a) * r0, geo.cy + Math.sin(a) * r0);
      ctx.lineTo(geo.cx + Math.cos(a) * (r0 + len), geo.cy + Math.sin(a) * (r0 + len));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  function drawPitchCircle(now, dt) {
    const r = geo.R * 0.3;
    // Faint 12-gon
    ctx.beginPath();
    for (let pc = 0; pc <= 12; pc++) {
      const [x, y] = pitchPos(pc % 12, r);
      pc ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = pa(P.mint, 0.15);
    ctx.stroke();

    // Chord polygons (each fades over ~2.5 s)
    for (let i = chords.length - 1; i >= 0; i--) {
      const c = chords[i];
      const age = (now - c.at) / 2500;
      if (age > 1) { chords.splice(i, 1); continue; }
      const alpha = 1 - age;
      const scale = 1 + age * 0.5;
      ctx.beginPath();
      c.pcs.forEach((pc, j) => {
        const a = -Math.PI / 2 + (pc / 12) * TAU;
        const x = geo.cx + Math.cos(a) * r * scale, y = geo.cy + Math.sin(a) * r * scale;
        j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.strokeStyle = c.color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2;
      ctx.shadowColor = c.color;
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.globalAlpha = alpha * 0.12;
      ctx.fillStyle = c.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1;
    }

    // Vertices + labels
    ctx.font = `${Math.max(9, geo.R * 0.034) * P.fontScale}px ${P.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const robotKey = S.robot?.arms?.find((a) => a.arm === 'a')?.selected;
    for (let pc = 0; pc < 12; pc++) {
      pitchGlow[pc] *= Math.exp(-dt / 500);
      const held = S.keysDown.get(pc);
      const g = Math.min(1.4, pitchGlow[pc] + (held && !held.released ? 0.5 : 0));
      const [x, y] = pitchPos(pc, r);
      ctx.fillStyle = g > 0.05 ? pitchColor[pc] : pa(P.ink, 0.35);
      ctx.shadowColor = pitchColor[pc];
      ctx.shadowBlur = g * 24;
      ctx.beginPath();
      ctx.arc(x, y, 2.5 + g * 6, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      const [lx, ly] = pitchPos(pc, r + geo.R * 0.075);
      ctx.globalAlpha = 0.35 + Math.min(0.65, g);
      ctx.fillText(NOTE_NAMES[pc], lx, ly);
      ctx.globalAlpha = 1;
      if (robotKey === NOTE_NAMES[pc]) {
        ctx.beginPath();
        ctx.arc(x, y, 12 + Math.sin(now / 160) * 2, 0, TAU);
        ctx.strokeStyle = P.hot;
        ctx.stroke();
      }
    }
  }

  function drawCore(now) {
    const fx = S.fx;
    const r = geo.R * (0.1 + fx.kick * 0.05);
    const sides = 6;
    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath();
      const rot = spin * 0.6 + (fx.motion * 1000) / (6000 - layer * 1500) * (layer % 2 ? -1 : 1);
      for (let i = 0; i <= sides; i++) {
        const a = rot + (i / sides) * TAU;
        const rr = r * (1 - layer * 0.25);
        const x = geo.cx + Math.cos(a) * rr, y = geo.cy + Math.sin(a) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = layer === 0 ? P.lime : layer === 1 ? P.violet : P.mint;
      ctx.globalAlpha = 0.5 + fx.kick * 0.5;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    // Beat-in-bar pips
    const c = S.clock;
    const t = c.transport;
    if (t === 'playing' || t === 'count-in' || t === 'paused') {
      const beatInBar = Math.floor(((c.beat % 4) + 4) % 4);
      const blink = t === 'paused' ? 0.4 + 0.6 * (Math.sin(now / 260) > 0 ? 1 : 0) : 1;
      for (let i = 0; i < 4; i++) {
        const x = geo.cx + (i - 1.5) * 10;
        ctx.fillStyle = i === beatInBar ? P.lime : pa(P.ink, 0.2);
        ctx.globalAlpha = i === beatInBar ? blink : 1;
        ctx.fillRect(x - 3, geo.cy + r + 10, 6, 3);
      }
      ctx.globalAlpha = 1;
    }
    drawTransportLabel(now, geo.cy + r + 22);
    // Thinking halo while Hermes is mid-turn
    if (fx.think > 0.02) {
      ctx.beginPath();
      ctx.arc(geo.cx, geo.cy, geo.R * 0.2, now / 300, now / 300 + TAU * 0.7 * fx.think);
      ctx.strokeStyle = P.mint;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
  }

  // Say plainly when Studio isn't playing (every treatment).
  function drawTransportLabel(now, y) {
    const t = S.clock.transport;
    // No data because this screen lost its own server: don't blame Studio.
    const label = t === 'stale' && S.sources.server?.online === false ? '⚠ SIGNAL SERVER OFFLINE' : TRANSPORT_LABELS[t];
    if (!label) return;
    ctx.font = `600 ${Math.max(11, geo.R * 0.04) * P.fontScale}px ${P.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = t === 'paused' ? P.lime : t === 'stale' || t === 'offline' ? P.hot : pa(P.ink, 0.7);
    ctx.globalAlpha = t === 'paused' ? 0.55 + 0.45 * Math.sin(now / 260) : 0.85;
    ctx.fillText(label, geo.cx, y);
    ctx.globalAlpha = 1;
  }

  function drawFx(dt) {
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.life -= dt;
      if (b.life <= 0) { bursts.splice(i, 1); continue; }
      const t = 1 - b.life / b.max;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r0 + (b.r1 - b.r0) * (1 - (1 - t) ** 3), 0, TAU);
      ctx.strokeStyle = b.color;
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.lineWidth = b.w * (1 - t) + 0.5;
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const f = dt / 16.7;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      const drag = p.drag ?? 0.96;
      p.vx *= drag ** f; p.vy *= drag ** f;
      // Gentle swirl around the orbit centre
      const dx = p.x - geo.cx, dy = p.y - geo.cy;
      const d = Math.hypot(dx, dy) + 1;
      p.vx += (-dy / d) * 0.04 * f * (trippy ? 3 : 1);
      p.vy += (dx / d) * 0.04 * f * (trippy ? 3 : 1);
      p.x += p.vx * f; p.y += p.vy * f;
      const a = p.life / p.max;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.glyph) {
        ctx.font = `${p.size}px ${P.font}`;
        ctx.fillText(p.glyph, p.x, p.y);
      } else {
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;
  }

  let last = performance.now();
  let switching = null;
  return {
    setTrippy(v) { trippy = v; },
    get treatment() { return treatment; },
    // Switch with a short fade so treatments never pop.
    setTreatment(id) {
      if (!TREATMENTS.some((t) => t.id === id) || id === treatment || switching === id) return;
      switching = id;
      document.body.classList.add('treatment-out');
      setTimeout(() => {
        treatment = id;
        switching = null;
        modules[id]?.reset?.();
        particles.length = 0;
        bursts.length = 0;
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.clearRect(0, 0, canvas.width, canvas.height);
        document.body.dataset.treatment = id;
        document.body.classList.remove('treatment-out');
      }, 450);
    },
    draw(now) {
      const dt = Math.min(100, now - last);
      last = now;
      resize();
      ctx = sctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      if (isOrbit()) {
        drawSpectrum(now, dt);
        drawPattern(now, S.clock.drumPos);
        drawPitchCircle(now, dt);
        drawCore(now);
      } else {
        modules[treatment].draw(ctx, geo, now, dt);
        drawTransportLabel(now, geo.rect.top + 26);
      }
      ctx.globalCompositeOperation = 'source-over';

      ctx = tctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Motion trails: erase a fraction of the previous frame instead of all of it.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${trippy ? 0.1 : 0.22})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      drawFx(dt);
      ctx.globalCompositeOperation = 'source-over';
    },
    get geo() { return geo; },
  };
}
