// Local video library + interval scheduler.
//
// Videos live in a media folder (uploaded from the settings page or copied in
// directly). Settings persist to data/settings.json. The scheduler decides
// when each video is due and broadcasts `video-play` / `video-stop` to every
// open visualizer, so all screens stay in step.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const VIDEO_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mkv': 'video/x-matroska',
};
const MAX_UPLOAD = 16 * 1024 ** 3; // 16 GiB

const DEFAULT_SCHEDULE = {
  enabled: true,
  transition: 'iris',      // iris | fade | glitch
  transitionMs: 2500,
  when: 'always',          // always | not-playing | playing
  overlay: true,           // keep the top bar visible over videos
};
// Centre-stage look, and optional rotation through all of them.
export const TREATMENT_IDS = ['orbit', 'warp', 'ridges', 'mandala'];
export const THEME_IDS = ['nebula', 'glass', 'terminal', 'signal'];
// Looks loop by default. rotateEvery is the chosen interval (kept while rotation is
// off); rotateMin is the active interval, 0 when not rotating.
const DEFAULT_VISUAL = { treatment: 'orbit', rotateMin: 1, rotateEvery: 1, theme: 'nebula', themeRotateMin: 0, whatsapp: true };
const minutes = (v) => (v == null || Number(v) <= 0 ? 0 : clamp(v, 0.25, 24 * 60, 0));
function cleanVisual(v = {}) {
  const rotateEvery = minutes(v.rotateEvery) || minutes(v.rotateMin) || DEFAULT_VISUAL.rotateEvery;
  return {
    treatment: TREATMENT_IDS.includes(v.treatment) ? v.treatment : DEFAULT_VISUAL.treatment,
    rotateMin: v.rotateMin === undefined ? DEFAULT_VISUAL.rotateMin : minutes(v.rotateMin),
    rotateEvery,
    theme: THEME_IDS.includes(v.theme) ? v.theme : DEFAULT_VISUAL.theme,
    themeRotateMin: minutes(v.themeRotateMin),
    whatsapp: v.whatsapp !== false, // show the WhatsApp (chat) conversation on screen
  };
}
// Connectivity alerts: groups the operator can mute, and a shared snooze.
export const ALERT_GROUPS = ['studio', 'orchid', 'robot', 'arms', 'hermes', 'whatsapp'];
function cleanAlerts(a = {}) {
  return {
    enabled: a.enabled !== false,
    ignore: Object.fromEntries(ALERT_GROUPS.map((g) => [g, a.ignore?.[g] === true])),
    snoozeUntil: Number.isFinite(Number(a.snoozeUntil)) ? Number(a.snoozeUntil) : 0,
  };
}
const DEFAULT_VIDEO = { enabled: true, title: '', everyMin: 10, playFor: null, startAt: 0, volume: 0, durationS: null };

const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback);

// Only plain file names inside the media folder: no paths, no dotfiles.
export function safeName(name) {
  const base = basename(String(name ?? '')).replace(/[^\w.\- ()]+/g, '_').trim();
  if (!base || base.startsWith('.') || !(extname(base).toLowerCase() in VIDEO_TYPES)) return null;
  return base.slice(0, 160);
}

function cleanSchedule(s = {}) {
  return {
    enabled: s.enabled !== false,
    transition: ['iris', 'fade', 'glitch'].includes(s.transition) ? s.transition : DEFAULT_SCHEDULE.transition,
    transitionMs: clamp(s.transitionMs, 300, 10000, DEFAULT_SCHEDULE.transitionMs),
    when: ['always', 'not-playing', 'playing'].includes(s.when) ? s.when : DEFAULT_SCHEDULE.when,
    overlay: s.overlay !== false,
  };
}

function cleanVideo(v = {}) {
  return {
    enabled: v.enabled !== false,
    title: String(v.title ?? '').slice(0, 120),
    everyMin: clamp(v.everyMin, 0.25, 24 * 60, DEFAULT_VIDEO.everyMin),
    playFor: v.playFor == null || v.playFor === '' || Number(v.playFor) <= 0 ? null : clamp(v.playFor, 1, 6 * 3600, null),
    startAt: clamp(v.startAt, 0, 6 * 3600, 0),
    volume: clamp(v.volume, 0, 1, 0),
    durationS: v.durationS == null ? null : clamp(v.durationS, 0, 24 * 3600, null),
  };
}

export function createMedia({ mediaDir, dataDir, emit, studioTransport, log }) {
  const settingsPath = join(dataDir, 'settings.json');
  let settings = { version: 1, schedule: { ...DEFAULT_SCHEDULE }, visual: { ...DEFAULT_VISUAL }, alerts: cleanAlerts(), videos: {} };
  const lastStart = new Map();       // file -> ms
  let scheduleSince = Date.now();
  let current = null;                // { file, startedAt, until }

  async function load() {
    await mkdir(mediaDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(settingsPath, 'utf8'));
      settings = {
        version: 1,
        schedule: cleanSchedule(raw.schedule),
        visual: cleanVisual(raw.visual),
        alerts: cleanAlerts(raw.alerts),
        videos: Object.fromEntries(Object.entries(raw.videos ?? {}).map(([f, v]) => [f, cleanVideo(v)])),
      };
    } catch (err) {
      if (err.code !== 'ENOENT') log?.(`settings: ${err.message}; using defaults`);
    }
  }

  async function save() {
    const tmp = `${settingsPath}.tmp`;
    await writeFile(tmp, JSON.stringify(settings, null, 2));
    await rename(tmp, settingsPath);
  }

  // Files on disk joined with their settings. New files get defaults.
  async function library() {
    const names = (await readdir(mediaDir).catch(() => [])).filter((n) => safeName(n) === n);
    const out = [];
    for (const file of names.sort()) {
      const st = await stat(join(mediaDir, file)).catch(() => null);
      if (!st?.isFile()) continue;
      const v = settings.videos[file] ?? cleanVideo({ title: file.replace(/\.[^.]+$/, '') });
      settings.videos[file] = v;
      out.push({ file, size: st.size, mtime: st.mtimeMs, url: `/media/${encodeURIComponent(file)}`, ...v });
    }
    return out;
  }

  function status() {
    const now = Date.now();
    const next = {};
    for (const [file, v] of Object.entries(settings.videos)) {
      if (!v.enabled) continue;
      next[file] = (lastStart.get(file) ?? scheduleSince) + v.everyMin * 60_000;
    }
    return { now, current: current && { file: current.file, startedAt: current.startedAt }, next, studio: studioTransport() };
  }

  function play(file, reason) {
    const v = settings.videos[file];
    if (!v) return false;
    const s = settings.schedule;
    const lengthS = v.playFor ?? (v.durationS ? Math.max(1, v.durationS - v.startAt) : 120);
    const now = Date.now();
    current = { file, startedAt: now, until: now + lengthS * 1000 + s.transitionMs * 2 + 5000 };
    lastStart.set(file, now);
    emit('video-play', {
      file, url: `/media/${encodeURIComponent(file)}`, title: v.title || file,
      playFor: v.playFor, startAt: v.startAt, volume: v.volume, durationS: v.durationS,
      transition: s.transition, transitionMs: s.transitionMs, overlay: s.overlay, reason,
    });
    log?.(`video ▶ ${file} (${reason})`);
    return true;
  }

  function stop(reason) {
    if (!current) return;
    log?.(`video ■ ${current.file} (${reason})`);
    current = null;
    emit('video-stop', { reason, transitionMs: settings.schedule.transitionMs });
  }

  function allowedNow() {
    const when = settings.schedule.when;
    if (when === 'always') return true;
    const playing = studioTransport() === 'playing';
    return when === 'playing' ? playing : !playing;
  }

  // Once a second: start the most overdue enabled video when nothing is showing.
  async function tickSchedule() {
    const now = Date.now();
    if (current && now > current.until) current = null; // a screen never reported back
    if (current || !settings.schedule.enabled || !allowedNow()) return;
    const files = new Set((await readdir(mediaDir).catch(() => [])));
    let best = null;
    for (const [file, v] of Object.entries(settings.videos)) {
      if (!v.enabled || !files.has(file)) continue;
      const due = (lastStart.get(file) ?? scheduleSince) + v.everyMin * 60_000;
      if (due <= now && (!best || due < best.due)) best = { file, due };
    }
    if (best) play(best.file, 'schedule');
  }

  const timer = setInterval(() => { tickSchedule().catch((err) => log?.(`schedule: ${err.message}`)); }, 1000);

  // ---- HTTP
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readJson(req, limit = 256 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('too large');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  async function serveMedia(req, res, file) {
    const name = safeName(file);
    if (!name || name !== file) return void res.writeHead(404).end();
    const path = join(mediaDir, name);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) return void res.writeHead(404).end();
    const type = VIDEO_TYPES[extname(name).toLowerCase()];
    // Range support so the browser can seek and stream large files.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m) {
      let start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
      let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : st.size - 1;
      start = Math.max(0, start); end = Math.min(end, st.size - 1);
      if (start > end) return void res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
      res.writeHead(206, {
        'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${st.size}`, 'cache-control': 'no-cache',
      });
      if (req.method === 'HEAD') return void res.end();
      return pipeline(createReadStream(path, { start, end }), res).catch(() => {});
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': st.size, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return void res.end();
    return pipeline(createReadStream(path), res).catch(() => {});
  }

  async function upload(req, res, url) {
    const name = safeName(url.searchParams.get('name'));
    if (!name) return json(res, 400, { error: 'Unsupported file. Use mp4, m4v, mov, webm, ogv or mkv.' });
    if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD) return json(res, 413, { error: 'File too large (16 GB max).' });
    // Never overwrite: "clip.mp4" -> "clip (2).mp4"
    let target = name;
    for (let i = 2; await stat(join(mediaDir, target)).then(() => true, () => false); i++) {
      target = name.replace(/(\.[^.]+)$/, ` (${i})$1`);
    }
    const tmp = join(mediaDir, `.upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) req.destroy(new Error('too large')); });
    try {
      await pipeline(req, createWriteStream(tmp));
      await rename(tmp, join(mediaDir, target));
    } catch (err) {
      await rm(tmp, { force: true });
      return json(res, 400, { error: `Upload failed: ${err.message}` });
    }
    settings.videos[target] = cleanVideo({ title: target.replace(/\.[^.]+$/, '') });
    lastStart.set(target, Date.now()); // first scheduled play is one interval from now
    await save();
    const lib = await library();
    emit('settings', { schedule: settings.schedule, visual: settings.visual });
    return json(res, 200, { file: target, videos: lib });
  }

  // Returns true when the request was handled.
  async function handle(req, res, url) {
    const path = url.pathname;
    if (path.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      await serveMedia(req, res, decodeURIComponent(path.slice('/media/'.length)));
      return true;
    }
    if (!path.startsWith('/api/')) return false;

    // Browser writes must come from this page's own origin.
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) { json(res, 403, { error: 'cross-origin request refused' }); return true; }
    }

    try {
      if (path === '/api/settings' && req.method === 'GET') {
        json(res, 200, { schedule: settings.schedule, visual: settings.visual, alerts: settings.alerts, videos: await library(), status: status(), mediaDir });
      } else if (path === '/api/settings' && req.method === 'PUT') {
        const body = await readJson(req);
        if (body.schedule) settings.schedule = cleanSchedule({ ...settings.schedule, ...body.schedule });
        if (body.visual) settings.visual = cleanVisual({ ...settings.visual, ...body.visual });
        if (body.alerts) settings.alerts = cleanAlerts({ ...settings.alerts, ...body.alerts, ignore: { ...settings.alerts.ignore, ...body.alerts.ignore } });
        for (const [file, v] of Object.entries(body.videos ?? {})) {
          if (settings.videos[file]) {
            const before = settings.videos[file];
            settings.videos[file] = cleanVideo({ ...before, ...v });
            // Changing the interval restarts that video's countdown.
            if (v.everyMin != null && Number(v.everyMin) !== before.everyMin) lastStart.set(file, Date.now());
          }
        }
        if (body.schedule && 'enabled' in body.schedule) scheduleSince = Date.now();
        await save();
        emit('settings', { schedule: settings.schedule, visual: settings.visual, alerts: settings.alerts });
        json(res, 200, { schedule: settings.schedule, visual: settings.visual, alerts: settings.alerts, videos: await library(), status: status() });
      } else if (path === '/api/videos' && req.method === 'POST') {
        await upload(req, res, url);
      } else if (path.startsWith('/api/videos/') && req.method === 'DELETE') {
        const file = safeName(decodeURIComponent(path.slice('/api/videos/'.length)));
        if (!file) { json(res, 400, { error: 'bad name' }); return true; }
        if (current?.file === file) stop('deleted');
        await rm(join(mediaDir, file), { force: true });
        delete settings.videos[file];
        lastStart.delete(file);
        await save();
        json(res, 200, { videos: await library() });
      } else if (path === '/api/video/play' && req.method === 'POST') {
        const { file } = await readJson(req);
        const name = safeName(file);
        await library();
        if (!name || !settings.videos[name]) { json(res, 404, { error: 'no such video' }); return true; }
        if (current) stop('replaced');
        play(name, 'manual');
        json(res, 200, { status: status() });
      } else if (path === '/api/alerts/snooze' && req.method === 'POST') {
        const { minutes } = await readJson(req);
        const m = Math.max(0, Math.min(24 * 60, Number(minutes) || 0));
        settings.alerts.snoozeUntil = m ? Date.now() + m * 60_000 : 0;
        await save();
        emit('settings', { schedule: settings.schedule, visual: settings.visual, alerts: settings.alerts });
        json(res, 200, { alerts: settings.alerts });
      } else if (path === '/api/video/stop' && req.method === 'POST') {
        stop('manual');
        json(res, 200, { status: status() });
      } else if (path === '/api/video/ended' && req.method === 'POST') {
        const { file } = await readJson(req);
        if (current?.file === file) current = null;
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return true;
  }

  return { load, handle, status, stop: () => clearInterval(timer), snapshot: () => ({ schedule: settings.schedule, visual: settings.visual, alerts: settings.alerts }) };
}
