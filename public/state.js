import { P } from './theme.js';

// Client state, the beat clock, and the event bus that turns polled
// snapshots into per-hit visual events.

export const S = {
  demo: false,
  sources: {},
  studio: null,
  studioAt: 0,
  beat: null,            // processed drum document
  robot: null,
  hermes: { session: null, msgs: [], calls: [], stream: null, lastPost: null, lastPre: null },
  clock: { beat: 0, drumPos: null, loopPos: null, lastFrame: 0, bpm: 120, running: false, transport: 'offline' },
  fx: { kick: 0, snare: 0, hat: 0, perc: 0, noteHit: 0, note: 0, think: 0, playing: 0, motion: 0 },
  keysDown: new Map(),   // pitch class -> {at, vel, chord}
  chordLit: null,        // {name, at}
};

// ---- event bus
const handlers = {};
export const on = (type, fn) => (handlers[type] ??= []).push(fn);
export const fire = (type, payload) => (handlers[type] ?? []).forEach((fn) => fn(payload));

// ---- drum document

export function laneKind(lane) {
  const s = `${lane.id} ${lane.name ?? ''}`.toLowerCase();
  if (/kick|\bbd\b|bass ?drum|808/.test(s)) return 'kick';
  if (/snare|clap|\bsd\b|rim/.test(s)) return 'snare';
  if (/hat|\bhh\b|shaker|cym|ride|tamb|crash/.test(s)) return 'hat';
  return 'perc';
}

export function setBeatDoc(doc) {
  if (!doc) { S.beat = null; return; }
  const lanes = doc.lanes.map((l, i) => {
    const kind = laneKind(l);
    const lane = { ...l, idx: i, kind };
    // Read through the theme palette so a theme switch recolours lanes immediately.
    Object.defineProperty(lane, 'color', { get: () => P.lanes[kind], enumerable: true });
    return lane;
  });
  const byId = Object.fromEntries(lanes.map((l) => [l.id, l]));
  const length = doc.bars * 4;
  // Swing shifts odd 16ths, exactly as Studio's scheduler does.
  const hits = doc.hits.filter((h) => byId[h.lane]).map((h) => {
    let pos = h.beat;
    if (Math.floor(pos * 4 + 1e-8) % 2) pos += (doc.swing ?? 0) * 0.25;
    const lane = byId[h.lane];
    return {
      lane: lane.idx, kind: lane.kind, beat: h.beat, at: pos % length,
      step: Math.round(h.beat * 4), vel: Math.min(1, h.velocity * (lane.gain ?? 1)),
      prob: h.probability ?? 1, muted: lane.muted || lane.gain === 0,
    };
  }).sort((a, b) => a.at - b.at);
  S.beat = { id: doc.id, name: doc.name, genre: doc.genre, feel: doc.feel, kit: doc.kit, bars: doc.bars, length, swing: doc.swing ?? 0, lanes, hits };
  fire('beat-doc', S.beat);
}

// ---- studio snapshot
export function setStudio(s) {
  S.studio = s;
  S.studioAt = s.receivedAt ?? Date.now();
}

// A snapshot older than this means Studio (or the visualizer server) stopped
// answering: freeze instead of extrapolating a beat that may not be playing.
const STALE_MS = 1500;

// Studio's transport, derived only from what Studio reports:
//   offline · stale · stopped · paused · count-in · playing
export function transportOf(s, wallNow) {
  if (!s?.tempo) return 'offline'; // no snapshot, or one without a transport (Studio mid-restart)
  if (wallNow - S.studioAt > STALE_MS) return 'stale';
  const t = s.tempo;
  if (!t?.running) return 'stopped';
  if (t.paused) return 'paused';
  if (s.looper?.running && s.looper.beat < 0) return 'count-in';
  return 'playing';
}

// studioAt is a wall-clock (Date.now) receive time from the server.
function tempoBeatAt(wallNow) {
  const t = S.studio.tempo;
  return t.beat + ((wallNow - S.studioAt) * t.bpm) / 60000;
}

// Fires 'drum' and 'note' events for everything crossed between two positions.
function crossHits(prev, cur, length, list, fn) {
  if (prev == null || cur < prev || cur - prev > 1) return; // jump or wrap: skip, never double-fire
  const a = prev % length;
  const b = cur % length;
  const inWindow = b >= a ? (x) => x > a && x <= b : (x) => x > a || x <= b;
  for (const h of list) if (inWindow(h.at)) fn(h);
}

const volumeOf = (s, channel) => s.mixer?.[channel]?.volume ?? 1;

export function tick(now) {
  const c = S.clock;
  const s = S.studio;
  const wallNow = Date.now();
  const transport = transportOf(s, wallNow);
  const moving = transport === 'playing' || transport === 'count-in';
  const holding = transport === 'paused';
  const dt = c.lastFrame ? Math.min(100, now - c.lastFrame) : 0;
  c.lastFrame = now;
  c.transport = transport;
  if (s?.tempo?.bpm) c.bpm = s.tempo.bpm;

  if (moving) {
    const target = tempoBeatAt(wallNow);
    if (!c.running || Math.abs(target - c.beat) > 0.5) c.beat = target;
    // Advance at tempo and bleed toward the polled position to absorb jitter.
    else c.beat += (dt * c.bpm) / 60000 + (target - c.beat) * 0.08;
  } else if (transport === 'paused' || transport === 'stopped') {
    c.beat = s.tempo.beat ?? c.beat; // exactly where Studio says it is
  } // stale/offline: hold the last position, don't guess
  const wasRunning = c.running;
  c.running = moving;

  const prevBeat = c._prevBeat;
  c._prevBeat = c.beat;
  if (moving && wasRunning && prevBeat != null && Math.floor(c.beat) > Math.floor(prevBeat) && c.beat - prevBeat < 1) {
    const b = Math.floor(c.beat);
    fire('beat-tick', b);
    if (b % 4 === 0) fire('bar', b / 4);
  }
  // Positions advance only while moving; paused shows Studio's exact position.
  const delta = moving ? c.beat - s.tempo.beat : 0;

  // Drums: Studio's sequencer position relative to the beat's anchor.
  const d = s?.drums;
  const prevDrum = c.drumPos;
  if (transport === 'stale') {
    // keep the last drawn position frozen
  } else if ((moving || holding) && d?.running && d.playingRequested && S.beat) {
    c.drumPos = Math.max(0, d.position - (d.anchor ?? 0) + delta);
    if (moving && volumeOf(s, 'drums') > 0) {
      crossHits(prevDrum, c.drumPos, S.beat.length, S.beat.hits, (h) => {
        if (h.muted || Math.random() > h.prob) return;
        fire('drum', h);
      });
    }
  } else {
    c.drumPos = null;
  }

  // Loops: replay layer notes against the loop position.
  const l = s?.looper;
  const prevLoop = c.loopPos;
  if (transport === 'stale') {
    // frozen
  } else if ((moving || holding) && l?.running && l.beat >= 0 && l.bars) {
    const len = l.bars * 4;
    c.loopPos = Math.max(0, l.beat + delta);
    c.loopLen = len;
    if (moving) {
      for (const layer of l.layers) {
        if (layer.muted || !layer.notes.length || volumeOf(s, `layer-${layer.slot}`) <= 0) continue;
        if (!layer._hits) layer._hits = layer.notes.map(([beat, dur, note, vel]) => ({ at: beat % len, dur, note, vel }));
        crossHits(prevLoop, c.loopPos, len, layer._hits, (h) => fire('note', { midi: h.note, vel: h.vel / 127, dur: h.dur, layer: layer.slot, source: 'loop' }));
      }
    }
  } else {
    c.loopPos = null;
  }

  // Decay the visual envelopes.
  const k = Math.exp(-dt / 140);
  const fx = S.fx;
  fx.kick *= k; fx.snare *= Math.exp(-dt / 180); fx.hat *= Math.exp(-dt / 70); fx.perc *= k;
  fx.noteHit *= Math.exp(-dt / 400);
  fx.think *= Math.exp(-dt / 1500);
  fx.playing += ((moving ? 1 : 0) - fx.playing) * Math.min(1, dt / 350);
  // Ambient motion runs on its own clock: full speed while playing, a slow
  // drift when paused or stopped, so a paused Studio reads as paused.
  fx.motion = (fx.motion ?? 0) + (dt / 1000) * (0.08 + 0.92 * fx.playing);
}

on('drum', (h) => { S.fx[h.kind] = Math.max(S.fx[h.kind], 0.35 + 0.65 * h.vel); });
on('note', (n) => { S.fx.note = (n.midi % 12) / 12; S.fx.noteHit = Math.max(S.fx.noteHit, 0.4 + 0.6 * (n.vel ?? 0.7)); });

// ---- which key was pressed
// With a chord button held, the Orchid sends the whole chord, voiced in an inversion,
// and Studio's key monitor names the *lowest* note (F major arrives as C F A, "C").
// The key pressed is the chord's root, so find the note the others form a chord type
// above. Order = preference when a set of notes reads more than one way.
const CHORD_TYPES = [
  ['Maj', [0, 4, 7]], ['Min', [0, 3, 7]], ['Dim', [0, 3, 6]], ['Sus', [0, 5, 7]],
  ['M7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['6', [0, 4, 7, 9]], ['9', [0, 2, 4, 7, 10]], ['Sus', [0, 2, 7]],
];
const pc12 = (n) => ((n % 12) + 12) % 12;
export function chordRoot(notes) {
  const pcs = [...new Set((notes ?? []).map(pc12))];
  const lowest = notes?.length ? pc12(Math.min(...notes)) : null;
  if (pcs.length < 3) return { pc: lowest, chord: null, intervals: [0], tones: pcs };
  for (const [chord, iv] of CHORD_TYPES) {
    const want = iv.join(',');
    for (const r of pcs) {
      if (pcs.map((p) => (p - r + 12) % 12).sort((a, b) => a - b).join(',') === want) return { pc: r, chord, intervals: iv, tones: pcs };
    }
  }
  return { pc: lowest, chord: null, intervals: pcs.map((p) => (p - lowest + 12) % 12), tones: pcs };
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const pressRoots = new Map(); // press time -> root pc, so releases light off the right key
export function onKeyEvents(events) {
  for (const e of events) {
    if (e.type === 'press') {
      const notes = e.notes?.length ? e.notes : [e.root];
      const r = chordRoot(notes);
      const pc = r.pc ?? NOTE_NAMES.indexOf(e.name);
      const vel = (e.velocity ?? 64) / 127;
      pressRoots.set(e.t, pc);
      if (pressRoots.size > 64) pressRoots.delete(pressRoots.keys().next().value);
      S.keysDown.set(pc, { at: performance.now(), vel, chord: r.chord, notes, tones: r.tones });
      if (r.chord) S.chordLit = { name: r.chord, at: performance.now() };
      fire('key', { pc, name: NOTE_NAMES[pc], vel, chord: r.chord, intervals: r.intervals, notes });
      for (const n of notes) fire('note', { midi: n, vel, source: 'key' });
    } else if (e.type === 'release') {
      const pc = pressRoots.get(e.press_t) ?? NOTE_NAMES.indexOf(e.name);
      const k = S.keysDown.get(pc);
      if (k) k.released = performance.now();
    } else if (e.type === 'voicing') {
      fire('voicing', e);
    }
  }
}
