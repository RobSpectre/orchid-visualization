import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, createStreamRedactor } from '../server/redact.mjs';

// Fake credentials assembled at runtime so the source has no secret-shaped literals.
const k = (prefix, n = 32) => prefix + 'Ab3'.repeat(Math.ceil(n / 3)).slice(0, n);

const SECRETS = [
  ['env export', `export NEBIUS_API_KEY=${k('', 40)}`],
  ['yaml', `api_key: "${k('', 30)}"`],
  ['json', `{"access_token": "${k('', 28)}", "model": "x"}`],
  ['python repr', `{'password': 'hunter2-correct-horse'}`],
  ['bearer', `Authorization: Bearer ${k('', 40)}`],
  ['header', `x-orchid-token: ${k('', 24)}`],
  ['openai', `key is ${k('sk-proj-', 30)}`],
  ['anthropic', `${k('sk-ant-', 40)}`],
  ['github', `${k('ghp_', 36)}`],
  ['slack', `${k('xoxb-', 30)}`],
  ['aws', 'AKIA' + 'ABCDEFGHIJ012345'],
  ['nebius v1', `${k('v1.', 60)}`],
  ['jwt', `eyJ${k('', 20)}.eyJ${k('', 20)}.${k('', 16)}`],
  ['url creds', `postgres://admin:${k('', 12)}@db.local:5432/x`],
  ['cli flag', `hermes login --token ${k('', 20)}`],
  ['pem', `-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----`],
  ['entropy', `blob ${k('', 48)} end`],
];

for (const [name, text] of SECRETS) {
  test(`redacts ${name}`, () => {
    const out = redact(text);
    assert.match(out, /«redacted»/, out);
    // No 12+ char run of the original secret material survives.
    assert.doesNotMatch(out, /Ab3Ab3Ab3Ab3/, out);
    assert.doesNotMatch(out, /hunter2|MIIabc|ABCDEFGHIJ012345/, out);
  });
}

const BENIGN = [
  'API call #8: model=deepseek-ai/DeepSeek-V4.1-Flash provider=nebius-token-factory in=26392 out=120 latency=1.7s',
  '{"input_tokens": 26392, "max_tokens": 4096, "token_count": 0, "auth": "none"}',
  'Nebius Token Factory hosts DeepSeek-V4.1-Flash; tokenizer: deepseek-v4',
  'session 20261009_142203_678b4dfc id=91f61ad598c045e08a244879d1ac2ab5 commit 517b5e10fe',
  'cd ~/.hermes/skills/orchid/orchid-robot-jam && python3 scripts/orchid_jam.py stop',
  "{'status': 'ok', 'command': 'panic', 'playing': False}",
  'Play a four chord progression in the key of F',
  'author: ArtemioLabs, password policy is documented below',
];

for (const text of BENIGN) {
  test(`leaves benign text alone: ${text.slice(0, 40)}`, () => {
    assert.equal(redact(text), text);
  });
}

test('masks WhatsApp JIDs but keeps the message', () => {
  const out = redact('from 15551234567@s.whatsapp.net: Stop');
  assert.equal(out, 'from •••@s.whatsapp.net: Stop');
});

test('stream redactor catches a secret split across deltas', () => {
  const r = createStreamRedactor();
  const secret = k('', 30);
  const chunks = ['Setting the env: NEBIUS_', 'API_KEY=', secret.slice(0, 10), secret.slice(10), ' and continuing.'];
  const out = chunks.map((c) => r.push(c)).join('') + r.flush();
  assert.doesNotMatch(out, /Ab3Ab3/, out);
  assert.match(out, /«redacted»/);
  assert.match(out, /and continuing\./);
});

test('stream redactor holds a bearer scheme until its value arrives', () => {
  const r = createStreamRedactor();
  const out = ['curl -H "Authorization: Bearer ', k('', 40), '" https://x'].map((c) => r.push(c)).join('') + r.flush();
  assert.doesNotMatch(out, /Ab3Ab3/, out);
});

test('masks phone numbers in allow-lists and +E.164 form', () => {
  assert.equal(redact('WHATSAPP_ALLOWED_USERS=15551234567,15557654321'), 'WHATSAPP_ALLOWED_USERS=•••');
  assert.equal(redact('call +15551234567 now'), 'call +••• now');
  // Epoch timestamps and token counts are not phone numbers.
  assert.equal(redact('ts=1791572526.16 in=283081'), 'ts=1791572526.16 in=283081');
});
