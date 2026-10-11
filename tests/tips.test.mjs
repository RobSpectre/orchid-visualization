import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTips } from '../server/tips.mjs';

const T = createTips({
  studioDir: '~/workspace/orchid-studio', studioPort: 8765,
  robotDir: '~/workspace/orchid-robot', robotPython: '~/.virtualenvs/orchid/bin/python', robotPort: 8081,
  vizDir: '~/workspace/orchid-visualization', vizPort: 4747,
});

test('every failure type has at least one actionable tip', () => {
  const all = {
    studioOffline: T.studioOffline(), studioSlow: T.studioSlow(), orchid: T.orchid(), keyMonitor: T.keyMonitor(),
    pistil: T.pistil(), studioComponent: T.studioComponent('Play Along'), robotOffline: T.robotOffline(),
    armStopped: T.armStopped('Chord arm', ''), armDisconnected: T.armDisconnected('Keys arm'), armHot: T.armHot(),
    armLimits: T.armLimits(), hermesOffline: T.hermesOffline(), gatewayDown: T.gatewayDown(), platform: T.platform('WhatsApp'),
    hermesErrors: T.hermesErrors(), streamHook: T.streamHook(), vizServer: T.vizServer(),
  };
  for (const [name, tips] of Object.entries(all)) {
    assert.ok(tips.length > 0, `${name} has tips`);
    for (const t of tips) assert.ok(t.text && t.text.length > 10, `${name}: tip text`);
  }
});

test('commands use this machine\'s paths and ports', () => {
  assert.ok(T.studioOffline().some((t) => t.cmd?.includes('cd ~/workspace/orchid-studio && scripts/start-macos.sh --sound-input Orchid --chord-channel 3')));
  assert.ok(T.robotOffline().some((t) => t.cmd?.includes('app.py --enable-hardware --port 8081')));
  assert.ok(T.armStopped('Chord arm').some((t) => t.cmd === 'http://127.0.0.1:8081'));
});

test('arm-stopped tips explain the actual cause', () => {
  const lost = T.armStopped('Chord arm', 'Operator connection lost. Motion has been stopped.').map((t) => t.text).join(' ');
  assert.match(lost, /console tab/);
  assert.match(lost, /Hold & keep playing/);
  const motor = T.armStopped('Keys arm', 'Motor worker stopped: serial timeout').map((t) => t.text).join(' ');
  assert.match(motor, /power supply and USB/);
});

test('a stale Orchid gets press-a-key advice, a missing one gets replug advice', () => {
  assert.match(T.orchid('connected · stale').at(-1).text, /Press a key/);
  assert.match(T.orchid('not connected').at(-1).text, /replugging/);
});

test('a motor bus dropout explains power and cables', () => {
  const t = T.armStopped('Chord arm', "Failed to sync read 'Present_Position' on ids=[1, 2, 3, 4, 5, 6] after 1 tries. [TxRxResult] There is no status packet!").map((x) => x.text).join(' ');
  assert.match(t, /stopped answering on the serial bus/);
  assert.match(t, /motor power supply/);
});
