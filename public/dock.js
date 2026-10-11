// On-screen controls: looks, themes, rotation, demo, fullscreen. Appears when
// the pointer moves and fades after a few idle seconds so the booth screen
// stays clean. Choices are saved to settings, so every screen follows; picking
// a look or theme stops that rotation (otherwise the screen would jump away).

const IDLE_MS = 3500;
const ROTATE_DEFAULT = { looks: 2, themes: 5 }; // minutes when rotation is switched on

async function save(visual) {
  try {
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visual }) });
  } catch { /* offline: the local switch already happened */ }
}

// Rotation is wall-clock based (every screen agrees). Pick the starting entry so
// that turning rotation on keeps what's on screen now until the next step.
function rotationStart(list, currentId, minutes) {
  const slot = Math.floor(Date.now() / (minutes * 60000)) % list.length;
  const cur = Math.max(0, list.findIndex((t) => t.id === currentId));
  return list[(cur - slot + list.length) % list.length].id;
}

export function createDock({ el, treatments, themes, current, onLook, onTheme, onDemo, onFullscreen }) {
  const btn = (group, id, label, title = '') => `<button type="button" data-group="${group}" data-id="${id}" title="${title}">${label}</button>`;
  el.innerHTML = `
    <div class="dk-group" role="group" aria-label="Look">
      <span class="dk-k">look</span>
      ${treatments.map((t, i) => btn('look', t.id, t.name, `${t.name} (${i + 1})`)).join('')}
      <button type="button" class="dk-rot" data-group="rotate" data-id="looks" title="Loop through the looks (interval set in Settings)">↻</button>
    </div>
    <div class="dk-group" role="group" aria-label="Theme">
      <span class="dk-k">theme</span>
      ${themes.map((t, i) => btn('theme', t.id, t.name.replace('Inference ', ''), `${t.name} (Shift+${i + 1})`)).join('')}
      <button type="button" class="dk-rot" data-group="rotate" data-id="themes" title="Rotate themes every ${ROTATE_DEFAULT.themes} min">↻</button>
    </div>
    <div class="dk-group" role="group" aria-label="Display">
      ${btn('demo', 'demo', 'Demo', 'Demo mode (D)')}
      ${btn('full', 'full', '⛶', 'Fullscreen (F)')}
      <a class="dk-link" href="/status" title="Status of Studio, robot and Hermes">Status</a>
    </div>`;

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const { group, id } = b.dataset;
    const v = current().visual;
    if (group === 'look') { onLook(id); save({ treatment: id, rotateMin: 0 }); }
    if (group === 'theme') { onTheme(id); save({ theme: id, themeRotateMin: 0 }); }
    if (group === 'rotate' && id === 'looks') {
      const every = v.rotateEvery || ROTATE_DEFAULT.looks; // the interval chosen in Settings
      save(v.rotateMin ? { rotateMin: 0, treatment: current().treatment } : { rotateMin: every, rotateEvery: every, treatment: rotationStart(treatments, current().treatment, every) });
    }
    if (group === 'rotate' && id === 'themes') {
      save(v.themeRotateMin ? { themeRotateMin: 0, theme: current().theme } : { themeRotateMin: ROTATE_DEFAULT.themes, theme: rotationStart(themes, current().theme, ROTATE_DEFAULT.themes) });
    }
    if (group === 'demo') onDemo();
    if (group === 'full') onFullscreen();
    wake();
  });

  // Highlight what's actually on screen.
  function sync() {
    const c = current();
    for (const b of el.querySelectorAll('button')) {
      const { group, id } = b.dataset;
      const on = (group === 'look' && id === c.treatment) || (group === 'theme' && id === c.theme)
        || (group === 'rotate' && id === 'looks' && c.visual.rotateMin > 0)
        || (group === 'rotate' && id === 'themes' && c.visual.themeRotateMin > 0)
        || (group === 'demo' && c.demo) || (group === 'full' && !!document.fullscreenElement);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  setInterval(sync, 400);
  sync();

  // Show on pointer activity, hide when idle (but never while hovered or focused).
  let timer = null;
  function wake() {
    el.classList.add('show');
    document.body.classList.remove('idle');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (el.matches(':hover') || el.contains(document.activeElement)) return wake();
      el.classList.remove('show');
      document.body.classList.add('idle');
    }, IDLE_MS);
  }
  for (const ev of ['pointermove', 'pointerdown', 'touchstart']) window.addEventListener(ev, wake, { passive: true });
  el.addEventListener('focusin', wake);
  document.body.classList.add('idle');
  return { wake };
}
