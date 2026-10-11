// Demo mode: synthesizes Studio, robot and Hermes data in the same shapes the
// server sends, so the visuals can run when nothing is playing. Uses the real
// beat document when Studio has one loaded.

const BPM = 124;
const PROGRESSION = [ // root pitch class, chord name, intervals
  [9, 'Min', [0, 3, 7]], [5, 'Maj', [0, 4, 7]], [0, 'Maj', [0, 4, 7]], [7, 'Sus', [0, 5, 7]],
];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Taught waypoints from the rig ([hover, hover, press] × [pan, lift, elbow, wrist,
// roll], in the SO101 model's degrees: vendor/taught-presses.json converted as
// build-rig.mjs does), so the demo arms press the keys on the 3D Orchid.
const POSES = {
  C: [[1.6,49,-66.9,93.6,-138.1], [1.6,49,-66.9,93.6,-138.1], [1,63.4,-76.9,97.6,-140.1]],
  D: [[-1.5,44.8,-60.4,97.6,-141.7], [-1.5,44.8,-60.4,97.6,-141.7], [-1.3,54.8,-60.5,91.6,-141]],
  E: [[-4.7,41.1,-53.3,97.6,-144.8], [-4.7,41.1,-53.3,97.6,-144.8], [-5.7,57.8,-64,98,-144.1]],
  F: [[-9.4,39.7,-54.6,97,-142.9], [-9.4,39.7,-54.6,97,-142.9], [-9.2,54.3,-56.4,92.3,-144.1]],
  G: [[-12.5,31.6,-41.2,97.6,-148.3], [-12.5,31.6,-41.2,97.6,-148.3], [-12.5,43.3,-39.6,92.5,-148.4]],
  A: [[-17.1,33.4,-39.7,93.5,-149.2], [-17.1,33.4,-39.7,93.5,-149.2], [-17.1,50.1,-48.8,97.6,-149.2]],
  B: [[-21.2,19.6,-19.6,85.4,-153.8], [-21.2,19.6,-19.6,85.4,-153.8], [-21.2,32.2,-21,81.7,-153.8]],
  'A#': [[-17.2,13.8,-12.7,90.4,-149.4], [-17.2,13.8,-12.7,90.4,-149.4], [-17.2,16.1,-0.9,77.9,-149.3]],
  'G#': [[-9.1,8.2,-4.1,85,-145.3], [-9.1,8.2,-4.1,85,-145.3], [-11.3,10.6,6,72.1,-147.4]],
  'F#': [[-4.7,10.3,-14.6,90,-139.6], [-4.7,10.3,-14.6,90,-139.6], [-4.6,7,10.2,67,-139.7]],
  'D#': [[0.4,23.4,-30.4,90.9,-135.8], [0.4,23.4,-30.4,90.9,-135.8], [0.4,43.1,-42,93.3,-135.8]],
  'C#': [[5.2,35.9,-46.1,96.9,-128.9], [5.2,35.9,-46.1,96.9,-128.9], [5.2,37.9,-34.8,86.7,-129]],
  'chord.dim': [[9.4,-10.1,17.4,84.9,6.7], [9.4,-10.1,17.4,84.9,6.7], [11.1,-7.1,22.6,77.1,8.2]],
  'chord.min': [[3.3,-10.3,17.9,82.4,-2], [3.3,-10.3,17.9,82.4,-2], [3.6,-3.3,20.3,76.9,-1.7]],
  'chord.maj': [[-2.3,-4.9,9.4,86.2,-4.8], [-2.3,-4.9,9.4,86.2,-4.8], [-2,-5.2,20,73.4,-4.8]],
  'chord.sus': [[-7.3,-1.9,6.8,83.9,-13.4], [-7.3,-1.9,6.8,83.9,-13.4], [-6.7,3.3,10.4,77,-10.8]],
};
const THOUGHTS = [
  'Kick is locked at 124 and the hats are breathing on the off-16ths. Hold the chord arm on Min through the A section; the bass layer already outlines the root.',
  'Bar 8 turnaround coming. If I press F Maj on the downbeat the arpeggio on layer 2 resolves cleanly — queue it for the keys arm one beat early to absorb travel time.',
  'Context is healthy and the cache hit rate is high, so I can keep the full session plan in view instead of summarizing. Next: open the filter on layer 3 for the lift.',
  'The voicing dial moved up an octave. Layer 1 bass and the live voice now overlap around C3 — nudge the live voice up to keep the low end clean.',
  'Snare density doubles in the fill bars. Let the robot rest on home during the fill so the motion does not fight the groove, then hit C M7 on the drop.',
  'Glass House wants space. Mute layer 4, keep the shaker, and let the pad sustain into the next phrase.',
];
const CHAT = [
  ['Bring the drums in', 'Drums are in — *Glass House* at 124, hats breathing on the off-16ths.'],
  ['Make it more dreamy', 'Opened the filter on layer 3 and switched Perform to *harp*. Pad now sustains across the phrase.'],
  ['Play a four chord progression in the key of F', 'Playing *F – C – Dm – B♭* on the chord arm; keys arm doubles the roots. Key monitor confirms each press ✓'],
  ['Stop', 'Stopped. Studio is quiet and both arms are parked at rest.'],
];
const TOOLS = [
  ['terminal', 'python3 scripts/orchid_jam.py chord --root A --type min'],
  ['terminal', 'python3 scripts/orchid_jam.py layer 3 --mute off'],
  ['terminal', 'python3 scripts/orchid_jam.py key F --arm a'],
  ['terminal', "orchid-studio request '{\"command\":\"perform-update\",\"settings\":{\"mode\":\"harp\"}}'"],
];

function generatedBeat() {
  const hits = [];
  for (let bar = 0; bar < 8; bar++) {
    for (let s = 0; s < 16; s++) {
      const beat = bar * 4 + s / 4;
      if (s % 4 === 0) hits.push({ lane: 'kick', beat, velocity: 0.9, probability: 1 });
      if (s === 4 || s === 12) hits.push({ lane: 'snare', beat, velocity: 0.8, probability: 1 });
      if (s % 2 === 1) hits.push({ lane: 'hat', beat, velocity: s % 4 === 2 ? 0.8 : 0.45, probability: 1 });
      if (s % 4 === 2) hits.push({ lane: 'hat', beat, velocity: 0.78, probability: 1 });
      if (bar % 2 && (s === 3 || s === 11 || s === 14)) hits.push({ lane: 'perc', beat, velocity: 0.6, probability: 1 });
      hits.push({ lane: 'shaker', beat, velocity: 0.2 + 0.2 * (s % 2), probability: 1 });
    }
  }
  return {
    kind: 'orchid-beat', id: 'demo-pulse', name: 'Demo Pulse', bars: 8, suggested_bpm: BPM, genre: 'demo', kit: 'synthetic', feel: 'four on the floor', swing: 0.06,
    lanes: [
      { id: 'kick', name: 'Kick', gain: 1 }, { id: 'snare', name: 'Snare', gain: 1 }, { id: 'hat', name: 'Hat', gain: 1 },
      { id: 'shaker', name: 'Shaker', gain: 1 }, { id: 'perc', name: 'Perc', gain: 1 },
    ],
    hits,
  };
}

function loopLayers() {
  const bass = [], arp = [], pad = [];
  for (let bar = 0; bar < 8; bar++) {
    const [root, , iv] = PROGRESSION[Math.floor(bar / 2) % 4];
    const base = 45 + root;
    for (let b = 0; b < 4; b++) bass.push([bar * 4 + b + 0.5, 0.4, base - 12 + (b === 3 ? 7 : 0), 100]);
    for (let s = 0; s < 8; s++) arp.push([bar * 4 + s * 0.5, 0.35, base + 12 + iv[s % iv.length] + (s >= 4 ? 12 : 0), 70 + (s % 2) * 25]);
    if (bar % 2 === 0) iv.forEach((i) => pad.push([bar * 4, 7.5, base + i, 60]));
  }
  return [
    { slot: 1, name: 'Layer 1', muted: false, mode: 'bass', notes: bass },
    { slot: 2, name: 'Layer 2', muted: false, mode: 'arp', notes: arp },
    { slot: 3, name: 'Layer 3', muted: false, mode: 'pad', notes: pad },
    { slot: 4, name: 'Layer 4', muted: false, mode: null, notes: [] },
  ];
}

export function createDemo(sink, getRealBeat) {
  let timers = [];
  let t0 = 0;
  let keyId = 0, msgId = 1e9, callN = 0, presses = 0;
  let ctxUsed = 182000;
  const beatAt = () => ((performance.now() - t0) * BPM) / 60000;

  function studio() {
    const beat = beatAt();
    const doc = getRealBeat() ?? generatedBeat();
    const layers = loopLayers();
    return {
      receivedAt: Date.now(), playing: true,
      connection: { connected: true, state: 'connected' },
      tempo: { bpm: BPM, target_bpm: BPM, beat, running: true, paused: false },
      instruments: {
        labels: ['Sound 045', 'Sound 052', 'Sound 023', 'Sound 025', 'Sound 040', 'Sound 015'],
        voices: [['Layer 1', 45, 'Basement'], ['Layer 2', 52, 'Slow Strings'], ['Layer 3', 23, 'FM Harp One'], ['Layer 4', 25, 'Space Harpsi'], ['Live', 40, 'SNES'], ['Play Along', 15, 'Opening Credits']]
          .map(([voice, number, name], i) => ({ voice, slot: i + 1, label: `Sound ${String(number).padStart(3, '0')}`, number, name })),
        selected: 2,
      },
      keyMonitor: { status: 'ready', presses },
      performance: { settings: { mode: 'harp', bpm: BPM } },
      looper: { running: true, phase: 'playing', beat, position: beat % 32, bars: 8, layers },
      drums: { playingRequested: true, beat: doc.id, running: true, position: beat, anchor: 0, activeBeat: doc.id },
      _doc: doc,
    };
  }

  function robot() {
    const beat = beatAt();
    const step = Math.floor(beat / 2);
    const phase = (beat % 2) / 2;
    const [root, chord] = PROGRESSION[Math.floor(beat / 8) % 4];
    const keyPc = (root + [0, 7, 4, 12][step % 4]) % 12;
    // Each stroke replays the arms' real taught waypoints: glide to the target's
    // hover pose, press at progress 0.5 (when the visualizer fires its press),
    // lift back to hover and wait.
    const chordPhase = (beat % 8) / 8;
    const control = `chord.${chord.toLowerCase()}`;
    const joints = (prev, target, p) => {
      const hp = POSES[prev]?.[1] ?? POSES[target][0], hv = POSES[target][1], pr = POSES[target][2];
      const ease = (x) => x * x * (3 - 2 * x);
      const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * ease(Math.max(0, Math.min(1, t))));
      const pose = p < 0.3 ? mix(hp, hv, p / 0.3) : p < 0.5 ? mix(hv, pr, (p - 0.3) / 0.2) : p < 0.7 ? mix(pr, hv, (p - 0.5) / 0.2) : hv;
      const down = p > 0.3 && p < 0.7 ? 1 : 0;
      return ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'].map((name, i) => ({
        name, temp: 38 + down * 6, deg: i < 5 ? pose[i] : -8, // gripper: nearly closed
      }));
    };
    const prevKey = NAMES[(root + [0, 7, 4, 12][(step + 3) % 4]) % 12];
    const prevChord = `chord.${PROGRESSION[(Math.floor(beat / 8) + 3) % 4][1].toLowerCase()}`;
    return {
      receivedAt: Date.now(), port: 'demo',
      arms: [
        { arm: 'a', phase: 'teach_play', mode: 'simulation', connected: true, selected: NAMES[keyPc], playing: true, teachMode: 'playing', progress: phase, joints: joints(prevKey, NAMES[keyPc], phase) },
        { arm: 'b', phase: 'teach_play', mode: 'simulation', connected: true, selected: control, chordHeld: control, playing: true, teachMode: 'playing', progress: chordPhase, joints: joints(prevChord, control, chordPhase) },
      ],
    };
  }

  function keyPress() {
    const beat = beatAt();
    const [root, , iv] = PROGRESSION[Math.floor(beat / 8) % 4];
    const now = performance.now() / 1000;
    presses++;
    const press = { type: 'press', t: now, root: 48 + root, name: NAMES[root], octave: 3, notes: iv.map((i) => 48 + root + i), intervals: iv, velocity: 60 + Math.round(Math.random() * 40), id: ++keyId, beat };
    sink.keys([press]);
    setTimeout(() => sink.keys([{ type: 'release', t: now + 0.8, name: NAMES[root], root: 48 + root, id: ++keyId }]), 900);
  }

  function chatExchange() {
    const [ask, reply] = CHAT[Math.floor(callN / 3) % CHAT.length];
    sink.hermesChat({ backfill: false, messages: [{ id: ++msgId, session: 'demo-wa', source: 'whatsapp', role: 'user', ts: Date.now(), content: ask, reasoning: '', tools: [] }] });
    setTimeout(() => sink.hermesChat({ backfill: false, messages: [{ id: ++msgId, session: 'demo-wa', source: 'whatsapp', role: 'assistant', ts: Date.now(), content: reply, reasoning: '', tools: [], finish: 'stop' }] }), 2600);
  }

  function hermesTurn() {
    callN++;
    if (callN % 3 === 1) chatExchange();
    const out = 60 + Math.round(Math.random() * 700);
    const latency = 0.45 + out / (150 + Math.random() * 90) + Math.random() * 0.3;
    ctxUsed += 600 + Math.round(Math.random() * 2400);
    const call = { type: 'call', ts: Date.now(), session: 'demo', n: callN, model: 'deepseek-ai/DeepSeek-V4.1-Flash', provider: 'nebius-token-factory', in: ctxUsed, out, total: ctxUsed + out, latency, cacheHit: Math.round(ctxUsed * (0.9 + Math.random() * 0.1)), cacheOf: ctxUsed, tps: out / latency };
    sink.hermesCalls({ backfill: false, calls: [call] });
    const thought = THOUGHTS[callN % THOUGHTS.length];
    const [tool, cmd] = TOOLS[callN % TOOLS.length];
    sink.hermesMsgs({ backfill: false, messages: [{ id: ++msgId, session: 'demo', role: 'assistant', ts: Date.now(), content: '', reasoning: thought, tools: [{ name: tool, args: JSON.stringify({ command: cmd }) }], finish: 'tool_calls' }] });
    setTimeout(() => sink.hermesMsgs({ backfill: false, messages: [{ id: ++msgId, session: 'demo', role: 'tool', toolName: tool, ts: Date.now(), content: "{'status': 'ok', 'playing': True}", tools: [] }] }), 900);
    sink.hermesSession({
      id: 'demo', source: 'demo', title: 'Demo jam', model: 'deepseek-ai/DeepSeek-V4.1-Flash', provider: 'nebius-token-factory',
      providerName: 'Nebius Token Factory', reasoningEffort: 'high', inputTokens: ctxUsed * callN / 2, outputTokens: callN * 400,
      reasoningTokens: callN * 230, cacheReadTokens: ctxUsed * callN / 2.2, apiCalls: callN, toolCalls: callN, contextUsed: ctxUsed, contextWindow: 1048000,
      costUsd: callN * 0.0012, turnActive: true,
      tokensSession: { total: ctxUsed * callN, fresh: ctxUsed * callN * 0.04, cached: ctxUsed * callN * 0.95, output: callN * 400 },
      tokens30d: { total: 145_800_000 + ctxUsed * callN, fresh: 6_100_000, cached: 139_000_000, output: 700_000, sessions: 18, calls: 820 + callN },
    });
  }

  return {
    start() {
      t0 = performance.now();
      const first = studio();
      sink.beat(first._doc);
      sink.hermesMsgs({ backfill: true, messages: [] });
      sink.hermesCalls({ backfill: true, calls: [] });
      sink.hermesChat({ backfill: true, messages: [] });
      timers = [
        setInterval(() => { const s = studio(); delete s._doc; sink.studio(s); }, 125),
        setInterval(() => sink.robot(robot()), 250),
        setInterval(keyPress, (60000 / BPM) * 4),
        setInterval(hermesTurn, 3800),
      ];
      hermesTurn();
    },
    stop() {
      timers.forEach(clearInterval);
      timers = [];
    },
  };
}
