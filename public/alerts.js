// Full-screen red takeover when a critical connection is lost (Studio, the
// Orchid, the robot console, an arm, Hermes, WhatsApp). The server decides
// what's active (debounced, muted groups removed); this renders it, ticks the
// "lost for" timers, offers snooze, and flashes green when everything is back.

import { tipsHtml, enableCopy } from './tips.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const since = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export function createAlerts({ el, restoredEl, isDemo }) {
  let state = { active: [], snoozedUntil: 0 };
  let shownIds = '';
  let wasShowing = false;
  let mutedBefore = 0;
  const list = el.querySelector('.al-list');
  const count = el.querySelector('.al-count');

  async function snooze(minutes) {
    try {
      await fetch('/api/alerts/snooze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes }) });
    } catch { /* server gone: the alert stays, which is right */ }
  }
  enableCopy(el);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-snooze]');
    if (b) snooze(Number(b.dataset.snooze));
  });

  function render() {
    const snoozed = state.snoozedUntil > Date.now();
    const show = state.active.length > 0 && !snoozed && !isDemo();
    if (show) {
      const ids = state.active.map((a) => a.id + a.title + a.detail + (a.tips?.length ?? 0)).join('|');
      if (ids !== shownIds) {
        shownIds = ids;
        list.innerHTML = state.active.map((a) => `
          <li data-id="${esc(a.id)}">
            <div class="al-title">${esc(a.title)}</div>
            <div class="al-detail">${esc(a.detail)}</div>
            <div class="al-since">lost for <span data-since="${a.since}">${since(a.since)}</span></div>
            ${a.tips?.length ? `<div class="al-tips"><div class="al-tips-k">try this</div>${tipsHtml(a.tips)}</div>` : ''}
          </li>`).join('');
        count.textContent = state.active.length === 1 ? 'connection lost' : `${state.active.length} connections lost`;
      }
      for (const s of list.querySelectorAll('[data-since]')) s.textContent = since(Number(s.dataset.since));
    }
    if (show !== !el.hidden) {
      el.hidden = !show;
      document.body.classList.toggle('alerting', show);
    }
    // Everything came back (not snoozed, not muted away): brief green all-clear.
    if (wasShowing && state.active.length === 0 && (state.muted ?? 0) <= mutedBefore) {
      restoredEl.hidden = false;
      restoredEl.classList.remove('go');
      void restoredEl.offsetWidth;
      restoredEl.classList.add('go');
      clearTimeout(render.t);
      render.t = setTimeout(() => { restoredEl.hidden = true; }, 3200);
    }
    wasShowing = show;
    mutedBefore = state.muted ?? 0;
  }

  setInterval(render, 1000);
  return {
    update(payload) { state = payload; render(); },
    render,
  };
}
