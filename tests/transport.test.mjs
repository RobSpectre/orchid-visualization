// The visualizer must mirror Studio's transport: advance only while Studio
// plays, hold position when paused, and never extrapolate from stale data.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { S, tick, setStudio, setBeatDoc, on, transportOf } from '../public/state.js';

// Fake wall clock shared by snapshots and the beat extrapolation.
let wall = 1_000_000;
Date.now = () => wall;

const drums = [];
on('drum', (h) => drums.push(h));

const doc = {
  id: 't', name: 'T', bars: 1, swing: 0,
  lanes: [{ id: 'kick', name: 'Kick', gain: 1 }],
  hits: [0, 1, 2, 3].map((beat) => ({ lane: 'kick', beat, velocity: 0.9, probability: 1 })),
};

function snapshot({ beat, paused = false, running = true, playing = true, receivedAt = wall, drumVolume = 0.3, playingRequested = true }) {
  return {
    receivedAt, playing,
    tempo: { bpm: 120, beat, running, paused },
    mixer: { drums: { volume: drumVolume } },
    drums: { running: true, playingRequested, position: beat, anchor: 0 },
    looper: { running: false, beat, position: beat, bars: 8, layers: [] },
  };
}

// Drive frames with a fake clock: performance-style `now` in ms.
let frameNow = 0;
// `poll` re-delivers a snapshot every 125 ms, like the server's Studio poller.
function frames(ms, poll = null, step = 16) {
  let sincePoll = 0;
  for (let t = 0; t < ms; t += step) {
    frameNow += step; wall += step; sincePoll += step;
    if (poll && sincePoll >= 125) { setStudio(poll()); sincePoll = 0; }
    tick(frameNow);
  }
}

beforeEach(() => {
  drums.length = 0;
  S.clock = { beat: 0, drumPos: null, loopPos: null, lastFrame: 0, bpm: 120, running: false, transport: 'offline' };
  setBeatDoc(doc);
});

test('transport states come from Studio fields', () => {
  const now = wall;
  setStudio(snapshot({ beat: 1 }));
  assert.equal(transportOf(S.studio, now), 'playing');
  setStudio(snapshot({ beat: 1, paused: true }));
  assert.equal(transportOf(S.studio, now), 'paused');
  setStudio(snapshot({ beat: 0, running: false, playing: false }));
  assert.equal(transportOf(S.studio, now), 'stopped');
  setStudio(snapshot({ beat: 1, receivedAt: now - 5000 }));
  assert.equal(transportOf(S.studio, now), 'stale');
  assert.equal(transportOf(null, now), 'offline');
});

test('paused: position holds exactly where Studio paused and nothing fires', () => {
  const paused = () => snapshot({ beat: 1.5, paused: true });
  setStudio(paused());
  frames(4000, paused);
  assert.equal(S.clock.transport, 'paused');
  assert.equal(S.clock.beat, 1.5);
  assert.equal(S.clock.drumPos, 1.5, 'drum playhead frozen at the paused position');
  assert.equal(drums.length, 0, 'no hits while paused');
  assert.ok(S.fx.playing < 0.01, 'visual energy settles when paused');
});

test('playing then paused: hits stop on the pause', () => {
  setStudio(snapshot({ beat: 0.1 }));
  frames(600); // ~1.2 beats at 120 bpm
  const fired = drums.length;
  assert.ok(fired >= 1, 'hits fire while playing');
  const pausedAt = S.clock.beat;
  const paused = () => snapshot({ beat: pausedAt, paused: true });
  setStudio(paused());
  frames(3000, paused);
  assert.equal(drums.length, fired, 'no further hits after pause');
  assert.equal(S.clock.beat, pausedAt);
});

test('resume continues from the paused position', () => {
  setStudio(snapshot({ beat: 2.2, paused: true }));
  frames(500);
  setStudio(snapshot({ beat: 2.2 }));
  frames(500); // one beat at 120 bpm, polled position goes stale-free since receivedAt advances with frames
  assert.ok(S.clock.beat > 2.9 && S.clock.beat < 3.4, `beat ${S.clock.beat}`);
  assert.deepEqual(drums.map((h) => h.beat), [3], 'only the hit after the resume point fires');
});

test('stale data freezes instead of extrapolating', () => {
  setStudio(snapshot({ beat: 1, receivedAt: wall - 4000 }));
  frames(2000);
  assert.equal(S.clock.transport, 'stale');
  assert.equal(S.clock.running, false);
  assert.equal(drums.length, 0, 'a dead connection must not keep playing');
  assert.ok(S.clock.beat < 1.01, `beat ${S.clock.beat}`);
});

test('stopped clears playheads', () => {
  setStudio(snapshot({ beat: 0, running: false, playing: false }));
  frames(500);
  assert.equal(S.clock.transport, 'stopped');
  assert.equal(S.clock.drumPos, null);
});

test('drums switched off or muted in the mixer do not animate', () => {
  setStudio(snapshot({ beat: 0.1, playingRequested: false }));
  frames(1500);
  assert.equal(drums.length, 0);
  assert.equal(S.clock.drumPos, null);
  S.clock.running = false;
  setStudio(snapshot({ beat: 0.1, drumVolume: 0 }));
  frames(1500);
  assert.equal(drums.length, 0, 'drums at zero volume make no hits');
});

test('a snapshot without a transport is treated as offline, not a crash', () => {
  setStudio({ receivedAt: wall, playing: false });
  assert.doesNotThrow(() => frames(200));
  assert.equal(S.clock.transport, 'offline');
});
