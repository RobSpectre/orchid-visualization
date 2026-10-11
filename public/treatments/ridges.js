// Ridgelines: stacked pulse profiles in the manner of a pulsar plot. Every 16th
// note a new line is drawn from what just sounded (kick in the centre, snare
// either side, hats as fine spikes, notes placed by pitch) and the stack
// scrolls back into the distance. Paused or stopped, the stack holds still.

import { S, on } from '../state.js';
import { P, a as pa } from '../theme.js';

const N = 128;     // samples per line
const MAXL = 56;   // lines kept

export function createRidges({ active }) {
  const lines = [];
  let energy = new Float32Array(N);
  let pendingKick = false;
  let lastStep = null;

  const bump = (center, width, amp) => {
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      energy[i] += amp * Math.exp(-(((x - center) / width) ** 2));
    }
  };

  // Lines only carry signal from the middle, like the classic plot.
  const envelope = (x) => Math.exp(-(((x - 0.5) / 0.3) ** 4));

  function pushLine(bar) {
    const h = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      h[i] = (energy[i] + 0.035 * Math.random() + 0.02 * Math.random() ** 3 * 4) * envelope(x);
    }
    lines.unshift({ h, kick: pendingKick, bar });
    if (lines.length > MAXL) lines.length = MAXL;
    energy = new Float32Array(N);
    pendingKick = false;
  }
  for (let i = 0; i < MAXL; i++) pushLine(i % 16 === 0); // a quiet field to start from

  on('drum', (h) => {
    if (!active()) return;
    const v = h.vel;
    if (h.kind === 'kick') { bump(0.5, 0.075, 1.1 * v); pendingKick = true; }
    else if (h.kind === 'snare') { bump(0.36, 0.045, 0.75 * v); bump(0.64, 0.045, 0.75 * v); }
    else if (h.kind === 'hat') { for (let k = 0; k < 3; k++) bump(0.25 + Math.random() * 0.5, 0.008, 0.45 * v); }
    else bump(0.3 + Math.random() * 0.4, 0.02, 0.5 * v);
  });
  on('note', (n) => {
    if (!active()) return;
    bump(0.26 + (((n.midi % 12) + 12) % 12) / 11 * 0.48, 0.018, 0.55 * (n.vel ?? 0.6));
  });
  on('key', (k) => {
    if (!active()) return;
    for (const i of k.intervals ?? [0]) bump(0.26 + ((k.pc + i) % 12) / 11 * 0.48, 0.022, 0.9);
  });

  return {
    reset() { lastStep = null; },
    draw(ctx, geo, now) {
      const c = S.clock;
      const moving = c.transport === 'playing' || c.transport === 'count-in';
      const step = Math.floor(c.beat * 4);
      if (moving) {
        if (lastStep == null || step < lastStep || step - lastStep > 8) lastStep = step;
        while (lastStep < step) { lastStep++; pushLine(lastStep % 16 === 0); }
      } else {
        lastStep = null;
      }
      const frac = moving ? ((c.beat * 4) % 1 + 1) % 1 : 0;

      const r = geo.rect;
      const width = Math.min(r.width * 0.86, geo.R * 2.3);
      const bottom = r.top + r.height * 0.93;
      const spacing = (r.height * 0.78) / MAXL;
      const amp = spacing * 11;

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineJoin = 'round';
      // Back to front so nearer lines occlude the ones behind them.
      for (let k = lines.length - 1; k >= 0; k--) {
        const L = lines[k];
        const depth = k + frac;
        const sc = 1 - depth * 0.0065;
        const y0 = bottom - depth * spacing;
        const left = geo.cx - (width * sc) / 2;
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
          const x = left + (i / (N - 1)) * width * sc;
          const y = y0 - L.h[i] * amp * sc;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        // Dark fill under the line hides the lines behind it.
        ctx.lineTo(left + width * sc, y0 + spacing * 1.5);
        ctx.lineTo(left, y0 + spacing * 1.5);
        ctx.closePath();
        ctx.fillStyle = P.void;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < N; i++) {
          const x = left + (i / (N - 1)) * width * sc;
          const y = y0 - L.h[i] * amp * sc;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        const fade = Math.max(0.12, 1 - depth / MAXL);
        if (k === 0) {
          ctx.strokeStyle = P.lime;
          ctx.shadowColor = P.lime;
          ctx.shadowBlur = 14 + S.fx.kick * 20;
          ctx.lineWidth = 2.4;
        } else {
          ctx.strokeStyle = L.kick ? pa(P.lime, 0.85 * fade) : L.bar ? pa(P.mint, 0.9 * fade) : pa(P.ink, 0.8 * fade);
          ctx.shadowBlur = 0;
          ctx.lineWidth = L.bar ? 1.8 : 1.2;
        }
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}
