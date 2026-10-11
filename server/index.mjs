// Orchid Visualizer server: polls Orchid Studio, orchid-robot and Hermes
// Agent (all read-only), and fans the results out to browsers over SSE.
// Binds to 127.0.0.1 only; the data includes local agent transcripts.

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startStudio } from './studio.mjs';
import { startRobot } from './robot.mjs';
import { startHermes } from './hermes.mjs';
import { redact, createStreamRedactor } from './redact.mjs';
import { createMedia } from './media.mjs';
import { createHealth } from './health.mjs';
import { createTips } from './tips.mjs';
import { homedir } from 'node:os';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.ORCHID_VIZ_PORT ?? '4747' },
    'studio-port': { type: 'string', default: '8765' },
    'robot-port': { type: 'string' },
    'hermes-home': { type: 'string' },
    'media-dir': { type: 'string' },
    'data-dir': { type: 'string' },
    'studio-dir': { type: 'string', default: '~/workspace/orchid-studio' },
    'robot-dir': { type: 'string', default: '~/workspace/orchid-robot' },
    'robot-python': { type: 'string', default: '~/.virtualenvs/orchid/bin/python' },
  },
});

const PORT = Number(args.port);
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// ---- hub: latest-value state plus short histories, replayed to new clients
const clients = new Set();
const latest = new Map();          // type (or type:name) -> payload
const rings = { 'hermes-msgs': [], 'hermes-calls': [], 'hermes-chat': [] };
const RING_MAX = { 'hermes-msgs': 60, 'hermes-calls': 2000, 'hermes-chat': 30 };

function send(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function emit(type, data) {
  if (type === 'source') latest.set(`source:${data.name}`, ['source', data]);
  else if (type in rings) {
    const items = type === 'hermes-calls' ? data.calls : data.messages;
    const ring = rings[type];
    if (data.backfill) ring.length = 0;
    ring.push(...items);
    if (ring.length > RING_MAX[type]) ring.splice(0, ring.length - RING_MAX[type]);
    // Calls: keep 2 h of history for the activity graph, and always the last 60.
    if (type === 'hermes-calls') {
      const cutoff = Date.now() - 2 * 3600_000;
      while (ring.length > 60 && ring[0].ts < cutoff) ring.shift();
    }
  } else if (['studio', 'beat', 'robot', 'hermes-session', 'alerts', 'version'].includes(type)) {
    latest.set(type, [type, data]);
  }
  for (const res of clients) send(res, type, data);
}

// Stream deltas are redacted per (session, kind) with hold-back, so a secret
// split across chunks is still caught before it reaches a browser.
const streamRedactors = new Map();
function redactStreamBatch(batch) {
  const out = [];
  for (const e of batch) {
    if (!e || typeof e !== 'object') continue;
    const key = (kind) => `${e.session_id ?? ''}:${kind}`;
    if (e.type === 'delta') {
      let r = streamRedactors.get(key(e.kind));
      if (!r) streamRedactors.set(key(e.kind), (r = createStreamRedactor()));
      const delta = r.push(String(e.delta ?? ''));
      if (delta) out.push({ ...e, delta });
    } else if (e.type === 'stream_end') {
      for (const kind of ['text', 'reasoning']) {
        const r = streamRedactors.get(key(kind));
        const rest = r?.flush();
        if (rest) out.push({ type: 'delta', kind, delta: rest, session_id: e.session_id, t: e.t });
        streamRedactors.delete(key(kind));
      }
      out.push({ ...e, error: e.error ? redact(String(e.error)) : null });
    } else if (['stream_start', 'pre_api', 'post_api'].includes(e.type)) {
      out.push(e); // timing/usage events carry numbers only
    } // message / stats / hello carry text or paths: handled (and redacted) by hermes.mjs, not forwarded raw
  }
  if (streamRedactors.size > 64) streamRedactors.clear();
  return out;
}

// Page version: changes when any file under public/ changes. Open screens reload
// themselves on a new version, so a booth display never keeps running stale code.
async function publicVersion(dir = PUBLIC) {
  let sig = '';
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sig += await publicVersion(p);
    else sig += `${entry.name}:${(await stat(p)).mtimeMs};`;
  }
  return sig;
}
let pageVersion = null;
async function checkVersion() {
  try {
    const sig = await publicVersion();
    let h = 0;
    for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
    const v = (h >>> 0).toString(36);
    if (v !== pageVersion) { pageVersion = v; emit('version', { v }); }
  } catch { /* keep the last version */ }
}

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// Studio's transport as the server sees it, for "only while Studio is/isn't playing".
function studioTransport() {
  const st = latest.get('studio')?.[1];
  if (!st || Date.now() - st.receivedAt > 1500) return 'offline';
  if (!st.tempo?.running) return 'stopped';
  return st.tempo.paused ? 'paused' : 'playing';
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const media = createMedia({
  mediaDir: args['media-dir'] ?? join(ROOT, 'media'),
  dataDir: args['data-dir'] ?? join(ROOT, 'data'),
  emit, studioTransport, log,
});
await media.load();

let hookLastAt = null;
const health = createHealth({
  latest, rings, clients, media,
  hermesHome: args['hermes-home'] ?? join(homedir(), '.hermes'),
  hookSeen: () => hookLastAt,
  hookClients: () => { try { return hermes.hookClients(); } catch { return []; } }, // hermes is created below
  startedAt: Date.now(),
  studioPort: Number(args['studio-port']),
  // Commands shown to the operator, matching how this machine runs each app.
  tips: createTips({
    studioDir: args['studio-dir'], studioPort: Number(args['studio-port']),
    robotDir: args['robot-dir'], robotPython: args['robot-python'], robotPort: Number(args['robot-port'] ?? 8081),
    vizDir: ROOT.replace(homedir(), '~').replace(/\/$/, ''), vizPort: PORT,
  }),
});

// Connectivity alerts: a problem must persist 4 s before it's raised, so one
// dropped poll never flashes the screen. Muted groups and snooze come from settings.
const ALERT_AFTER_MS = 4000;
const firstSeen = new Map();
let lastAlertKey = null;
setInterval(async () => {
  try {
    const now = Date.now();
    const problems = await health.connectivity(now);
    const cfg = media.snapshot().alerts;
    const ids = new Set(problems.map((p) => p.id));
    for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id);
    for (const p of problems) if (!firstSeen.has(p.id)) firstSeen.set(p.id, now);
    const due = problems.filter((p) => now - firstSeen.get(p.id) >= ALERT_AFTER_MS).map((p) => ({ ...p, since: firstSeen.get(p.id) }));
    const active = due.filter((p) => cfg.enabled && !cfg.ignore[p.group]);
    const payload = { active, muted: due.length - active.length, snoozedUntil: cfg.snoozeUntil > now ? cfg.snoozeUntil : 0 };
    const key = JSON.stringify([active.map((a) => [a.id, a.title, a.detail]), payload.muted, payload.snoozedUntil]);
    if (key !== lastAlertKey) {
      lastAlertKey = key;
      emit('alerts', payload);
      if (active.length) log(`alert: ${active.map((a) => a.title).join(' · ')}`);
    }
  } catch (err) {
    log(`alerts: ${err.message}`);
  }
}, 2000);

startStudio({ port: Number(args['studio-port']), emit, log });
startRobot({ ports: args['robot-port'] ? [Number(args['robot-port'])] : undefined, emit });
const hermes = startHermes({ home: args['hermes-home'], emit, log });

// ---- http
async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname === '/settings' ? '/settings.html' : url.pathname === '/status' ? '/status.html' : url.pathname;
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (rel.startsWith('..')) return void res.writeHead(403).end();
  try {
    const body = await readFile(join(PUBLIC, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  // Same DNS-rebinding guard the Orchid apps use.
  if (!LOCAL_HOSTS.has(req.headers.host ?? '')) return void res.writeHead(403).end('local clients only');
  const path = new URL(req.url, 'http://x').pathname;

  if (path === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    for (const [type, data] of latest.values()) send(res, type, data);
    if (rings['hermes-msgs'].length) send(res, 'hermes-msgs', { backfill: true, messages: rings['hermes-msgs'] });
    if (rings['hermes-calls'].length) send(res, 'hermes-calls', { backfill: true, calls: rings['hermes-calls'] });
    send(res, 'hermes-chat', { backfill: true, messages: rings['hermes-chat'] });
    send(res, 'settings', media.snapshot());
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  // Optional Hermes plugin (hermes-plugin/orchid_viz) posts batched stream events here.
  if (path === '/hermes/hook' && req.method === 'POST') {
    if (req.headers.origin) return void res.writeHead(403).end();
    try {
      const batch = JSON.parse(await readBody(req));
      if (Array.isArray(batch) && batch.length) {
        if (!latest.has('source:hermes-stream')) emit('source', { name: 'hermes-stream', online: true, error: null });
        hookLastAt = Date.now();
        // API calls and Hermes' context length, from any Hermes running the plugin.
        hermes.noteHookBatch(batch);
        const safe = redactStreamBatch(batch);
        if (safe.length) emit('hermes-stream', safe);
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return;
  }

  if (path === '/api/health' && req.method === 'GET') {
    try {
      const body = JSON.stringify(await health());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (await media.handle(req, res, new URL(req.url, 'http://x'))) return;

  if (req.method !== 'GET') return void res.writeHead(405).end();
  serveStatic(req, res);
});

await checkVersion();
setInterval(checkVersion, 3000);

server.listen(PORT, '127.0.0.1', () => log(`Orchid Visualizer → http://127.0.0.1:${PORT}/`));
