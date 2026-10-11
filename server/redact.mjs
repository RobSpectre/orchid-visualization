// Secret redaction for everything the server forwards to browsers.
// Agent transcripts include tool calls and their output, which can echo env
// vars, config files, auth headers or tokens. All text passes through
// redact() server-side, so unredacted values never reach the page.

const MASK = '«redacted»';

// Key names whose values are treated as secrets: `KEY=v`, `key: v`, `"key": "v"`.
const SENSITIVE_KEY = /(^|[^a-z])(api[_-]?key|apikey|secret|client[_-]?secret|token|access[_-]?key|private[_-]?key|password|passwd|pwd|passphrase|credentials?|authorization|auth|cookie|session[_-]?key|signature|x-orchid-token)s?($|[^a-z])/i;

const RULES = [
  // PEM private keys (also an unterminated block at the end of the text)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => `${MASK} (private key)`],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, () => MASK],
  // Provider key formats
  [/\b(?:sk|rk|pk)[-_](?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,}/g, () => MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, () => MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, () => MASK],
  [/\b(?:hf|glpat|npm|nvapi)[-_][A-Za-z0-9_-]{20,}/g, () => MASK],
  [/\bv1\.[A-Za-z0-9_\-+/=.]{40,}/g, () => MASK], // Nebius-style v1.<base64> keys
  // Authorization headers
  [/\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{12,})/g, (m, kind, sp, value) => (
    // Prose like "Token Factory-hosted" has no digits; credentials nearly always do.
    /\d/.test(value) || value.length >= 24 ? `${kind}${sp}${MASK}` : m
  )],
  // Credentials embedded in URLs
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, (_, scheme) => `${scheme}${MASK}@`],
  // CLI flags: --token abc, --api-key=abc, -p secret
  [/(--?(?:api[-_]?key|token|access[-_]?token|auth[-_]?token|password|passwd|secret|client[-_]?secret)(?:=|\s+))(["']?)[^\s"']{4,}\2/gi, (_, flag, q) => `${flag}${q}${MASK}${q}`],
  // key/value pairs (env, YAML, JSON, Python reprs, HTTP headers)
  [/(["']?)([A-Za-z_][\w.-]{0,60})\1(\s*(?:=>|=|:)\s*)(["']?)([^\s"',;}{)\]]+)/g, (m, q1, key, sep, q2, value) => {
    if (!SENSITIVE_KEY.test(key)) return m;
    // Numbers, booleans and short words (token counts, "auth: none") aren't secrets.
    if (!/[A-Za-z]/.test(value) || value.length < 6 || /^(true|false|null|none|undefined|required|optional|enabled|disabled)$/i.test(value)) return m;
    return `${q1}${key}${q1}${sep}${q2}${MASK}`;
  }],
  // High-entropy fallback: long tokens mixing upper, lower and digits.
  // Git SHAs and request ids (lowercase hex) don't qualify; paths are skipped.
  [/(?<![\w/.-])[A-Za-z0-9_+=-]{32,}(?![\w/.-])/g, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? MASK : m)],
  // WhatsApp JIDs / phone numbers: keep the chat visible, hide the number.
  [/\+?\d[\d ()-]{6,}\d(@(?:s\.whatsapp\.net|c\.us|g\.us|lid))/g, (_, domain) => `•••${domain}`],
  [/(\b[A-Z0-9_]*(?:ALLOWED_USERS|PHONE|NUMBERS?|CHAT_ID)[A-Z0-9_]*\s*[=:]\s*["']?)[+\d][\d ,+()-]{5,}/gi, (_, key) => `${key}•••`],
  [/(?<![\w.])\+\d{10,15}\b/g, () => '+•••'],
];

export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const [re, fn] of RULES) out = out.replace(re, fn);
  return out;
}

// A text tail that might be the start of a secret split across stream chunks:
// a sensitive key and separator, an auth scheme, or a flag waiting for its value.
const PENDING_TAIL = /(?:(["']?)([A-Za-z_][\w.-]{0,60})\1\s*(?:=>|=|:)\s*["']?|\b(?:Bearer|Basic|Token)\s*|--?[\w-]{2,40}[= ]?\s*|-----BEGIN[\s\S]*)$/;

// Streaming redactor: holds back the trailing partial word (and any pending
// "key:" tail) until the next chunk, so secrets split across deltas are still
// caught. flush() releases what's left at end of stream.
export function createStreamRedactor() {
  let buf = '';
  return {
    push(delta) {
      buf += delta;
      if (buf.length > 16384) buf = buf.slice(-16384);
      let cut = Math.max(buf.lastIndexOf(' '), buf.lastIndexOf('\n'));
      if (cut < 0) return '';
      let head = buf.slice(0, cut + 1);
      const tail = PENDING_TAIL.exec(head);
      if (tail && (tail[0].startsWith('-----BEGIN') || /^(Bearer|Basic|Token|-)/.test(tail[0]) || SENSITIVE_KEY.test(tail[2] ?? ''))) {
        cut = tail.index - 1;
        head = buf.slice(0, cut + 1);
      }
      buf = buf.slice(cut + 1);
      return redact(head);
    },
    flush() {
      const out = redact(buf);
      buf = '';
      return out;
    },
  };
}
