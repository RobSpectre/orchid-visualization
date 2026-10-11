// Renders diagnostic tips ({text, cmd?}) as numbered steps. Commands copy on
// click; URLs open in a new tab.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function tipsHtml(tips) {
  if (!tips?.length) return '';
  return `<ol class="tips">${tips.map((t) => `<li><span class="tip-text">${esc(t.text)}</span>${t.cmd ? cmdHtml(t.cmd) : ''}</li>`).join('')}</ol>`;
}

function cmdHtml(cmd) {
  if (/^(https?:\/\/|\/)/.test(cmd)) return ` <a class="tip-link" href="${esc(cmd)}" target="_blank" rel="noopener">${esc(cmd)} ↗</a>`;
  return `<code class="tip-cmd" role="button" tabindex="0" title="Click to copy">${esc(cmd)}</code>`;
}

// One delegated handler per page: click (or Enter) on a command copies it.
export function enableCopy(root = document) {
  const copy = async (el) => {
    try {
      await navigator.clipboard.writeText(el.textContent);
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1200);
    } catch { /* clipboard blocked: the text is still selectable */ }
  };
  root.addEventListener('click', (e) => { const c = e.target.closest('.tip-cmd'); if (c) copy(c); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches?.('.tip-cmd')) copy(e.target); });
}
