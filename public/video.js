// Scheduled video takeovers. The server decides when a video is due and sends
// `video-play`; this layer transitions from the visualizer into the video
// (iris from the orbit, crossfade or glitch), plays it, and transitions back.

const ROOT = document.documentElement;

export function createVideo({ layer, veil, video, overlay, orbitEl }) {
  let active = null;   // { cmd, shownAt, leaving }
  let endTimer = null;
  let token = 0;       // guards against overlapping play/stop calls

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const once = (el, ev, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${ev} timeout`)), ms);
    el.addEventListener(ev, () => { clearTimeout(t); resolve(); }, { once: true });
  });

  function setGeometry(cmd) {
    const r = orbitEl.getBoundingClientRect();
    ROOT.style.setProperty('--vt', `${cmd.transitionMs}ms`);
    for (const el of [layer, veil]) {
      el.style.setProperty('--cx', `${r.left + r.width / 2}px`);
      el.style.setProperty('--cy', `${r.top + r.height / 2}px`);
    }
    layer.dataset.transition = cmd.transition;
  }

  async function report(file) {
    try {
      await fetch('/api/video/ended', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }) });
    } catch { /* server gone: nothing to tell */ }
  }

  function teardown() {
    clearTimeout(endTimer);
    video.pause();
    video.removeAttribute('src');
    video.load();
    layer.classList.remove('on', 'shown', 'leaving');
    document.body.classList.remove('video-on', 'video-overlay');
    overlay.hidden = true;
    active = null;
  }

  async function play(cmd) {
    const my = ++token;
    if (active) teardown();
    setGeometry(cmd);
    video.loop = false;
    video.muted = !(cmd.volume > 0);
    video.volume = 0;
    video.src = cmd.url;
    try {
      await once(video, 'loadedmetadata', 10000);
      if (my !== token) return;
      const remaining = video.duration - (cmd.startAt || 0);
      if (cmd.startAt && cmd.startAt < video.duration) video.currentTime = cmd.startAt;
      // Asked to show it longer than it runs: loop it.
      if (cmd.playFor && Number.isFinite(remaining) && cmd.playFor > remaining) video.loop = true;
      try {
        await video.play();
      } catch {
        video.muted = true; // autoplay with sound refused: play silently rather than not at all
        await video.play();
      }
    } catch (err) {
      console.warn('video failed', cmd.file, err);
      if (my === token) { teardown(); report(cmd.file); }
      return;
    }
    if (my !== token) return;

    active = { cmd, shownAt: performance.now(), leaving: false };
    layer.classList.add('on');
    void layer.offsetWidth; // commit the start state so the transition runs
    layer.classList.add('shown');
    document.body.classList.add('video-on');
    if (cmd.overlay) document.body.classList.add('video-overlay');
    overlay.hidden = !cmd.overlay;
    overlay.querySelector('[data-k=title]').textContent = cmd.title;

    // End on the requested length, else on the video's own length. Files without
    // duration metadata (common for recorded webm) may never fire 'ended', so the
    // timer and the stall watchdog in tick() are the backstops.
    const ownLength = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : cmd.durationS;
    const lengthS = cmd.playFor ?? (ownLength ? Math.max(0.5, ownLength - (cmd.startAt || 0)) + 0.4 : null);
    if (lengthS) endTimer = setTimeout(() => leave(cmd.playFor ? 'time' : 'ended'), lengthS * 1000);
    active.lastTime = video.currentTime;
    active.lastProgressAt = performance.now();
    video.onended = () => leave('ended');
    video.onerror = () => leave('error');
  }

  async function leave(reason, transitionMs) {
    if (!active || active.leaving) return;
    const my = token;
    const { cmd } = active;
    active.leaving = true;
    active.leftAt = performance.now();
    clearTimeout(endTimer);
    if (transitionMs) ROOT.style.setProperty('--vt', `${transitionMs}ms`);
    layer.classList.add('leaving');
    layer.classList.remove('shown');
    document.body.classList.remove('video-on', 'video-overlay');
    await wait(transitionMs ?? cmd.transitionMs);
    if (my !== token) return;
    teardown();
    report(cmd.file);
    console.info('video done', cmd.file, reason);
  }

  return {
    play,
    stop: (cmd) => leave('stopped', cmd?.transitionMs),
    get playing() { return !!active; },
    // Fully on screen: the visualizer behind it can skip rendering.
    covering(now) {
      return !!active && !active.leaving && now - active.shownAt > active.cmd.transitionMs + 100;
    },
    // Audio follows the picture in and out.
    tick(now) {
      if (!active) return;
      if (!active.leaving) {
        if (video.currentTime !== active.lastTime) { active.lastTime = video.currentTime; active.lastProgressAt = now; }
        else if (now - active.lastProgressAt > 4000) leave('stalled');
      }
      if (video.muted) return;
      const t = active.cmd.transitionMs;
      const v = active.leaving
        ? Math.max(0, 1 - (now - active.leftAt) / t)
        : Math.min(1, (now - active.shownAt) / t);
      video.volume = Math.max(0, Math.min(1, active.cmd.volume * v));
    },
    renderOverlay(fields) {
      if (overlay.hidden) return;
      for (const [k, v] of Object.entries(fields)) {
        const el = overlay.querySelector(`[data-k=${k}]`);
        if (el && el.textContent !== v) el.textContent = v;
      }
    },
  };
}
