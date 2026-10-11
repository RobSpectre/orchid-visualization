import { S, on, fire, tick, setStudio, setBeatDoc, onKeyEvents, NOTE_NAMES } from './state.js';
import { createNebula } from './shader.js';
import { createOrbit, TREATMENTS } from './orbit.js';
import { createDrums, createLoops, createKeys } from './deck.js';
import { createArmView } from './arm3d.js';
import { createFactory } from './factory.js';
import { createTrace } from './trace.js';
import { createDemo } from './demo.js';
import { createVideo } from './video.js';
import { THEMES, applyPalette } from './theme.js';
import { createAlerts } from './alerts.js';
import { createDock } from './dock.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const root = document.documentElement;

const nebula = createNebula($('nebula'));
const orbit = createOrbit($('fx'), $('orbit-static'), $('orbit'));
const drawDrums = createDrums($('drum-canvas'), $('drum-meta'));
const drawLoops = createLoops($('loop-canvas'), $('loop-meta'));
const drawKeys = createKeys($('keys-canvas'), $('keys-meta'));
const drawRobot = createArmView($('robot-canvas'), $('robot-meta'));
const updateFactory = createFactory();
const trace = createTrace($('trace'), $('trace-session'), $('trace-live'), $('factory'), {
  wrap: $('chat-wrap'), body: $('chat'), platform: $('chat-platform'), meta: $('chat-meta'),
});

const video = createVideo({ layer: $('video-layer'), veil: $('video-veil'), video: $('video'), overlay: $('video-overlay'), orbitEl: $('orbit') });

// ---- data sinks (shared by the live stream and demo mode)
let realBeatDoc = null;
const sink = {
  studio: (s) => setStudio(s),
  beat: (doc) => setBeatDoc(doc),
  keys: (events) => onKeyEvents(events),
  robot: (r) => { S.robot = r; },
  hermesSession: (s) => { S.hermes.session = s; trace.session(s); },
  hermesMsgs: (m) => {
    if (m.backfill) S.hermes.msgs = m.messages; else S.hermes.msgs.push(...m.messages);
    S.hermes.msgs = S.hermes.msgs.slice(-80);
    trace.messages(m);
  },
  hermesChat: (m) => trace.chat(m),
  hermesCalls: (c) => {
    if (c.backfill) S.hermes.calls = c.calls; else S.hermes.calls.push(...c.calls);
    const cutoff = Date.now() - 2 * 3600_000; // 2 h for the activity graph, at least the last 60 calls
    while (S.hermes.calls.length > 60 && S.hermes.calls[0].ts < cutoff) S.hermes.calls.shift();
  },
};

// ---- live stream
const es = new EventSource('/stream');
const live = (type, fn) => es.addEventListener(type, (e) => fn(JSON.parse(e.data)));
live('source', (src) => { S.sources[src.name] = src; renderSources(); });
// Reload when the visualizer's files change, so long-running booth screens never run stale code.
let pageVersion = null;
live('version', ({ v }) => {
  if (pageVersion == null) pageVersion = v;
  else if (v !== pageVersion) setTimeout(() => location.reload(), 400);
});
live('studio', (s) => { if (!S.demo) sink.studio(s); });
live('beat', (doc) => {
  realBeatDoc = doc;
  // In demo mode, upgrade from the generated pattern to Studio's real beat.
  if (!S.demo || S.beat?.id === 'demo-pulse') sink.beat(doc);
});
live('keys', (ev) => { if (!S.demo) sink.keys(ev); });
live('robot', (r) => { if (!S.demo) sink.robot(r); });
live('hermes-session', (s) => { if (!S.demo) sink.hermesSession(s); });
live('hermes-msgs', (m) => { if (!S.demo) sink.hermesMsgs(m); });
live('hermes-calls', (c) => { if (!S.demo) sink.hermesCalls(c); });
live('hermes-chat', (m) => { if (!S.demo) sink.hermesChat(m); });
// ---- themes: palette (canvas), background shader and CSS switch together
let themeId = null;
function setTheme(id) {
  if (id === themeId || !THEMES.some((t) => t.id === id)) return;
  const apply = () => {
    const t = applyPalette(id);
    themeId = t.id;
    document.body.dataset.theme = t.id;
    nebula?.setMode(t.background);
  };
  if (themeId == null) { apply(); return; }
  document.body.classList.add('theme-out');
  setTimeout(() => { apply(); document.body.classList.remove('theme-out'); }, 450);
}
setTheme('nebula');

// Look + theme from settings. With rotation on, the wall clock picks them so every screen agrees.
let visual = { treatment: 'orbit', rotateMin: 0, rotateEvery: 1, theme: 'nebula', themeRotateMin: 0 };
let lastWanted = null, lastTheme = null;
function rotated(list, startId, minutes) {
  const start = Math.max(0, list.findIndex((t) => t.id === startId));
  if (!minutes) return list[start].id;
  return list[(start + Math.floor(Date.now() / (minutes * 60000))) % list.length].id;
}
function syncVisual() {
  const wanted = rotated(TREATMENTS, visual.treatment, visual.rotateMin);
  if (wanted !== lastWanted) { lastWanted = wanted; orbit.setTreatment(wanted); }
  const theme = rotated(THEMES, visual.theme, visual.themeRotateMin);
  if (theme !== lastTheme) { lastTheme = theme; setTheme(theme); }
}
live('settings', (st) => { if (st.visual) { visual = { ...visual, ...st.visual }; lastWanted = null; lastTheme = null; syncVisual(); } });
setInterval(syncVisual, 1000);

// Connectivity takeover (suppressed in demo mode, where things are offline on purpose).
const alerts = createAlerts({ el: $('alert'), restoredEl: $('restored'), isDemo: () => S.demo });
live('alerts', (p) => alerts.update(p));

createDock({
  el: $('dock'),
  treatments: TREATMENTS,
  themes: THEMES,
  current: () => ({ visual, treatment: orbit.treatment, theme: themeId, demo: S.demo }),
  onLook: (id) => orbit.setTreatment(id),
  onTheme: (id) => setTheme(id),
  onDemo: () => setDemo(!S.demo),
  onFullscreen: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()),
});

live('video-play', (cmd) => video.play(cmd));
live('video-stop', (cmd) => video.stop(cmd));
live('hermes-log', (lines) => {
  for (const l of lines) if (l.type === 'turn-start') S.fx.think = 1;
});
live('studio-events', (events) => {
  for (const e of events) if (e.event === 'sound_forwarded') fire('sound', e);
});
live('hermes-stream', (batch) => {
  const st = (S.hermes.stream ??= { samples: [], lastAt: 0 });
  const now = performance.now();
  for (const e of batch) {
    if (e.type === 'delta') { st.samples.push({ t: now, n: e.delta.length }); st.lastAt = now; }
    if (e.type === 'post_api') {
      const ttft = e.first_chunk_at && e.started_at ? e.first_chunk_at - e.started_at : null;
      const decode = e.ended_at && e.first_chunk_at ? e.ended_at - e.first_chunk_at : null;
      const out = e.usage?.output_tokens;
      S.hermes.lastPost = {
        ttft, out, call: e.api_call_count, session: e.session_id,
        contextLength: e.context_length ?? null, // the window Hermes' compressor actually uses
        decodeTps: out && decode > 0.05 ? out / decode : null,
      };
    }
  }
  st.samples = st.samples.filter((s) => now - s.t < 3000);
  if (!S.demo) trace.stream(batch);
});
// This screen's own link to the Orchid Signal server. If it drops, Studio, the
// robot and Hermes may all be fine: say that, instead of blaming them.
es.onerror = () => {
  if (S.sources.server?.online !== false) S.sources.server = { name: 'server', online: false, since: Date.now() };
  renderSources();
};
es.onopen = () => {
  S.sources.server = { name: 'server', online: true };
  renderSources(); // the server replays its real alert state on connect
};
setInterval(() => {
  const srv = S.sources.server;
  if (srv?.online === false && Date.now() - srv.since > 4000) {
    alerts.update({
      active: [{
        id: 'viz-server', title: 'Orchid Signal server offline', since: srv.since,
        detail: 'This screen lost its connection to the visualizer server, so it can’t see Studio, the robot or Hermes. They may be running fine.',
        tips: [
          { text: 'Start the visualizer server (or check its Terminal tab for an error):', cmd: 'cd ~/workspace/orchid-visualization && npm start' },
          { text: 'This screen reconnects by itself within a few seconds of the server coming back.' },
        ],
      }],
      muted: 0, snoozedUntil: 0,
    });
  }
}, 1000);

// ---- demo
const demo = createDemo(sink, () => realBeatDoc);
function setDemo(onOff) {
  S.demo = onOff;
  if (onOff) demo.start();
  else {
    demo.stop();
    // Reload so the server replays fresh live state.
    const url = new URL(location.href);
    url.searchParams.delete('demo');
    location.replace(url);
  }
  renderSources();
}

// ---- sources
function renderSources() {
  const items = [
    ['studio', 'studio'], ['robot', 'robot'], ['hermes', 'hermes'],
    ['hermes-stream', 'stream hook'],
  ];
  $('sources').innerHTML = items.map(([k, label]) => {
    const src = S.sources[k];
    const cls = S.demo ? 'on' : src?.online ? 'on' : src ? 'off' : '';
    return `<span class="src ${cls}" title="${esc(src?.error)}"><i></i>${label}</span>`;
  }).join('');
}
renderSources();

// ---- robot press detection: progress crossing the press point
const robotProgress = {};
function watchRobot() {
  for (const a of S.robot?.arms ?? []) {
    const prev = robotProgress[a.arm];
    const p = a.playing ? a.progress : null;
    robotProgress[a.arm] = p;
    if (p != null && prev != null && prev < 0.5 && p >= 0.5) {
      const pc = NOTE_NAMES.indexOf(a.selected);
      fire('robot-press', { arm: a.arm, control: a.selected, pc: pc >= 0 ? pc : null });
      if (pc >= 0) fire('note', { midi: 60 + pc, vel: 0.9, source: 'robot' });
    }
  }
}

// ---- top bar + HUD
let lastHud = 0;
function renderHud(now) {
  if (now - lastHud < 100) return;
  lastHud = now;
  const s = S.studio;
  const b = S.beat;
  const c = S.clock;
  $('bpm').textContent = s?.tempo ? Math.round(s.tempo.bpm) : '---';
  if (['playing', 'count-in', 'paused'].includes(c.transport)) {
    const beat = Math.max(0, c.beat);
    const bar = Math.floor(beat / 4) + 1;
    const bt = Math.floor(beat % 4) + 1;
    const six = Math.floor((beat % 1) * 4) + 1;
    $('pos').textContent = `${String(bar).padStart(3, '0')}.${bt}.${six}`;
  } else {
    $('pos').textContent = '---.-.-';
  }
  const pill = $('transport-state');
  const recording = s?.looper?.phase === 'recording' || s?.looper?.phase === 'count-in';
  // Mirror Studio's transport exactly (see transportOf in state.js).
  const t = c.transport;
  const state = S.demo ? 'demo' : recording && t !== 'paused' ? s.looper.phase : t === 'stale' ? 'no signal' : t;
  pill.textContent = state;
  pill.className = `state-pill ${S.demo ? 'demo' : recording && t !== 'paused' ? 'recording' : t}`;
  document.body.dataset.transport = S.demo ? 'playing' : t;

  $('np-title').textContent = b ? b.name : '—';
  if (themeId === 'signal') {
    $('bn-tps').textContent = $('tf-tps').textContent;
    $('bn-model').textContent = $('tf-model').textContent;
    $('bn-beat').textContent = b ? b.name : 'waiting for the downbeat';
    $('bn-meta').textContent = s?.tempo ? `${Math.round(s.tempo.bpm)} bpm · ${pill.textContent}` : '';
  }
  $('np-meta').textContent = b
    ? [b.genre, b.feel, b.kit].filter(Boolean).join(' · ')
    : 'waiting for the downbeat';

  const voices = s?.instruments?.voices ?? [];
  const mix = s?.mixer;
  $('hud-tl').innerHTML = b
    ? `<b>${b.lanes.length}</b> lanes · <b>${b.hits.length}</b> hits<br>${b.bars} bars · swing ${Math.round(b.swing * 100)}%`
      + (s?.drums?.pendingBeat ? `<br>next ▸ <b>${esc(s.drums.pendingBeat)}</b>` : '')
    : '';
  const perf = s?.performance;
  $('hud-tr').innerHTML = perf
    ? `perform <b>${esc(perf.settings?.mode)}</b><br>${esc(perf.settings?.pattern)} · gate ${esc(perf.settings?.gate)}`
    : s ? `perform <b>off</b><br>${s.connection?.connected ? 'orchid connected' : 'orchid not connected'}` : '';
  // Pistil voices with full sound names; ◉ marks the voice the hardware Sound dial controls.
  const short = ['L1', 'L2', 'L3', 'L4', 'LIVE', 'ALONG'];
  $('hud-bl').innerHTML = voices.length
    ? voices.map((v, i) => `${v.slot === s.instruments.selected ? '◉' : '·'} ${short[i] ?? v.slot} <b>${esc(v.name)}</b>${v.number ? ` <span class="num">${String(v.number).padStart(3, '0')}</span>` : ''}`).join('<br>')
    : '';
  const sess = S.hermes.session;
  const lastMsg = S.hermes.msgs.at(-1);
  const lastTool = [...S.hermes.msgs].reverse().find((m) => m.tools?.length)?.tools[0];
  $('hud-br').innerHTML = sess
    ? `hermes <b>${sess.turnActive || S.fx.think > 0.3 ? 'thinking' : 'listening'}</b><br>${lastTool ? `last tool ▸ ${esc(lastTool.name)}` : ''}<br>${lastMsg ? new Date(lastMsg.ts).toLocaleTimeString('en-GB') : ''}`
    : '';
  if (mix?.drums) $('hud-tl').innerHTML += `<br>drums vol ${Math.round(mix.drums.volume * 100)}%`;
}

// ---- main loop
let trippy = false;
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  tick(now);
  watchRobot();
  if (S.hermes.session?.turnActive) S.fx.think = Math.max(S.fx.think, 0.6);
  const fx = S.fx;
  root.style.setProperty('--kick', fx.kick.toFixed(3));
  root.style.setProperty('--snare', fx.snare.toFixed(3));
  video.tick(now);
  // While a video fully covers the screen, skip drawing what nobody can see.
  if (!video.covering(now)) {
    nebula?.draw({
      time: fx.motion, beat: S.clock.beat, kick: fx.kick, snare: fx.snare, hat: fx.hat,
      note: fx.note, noteHit: fx.noteHit, think: fx.think, playing: Math.max(fx.playing, trippy ? 0.6 : 0),
    });
    orbit.draw(now);
    drawDrums(now);
    drawLoops(now);
    drawKeys(now);
    drawRobot(now);
  }
  updateFactory(now);
  trace.tick(dt);
  renderHud(now);
  if (video.playing) {
    video.renderOverlay({
      beat: $('np-title').textContent, bpm: $('bpm').textContent,
      transport: $('transport-state').textContent, tps: $('tf-tps').textContent,
    });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- keys
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'd') setDemo(!S.demo);
  if (k === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  if (k === 't') { trippy = !trippy; document.body.classList.toggle('trippy', trippy); orbit.setTrippy(trippy); }
  if (k === 'v') fetch('/api/video/stop', { method: 'POST' }).catch(() => video.stop());
  if (k === 's') location.href = '/settings';
  // 1–4 jump to a look, Shift+1–4 to a theme (until the next rotation step, if rotating).
  const digit = /^Digit(\d)$/.exec(e.code)?.[1];
  const n = Number(digit);
  if (digit && e.shiftKey && n >= 1 && n <= THEMES.length) setTheme(THEMES[n - 1].id);
  else if (digit && n >= 1 && n <= TREATMENTS.length) orbit.setTreatment(TREATMENTS[n - 1].id);
});
if (new URLSearchParams(location.search).has('demo')) setDemo(true);
