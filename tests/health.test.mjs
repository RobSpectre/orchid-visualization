// Arm alerts must follow orchid-robot's own state: a refused command sets `error`
// but leaves the arm working; only phase "fault" means the arm is stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from '../server/health.mjs';

function healthWith(arms) {
  const now = Date.now();
  const latest = new Map([
    ['source:robot', ['source', { name: 'robot', online: true }]],
    ['robot', ['robot', { receivedAt: now, port: 8081, pollMs: 5, arms }]],
  ]);
  return createHealth({
    latest, rings: { 'hermes-calls': [] }, clients: new Set(), hermesHome: '/nonexistent',
    media: { status: () => ({ next: {}, current: null }), snapshot: () => ({ schedule: { enabled: false }, visual: { theme: 'nebula', treatment: 'orbit' }, alerts: { enabled: true, ignore: {}, snoozeUntil: 0 } }) },
    hookSeen: () => null, startedAt: now,
  });
}
const arm = (o) => ({ arm: 'a', mode: 'hardware', connected: true, calibrated: true, phase: 'teach_hold', error: null, joints: [], ...o });

test('a refused command does not raise an arm alert', async () => {
  const h = healthWith([arm({ error: 'Chord Arm is not parked at its home or rest (5° from home). The arms can touch, so send it home or to rest first.' })]);
  const alerts = (await h.connectivity()).filter((a) => a.id.startsWith('arm-'));
  assert.deepEqual(alerts, []);
  const check = (await h()).systems[1].checks.find((c) => c.name.startsWith('Keys arm'));
  assert.equal(check.status, 'ok');
  assert.match(check.detail, /last command refused/);
});

test('a real fault does raise "stopped"', async () => {
  const h = healthWith([arm({ phase: 'fault', error: 'Operator connection lost. Motion has been stopped.' })]);
  const alerts = (await h.connectivity()).filter((a) => a.id.startsWith('arm-'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Keys arm stopped');
});

test('a disconnected arm raises "disconnected"; simulation never alerts', async () => {
  const off = (await healthWith([arm({ connected: false, phase: 'disconnected' })]).connectivity()).filter((a) => a.id.startsWith('arm-'));
  assert.equal(off[0].title, 'Keys arm disconnected');
  const sim = (await healthWith([arm({ mode: 'simulation', connected: false, phase: 'fault', error: 'x' })]).connectivity()).filter((a) => a.id.startsWith('arm-'));
  assert.deepEqual(sim, []);
});
