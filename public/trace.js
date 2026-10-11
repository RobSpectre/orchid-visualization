// Hermes reasoning trace: new thoughts type out at the measured Token Factory
// speed; tool calls appear as chips; live stream deltas (when the optional
// hook is installed) render in a pulsing block until the finished message
// arrives (from state.db, or from the plugin when the session isn't saved
// there). A block nothing replaces is kept, so streamed reasoning never vanishes.

import { S, fire } from './state.js';

const MAX_ENTRIES = 24;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const time = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
// WhatsApp formatting on already-escaped text: *bold*, _italic_, ~strike~.
const chatMarkup = (s) => esc(s)
  .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
  .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>')
  .replace(/~([^~\n]+)~/g, '<s>$1</s>');
const CHAT_SOURCES = new Set(['whatsapp', 'telegram', 'signal', 'slack', 'discord', 'sms', 'imessage']);

export function createTrace(body, sessionEl, liveTag, factoryEl, chatEls) {
  const typing = []; // {el, text, shown}
  let liveEntry = null;
  const pending = []; // finished stream blocks waiting for their message: { el, at }
  const PENDING_MS = 8000;

  // A stream ended: keep its block until the finished message replaces it.
  function park() {
    if (!liveEntry) return;
    const hasText = liveEntry.querySelector('.think').textContent || liveEntry.querySelector('.say').textContent;
    if (hasText) pending.push({ el: liveEntry, at: performance.now() }); else liveEntry.remove();
    liveEntry = null;
  }
  // Nothing replaced it in time: it stays as the record of that step.
  function settle(now) {
    while (pending.length && now - pending[0].at > PENDING_MS) {
      const { el } = pending.shift();
      el.classList.remove('live');
      el.querySelector('.who').textContent = 'think';
    }
  }
  const chatSeen = new Set();
  let chatCount = 0;

  function addChat(m, fresh) {
    if (chatSeen.has(m.id)) return;
    chatSeen.add(m.id);
    chatCount++;
    const incoming = m.role === 'user';
    const el = document.createElement('div');
    el.className = `msg ${incoming ? 'in' : 'out'}${fresh ? ' fresh' : ''}`;
    const text = incoming ? stripEnvelope(m.content).slice(0, 1200) : m.content;
    el.innerHTML = `<div class="when">${incoming ? '▸ in' : 'hermes ▸'} · ${time(m.ts)}</div><div class="bubble">${chatMarkup(text)}</div>`;
    chatEls.body.appendChild(el);
    while (chatEls.body.children.length > 30) chatEls.body.removeChild(chatEls.body.firstChild);
    chatEls.wrap.hidden = false;
    chatEls.platform.textContent = m.source;
    chatEls.meta.textContent = `${chatCount} messages · last ${time(m.ts)}`;
  }

  function trim() {
    while (body.children.length > MAX_ENTRIES) body.removeChild(body.firstChild);
  }

  function addEntry(m, animate) {
    const el = document.createElement('div');
    const chat = CHAT_SOURCES.has(m.source);
    // A chat reply is the turn's final assistant text (no tool calls pending).
    const chatIn = chat && m.role === 'user';
    const chatOut = chat && m.role === 'assistant' && m.content && !m.tools.length && m.finish === 'stop';
    el.className = `entry ${m.role}${chatIn ? ' chat-in' : ''}${chatOut ? ' chat-out' : ''}`;
    const who = chatIn ? `${m.source} ▸ hermes`
      : chatOut ? `hermes ▸ ${m.source}`
        : m.role === 'assistant' ? (m.reasoning ? 'think' : 'say') : m.role === 'tool' ? `↳ ${m.toolName ?? 'tool'}` : 'user';
    const badge = m.source && !chat ? `<span class="plat">${esc(m.source)}</span>` : '';
    let html = `<div class="meta"><span class="who">${esc(who)}</span>${badge}<span>${time(m.ts)}</span>${m.finish && !chatOut ? `<span>${esc(m.finish)}</span>` : ''}</div>`;
    if (m.role === 'assistant') {
      if (m.reasoning) html += `<div class="think"></div>`;
      if (m.content) html += chatOut ? `<div class="bubble">${chatMarkup(m.content)}</div>` : `<div class="say">${esc(m.content)}</div>`;
      for (const t of m.tools) html += `<span class="chip"><b>${esc(t.name)}</b>${esc(summarizeArgs(t.args))}</span>`;
    } else if (m.role === 'tool') {
      html += `<div class="out">${esc(m.content)}</div>`;
    } else if (chatIn) {
      html += `<div class="bubble">${chatMarkup(stripEnvelope(m.content).slice(0, 1200))}</div>`;
    } else {
      html += `<div class="say">${esc(stripEnvelope(m.content).slice(0, 400))}</div>`;
    }
    el.innerHTML = html;
    const think = el.querySelector('.think');
    if (think) {
      if (animate) {
        think.innerHTML = '<span class="txt"></span><span class="caret"></span>';
        typing.push({ el: think.firstChild, caret: think.lastChild, text: m.reasoning, shown: 0 });
      } else {
        think.textContent = m.reasoning;
      }
    }
    body.appendChild(el);
    trim();
  }

  function summarizeArgs(args) {
    try {
      const o = JSON.parse(args);
      const v = o.command ?? o.query ?? o.path ?? o.url ?? Object.values(o)[0];
      return typeof v === 'string' ? v.replace(/\s+/g, ' ') : JSON.stringify(v);
    } catch {
      return args;
    }
  }

  // Gateway messages wrap user text in an out-of-band envelope; show the payload.
  function stripEnvelope(s) {
    return String(s ?? '').replace(/^\[[A-Z \-—]+\][^\n]*\n?/, '').trim() || String(s ?? '');
  }

  function factoryRect() {
    const r = factoryEl.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.3, w: r.width * 0.7, h: r.height * 0.2 };
  }


  function chatRect() {
    const r = chatEls.body.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 30, w: r.width * 0.8, h: 30 };
  }

  return {
    chat({ backfill, messages }) {
      if (backfill) {
        chatEls.body.innerHTML = '';
        chatSeen.clear();
        chatCount = 0;
        chatEls.wrap.hidden = !messages.length;
      }
      for (const m of messages) {
        addChat(m, !backfill);
        if (!backfill && m.role === 'user') {
          // Incoming chat message: its letters fly from the chat into the orbit.
          fire('tokens', { from: chatRect(), count: Math.max(30, m.content.length * 2), text: m.content, colors: ['#87EDDC', '#AFF8EC'] });
          fire('chat', m);
        }
      }
    },
    messages({ backfill, messages }) {
      if (backfill) {
        body.innerHTML = '';
        typing.length = 0;
        messages.slice(-MAX_ENTRIES).forEach((m) => addEntry(m, false));
        return;
      }
      // Each finished assistant message replaces the oldest waiting stream block (or the live one).
      for (const m of messages) {
        if (m.role !== 'assistant') continue;
        const p = pending.shift();
        if (p) p.el.remove();
        else if (liveEntry) { liveEntry.remove(); liveEntry = null; }
      }
      for (const m of messages) {
        addEntry(m, true);
        if (m.role === 'assistant') {
          S.fx.think = 1;
          const text = `${m.reasoning}${m.content}`;
          fire('tokens', { from: factoryRect(), count: Math.max(20, text.length / 4), text });
        }
      }
    },
    session(s) {
      sessionEl.textContent = `${s.source ?? ''} · ${s.title ?? 'untitled'} · ${s.id}`;
      if (s.turnActive) S.fx.think = Math.max(S.fx.think, 0.8);
    },
    stream(batch) {
      liveTag.textContent = 'live';
      liveTag.classList.add('live');
      for (const e of batch) {
        if (e.type === 'stream_end') park();
        if (e.type === 'stream_start' || (e.type === 'delta' && !liveEntry)) {
          park();
          liveEntry = document.createElement('div');
          liveEntry.className = 'entry assistant live';
          liveEntry.innerHTML = `<div class="meta"><span class="who">streaming</span><span>${time(Date.now())}</span></div><div class="think"></div><div class="say"></div>`;
          body.appendChild(liveEntry);
          trim();
        }
        if (e.type === 'delta' && liveEntry) {
          const target = liveEntry.querySelector(e.kind === 'reasoning' ? '.think' : '.say');
          target.textContent = (target.textContent + e.delta).slice(-1200);
          S.fx.think = 1;
        }
      }
    },
    tick(dt) {
      settle(performance.now());
      // Type at the latest measured speed (≈4 chars/token), clamped for legibility.
      const tps = S.hermes.calls.at(-1)?.tps ?? 40;
      const cps = Math.min(900, Math.max(80, tps * 4 * 2));
      for (let i = typing.length - 1; i >= 0; i--) {
        const t = typing[i];
        t.shown = Math.min(t.text.length, t.shown + (cps * dt) / 1000);
        t.el.textContent = t.text.slice(0, Math.floor(t.shown));
        if (t.shown >= t.text.length) { t.caret.remove(); typing.splice(i, 1); }
      }
    },
  };
}
