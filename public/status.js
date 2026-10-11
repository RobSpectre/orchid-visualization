// Status page: polls /api/health every 2 s and renders one card per system.
import { tipsHtml, enableCopy } from './tips.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = { ok: 'ok', warn: 'attention', down: 'down', info: 'info' };
const VERDICT = {
  ok: 'All systems go',
  warn: 'Running — something needs attention',
  down: 'Something is down',
};
let lastOk = 0;
let lastHtml = '';
enableCopy(document);

function card(sys) {
  const checks = sys.checks.map((c) => `
    <li data-status="${c.status}"><span class="light"></span><span class="name">${esc(c.name)}</span><span class="detail">${esc(c.detail)}</span>${c.tips?.length ? `<div class="check-tips">${tipsHtml(c.tips)}</div>` : ''}</li>`).join('');
  const facts = sys.facts?.length
    ? `<dl class="facts">${sys.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
  const events = sys.events?.length
    ? `<ul class="events">${sys.events.map((e) => `<li class="${e.level === 'WARNING' ? '' : 'err'}"><span class="when">${new Date(e.at).toLocaleTimeString('en-GB')}</span><b>${esc(e.level)}</b>${esc(e.text)}</li>`).join('')}</ul>` : '';
  return `
    <section class="card sys" data-status="${sys.status}" id="sys-${sys.id}">
      <div class="head"><span class="light"></span><h2>${esc(sys.name)}</h2><span class="pill">${LABEL[sys.status]}</span></div>
      <p class="summary">${esc(sys.summary)}</p>
      <ul class="checks">${checks}</ul>
      ${facts}${events}
    </section>`;
}

async function refresh() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    const h = await res.json();
    lastOk = Date.now();
    const v = $('verdict');
    v.dataset.status = h.overall;
    $('v-title').textContent = VERDICT[h.overall] ?? h.overall;
    const bad = h.systems.slice(0, 3).filter((s) => s.status !== 'ok' && s.status !== 'info');
    $('v-sub').textContent = bad.length
      ? bad.map((s) => `${s.name}: ${s.summary}`).join(' · ')
      : 'Orchid Studio · orchid-robot · Hermes Agent';
    const html = h.systems.map(card).join('');
    if (html !== lastHtml) { $('systems').innerHTML = html; lastHtml = html; }
    document.title = `${h.overall === 'ok' ? '●' : h.overall === 'warn' ? '▲' : '✕'} Orchid Signal Status`;
  } catch {
    const v = $('verdict');
    v.dataset.status = 'down';
    $('v-title').textContent = 'Visualizer server unreachable';
    $('v-sub').innerHTML = tipsHtml([{ text: 'Start the visualizer server:', cmd: 'cd ~/workspace/orchid-visualization && npm start' }, { text: 'Then reload this page.' }]);
  }
}

function tick() {
  $('updated').textContent = lastOk ? `updated ${Math.round((Date.now() - lastOk) / 1000)}s ago` : '';
  $('updated').className = 'saved show';
}

refresh();
setInterval(refresh, 2000);
setInterval(tick, 1000);
