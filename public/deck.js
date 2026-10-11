// Bottom deck: drum machine grid, loop-layer sequencer, Orchid keyboard and
// chord bank. The SO101 arms are drawn by robotview.js.

import { S, on, NOTE_NAMES } from './state.js';
import { P, a as pa } from './theme.js';

// Colours come from the live theme palette.
const C = P;
const CHORD_BUTTONS = ['Dim', 'Min', 'Maj', 'Sus', '6', 'm7', 'M7', '9'];
const FONT = (px, w = 400) => `${w} ${px * P.fontScale}px ${P.font}`;

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return [ctx, w, h];
}

// Truncate to a pixel width with an ellipsis.
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

// ---------------------------------------------------------------- drums
export function createDrums(canvas, metaEl) {
  const flash = new Map();
  on('drum', (h) => flash.set(`${h.lane}:${h.step}`, performance.now()));

  return function draw(now) {
    const [ctx, w, h] = fit(canvas);
    const b = S.beat;
    if (!b) {
      ctx.fillStyle = C.dim; ctx.font = FONT(11);
      ctx.fillText('no beat loaded', 4, 16);
      metaEl.textContent = '';
      return;
    }
    const pos = S.clock.drumPos;
    const playing = pos != null;
    const bar = playing ? Math.floor(pos / 4) % b.bars : 0;
    const stepNow = playing ? (pos % 4) * 4 : -1;
    metaEl.textContent = `${b.name} · bar ${String(bar + 1).padStart(2, '0')}/${b.bars} · swing ${Math.round(b.swing * 100)}%`;

    const overviewH = 18;
    const labelW = Math.min(150, Math.max(96, w * 0.24));
    const gridH = h - overviewH - 8;
    const rows = b.lanes.length;
    const rowH = gridH / rows;
    const colW = (w - labelW) / 16;
    const lo = bar * 4;

    // Step beat-group shading + playhead column
    for (let s = 0; s < 16; s++) {
      const x = labelW + s * colW;
      if (Math.floor(s / 4) % 2 === 0) { ctx.fillStyle = pa(P.ink, 0.025); ctx.fillRect(x, 0, colW, gridH); }
      if (playing && Math.floor(stepNow) === s) {
        const g = ctx.createLinearGradient(0, 0, 0, gridH);
        g.addColorStop(0, pa(P.lime, 0.25)); g.addColorStop(1, pa(P.lime, 0.05));
        ctx.fillStyle = g; ctx.fillRect(x, 0, colW, gridH);
      }
    }

    const index = new Map();
    for (const hit of b.hits) if (hit.beat >= lo && hit.beat < lo + 4) index.set(`${hit.lane}:${hit.step - lo * 4}`, hit);

    for (const lane of b.lanes) {
      const y = lane.idx * rowH;
      ctx.fillStyle = lane.muted ? C.faint : lane.color;
      ctx.globalAlpha = lane.muted ? 1 : 0.8;
      ctx.font = FONT(Math.min(10.5, rowH * 0.48), 600);
      ctx.textBaseline = 'middle';
      ctx.fillText(fitText(ctx, lane.name || lane.id, labelW - 8), 0, y + rowH / 2);
      ctx.globalAlpha = 1;
      for (let s = 0; s < 16; s++) {
        const x = labelW + s * colW;
        const pad = Math.max(1.5, Math.min(colW, rowH) * 0.14);
        const hit = index.get(`${lane.idx}:${s}`);
        roundRect(ctx, x + pad, y + pad, colW - pad * 2, rowH - pad * 2, 2);
        if (!hit) {
          ctx.strokeStyle = C.faint; ctx.stroke();
          continue;
        }
        const f = flash.get(`${lane.idx}:${hit.step}`);
        const fl = f ? Math.max(0, 1 - (now - f) / 350) : 0;
        ctx.fillStyle = lane.color;
        ctx.globalAlpha = (lane.muted ? 0.15 : 0.3 + hit.vel * 0.55) + fl * 0.5;
        ctx.shadowColor = lane.color;
        ctx.shadowBlur = fl * 18;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        if (hit.vel >= 0.75) { ctx.strokeStyle = C.lime; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
      }
    }

    // Arrangement overview: one mini heat-strip per bar
    const oy = h - overviewH;
    const bw = (w - labelW) / b.bars;
    ctx.fillStyle = C.dim; ctx.font = FONT(9); ctx.textBaseline = 'middle';
    ctx.fillText('ARRANGE', 0, oy + overviewH / 2);
    const density = new Array(b.bars).fill(0);
    for (const hit of b.hits) density[Math.floor(hit.beat / 4) % b.bars] += hit.vel;
    const maxD = Math.max(...density, 1);
    for (let i = 0; i < b.bars; i++) {
      const x = labelW + i * bw + 1;
      const d = density[i] / maxD;
      ctx.fillStyle = i === bar && playing ? C.lime : pa(P.violet, 0.2 + d * 0.6);
      ctx.fillRect(x, oy + overviewH * (1 - d) * 0.6, bw - 2, overviewH - overviewH * (1 - d) * 0.6);
    }
    if (playing) {
      const x = labelW + ((pos % b.length) / b.length) * (w - labelW);
      ctx.fillStyle = '#fff'; ctx.fillRect(x, oy - 2, 1.5, overviewH + 2);
    }
  };
}

// ---------------------------------------------------------------- loops
export function createLoops(canvas, metaEl) {
  const flash = new Map();
  on('note', (n) => { if (n.source === 'loop') flash.set(n.layer, performance.now()); });

  return function draw(now) {
    const [ctx, w, h] = fit(canvas);
    const l = S.studio?.looper;
    const voices = S.studio?.instruments?.voices ?? [];
    const selected = S.studio?.instruments?.selected;
    if (!l) { metaEl.textContent = 'studio offline'; return; }
    const perf = S.studio.performance;
    metaEl.textContent = `${l.phase}${l.beatsUntilRecord != null ? ` · rec in ${Math.ceil(l.beatsUntilRecord)}` : ''} · ${l.bars} bars${perf ? ` · perform ${perf.settings?.mode}` : ''}`;
    const len = (l.bars || 8) * 4;
    const labelW = Math.min(150, Math.max(104, w * 0.27));
    const rows = Math.max(4, l.layers.length);
    const rowH = h / rows;
    const pos = S.clock.loopPos;

    l.layers.forEach((layer, i) => {
      const y = i * rowH;
      const color = P.layers[i % P.layers.length];
      const recording = l.recordSlot === layer.slot && (l.phase === 'recording' || l.phase === 'count-in' || l.phase === 'armed');
      const f = flash.get(layer.slot);
      const fl = f ? Math.max(0, 1 - (now - f) / 300) : 0;

      ctx.fillStyle = recording ? pa(P.hot, 0.12) : pa(P.ink, 0.025);
      ctx.fillRect(labelW, y + 2, w - labelW, rowH - 4);
      if (recording) { ctx.strokeStyle = C.hot; ctx.strokeRect(labelW + 0.5, y + 2.5, w - labelW - 1, rowH - 5); }

      ctx.textBaseline = 'top';
      ctx.font = FONT(10, 800);
      ctx.fillStyle = layer.muted ? C.dim : color;
      ctx.globalAlpha = 0.6 + fl * 0.4;
      ctx.fillText(`L${layer.slot}${layer.muted ? ' ∅' : ''}${recording ? ' ●REC' : ''}`, 0, y + 3);
      ctx.globalAlpha = 1;
      const v = voices[i];
      if (v) {
        ctx.font = FONT(10, 400);
        ctx.fillStyle = selected === v.slot ? C.lavender : C.dim;
        ctx.fillText(fitText(ctx, `${selected === v.slot ? '◉ ' : ''}${v.name}`, labelW - 8), 0, y + 16);
      }

      // Bar lines
      for (let bIdx = 1; bIdx < len / 4; bIdx++) {
        const x = labelW + (bIdx * 4 / len) * (w - labelW);
        ctx.fillStyle = pa(P.ink, 0.06); ctx.fillRect(x, y + 2, 1, rowH - 4);
      }

      if (!layer.notes.length) {
        ctx.fillStyle = pa(P.ink, 0.18); ctx.font = FONT(9);
        ctx.textBaseline = 'middle';
        ctx.fillText('· · · empty · · ·', labelW + 8, y + rowH / 2);
        return;
      }
      let lo = 127, hi = 0;
      for (const [, , note] of layer.notes) { lo = Math.min(lo, note); hi = Math.max(hi, note); }
      const span = Math.max(12, hi - lo + 1);
      for (const [beat, dur, note, vel] of layer.notes) {
        const x = labelW + ((beat % len) / len) * (w - labelW);
        const nw = Math.max(2, (dur / len) * (w - labelW));
        const ny = y + 4 + (1 - (note - lo + 0.5) / span) * (rowH - 10);
        const active = pos != null && (pos % len) >= (beat % len) && (pos % len) < (beat % len) + dur;
        ctx.fillStyle = color;
        ctx.globalAlpha = layer.muted ? 0.15 : active ? 1 : 0.25 + (vel / 127) * 0.45;
        ctx.shadowColor = color; ctx.shadowBlur = active ? 12 : 0;
        ctx.fillRect(x, ny - 1.5, nw, 3);
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    });

    if (pos != null) {
      const x = labelW + ((pos % len) / len) * (w - labelW);
      ctx.fillStyle = C.lime; ctx.shadowColor = C.lime; ctx.shadowBlur = 10;
      ctx.fillRect(x, 0, 1.5, h);
      ctx.shadowBlur = 0;
    }
  };
}

// ---------------------------------------------------------------- keys
export function createKeys(canvas, metaEl) {
  let lastVoicing = null;
  let lastKey = null;
  on('voicing', (e) => { lastVoicing = { value: e.value, at: performance.now() }; });
  on('key', (k) => { lastKey = k; });

  const WHITE = [0, 2, 4, 5, 7, 9, 11];
  const BLACK = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 }; // pc -> white index it sits after

  return function draw(now) {
    const [ctx, w, h] = fit(canvas);
    const km = S.studio?.keyMonitor;
    const robotB = S.robot?.arms?.find((a) => a.arm === 'b');
    const robotA = S.robot?.arms?.find((a) => a.arm === 'a');
    metaEl.textContent = lastKey
      ? `${lastKey.name}${lastKey.chord ? ` ${lastKey.chord}` : ''} · vel ${Math.round(lastKey.vel * 127)} · ${km?.presses ?? 0} presses`
      : km ? `key monitor ${km.status} · ${km.presses ?? 0} presses` : 'key monitor offline';

    const chordH = Math.min(26, h * 0.2);
    const kbH = h - chordH - 10;
    const ww = w / 7;

    const fade = (k) => (!k ? 0 : !k.released ? 1 : Math.max(0, 1 - (now - k.released) / 500));
    const lit = (pc) => fade(S.keysDown.get(pc)); // the key pressed (chord root)
    // The chord's other notes glow faintly, so the key and the chord both read.
    const tone = (pc) => {
      let v = 0;
      for (const [root, k] of S.keysDown) if (root !== pc && k.tones?.includes(pc)) v = Math.max(v, fade(k) * 0.35);
      return v;
    };
    const robotKey = robotA?.selected && NOTE_NAMES.includes(robotA.selected) ? NOTE_NAMES.indexOf(robotA.selected) : null;
    const robotActive = robotA?.playing;

    WHITE.forEach((pc, i) => {
      const x = i * ww;
      const v = lit(pc), tv = tone(pc);
      roundRect(ctx, x + 1.5, 0, ww - 3, kbH, 3);
      ctx.fillStyle = v ? pa(P.lime, 0.25 + v * 0.75) : tv ? pa(P.mint, 0.1 + tv) : pa(P.ink, 0.10);
      ctx.shadowColor = C.lime; ctx.shadowBlur = v * 22;
      ctx.fill(); ctx.shadowBlur = 0;
      if (pc === robotKey) { ctx.strokeStyle = C.hot; ctx.lineWidth = robotActive ? 2.5 : 1.2; ctx.stroke(); ctx.lineWidth = 1; }
      ctx.fillStyle = v > 0.5 ? P.bg : C.dim;
      ctx.font = FONT(10, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(NOTE_NAMES[pc], x + ww / 2, kbH - 4);
    });
    for (const [pcStr, after] of Object.entries(BLACK)) {
      const pc = Number(pcStr);
      const bw = ww * 0.6;
      const x = (after + 1) * ww - bw / 2;
      const v = lit(pc), tv = tone(pc);
      roundRect(ctx, x, 0, bw, kbH * 0.6, 3);
      ctx.fillStyle = v ? pa(P.mint, 0.4 + v * 0.6) : tv ? pa(P.mint, 0.15 + tv) : P.keyDark;
      ctx.shadowColor = C.mint; ctx.shadowBlur = v * 22;
      ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = pc === robotKey ? C.hot : pa(P.ink, 0.18);
      ctx.lineWidth = pc === robotKey && robotActive ? 2.5 : 1;
      ctx.stroke(); ctx.lineWidth = 1;
    }

    // Chord bank
    const cy = kbH + 8;
    const cw = w / CHORD_BUTTONS.length;
    const chordAge = S.chordLit ? (now - S.chordLit.at) / 900 : 9;
    const robotChord = robotB?.chordHeld || (robotB?.playing && robotB?.selected?.startsWith('chord.') ? robotB.selected : null);
    CHORD_BUTTONS.forEach((name, i) => {
      const on = S.chordLit?.name === name && chordAge < 1 ? 1 - chordAge : 0;
      const robotOn = robotChord && robotChord.toLowerCase() === `chord.${name.toLowerCase()}`;
      roundRect(ctx, i * cw + 2, cy, cw - 4, chordH, 2);
      ctx.fillStyle = on ? pa(P.lime, 0.2 + on * 0.8) : pa(P.deep, 0.8);
      ctx.fill();
      ctx.strokeStyle = robotOn ? C.hot : pa(P.lime, 0.25);
      ctx.lineWidth = robotOn ? 2 : 1; ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = on > 0.4 ? P.bg : C.lavender;
      ctx.font = FONT(10, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(name, i * cw + cw / 2, cy + chordH / 2 + 1);
    });
    ctx.textAlign = 'left';

    // Voicing dial pip
    if (lastVoicing && now - lastVoicing.at < 2000) {
      const a = (lastVoicing.value / 127) * Math.PI * 1.5 - Math.PI * 1.25;
      const r = 10, x = w - 14, y = 14;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.strokeStyle = C.mint; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.stroke();
    }
  };
}
