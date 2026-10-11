// Read-only view of Hermes Agent: reasoning traces and tool calls from
// state.db (SQLite, WAL), per-request latency/tokens from agent.log, and the
// model's context window from the models.dev cache. Nothing here writes to
// ~/.hermes.

import { DatabaseSync } from 'node:sqlite';
import { open, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContextTracker } from './context.mjs';
import { redact } from './redact.mjs';

const DB_MS = 400;
const LOG_MS = 300;
const TEXT_LIMIT = 4000;
const TOOL_OUTPUT_LIMIT = 600;
// Messaging platforms whose conversation gets its own pinned chat view.
const CHAT_SOURCES = ['whatsapp', 'telegram', 'signal', 'slack', 'discord', 'sms', 'imessage'];
const CHAT_SQL = `s.source IN (${CHAT_SOURCES.map((x) => `'${x}'`).join(',')})
  AND (m.role = 'user' OR (m.role = 'assistant' AND m.finish_reason = 'stop' AND COALESCE(m.content, '') != ''))`;
const isChat = (r) => CHAT_SOURCES.includes(r.source)
  && (r.role === 'user' || (r.role === 'assistant' && r.finish_reason === 'stop' && r.content));

// Hermes' provider ids vs models.dev provider keys.
const PROVIDER_ALIASES = { 'nebius-token-factory': 'nebius' };

const API_CALL = /^(\S+ \S+) INFO \[(\S+)\] agent\.conversation_loop: API call #(\d+): model=(\S+) provider=(\S+) in=(\S+) out=(\S+) total=(\S+) latency=([\d.]+)s(?: cache=(\d+)\/(\d+))?/;
const TURN_START = /^(\S+ \S+) INFO \[(\S+)\] agent\.turn_context: conversation turn: .*?platform=(\S+)/;
const COMPRESSION = /^(\S+ \S+) INFO (?:\[\S+\] )?agent\.conversation_compression: context compression attempt telemetry: (\{.*\})\s*$/;
const TURN_END = /^(\S+ \S+) INFO \[(\S+)\] agent\.conversation_loop: Turn ended: reason=(\S+)/;
const TOOL_DONE = /^(\S+ \S+) INFO \[(\S+)\] agent\.tool_executor: tool (\S+) completed \(([\d.]+)s/;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
const logTime = (s) => new Date(s.replace(' ', 'T').replace(',', '.')).getTime();
// Redact before clipping so a secret cut at the boundary can't slip past the patterns.
const clip = (s, n) => {
  const r = redact(s);
  return r && r.length > n ? `${r.slice(0, n)}…` : r;
};
const num = (s) => (s === '?' || s == null ? null : Number(s));

export function startHermes({ home = join(homedir(), '.hermes'), emit, log, contextFile = fileURLToPath(new URL('../data/hermes-context.json', import.meta.url)) }) {
  const dbPath = join(home, 'state.db');
  const logPath = join(home, 'logs', 'agent.log');
  let db = null;
  let online = null;
  let lastId = null;
  let sessionKey = null;
  let models = null;
  let logOffset = null;
  const calls = [];
  // Per-session totals from agent.log, for sessions Hermes couldn't save to state.db (e.g. a CLI run
  // by another macOS user that can't write the database: "session will NOT be indexed").
  const logSessions = new Map();
  function ledger(p) {
    if (!p.session) return;
    let e = logSessions.get(p.session);
    if (!e) logSessions.set(p.session, (e = { firstAt: p.ts, lastAt: p.ts, calls: 0, in: 0, out: 0, cached: 0, tools: 0 }));
    e.lastAt = Math.max(e.lastAt, p.ts);
    if (p.type === 'turn-start' && !p.background) Object.assign(e, { platform: p.platform, model: p.model ?? e.model, provider: p.provider ?? e.provider });
    if (p.type === 'call') {
      e.calls++; e.in += p.in ?? 0; e.out += p.out ?? 0; e.cached += p.cacheHit ?? 0; e.lastIn = p.in ?? 0; e.lastOut = p.out ?? 0;
      e.model = p.model; e.provider = p.provider;
    }
    if (p.type === 'tool') e.tools++;
    if (p.type === 'stats') Object.assign(e, { model: p.model ?? e.model, provider: p.provider ?? e.provider, platform: p.platform ?? e.platform });
  }
  // Plugin data per session / per connected Hermes (hermes-plugin/orchid_viz).
  const hookStats = new Map(); // session -> Hermes' own status-bar numbers + receivedAt
  const hookClients = new Map(); // "user@home" -> { user, home, plugin, at }
  let hookSeq = 0;
  const dbHas = new Map(); // session -> { v, at }: is this session in state.db?
  function inDb(session) {
    const c = dbHas.get(session);
    if (c && Date.now() - c.at < 5000) return c.v;
    let v = false;
    try { v = !!openDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(session); } catch { /* unreadable: not here */ }
    dbHas.set(session, { v, at: Date.now() });
    if (dbHas.size > 200) dbHas.delete(dbHas.keys().next().value);
    return v;
  }

  // One API call can arrive twice: as an agent.log line and from the stream hook. Keep the first.
  const seenCalls = new Map(); // "session#n" -> ts
  function claim(c) {
    const k = `${c.session}#${c.n}`;
    const t = seenCalls.get(k);
    if (t != null && Math.abs(t - c.ts) < 30_000) return false; // (call numbers restart in review agents)
    seenCalls.set(k, c.ts);
    if (seenCalls.size > 5000) seenCalls.delete(seenCalls.keys().next().value);
    return true;
  }
  function trimCalls() {
    // Keep the last 2 hours (for the activity graph) and at least the last 60 calls.
    const cutoff = Date.now() - 2 * 3600_000;
    while (calls.length > 60 && calls[0].ts < cutoff) calls.shift();
    if (calls.length > 2000) calls.splice(0, calls.length - 2000);
  }
  const ctx = createContextTracker({ file: contextFile });

  function setOnline(value, error) {
    if (online === value) return;
    online = value;
    emit('source', { name: 'hermes', online: value, error: error ? String(error.message || error) : null });
  }

  async function loadModels() {
    try {
      models = JSON.parse(await readFile(join(home, 'models_dev_cache.json'), 'utf8'));
    } catch (err) {
      log?.(`hermes models cache: ${err.message}`);
      models = {};
    }
  }

  function modelInfo(provider, model) {
    if (!models || !model) return null;
    const key = PROVIDER_ALIASES[provider] ?? provider;
    let entry = models[key]?.models?.[model];
    let providerName = models[key]?.name ?? provider;
    if (!entry) {
      for (const p of Object.values(models)) {
        if (p?.models?.[model]) { entry = p.models[model]; providerName = p.name; break; }
      }
    }
    if (!entry) return null;
    return {
      providerName,
      context: entry.limit?.context ?? null,
      output: entry.limit?.output ?? null,
      cost: entry.cost ?? null,
      reasoning: !!entry.reasoning,
      name: entry.name ?? model,
    };
  }

  function openDb() {
    if (db) return db;
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db;
  }

  function messageRow(r) {
    let tools = [];
    if (r.tool_calls) {
      try {
        tools = JSON.parse(r.tool_calls).map((c) => ({
          name: c.function?.name ?? c.type,
          args: clip(c.function?.arguments ?? '', 400),
        }));
      } catch { /* malformed tool_calls JSON: show none */ }
    }
    return {
      id: r.id,
      session: r.session_id,
      source: r.source ?? null,
      role: r.role,
      ts: r.timestamp * 1000,
      content: clip(r.content ?? '', r.role === 'tool' ? TOOL_OUTPUT_LIMIT : TEXT_LIMIT),
      reasoning: clip(r.reasoning ?? r.reasoning_content ?? '', TEXT_LIMIT),
      tools,
      toolName: r.tool_name,
      finish: r.finish_reason,
    };
  }

  // Last 30 days across every session and task (main loop plus background work
  // like reviews and titles). Re-queried every 15 s; it's an aggregate, not a stream.
  let usageCache = null, usageAt = 0;
  function usage30d(d) {
    if (usageCache && Date.now() - usageAt < 15_000) return usageCache;
    const since = Date.now() / 1000 - 30 * 86400;
    try {
      const r = d.prepare(`SELECT COUNT(DISTINCT session_id) AS sessions, SUM(api_call_count) AS calls,
          SUM(input_tokens) AS fresh, SUM(cache_read_tokens) + SUM(cache_write_tokens) AS cached, SUM(output_tokens) AS output
          FROM session_model_usage WHERE last_seen >= ?`).get(since);
      usageCache = { total: (r.fresh ?? 0) + (r.cached ?? 0) + (r.output ?? 0), fresh: r.fresh ?? 0, cached: r.cached ?? 0, output: r.output ?? 0, sessions: r.sessions ?? 0, calls: r.calls ?? 0 };
    } catch {
      // Older schema without per-model usage: fall back to session totals.
      const r = d.prepare(`SELECT COUNT(*) AS sessions, SUM(api_call_count) AS calls, SUM(input_tokens) AS fresh,
          SUM(cache_read_tokens) + SUM(cache_write_tokens) AS cached, SUM(output_tokens) AS output
          FROM sessions WHERE COALESCE(last_activity_at, started_at) >= ?`).get(since);
      usageCache = { total: (r.fresh ?? 0) + (r.cached ?? 0) + (r.output ?? 0), fresh: r.fresh ?? 0, cached: r.cached ?? 0, output: r.output ?? 0, sessions: r.sessions ?? 0, calls: r.calls ?? 0 };
    }
    usageAt = Date.now();
    return usageCache;
  }

  // Live CLI sessions from Hermes' runtime registry (pid still running), newest first.
  let cliCache = null, cliAt = 0;
  function liveCliSession() {
    if (Date.now() - cliAt < 2000) return cliCache;
    cliAt = Date.now();
    cliCache = null;
    try {
      const reg = JSON.parse(readFileSync(join(home, 'runtime', 'active_sessions.json'), 'utf8'));
      const alive = (reg.entries ?? []).filter((e) => e.surface === 'cli' && e.session_id && pidAlive(e.pid))
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
      cliCache = alive[0]?.session_id ?? null;
    } catch { /* no registry: fall back to newest activity */ }
    return cliCache;
  }

  // A session Hermes is running but couldn't write to state.db, shaped like a sessions row from agent.log.
  function logOnlySession(id) {
    const e = logSessions.get(id);
    if (!e?.model) return null;
    return {
      id, source: e.platform ?? 'cli', title: null, model: e.model, billing_provider: e.provider, model_config: '{}',
      started_at: e.firstAt / 1000, input_tokens: e.in - e.cached, output_tokens: e.out, cache_read_tokens: e.cached,
      cache_write_tokens: 0, reasoning_tokens: null, api_call_count: e.calls, message_count: null, tool_call_count: e.tools,
      logOnly: true,
    };
  }

  function emitSession(d) {
    // "Current" session = the one Hermes is working in, as its status bar shows.
    // The registry alone isn't enough: /new (or a model switch) inside a running CLI starts a
    // new session but can leave the old entry. So take the most recently active of: the
    // registered CLI session, the session with the newest message, the newest-started
    // session and the session of the newest API call. Background (bg_) sessions don't count.
    const lastCall = calls[calls.length - 1];
    const candidates = [...new Set([
      liveCliSession(),
      d?.prepare('SELECT session_id FROM messages ORDER BY id DESC LIMIT 1').get()?.session_id,
      d?.prepare('SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1').get()?.id,
      lastCall?.session,
      [...hookStats.values()].sort((a, b) => b.receivedAt - a.receivedAt)[0]?.session_id, // a Hermes with the plugin
    ])].filter((id) => id && !id.startsWith('bg_'));
    const activity = (id) => {
      const row = d?.prepare('SELECT started_at, (SELECT MAX(timestamp) FROM messages WHERE session_id = ?) AS last FROM sessions WHERE id = ?').get(id, id);
      if (!row) return logSessions.get(id)?.lastAt ?? -1; // not in state.db: known only from agent.log / the hook
      let t = Math.max(row.started_at ?? 0, row.last ?? 0) * 1000;
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i].session === id) { t = Math.max(t, calls[i].ts); break; }
      return t;
    };
    const best = candidates.map((id) => [id, activity(id)]).filter(([, t]) => t >= 0).sort((a, b) => b[1] - a[1])[0];
    const cur = best ? { session_id: best[0] } : null;
    if (!cur) return;
    const s = d?.prepare(`SELECT id, source, title, model, billing_provider, model_config, started_at,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, api_call_count, message_count, tool_call_count
        FROM sessions WHERE id = ?`).get(cur.session_id) ?? logOnlySession(cur.session_id);
    let lease = null;
    try {
      lease = d?.prepare('SELECT acquired_at, expires_at FROM session_turn_leases WHERE conversation_id = ? LIMIT 1').get(cur.session_id) ?? null;
    } catch { /* older schema without leases */ }
    if (!s) return;

    let config = {};
    try { config = JSON.parse(s.model_config || '{}'); } catch { /* keep {} */ }
    const usage30 = d ? usage30d(d) : null;
    const info = modelInfo(s.billing_provider, s.model);
    // As Hermes' status bar: turn-base anchor + estimate of what was appended since; else the
    // persisted last-response anchor. Window: Hermes' own context length when known.
    const anchor = config._usage_anchor;
    const contextWindow = ctx.limit(s.model) ?? info?.context ?? null;
    let contextUsed = ctx.used(s.id, (session, sinceMs) => !d ? [] : d.prepare(`SELECT role, content, tool_calls, tool_call_id, reasoning, reasoning_content
        FROM messages WHERE session_id = ? AND active = 1 AND role != 'session_meta' AND timestamp >= ? ORDER BY id`).all(session, sinceMs / 1000 - 1))
      ?? (anchor?.prompt_tokens ? anchor.prompt_tokens + (anchor.completion_tokens ?? 0) : null)
      ?? (logSessions.get(s.id)?.lastIn != null ? logSessions.get(s.id).lastIn + logSessions.get(s.id).lastOut : null);
    if (contextUsed != null && contextWindow) contextUsed = Math.min(contextUsed, contextWindow);
    const cost = info?.cost
      ? ((s.input_tokens - (s.cache_read_tokens ?? 0)) * (info.cost.input ?? 0)
        + (s.cache_read_tokens ?? 0) * (info.cost.cache_read ?? info.cost.input ?? 0)
        + s.output_tokens * (info.cost.output ?? 0)) / 1e6
      : null;
    const session = {
      id: s.id,
      source: s.source,
      title: redact(s.title),
      model: s.model,
      provider: s.billing_provider,
      providerName: info?.providerName ?? s.billing_provider,
      reasoningEffort: config.reasoning_config?.effort ?? null,
      startedAt: s.started_at ? s.started_at * 1000 : null,
      inputTokens: s.input_tokens,
      outputTokens: s.output_tokens,
      cacheReadTokens: s.cache_read_tokens,
      reasoningTokens: s.reasoning_tokens,
      apiCalls: s.api_call_count,
      messages: s.message_count,
      toolCalls: s.tool_call_count,
      contextUsed,
      contextWindow,
      // Same definition as Hermes' session_total_tokens: prompt (fresh + cached) + completion.
      tokensSession: {
        total: (s.input_tokens ?? 0) + (s.cache_read_tokens ?? 0) + (s.cache_write_tokens ?? 0) + (s.output_tokens ?? 0),
        fresh: s.input_tokens ?? 0, cached: (s.cache_read_tokens ?? 0) + (s.cache_write_tokens ?? 0), output: s.output_tokens ?? 0,
      },
      tokens30d: usage30,
      costUsd: cost,
      turnActive: !!lease,
      // Not in state.db (Hermes couldn't save it, or this server can't read that database):
      // stats come from agent.log and the stream hook; its messages only through the hook.
      notSaved: !!s.logOnly,
    };
    // Hermes' own status-bar numbers from the plugin (exact, any user) win over our reconstruction.
    const hs = hookStats.get(session.id);
    if (hs && Date.now() - hs.receivedAt < 15 * 60_000) {
      if (hs.context_used != null) session.contextUsed = hs.context_used;
      if (hs.context_length) session.contextWindow = hs.context_length;
      if (hs.session_api_calls != null) session.apiCalls = hs.session_api_calls;
      if (hs.session_total_tokens) {
        session.tokensSession = {
          total: hs.session_total_tokens, fresh: hs.session_input_tokens ?? 0,
          cached: (hs.session_cache_read_tokens ?? 0) + (hs.session_cache_write_tokens ?? 0), output: hs.session_output_tokens ?? 0,
        };
      }
      session.model = hs.model ?? session.model;
      session.hermes = {
        velocity: hs.avg_velocity ?? null, latency: hs.avg_latency ?? null, samples: hs.samples ?? null,
        cacheHitPct: hs.cache_hit_pct ?? null, compressions: hs.compressions ?? null, contextPercent: hs.context_percent ?? null,
        at: hs.receivedAt,
      };
    }
    const key = JSON.stringify(session);
    if (key !== sessionKey) {
      sessionKey = key;
      emit('hermes-session', session);
    }
  }

  function pollDb() {
    try {
      const d = openDb();
      if (lastId === null) {
        // Backfill the tail of the conversation so the trace panel isn't empty.
        const rows = d.prepare(`SELECT * FROM (
            SELECT m.id, m.session_id, m.role, m.content, m.reasoning, m.reasoning_content, m.tool_calls, m.tool_name, m.timestamp, m.finish_reason, s.source
            FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
            WHERE m.active = 1 AND m.role != 'session_meta' ORDER BY m.id DESC LIMIT 40
          ) ORDER BY id`).all();
        lastId = rows.length ? rows[rows.length - 1].id : 0;
        emit('hermes-msgs', { backfill: true, messages: rows.map(messageRow) });
        // The chat history is fetched separately so busy CLI sessions can't push it out.
        const chat = d.prepare(`SELECT * FROM (
            SELECT m.id, m.session_id, m.role, m.content, m.reasoning, m.reasoning_content, m.tool_calls, m.tool_name, m.timestamp, m.finish_reason, s.source
            FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.active = 1 AND m.id <= ? AND ${CHAT_SQL} ORDER BY m.id DESC LIMIT 20
          ) ORDER BY id`).all(lastId);
        emit('hermes-chat', { backfill: true, messages: chat.map(messageRow) });
      } else {
        const rows = d.prepare(`SELECT m.id, m.session_id, m.role, m.content, m.reasoning, m.reasoning_content, m.tool_calls, m.tool_name, m.timestamp, m.finish_reason, s.source
            FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
            WHERE m.id > ? AND m.active = 1 AND m.role != 'session_meta' ORDER BY m.id LIMIT 200`).all(lastId);
        if (rows.length) {
          lastId = rows[rows.length - 1].id;
          emit('hermes-msgs', { backfill: false, messages: rows.map(messageRow) });
          const chat = rows.filter(isChat);
          if (chat.length) emit('hermes-chat', { backfill: false, messages: chat.map(messageRow) });
        }
      }

      setOnline(true);
      emitSession(d);
    } catch (err) {
      try { db?.close(); } catch { /* already closed */ }
      db = null;
      setOnline(false, err);
      // Still follow the session from agent.log and the stream hook (e.g. the visualizer's
      // user can't read this Hermes home's database).
      try { emitSession(null); } catch { /* nothing to show yet */ }
    }
  }

  function parseLine(line) {
    let m = API_CALL.exec(line);
    if (m) {
      const latency = Number(m[9]);
      const out = num(m[7]);
      return {
        type: 'call',
        ts: logTime(m[1]), session: m[2], n: Number(m[3]), model: m[4], provider: m[5],
        in: num(m[6]), out, total: num(m[8]), latency,
        cacheHit: num(m[10]), cacheOf: num(m[11]),
        tps: out != null && latency > 0 ? out / latency : null,
      };
    }
    if ((m = TURN_START.exec(line))) {
      const mp = /\bmodel=(\S+) provider=(\S+)/.exec(line);
      return { type: 'turn-start', ts: logTime(m[1]), session: m[2], platform: m[3], model: mp?.[1], provider: mp?.[2], background: /\borigin=background_review\b/.test(line) };
    }
    if ((m = COMPRESSION.exec(line))) {
      try {
        const d = JSON.parse(m[2]);
        return { type: 'compression', ts: logTime(m[1]), model: d.main_model ?? null, limit: d.main_context_limit ?? null, committed: d.commit_status === 'committed' };
      } catch { return null; }
    }
    if ((m = TURN_END.exec(line))) return { type: 'turn-end', ts: logTime(m[1]), session: m[2], reason: m[3] };
    if ((m = TOOL_DONE.exec(line))) return { type: 'tool', ts: logTime(m[1]), session: m[2], tool: m[3], seconds: Number(m[4]) };
    return null;
  }

  let partial = '';
  async function pollLog() {
    let fh;
    try {
      const st = await stat(logPath);
      let backfill = false;
      if (logOffset === null) {
        logOffset = Math.max(0, st.size - 4 * 1024 * 1024); // enough for 2 h of calls
        backfill = true;
      } else if (st.size < logOffset) {
        logOffset = 0; // rotated or truncated
        partial = '';
      }
      if (st.size === logOffset) return;
      fh = await open(logPath, 'r');
      const len = Math.min(st.size - logOffset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, logOffset);
      logOffset += len;
      const text = partial + buf.toString('utf8');
      const lines = text.split('\n');
      partial = lines.pop();
      if (backfill) partial = '';
      const parsed = lines.map(parseLine).filter(Boolean);
      const newCalls = [];
      for (const p of parsed) {
        if (p.type === 'call') { if (!claim(p)) continue; newCalls.push(p); }
        ctx.track(p);
        ledger(p);
      }
      calls.push(...newCalls);
      calls.sort((a, b) => a.ts - b.ts);
      trimCalls();
      if (backfill) {
        emit('hermes-calls', { backfill: true, calls: [...calls] });
      } else {
        if (newCalls.length) emit('hermes-calls', { backfill: false, calls: newCalls });
        const turns = parsed.filter((p) => p.type !== 'call' && p.type !== 'compression');
        if (turns.length) emit('hermes-log', turns);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log?.(`hermes log: ${err.message}`);
    } finally {
      await fh?.close();
    }
  }

  loadModels();
  const modelsTimer = setInterval(loadModels, 10 * 60 * 1000);
  const dbTimer = setInterval(pollDb, DB_MS);
  let logBusy = false;
  const logTimer = setInterval(async () => {
    if (logBusy) return;
    logBusy = true;
    try { await pollLog(); } finally { logBusy = false; }
  }, LOG_MS);
  pollLog();

  return {
    // Stream-hook batches (hermes-plugin/orchid_viz): every API call of any Hermes that has the
    // plugin, whichever macOS user runs it and whether or not its files are readable here.
    hookClients() { return [...hookClients.values()]; },
    noteHookBatch(batch) {
      const fresh = [];
      for (const e of batch) {
        if (!e?.session_id && e?.type !== 'hello') continue;
        if (e.type === 'hello') {
          hookClients.set(`${e.user}@${e.home}`, { user: String(e.user ?? ''), home: String(e.home ?? ''), plugin: String(e.plugin ?? ''), at: Date.now() });
          continue;
        }
        if (e.type === 'stats') {
          hookStats.set(e.session_id, { ...e, receivedAt: Date.now() });
          if (e.model && e.context_length > 0) ctx.noteLimit(e.model, e.context_length);
          ledger({ type: 'stats', session: e.session_id, ts: Date.now(), model: e.model, provider: e.provider, platform: e.platform });
          continue;
        }
        if (e.type === 'message') {
          // The trace for sessions not in state.db (Hermes couldn't save them, or this server
          // can't read that database). Sessions in state.db get their rows from there.
          if (e.background || inDb(e.session_id)) continue;
          const tools = (e.tool_calls ?? []).map((c) => ({ function: { name: c.name, arguments: c.args ?? '' } }));
          const row = messageRow({
            id: `hook-${++hookSeq}`, session_id: e.session_id, source: e.platform ?? null, role: e.role,
            content: e.content ?? '', reasoning: e.reasoning ?? '', tool_calls: tools.length ? JSON.stringify(tools) : null,
            tool_name: e.tool_name ?? null, timestamp: e.t ?? Date.now() / 1000, finish_reason: e.finish_reason ?? null,
          });
          emit('hermes-msgs', { backfill: false, messages: [row] });
          if (isChat({ ...row, finish_reason: row.finish })) emit('hermes-chat', { backfill: false, messages: [row] });
          ledger({ type: 'message', session: e.session_id, ts: row.ts });
          continue;
        }
        if (e.type !== 'post_api' || e.background) continue;
        if (e.model && e.context_length > 0) ctx.noteLimit(e.model, e.context_length);
        const u = e.usage ?? {};
        if (u.output_tokens == null && u.input_tokens == null) continue;
        const prompt = (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0); // input_tokens is the uncached part
        const out = u.output_tokens ?? 0;
        const latency = Number(e.api_duration) || null;
        const c = {
          type: 'call', ts: Math.round((e.ended_at ?? e.t ?? Date.now() / 1000) * 1000), session: e.session_id,
          n: Number(e.api_call_count) || 0, model: e.model, provider: e.provider, in: prompt, out, total: prompt + out,
          latency, cacheHit: u.cache_read_tokens ?? null, cacheOf: prompt, tps: latency > 0 ? out / latency : null, via: 'hook',
        };
        if (!claim(c)) continue;
        ctx.track(c);
        ledger(c);
        fresh.push(c);
      }
      if (!fresh.length) return;
      calls.push(...fresh);
      calls.sort((a, b) => a.ts - b.ts);
      trimCalls();
      emit('hermes-calls', { backfill: false, calls: fresh });
    },
    stop() {
      clearInterval(modelsTimer); clearInterval(dbTimer); clearInterval(logTimer);
      try { db?.close(); } catch { /* ignore */ }
    },
  };
}
