// The Orchid voices chords in inversions and Studio names the lowest note, so the
// pressed key must be inferred from the chord's shape. Cases are real presses from
// Studio's key monitor, with the key the robot's own check confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chordRoot, NOTE_NAMES, onKeyEvents, S, on } from '../public/state.js';

const read = (notes) => { const r = chordRoot(notes); return `${NOTE_NAMES[r.pc]} ${r.chord ?? ''}`.trim(); };

test('real inversions resolve to the key pressed', () => {
  assert.equal(read([48, 53, 57]), 'F Maj');   // C F A   (Studio said "C")
  assert.equal(read([48, 52, 57]), 'A Min');   // C E A   (Studio said "C")
  assert.equal(read([50, 55, 59]), 'G Maj');   // D G B   (Studio said "D")
  assert.equal(read([48, 52, 55]), 'C Maj');   // C E G   root position
});

test('other chord buttons', () => {
  assert.equal(read([50, 53, 59]), 'B Dim');   // D F B
  assert.equal(read([48, 53, 55]), 'C Sus');   // C F G
  assert.equal(read([48, 52, 55, 59]), 'C M7');
  assert.equal(read([45, 48, 52, 55]), 'A m7'); // A C E G (also reads as C6; m7 wins)
});

test('a key with no chord button is just that note', () => {
  assert.equal(read([57]), 'A');
  assert.equal(read([61]), 'C#');
});

test('press lights the root; release turns that same key off', () => {
  const keys = [];
  on('key', (k) => keys.push(k));
  onKeyEvents([{ type: 'press', t: 100.5, root: 48, name: 'C', notes: [48, 53, 57], intervals: [0, 5, 9], velocity: 40 }]);
  assert.equal(keys.at(-1).name, 'F');
  assert.equal(keys.at(-1).chord, 'Maj');
  const f = NOTE_NAMES.indexOf('F');
  assert.ok(S.keysDown.get(f) && !S.keysDown.get(f).released);
  assert.equal(S.keysDown.get(0), undefined, 'C is not lit as the pressed key');
  onKeyEvents([{ type: 'release', t: 101.2, press_t: 100.5, root: 48, name: 'C', held_s: 0.7 }]);
  assert.ok(S.keysDown.get(f).released, 'releasing turns off F');
});
