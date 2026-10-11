// Context window figures computed the way Hermes' own status bar does, so the
// display matches it (hermes_cli/cli_status_bar_mixin.py, agent/usage_anchor.py):
//
//   used   = the current turn's FIRST response (prompt + completion tokens, as the
//            provider reported them) + a rough bytes/4 estimate of only the messages
//            appended since. Later requests in a tool loop are not used: on
//            reasoning models they replay the turn's thinking and run high.
//   window = the context length Hermes' compressor uses (from the stream hook, or
//            from Hermes' compression telemetry in agent.log), not models.dev.
//
// Fed from agent.log lines (turn starts, API calls, compression telemetry) and
// the stream hook; the delta messages come from state.db.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STALE_THINKING = ['reasoning', 'reasoning_content'];

// Hermes' estimate_tokens_rough over str(message shadow): ceil(UTF-8 bytes / 4).
// JSON stands in for Python's dict repr (about the same length).
export function roughTokens(rows) {
  let newest = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === 'assistant') { newest = i; break; }
  let total = 0;
  rows.forEach((r, i) => {
    const shadow = { role: r.role, content: r.content ?? '' };
    if (r.tool_calls) { try { shadow.tool_calls = JSON.parse(r.tool_calls); } catch { shadow.tool_calls = r.tool_calls; } }
    if (r.tool_call_id) shadow.tool_call_id = r.tool_call_id;
    // Stale thinking is not charged: only the newest assistant message keeps its reasoning.
    if (i === newest) for (const k of STALE_THINKING) if (r[k]) shadow[k] = r[k];
    total += Math.ceil(Buffer.byteLength(JSON.stringify(shadow), 'utf8') / 4);
  });
  return total;
}

export function createContextTracker({ file } = {}) {
  const turns = new Map(); // session -> { at, base: { in, out } | null }
  const background = new Set(); // sessions whose latest turn is a background review (separate agent)
  let limits = {}; // model -> { n, source, at }
  let lastMainSession = null;
  if (file) { try { limits = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ } }

  const save = () => {
    if (!file) return;
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(limits, null, 1)); } catch { /* read-only is fine */ }
  };
  const setLimit = (model, n, source) => {
    if (!model || !(n > 0)) return;
    if (limits[model]?.n === n && limits[model]?.source === source) return;
    limits[model] = { n, source, at: Date.now() };
    save();
  };

  return {
    // One parsed agent.log record (see hermes.mjs parseLine), in log order.
    track(p) {
      if (p.type === 'turn-start') {
        if (p.background) { background.add(p.session); return; }
        background.delete(p.session);
        turns.set(p.session, { at: p.ts, base: null });
        lastMainSession = p.session;
      } else if (p.type === 'call') {
        if (background.has(p.session)) return; // the review agent's calls are not the main agent's context
        const t = turns.get(p.session);
        if (t && !t.base && p.in != null) t.base = { in: p.in, out: p.out ?? 0 };
      } else if (p.type === 'compression') {
        if (p.limit) setLimit(p.model, p.limit, 'hermes log');
        // A committed compaction rewrites the transcript: the next response is the new anchor.
        const t = p.committed && turns.get(lastMainSession);
        if (t) { t.base = null; t.at = p.ts; }
      }
    },
    // The stream hook reports Hermes' compressor context_length on every request.
    noteLimit(model, n) { setLimit(model, n, 'hermes'); },
    limit(model) { return limits[model]?.n ?? null; },
    // fetchSince(session, sinceMs) → messages (role, content, tool_calls, tool_call_id, reasoning…) in order.
    used(session, fetchSince) {
      const t = turns.get(session);
      if (!t?.base) return null;
      const rows = fetchSince(session, t.at);
      const reply = rows.findIndex((r) => r.role === 'assistant'); // the anchored response itself
      const delta = reply >= 0 ? rows.slice(reply + 1) : [];
      return t.base.in + t.base.out + roughTokens(delta);
    },
  };
}
