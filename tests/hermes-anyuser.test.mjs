// The stats must follow whatever Hermes is running, for any user: even when its
// session isn't in a state.db this server can read (another macOS user, no
// write access), from agent.log and from the stream hook, without counting a
// call twice when both report it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHermes } from '../server/hermes.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (d) => {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`;
};

test('a session Hermes could not save is followed from agent.log and the hook', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hermes-'));
  mkdirSync(join(home, 'logs'));
  const S = 'demo_session_1';
  const t = Date.now() - 20_000;
  const line = (ms, rest) => `${stamp(new Date(t + ms))} INFO [${S}] ${rest}`;
  writeFileSync(join(home, 'logs', 'agent.log'), [
    line(0, `agent.turn_context: conversation turn: session=${S} model=zai-org/GLM-5.3-Flash provider=nebius-token-factory platform=cli history=0 msg='jam'`),
    line(2000, 'agent.conversation_loop: API call #1: model=zai-org/GLM-5.3-Flash provider=nebius-token-factory in=20000 out=100 total=20100 latency=2.0s cache=0/20000 (0%)'),
    line(5000, 'agent.conversation_loop: API call #2: model=zai-org/GLM-5.3-Flash provider=nebius-token-factory in=21000 out=200 total=21200 latency=2.0s cache=20000/21000 (95%)'),
  ].join('\n') + '\n');
  // No state.db at all: this server can't read Hermes' database.

  const events = [];
  const h = startHermes({ home, contextFile: join(home, 'ctx.json'), emit: (type, data) => events.push({ type, data }), log: () => {} });
  try {
    await wait(1200);
    const sessions = events.filter((e) => e.type === 'hermes-session').map((e) => e.data);
    const s = sessions.at(-1);
    assert.ok(s, 'a session is emitted without state.db');
    assert.equal(s.id, S);
    assert.equal(s.model, 'zai-org/GLM-5.3-Flash');
    assert.equal(s.apiCalls, 2);
    assert.equal(s.notSaved, true);
    assert.equal(s.tokensSession.total, 20100 + 21200);
    assert.equal(s.contextUsed, 20100, 'context from the turn\'s first response');

    // The hook reports call #2 again (already in the log) and a new call #3.
    const before = events.filter((e) => e.type === 'hermes-calls').flatMap((e) => e.data.calls).length;
    const now = Date.now() / 1000;
    h.noteHookBatch([
      { type: 'post_api', session_id: S, api_call_count: 2, model: 'zai-org/GLM-5.3-Flash', ended_at: t / 1000 + 5, api_duration: 2, usage: { input_tokens: 1000, cache_read_tokens: 20000, output_tokens: 200 } },
      { type: 'post_api', session_id: S, api_call_count: 3, model: 'zai-org/GLM-5.3-Flash', ended_at: now, api_duration: 4, usage: { input_tokens: 500, cache_read_tokens: 21200, output_tokens: 400 } },
    ]);
    const added = events.filter((e) => e.type === 'hermes-calls').flatMap((e) => e.data.calls).slice(before);
    assert.deepEqual(added.map((c) => c.n), [3], 'the duplicate is dropped, the new call kept');
    assert.equal(added[0].in, 21700, 'prompt = uncached input + cache reads');
    assert.equal(added[0].tps, 100);
    await wait(700);
    assert.equal(events.filter((e) => e.type === 'hermes-session').at(-1).data.apiCalls, 3);
  } finally {
    h.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugin messages build the trace, and Hermes' own stats override ours", async () => {
  const home = mkdtempSync(join(tmpdir(), 'hermes-'));
  mkdirSync(join(home, 'logs'));
  writeFileSync(join(home, 'logs', 'agent.log'), '');
  const events = [];
  const h = startHermes({ home, contextFile: join(home, 'ctx.json'), emit: (type, data) => events.push({ type, data }), log: () => {} });
  try {
    const S = 'demo_session_2';
    const t = Date.now() / 1000;
    h.noteHookBatch([
      { type: 'hello', user: 'demo', home: '/Users/demo/.hermes', plugin: '0.2.0' },
      { type: 'message', session_id: S, platform: 'cli', role: 'user', content: 'play a beat', t },
      { type: 'message', session_id: S, platform: 'cli', role: 'assistant', reasoning: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', content: '', tool_calls: [{ name: 'terminal', args: '{"command":"orchid jam"}' }], finish_reason: 'tool_calls', t: t + 1 },
      { type: 'message', session_id: S, platform: 'cli', role: 'assistant', content: 'saved a memory', background: true, t: t + 2 },
      { type: 'message', session_id: S, platform: 'cli', role: 'tool', tool_name: 'terminal', content: '{"ok":true}', t: t + 3 },
      { type: 'stats', session_id: S, model: 'zai-org/GLM-5.3-Flash', provider: 'nebius-token-factory', platform: 'cli', context_used: 12345, context_length: 200000, context_percent: 6, session_api_calls: 4, session_total_tokens: 50000, session_input_tokens: 9000, session_cache_read_tokens: 40000, session_output_tokens: 1000, avg_latency: 2.5, avg_velocity: 120, samples: 4 },
    ]);
    const msgs = events.filter((e) => e.type === 'hermes-msgs').flatMap((e) => e.data.messages);
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool'], 'review-agent messages are left out');
    assert.ok(!msgs[1].reasoning.includes('sk-ant-api03'), 'reasoning is redacted');
    assert.equal(msgs[1].tools[0].name, 'terminal');
    assert.deepEqual(h.hookClients().map((c) => c.user), ['demo']);
    await wait(700);
    const s = events.filter((e) => e.type === 'hermes-session').at(-1)?.data;
    assert.equal(s?.id, S, 'a session known only from the plugin is followed');
    assert.equal(s.contextUsed, 12345);
    assert.equal(s.contextWindow, 200000);
    assert.equal(s.apiCalls, 4);
    assert.equal(s.tokensSession.total, 50000);
    assert.equal(s.hermes.velocity, 120);
    assert.equal(s.hermes.latency, 2.5);
  } finally {
    h.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
