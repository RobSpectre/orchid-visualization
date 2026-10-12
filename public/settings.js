// Settings page: video library, per-video intervals and the transition style.
// Every change saves immediately (debounced) to the server, which broadcasts
// it to open visualizers.

const $ = (id) => document.getElementById(id);
const state = { schedule: null, visual: null, alerts: null, videos: [], status: null, statusAt: 0 };

const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const fmtDur = (s) => {
  if (s == null || !Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const countdown = (ms) => {
  if (ms <= 0) return 'due now';
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---- saving
let pending = { schedule: {}, visual: {}, alerts: {}, videos: {} };
let saveTimer = null;
function queue(patch) {
  if (patch.schedule) Object.assign(pending.schedule, patch.schedule);
  if (patch.visual) Object.assign(pending.visual, patch.visual);
  if (patch.alerts) {
    const ignore = { ...pending.alerts.ignore, ...patch.alerts.ignore };
    Object.assign(pending.alerts, patch.alerts, Object.keys(ignore).length ? { ignore } : {});
  }
  for (const [f, v] of Object.entries(patch.videos ?? {})) pending.videos[f] = { ...pending.videos[f], ...v };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 350);
}
async function flush() {
  const body = pending;
  pending = { schedule: {}, visual: {}, alerts: {}, videos: {} };
  try {
    const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    apply(data, false);
    flash('saved ✓');
  } catch (err) {
    flash(`not saved: ${err.message}`, true);
  }
}
function flash(text, err = false) {
  const el = $('saved');
  el.textContent = text;
  el.className = `saved show${err ? ' err' : ''}`;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => el.classList.remove('show'), err ? 6000 : 1400);
}

// ---- schedule controls
function renderSchedule() {
  const s = state.schedule;
  $('sch-enabled').checked = s.enabled;
  $('sch-overlay').checked = s.overlay;
  $('sch-when').value = s.when;
  $('sch-ms').value = s.transitionMs;
  $('sch-ms-v').textContent = `${(s.transitionMs / 1000).toFixed(1)} s`;
  for (const b of $('sch-transition').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === s.transition));
}
$('sch-enabled').addEventListener('change', (e) => queue({ schedule: { enabled: e.target.checked } }));
$('sch-overlay').addEventListener('change', (e) => queue({ schedule: { overlay: e.target.checked } }));
$('sch-when').addEventListener('change', (e) => queue({ schedule: { when: e.target.value } }));
$('sch-ms').addEventListener('input', (e) => {
  $('sch-ms-v').textContent = `${(e.target.value / 1000).toFixed(1)} s`;
  queue({ schedule: { transitionMs: Number(e.target.value) } });
});
$('sch-transition').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.schedule.transition = b.dataset.v;
  renderSchedule();
  queue({ schedule: { transition: b.dataset.v } });
});

// ---- visualization
function renderVisual() {
  const v = state.visual;
  for (const b of $('vis-treatment').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === v.treatment));
  for (const b of $('vis-theme').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === v.theme));
  const every = v.rotateEvery || v.rotateMin || 1;
  $('vis-loop').checked = v.rotateMin > 0;
  $('vis-whatsapp').checked = v.whatsapp !== false;
  $('vis-loop-field').classList.toggle('off', !(v.rotateMin > 0));
  if (document.activeElement !== $('vis-rotate')) $('vis-rotate').value = stepIndex(every);
  $('vis-rotate-v').textContent = fmtStep(LOOP_STEPS[stepIndex(every)]);
  if (document.activeElement !== $('vis-theme-rotate')) $('vis-theme-rotate').value = v.themeRotateMin ?? 0;
}
$('vis-theme').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.visual.theme = b.dataset.v;
  renderVisual();
  queue({ visual: { theme: b.dataset.v } });
});
$('vis-theme-rotate').addEventListener('change', (e) => queue({ visual: { themeRotateMin: Number(e.target.value) || 0 } }));
$('vis-treatment').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.visual.treatment = b.dataset.v;
  renderVisual();
  queue({ visual: { treatment: b.dataset.v } });
});
// Loop timing: a slider over sensible booth intervals (minutes).
const LOOP_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30];
const stepIndex = (min) => LOOP_STEPS.reduce((best, m, i) => (Math.abs(m - min) < Math.abs(LOOP_STEPS[best] - min) ? i : best), 0);
const fmtStep = (m) => (m < 1 ? `${Math.round(m * 60)} seconds` : m === 1 ? '1 minute' : `${m} minutes`);
$('vis-rotate').max = LOOP_STEPS.length - 1;
$('vis-rotate').addEventListener('input', (e) => {
  const m = LOOP_STEPS[Number(e.target.value)];
  $('vis-rotate-v').textContent = fmtStep(m);
  state.visual.rotateEvery = m;
  queue({ visual: state.visual.rotateMin > 0 ? { rotateEvery: m, rotateMin: m } : { rotateEvery: m } });
});
$('vis-whatsapp').addEventListener('change', (e) => queue({ visual: { whatsapp: e.target.checked } }));
$('vis-loop').addEventListener('change', (e) => {
  const every = state.visual.rotateEvery || 1;
  state.visual.rotateMin = e.target.checked ? every : 0;
  renderVisual();
  queue({ visual: { rotateMin: state.visual.rotateMin, rotateEvery: every } });
});

// ---- connectivity alerts (checked = watched; stored as "ignore")
function renderAlerts() {
  const a = state.alerts;
  $('al-enabled').checked = a.enabled;
  $('al-groups').classList.toggle('off', !a.enabled);
  for (const cb of $('al-groups').querySelectorAll('input')) cb.checked = !a.ignore[cb.dataset.g];
  const snoozed = a.snoozeUntil > Date.now();
  $('al-status').innerHTML = !a.enabled ? 'Takeovers are <b>off</b>.'
    : snoozed ? `Snoozed until <b>${new Date(a.snoozeUntil).toLocaleTimeString('en-GB')}</b> <button type="button" class="clear" id="al-unsnooze">resume now</button>`
      : 'Watching. Problems show on every screen after 4 seconds.';
}
$('al-enabled').addEventListener('change', (e) => { state.alerts.enabled = e.target.checked; renderAlerts(); queue({ alerts: { enabled: e.target.checked } }); });
$('al-groups').addEventListener('change', (e) => {
  const g = e.target.dataset.g;
  if (!g) return;
  state.alerts.ignore[g] = !e.target.checked;
  queue({ alerts: { ignore: { [g]: !e.target.checked } } });
});
$('al-status').addEventListener('click', async (e) => {
  if (e.target.id !== 'al-unsnooze') return;
  await fetch('/api/alerts/snooze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 0 }) });
  refresh();
});

// ---- video cards
const cards = new Map(); // file -> {el, refs}

function cardFor(v) {
  let c = cards.get(v.file);
  if (c) return c;
  const el = $('video-card').content.firstElementChild.cloneNode(true);
  const q = (sel) => el.querySelector(sel);
  const refs = {
    thumb: q('.thumb video'), dur: q('.dur'), title: q('.title'), enabled: q('.enabled'), meta: q('.meta'),
    every: q('.every'), mode: q('.mode'), forWrap: q('.for-wrap'), playfor: q('.playfor'), start: q('.start'),
    volume: q('.volume'), volV: q('.vol-v'), next: q('.next'), play: q('.play'), del: q('.delete'),
  };
  const f = v.file;
  refs.thumb.src = `${v.url}#t=1`;
  refs.thumb.addEventListener('loadedmetadata', () => {
    const d = refs.thumb.duration;
    refs.dur.textContent = fmtDur(d);
    // Tell the server how long it is, so the scheduler knows when it ends.
    const known = state.videos.find((x) => x.file === f)?.durationS;
    if (Number.isFinite(d) && (known == null || Math.abs(known - d) > 0.5)) queue({ videos: { [f]: { durationS: d } } });
  });
  refs.title.addEventListener('input', () => queue({ videos: { [f]: { title: refs.title.value } } }));
  refs.enabled.addEventListener('change', () => { el.classList.toggle('off', !refs.enabled.checked); queue({ videos: { [f]: { enabled: refs.enabled.checked } } }); });
  refs.every.addEventListener('change', () => queue({ videos: { [f]: { everyMin: Number(refs.every.value) } } }));
  refs.mode.addEventListener('change', () => {
    const full = refs.mode.value === 'full';
    refs.forWrap.hidden = full;
    if (!full && !refs.playfor.value) refs.playfor.value = 30;
    queue({ videos: { [f]: { playFor: full ? null : Number(refs.playfor.value) } } });
  });
  refs.playfor.addEventListener('change', () => queue({ videos: { [f]: { playFor: Number(refs.playfor.value) } } }));
  refs.start.addEventListener('change', () => queue({ videos: { [f]: { startAt: Number(refs.start.value) } } }));
  refs.volume.addEventListener('input', () => {
    refs.volV.textContent = Number(refs.volume.value) ? `${Math.round(refs.volume.value * 100)}%` : 'muted';
    queue({ videos: { [f]: { volume: Number(refs.volume.value) } } });
  });
  refs.play.addEventListener('click', async () => {
    await flush();
    const res = await fetch('/api/video/play', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: f }) });
    flash(res.ok ? 'playing on the visualizer' : 'could not play', !res.ok);
    refresh();
  });
  refs.del.addEventListener('click', async () => {
    if (!confirm(`Delete "${refs.title.value || f}"? This removes the file from the media folder.`)) return;
    const res = await fetch(`/api/videos/${encodeURIComponent(f)}`, { method: 'DELETE' });
    if (res.ok) { el.remove(); cards.delete(f); apply(await res.json(), true); flash('deleted'); }
  });
  c = { el, refs };
  cards.set(f, c);
  return c;
}

function renderVideos(fromServer) {
  const list = $('videos');
  const seen = new Set();
  for (const v of state.videos) {
    seen.add(v.file);
    const { el, refs } = cardFor(v);
    if (el.parentNode !== list) list.appendChild(el);
    // Don't overwrite a field the user is typing in.
    const idle = (input) => document.activeElement !== input;
    if (fromServer) {
      if (idle(refs.title)) refs.title.value = v.title;
      refs.enabled.checked = v.enabled;
      if (idle(refs.every)) refs.every.value = v.everyMin;
      if (idle(refs.mode)) refs.mode.value = v.playFor ? 'for' : 'full';
      refs.forWrap.hidden = !v.playFor;
      if (idle(refs.playfor) && v.playFor) refs.playfor.value = v.playFor;
      if (idle(refs.start)) refs.start.value = v.startAt;
      if (idle(refs.volume)) refs.volume.value = v.volume;
      refs.volV.textContent = v.volume ? `${Math.round(v.volume * 100)}%` : 'muted';
      el.classList.toggle('off', !v.enabled);
    }
    refs.meta.textContent = `${v.file} · ${fmtSize(v.size)}${v.durationS ? ` · ${fmtDur(v.durationS)}` : ''}`;
  }
  for (const [f, c] of cards) if (!seen.has(f)) { c.el.remove(); cards.delete(f); }
  $('empty').hidden = state.videos.length > 0;
  renderStatus();
}

function renderStatus() {
  const st = state.status;
  if (!st) return;
  const skew = Date.now() - state.statusAt; // countdowns tick locally between polls
  const now = st.now + skew;
  const studio = { playing: 'playing', paused: 'paused', stopped: 'stopped', offline: 'offline' }[st.studio] ?? st.studio;
  let soonest = null;
  for (const v of state.videos) {
    const c = cards.get(v.file);
    if (!c) continue;
    const isNow = st.current?.file === v.file;
    c.el.classList.toggle('now', isNow);
    const due = st.next[v.file];
    c.refs.next.textContent = isNow ? '● on screen now'
      : !v.enabled ? 'not scheduled'
        : !state.schedule.enabled ? 'schedule paused'
          : due != null ? `next ${countdown(due - now)}` : '';
    if (v.enabled && due != null && (!soonest || due < soonest.due)) soonest = { due, title: v.title || v.file };
  }
  const gate = state.schedule.when === 'not-playing' ? ' · waits while Studio plays' : state.schedule.when === 'playing' ? ' · only while Studio plays' : '';
  $('status').innerHTML = !state.schedule.enabled
    ? 'Schedule is <b>off</b>. Videos only play with “Play now”.'
    : st.current ? `On screen: <b>${escapeHtml(state.videos.find((v) => v.file === st.current.file)?.title ?? st.current.file)}</b> · Studio ${studio}`
      : soonest ? `Next: <b>${escapeHtml(soonest.title)}</b> ${countdown(soonest.due - now)} · Studio ${studio}${gate}`
        : `Nothing scheduled · Studio ${studio}`;
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function apply(data, fromServer = true) {
  if (data.schedule) { state.schedule = data.schedule; renderSchedule(); }
  if (data.visual) { state.visual = data.visual; renderVisual(); }
  if (data.alerts) { state.alerts = data.alerts; renderAlerts(); }
  if (data.videos) state.videos = data.videos;
  if (data.status) { state.status = data.status; state.statusAt = Date.now(); }
  if (data.mediaDir) $('media-dir').textContent = data.mediaDir;
  renderVideos(fromServer);
}

async function refresh() {
  try {
    const res = await fetch('/api/settings');
    apply(await res.json(), Object.values(pending).every((p) => Object.keys(p).length === 0));
  } catch {
    $('status').textContent = 'Visualizer server not reachable.';
  }
}

// ---- uploads
function upload(file) {
  const row = document.createElement('div');
  row.className = 'upload';
  row.innerHTML = '<span></span><div class="track"><i></i></div>';
  row.firstChild.textContent = `Uploading ${file.name} (${fmtSize(file.size)})…`;
  $('uploads').appendChild(row);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/videos?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) row.querySelector('i').style.width = `${(e.loaded / e.total) * 100}%`; };
  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* keep {} */ }
    if (xhr.status === 200) {
      row.remove();
      apply(data, true);
      flash(`added ${data.file}`);
    } else {
      row.classList.add('err');
      row.firstChild.textContent = `${file.name}: ${data.error ?? xhr.statusText}`;
    }
  };
  xhr.onerror = () => { row.classList.add('err'); row.firstChild.textContent = `${file.name}: upload failed`; };
  xhr.send(file);
}
$('file').addEventListener('change', (e) => { [...e.target.files].forEach(upload); e.target.value = ''; });
const drop = $('drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); [...e.dataTransfer.files].forEach(upload); });

refresh();
setInterval(refresh, 3000);
setInterval(renderStatus, 1000);
