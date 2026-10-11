// SO101 arms in 2D: the fallback for arm3d.js when WebGL is unavailable.
// Two "camera feeds", one per arm.
//
// Each arm gets its own viewport with:
//   - real SO101 side-view kinematics (upper arm 116 mm, forearm 135 mm,
//     gripper ~100 mm), offsets calibrated so the playing pose points the
//     gripper down at the keys as the real arm does;
//   - an auto-framing camera that zooms to the arm's recent motion, so the
//     arm fills its box instead of sitting at the bottom of a fixed frame;
//   - a fingertip comet trail, the key strip under the press point with the
//     target key lit, and a ripple on every press.

import { S, on } from './state.js';
import { P, a as pa } from './theme.js';

const TAU = Math.PI * 2;
const L1 = 116, L2 = 135, L3 = 100, H0 = 55; // mm
const rad = (d) => (d * Math.PI) / 180;
const FONT = (px, w = 400) => `${w} ${px * P.fontScale}px ${P.font}`;
const CHORD_LABEL = { 'chord.dim': 'Dim', 'chord.min': 'Min', 'chord.maj': 'Maj', 'chord.sus': 'Sus', 'chord.6': '6', 'chord.m7': 'm7', 'chord.M7': 'M7', 'chord.9': '9' };

// Side-view forward kinematics in mm (x forward, y up). Joint degrees are
// orchid-robot's degrees_from_midpoint.
function fk(j) {
  const p1 = rad(90 - j.shoulder_lift);
  const p2 = rad(j.elbow_flex - j.shoulder_lift);
  const p3 = p2 - rad(j.wrist_flex - 55);
  const sh = [0, H0];
  const el = [sh[0] + L1 * Math.cos(p1), sh[1] + L1 * Math.sin(p1)];
  const wr = [el[0] + L2 * Math.cos(p2), el[1] + L2 * Math.sin(p2)];
  const tip = [wr[0] + L3 * Math.cos(p3), wr[1] + L3 * Math.sin(p3)];
  return { base: [0, 0], sh, el, wr, tip, grip: p3 };
}

const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];

function createArmCam() {
  const st = {
    j: null,                 // smoothed joint degrees
    hist: [],                // recent poses for framing [{t, pts}]
    trail: [],               // fingertip trail [{t, x, y}]
    view: null,              // smoothed {cx, cy, s}
    press: null,             // last press point {x, y, label, t}
    ripples: [],
  };

  function update(arm, now, dt, offline) {
    const target = {};
    for (const n of JOINTS) {
      const deg = offline ? null : arm?.joints?.find((x) => x.name === n)?.deg;
      target[n] = deg ?? (n === 'wrist_flex' ? 86 + Math.sin(now / 1700) * 6 : n === 'elbow_flex' ? 10 + Math.sin(now / 1300) * 8 : n === 'shoulder_lift' ? -4 + Math.sin(now / 1500) * 8 : 0);
    }
    if (!st.j) st.j = { ...target };
    const k = 1 - Math.exp(-dt / 90); // robot state arrives at ~4 Hz; glide between samples
    for (const n of JOINTS) st.j[n] += (target[n] - st.j[n]) * k;
    const f = fk(st.j);
    st.hist.push({ t: now, pts: [f.base, f.sh, f.el, f.wr, f.tip] });
    while (st.hist.length && now - st.hist[0].t > 9000) st.hist.shift();
    st.trail.push({ t: now, x: f.tip[0], y: f.tip[1] });
    while (st.trail.length && now - st.trail[0].t > 1800) st.trail.shift();
    return f;
  }

  // Fit the recent motion (plus the base and the key strip under the last press)
  // into the viewport, eased.
  function frame(vx, vy, vw, vh, dt) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const h of st.hist) for (const [x, y] of h.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (st.press) { y0 = Math.min(y0, st.press.y - 34); x0 = Math.min(x0, st.press.x - 60); x1 = Math.max(x1, st.press.x + 60); }
    const bw = Math.max(160, x1 - x0), bh = Math.max(140, y1 - y0);
    const fw = vw;
    const s = Math.min((fw * 0.84) / bw, (vh * 0.74) / bh);
    const target = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s };
    if (!st.view) st.view = target;
    const k = 1 - Math.exp(-dt / 700);
    for (const key of ['cx', 'cy', 's']) st.view[key] += (target[key] - st.view[key]) * k;
    const v = st.view;
    return ([x, y]) => [vx + fw / 2 + (x - v.cx) * v.s, vy + vh * 0.5 - (y - v.cy) * v.s];
  }

  return {
    st,
    onPress(label, now) {
      const f = st.j && fk(st.j);
      if (!f) return;
      st.press = { x: f.tip[0], y: f.tip[1], label, t: now };
      st.ripples.push({ t: now, x: f.tip[0], y: f.tip[1] });
    },

    draw(ctx, box, arm, now, dt, opts) {
      const { color, title, offline } = opts;
      const { x: vx, y: vy, w: vw, h: vh } = box;
      const f = update(arm, now, dt, offline);
      const map = frame(vx, vy, vw, vh, dt);
      const s = st.view.s;

      ctx.save();
      ctx.beginPath(); ctx.rect(vx, vy, vw, vh); ctx.clip();

      // Camera chrome: faint grid, corner brackets, scan line.
      ctx.globalAlpha = offline ? 0.35 : 1;
      ctx.strokeStyle = pa(P.ink, 0.05);
      ctx.lineWidth = 1;
      const g = 20 * s;
      if (g > 6) {
        const [ox, oy] = map([0, 0]);
        for (let x = ((ox - vx) % g) + vx; x < vx + vw; x += g) { ctx.beginPath(); ctx.moveTo(x, vy); ctx.lineTo(x, vy + vh); ctx.stroke(); }
        for (let y = ((oy - vy) % g) + vy; y < vy + vh; y += g) { ctx.beginPath(); ctx.moveTo(vx, y); ctx.lineTo(vx + vw, y); ctx.stroke(); }
      }
      const scanY = vy + ((now / 18) % vh);
      ctx.fillStyle = pa(color, 0.05);
      ctx.fillRect(vx, scanY, vw, 2);

      // Instrument: key strip under the last press point, target key lit.
      if (st.press) {
        const [px, py] = map([st.press.x, st.press.y]);
        const kw = Math.max(10, 26 * s), kh = Math.max(4, 7 * s);
        const age = (now - st.press.t) / 600;
        for (let i = -3; i <= 3; i++) {
          const x = px + i * (kw + 2) - kw / 2;
          const lit = i === 0;
          ctx.fillStyle = lit ? pa(color, 0.25 + Math.max(0, 1 - age) * 0.6) : pa(P.ink, 0.08);
          ctx.fillRect(x, py + 2, kw, kh);
        }
        ctx.font = FONT(Math.max(10, 12 * Math.min(1.4, s)), 800);
        ctx.fillStyle = color;
        ctx.textAlign = 'left'; // just above the strip, right of the gripper
        ctx.textBaseline = 'bottom';
        ctx.fillText(st.press.label, px + kw / 2 + 6, py - 3);
      }

      // Fingertip comet trail.
      if (st.trail.length > 2) {
        ctx.lineCap = 'round';
        for (let i = 1; i < st.trail.length; i++) {
          const a = st.trail[i - 1], b = st.trail[i];
          const life = 1 - (now - b.t) / 1800;
          const [ax, ay] = map([a.x, a.y]), [bx, by] = map([b.x, b.y]);
          ctx.strokeStyle = pa(color, life * 0.7);
          ctx.lineWidth = 1 + life * 3;
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        }
      }

      // Press ripples.
      for (let i = st.ripples.length - 1; i >= 0; i--) {
        const r = st.ripples[i];
        const t = (now - r.t) / 900;
        if (t >= 1) { st.ripples.splice(i, 1); continue; }
        const [x, y] = map([r.x, r.y]);
        ctx.beginPath(); ctx.arc(x, y, 6 + t * 40, 0, TAU);
        ctx.strokeStyle = pa(P.hot, 1 - t); ctx.lineWidth = 2.5 * (1 - t) + 0.5; ctx.stroke();
      }

      // The arm.
      const pts = [f.base, f.sh, f.el, f.wr, f.tip].map(map);
      const [base, sh, el, wr, tip] = pts;
      ctx.fillStyle = pa(P.ink, 0.12);
      ctx.fillRect(base[0] - 24 * s, base[1], 48 * s, 5);
      const heat = (name) => {
        const t = arm?.joints?.find((j) => j.name === name)?.temp;
        return t == null ? 0 : Math.max(0, Math.min(1, (t - 35) / 25)); // 35°C cool → 60°C hot
      };
      ctx.lineCap = 'round';
      ctx.shadowColor = color;
      ctx.shadowBlur = arm?.playing ? 18 : 8;
      for (const [a, b, wdt] of [[base, sh, 12], [sh, el, 9], [el, wr, 7], [wr, tip, 5]]) {
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b);
        ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, wdt * s * 0.9); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,10,18,0.55)'; ctx.lineWidth = Math.max(0.8, wdt * s * 0.3); ctx.stroke(); // inner channel
      }
      ctx.shadowBlur = 0;
      // Gripper jaws
      const ga = -f.grip; // canvas angle
      const open = 0.18 + Math.abs(rad(st.j.gripper)) * 0.5;
      for (const sgn of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(...tip);
        ctx.lineTo(tip[0] + Math.cos(ga + sgn * open) * 18 * s, tip[1] + Math.sin(ga + sgn * open) * 18 * s);
        ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, 3 * s); ctx.stroke();
      }
      // Joints, tinted by motor temperature.
      for (const [p, name] of [[sh, 'shoulder_lift'], [el, 'elbow_flex'], [wr, 'wrist_flex']]) {
        const h = heat(name);
        ctx.beginPath(); ctx.arc(...p, Math.max(3, 7 * s), 0, TAU);
        ctx.fillStyle = P.bg; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = h > 0.5 ? `rgba(255,${Math.round(180 - h * 120)},70,1)` : P.lavender; ctx.stroke();
      }
      // Fingertip
      ctx.beginPath(); ctx.arc(...tip, 3.5, 0, TAU); ctx.fillStyle = arm?.playing ? P.hot : color; ctx.fill();

      // Pan compass (top-down yaw)
      const cx = vx + vw - 18, cy = vy + vh - 18;
      ctx.beginPath(); ctx.arc(cx, cy, 10, 0, TAU); ctx.strokeStyle = pa(P.ink, 0.3); ctx.lineWidth = 1; ctx.stroke();
      const pan = -Math.PI / 2 + rad(st.j.shoulder_pan);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(pan) * 10, cy + Math.sin(pan) * 10); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();

      // Corner brackets + labels
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pa(color, 0.7);
      ctx.lineWidth = 1.5;
      const c = 10;
      for (const [x, y, dx, dy] of [[vx + 2, vy + 2, 1, 1], [vx + vw - 2, vy + 2, -1, 1], [vx + 2, vy + vh - 2, 1, -1], [vx + vw - 2, vy + vh - 2, -1, -1]]) {
        ctx.beginPath(); ctx.moveTo(x + dx * c, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * c); ctx.stroke();
      }
      ctx.font = FONT(10, 800);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = color;
      ctx.fillText(title, vx + 8, vy + 7);
      ctx.font = FONT(9);
      ctx.fillStyle = offline ? P.hot : pa(P.ink, 0.6);
      const rec = offline ? 'NO SIGNAL' : arm?.playing ? '● LIVE' : 'STANDBY';
      ctx.fillText(rec, vx + 8, vy + 20);
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = pa(P.ink, 0.75);
      ctx.fillText(opts.line, vx + 8, vy + vh - 6);
      if (opts.progress != null) {
        ctx.fillStyle = pa(P.ink, 0.12); ctx.fillRect(vx + 8, vy + vh - 4, vw * 0.45, 2);
        ctx.fillStyle = P.hot; ctx.fillRect(vx + 8, vy + vh - 4, vw * 0.45 * opts.progress, 2);
      }
      ctx.restore();
    },
  };
}

export function createRobotView(canvas, metaEl) {
  const cams = { a: createArmCam(), b: createArmCam() };
  let last = performance.now();

  // Robot presses (progress crossing the press point) mark the key position.
  on('robot-press', (p) => {
    const label = p.control?.startsWith('chord.') ? CHORD_LABEL[p.control] ?? p.control : p.control ?? '';
    cams[p.arm]?.onPress(label, performance.now());
  });

  return function draw(now) {
    const dt = Math.min(100, now - last);
    last = now;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const r = S.robot;
    const offline = !r || (!S.demo && S.sources.robot?.online === false);
    metaEl.textContent = offline ? 'offline · start orchid-robot' : `${r.arms[0]?.mode ?? ''}${typeof r.port === 'number' ? ` · :${r.port}` : ''}`;
    const A = r?.arms?.find((x) => x.arm === 'a');
    const B = r?.arms?.find((x) => x.arm === 'b');
    const describe = (a, isChord) => {
      if (!a || offline) return { line: 'offline', progress: null };
      const what = a.sequence || (isChord ? CHORD_LABEL[a.chordHeld] ?? CHORD_LABEL[a.selected] ?? a.selected : a.selected) || '—';
      return { line: (a.playing ? `▶ ${what}` : `${(a.phase || '').replace(/_/g, ' ')} · ${what}`).slice(0, 34), progress: a.playing ? a.progress : null };
    };
    const gap = 8;
    const half = (w - gap) / 2;
    cams.a.draw(ctx, { x: 0, y: 0, w: half, h }, A, now, dt, { color: P.lime, title: 'CAM A · KEYS ARM', offline, ...describe(A, false) });
    cams.b.draw(ctx, { x: half + gap, y: 0, w: half, h }, B, now, dt, { color: P.mint, title: 'CAM B · CHORD ARM', offline, ...describe(B, true) });
  };
}

