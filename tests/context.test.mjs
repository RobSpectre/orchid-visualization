// Context remaining must match Hermes' status bar: turn-base anchor + appended
// estimate for "used", Hermes' own context length for the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextTracker, roughTokens } from '../server/context.mjs';

const T0 = Date.parse('2026-10-11T00:53:10');

test('used = first response of the turn + estimate of messages appended after it', () => {
  const ctx = createContextTracker();
  ctx.track({ type: 'turn-start', session: 's', ts: T0 });
  ctx.track({ type: 'call', session: 's', in: 381372, out: 109 });
  ctx.track({ type: 'call', session: 's', in: 381600, out: 308 }); // later calls don't move the anchor
  const tool = { role: 'tool', content: 'x'.repeat(400), tool_call_id: 'c1' };
  const rows = [
    { role: 'user', content: 'stop playing' },
    { role: 'assistant', content: '', tool_calls: '[{"id":"c1"}]' }, // the anchored reply: already priced
    tool,
  ];
  assert.equal(ctx.used('s', () => rows), 381372 + 109 + roughTokens([tool]));
});

test("a background review turn's calls don't replace the main agent's anchor", () => {
  const ctx = createContextTracker();
  ctx.track({ type: 'turn-start', session: 's', ts: T0 });
  ctx.track({ type: 'call', session: 's', in: 1000, out: 10 });
  ctx.track({ type: 'turn-start', session: 's', ts: T0 + 60000, background: true });
  ctx.track({ type: 'call', session: 's', in: 9999, out: 99 });
  assert.equal(ctx.used('s', () => []), 1010);
});

test('no anchor yet → null (caller falls back to the persisted anchor)', () => {
  const ctx = createContextTracker();
  ctx.track({ type: 'turn-start', session: 's', ts: T0 });
  assert.equal(ctx.used('s', () => []), null);
});

test("window: Hermes' context length from the hook beats the one in its compression telemetry", () => {
  const ctx = createContextTracker();
  ctx.track({ type: 'compression', model: 'm', limit: 1000000, committed: false });
  assert.equal(ctx.limit('m'), 1000000);
  ctx.noteLimit('m', 1048576);
  assert.equal(ctx.limit('m'), 1048576);
  assert.equal(ctx.limit('other'), null);
});

test('a committed compaction resets the anchor to the next response', () => {
  const ctx = createContextTracker();
  ctx.track({ type: 'turn-start', session: 's', ts: T0 });
  ctx.track({ type: 'call', session: 's', in: 500000, out: 10 });
  ctx.track({ type: 'compression', committed: true, ts: T0 + 1000 });
  assert.equal(ctx.used('s', () => []), null);
  ctx.track({ type: 'call', session: 's', in: 60000, out: 20 });
  assert.equal(ctx.used('s', () => []), 60020);
});

test('rough estimate charges reasoning only on the newest assistant message', () => {
  const old = { role: 'assistant', content: 'a', reasoning: 'r'.repeat(4000) };
  const newest = { role: 'assistant', content: 'b', reasoning: 'r'.repeat(400) };
  const withOld = roughTokens([old, newest]);
  const withoutOld = roughTokens([{ role: 'assistant', content: 'a' }, newest]);
  assert.equal(withOld, withoutOld);
  assert.ok(roughTokens([newest]) > 100);
});
