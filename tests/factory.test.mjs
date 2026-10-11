// The headline tok/s must equal Hermes' own status-bar number:
// sum(out) / sum(latency) over the last 10 calls (hermes_cli/cli_status_bar_mixin.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hermesVelocity, fitDecode } from '../public/factory.js';

const call = (out, latency) => ({ out, latency, total: out + 1000 });

test('matches Hermes: sum/sum over the last 10 calls, not a mean of ratios', () => {
  const calls = [call(9999, 0.1), ...Array.from({ length: 10 }, (_, i) => call(100 * (i + 1), 2 + i * 0.5))];
  const v = hermesVelocity(calls);
  const window = calls.slice(-10);
  const expected = window.reduce((a, c) => a + c.out, 0) / window.reduce((a, c) => a + c.latency, 0);
  assert.equal(v.n, 10);
  assert.ok(Math.abs(v.tps - expected) < 1e-9);
  assert.ok(Math.abs(v.avgLatency - window.reduce((a, c) => a + c.latency, 0) / 10) < 1e-9);
});

test('decode fit recovers overhead and decode rate from clean data', () => {
  // latency = 3s overhead + out / 500 tok/s
  const calls = [100, 400, 800, 1500, 2500, 3000, 4000, 600, 250, 1200].map((out) => call(out, 3 + out / 500));
  const fit = fitDecode(calls);
  assert.ok(Math.abs(fit.tps - 500) < 1, `tps ${fit.tps}`);
  assert.ok(Math.abs(fit.overhead - 3) < 0.01, `overhead ${fit.overhead}`);
});

test('decode fit refuses to guess without enough spread', () => {
  assert.equal(fitDecode(Array.from({ length: 12 }, () => call(300, 2))), null);
  assert.equal(fitDecode([call(100, 1), call(2000, 5)]), null);
});
