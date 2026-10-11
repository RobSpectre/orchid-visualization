// System health for the status page: turns what the server already watches
// (Studio, robot, Hermes) plus a few Hermes files into named checks.
// Status levels: ok · warn · down · info (info never affects the rollup).

import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from './redact.mjs';

const RANK = { ok: 0, info: 0, warn: 1, down: 2 };
const worst = (checks) => checks.reduce((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'ok');
const ago = (ms) => {
  if (ms == null) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
};
const clip = (s, n = 160) => { const r = redact(String(s ?? '')); return r.length > n ? `${r.slice(0, n)}…` : r; };

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Last N lines of a log without reading the whole file.
async function tail(path, bytes = 64 * 1024) {
  let fh;
  try {
    const st = await stat(path);
    fh = await open(path, 'r');
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    return buf.toString('utf8').split('\n').slice(1).filter(Boolean);
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

const LOG_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ (ERROR|WARNING|CRITICAL) (?:\[[^\]]+\] )?([\w.]+): (.*)$/;

const OK_PLATFORM_STATES = ['connected', 'running', 'ready', 'online'];
const ARM_NAMES = { a: 'Keys arm', b: 'Chord arm' };

// Which tips go with which failing check (by check name) or alert (by id).
function tipsForCheck(c, T) {
  const arm = /^(Keys|Chord) arm/.exec(c.name);
  if (c.name === 'Studio API') return c.status === 'down' ? T.studioOffline() : T.studioSlow();
  if (c.name.startsWith('Orchid instrument')) return T.orchid(c.detail);
  if (c.name === 'Key monitor') return T.keyMonitor();
  if (c.name === 'Pistil sound engine') return T.pistil();
  if (['Play Along', 'Sound dial follow', 'Looper', 'MIDI clock out'].includes(c.name)) return T.studioComponent(c.name);
  if (c.name === 'Robot console') return c.status === 'down' ? T.robotOffline() : T.studioSlow().slice(0, 1).map((t) => ({ text: t.text.replace('Studio', 'The robot console') }));
  if (arm) {
    const name = `${arm[1]} arm`;
    if (/stopped/.test(c.detail)) return T.armStopped(name, c.detail);
    if (/not connected/.test(c.detail)) return T.armDisconnected(name);
    if (/control worker stopped/.test(c.detail)) return T.robotOffline().slice(1, 3);
    if (/°C/.test(c.detail)) return T.armHot();
    if (/outside limits/.test(c.detail)) return T.armLimits();
  }
  if (c.name === 'Hermes state database') return T.hermesOffline();
  if (c.name === 'Current session saved') return T.sessionNotSaved();
  if (c.name === 'Messaging gateway') return T.gatewayDown();
  if (c.name === 'WhatsApp' || c.group === 'platform') return T.platform(c.name);
  if (c.name.startsWith('Errors')) return T.hermesErrors();
  if (c.name === 'Visualizer stream hook') return T.streamHook();
  if (c.name === 'Connectivity alerts') return [{ text: 'Resume or re-enable takeovers in Settings → Connectivity alerts.', cmd: '/settings' }];
  return [];
}
function tipsForAlert(a, T) {
  if (a.id === 'studio') return T.studioOffline();
  if (a.id === 'orchid') return T.orchid(a.detail);
  if (a.id === 'robot') return T.robotOffline();
  if (a.id.startsWith('arm-')) {
    const name = a.title.replace(/ (stopped|disconnected)$/, '');
    return / stopped$/.test(a.title) ? T.armStopped(name, a.detail) : T.armDisconnected(name);
  }
  if (a.id === 'hermes') return T.hermesOffline();
  if (a.id === 'hermes-gateway') return T.gatewayDown();
  if (a.id.startsWith('platform-')) return T.platform(a.title.replace(/ disconnected$/, ''));
  return [];
}

export function createHealth({ latest, rings, clients, hermesHome, media, hookSeen, hookClients = () => [], startedAt, studioPort = 8765, tips }) {
  const get = (k) => latest.get(k)?.[1];
  const readGateway = async () => {
    try { return JSON.parse(await readFile(join(hermesHome, 'gateway_state.json'), 'utf8')); } catch { return null; }
  };

  // Lost connections that warrant a full-screen alert. Each has a stable id and
  // a group the operator can mute in Settings.
  async function connectivity(now = Date.now()) {
    const out = [];
    const sSrc = get('source:studio');
    const s = get('studio');
    if (!sSrc?.online || !s || now - s.receivedAt > 5000) {
      out.push({ id: 'studio', group: 'studio', title: 'Orchid Studio offline', detail: `No answer from Studio on 127.0.0.1:${studioPort}${sSrc?.error ? ` (${clip(sSrc.error, 80)})` : ''}. Is orchid-studio running?` });
    } else {
      const o = s.health?.orchid;
      if (o && (!o.connected || o.stale)) {
        out.push({ id: 'orchid', group: 'orchid', title: 'Orchid disconnected', detail: o.error ? clip(o.error, 140) : `Studio can't hear the Orchid (${o.stale ? 'no recent MIDI' : o.state ?? 'no MIDI input'}). Check the Orchid's USB cable and power.` });
      }
    }

    const rSrc = get('source:robot');
    const r = get('robot');
    if (!rSrc?.online || !r || now - r.receivedAt > 5000) {
      out.push({ id: 'robot', group: 'robot', title: 'orchid-robot offline', detail: `No robot console on 127.0.0.1:${(rSrc?.ports ?? [8081, 8080, 8090]).join(' / ')}. Is the robot app running?` });
    } else {
      for (const a of r.arms) {
        if (a.mode === 'simulation') continue;
        const name = ARM_NAMES[a.arm] ?? `Arm ${a.arm}`;
        // Only orchid-robot's own fault phase means stopped. It also puts *refused commands*
        // (e.g. "Chord Arm is not parked…") in `error` while the arm carries on normally,
        // and keeps that text until its next step, so `error` alone is not a fault.
        if (a.phase === 'fault') {
          out.push({
            id: `arm-${a.arm}`, group: 'arms', title: `${name} stopped`,
            detail: `orchid-robot: "${clip(a.error || 'fault', 90)}"${a.connected ? ' Motors are connected, but the arm' : ' The arm'} stays stopped until cleared: in the robot console open the ${name}, support it, and press Hold & keep playing.`,
          });
        }
        else if (!a.connected) out.push({ id: `arm-${a.arm}`, group: 'arms', title: `${name} disconnected`, detail: 'Motors not connected. Check the arm power supply and USB cable.' });
      }
    }

    const hSrc = get('source:hermes');
    if (hSrc && !hSrc.online) {
      out.push({ id: 'hermes', group: 'hermes', title: 'Hermes Agent offline', detail: `Can't read Hermes state${hSrc.error ? ` (${clip(hSrc.error, 80)})` : ''}.` });
    }
    const gw = await readGateway();
    const alive = gw && pidAlive(gw.pid);
    if (!gw || !alive || gw.gateway_state !== 'running') {
      out.push({ id: 'hermes-gateway', group: 'hermes', title: 'Hermes gateway down', detail: gw ? `Gateway is ${alive ? gw.gateway_state : 'not running'}. Messages from WhatsApp won't reach the agent.` : 'No Hermes gateway found.' });
    } else {
      for (const [name, p] of Object.entries(gw.platforms ?? {})) {
        if (OK_PLATFORM_STATES.includes(p.state) && !p.error_message) continue;
        const label = name === 'whatsapp' ? 'WhatsApp' : name;
        out.push({ id: `platform-${name}`, group: name === 'whatsapp' ? 'whatsapp' : 'hermes', title: `${label} disconnected`, detail: `${label} is ${p.state ?? 'unknown'}${p.error_message ? `: ${clip(p.error_message, 100)}` : ''}.` });
      }
    }
    return out.map((a) => ({ ...a, tips: tips ? tipsForAlert(a, tips) : [] }));
  }

  function studio(now) {
    const src = get('source:studio');
    const s = get('studio');
    const checks = [];
    const age = s ? now - s.receivedAt : null;
    if (!src?.online || !s) {
      checks.push({ name: 'Studio API', status: 'down', detail: `127.0.0.1:${studioPort} not answering${src?.error ? ` · ${clip(src.error, 80)}` : ''}` });
      return { id: 'studio', name: 'Orchid Studio', status: 'down', summary: 'not running or not reachable', checks, facts: [] };
    }
    checks.push({ name: 'Studio API', status: age < 2000 ? 'ok' : 'warn', detail: `127.0.0.1:${studioPort} · ${Math.round(s.pollMs ?? 0)} ms · updated ${ago(age)}` });
    const h = s.health ?? {};
    const o = h.orchid;
    if (o) {
      const good = o.connected && !o.stale && !o.error;
      checks.push({ name: 'Orchid instrument (USB MIDI)', status: good ? 'ok' : 'warn', detail: good ? `${o.input ?? 'Orchid'} · ${o.state}` : clip(o.error || `${o.state ?? 'not connected'}${o.stale ? ' · stale' : ''}`) });
    }
    if (h.keyMonitor) {
      const k = h.keyMonitor;
      checks.push({ name: 'Key monitor', status: !k.enabled ? 'info' : k.status === 'ready' && !k.error ? 'ok' : 'warn', detail: k.error ? clip(k.error) : k.enabled ? `${k.status} · ${k.presses ?? 0} presses` : 'off' });
    }
    if (h.instruments) {
      const i = h.instruments;
      checks.push({ name: 'Pistil sound engine', status: i.error ? 'warn' : i.enabled ? 'ok' : 'info', detail: i.error ? clip(i.error) : i.enabled ? i.engine ?? 'enabled' : 'disabled' });
    }
    if (h.playAlong) checks.push({ name: 'Play Along', status: !h.playAlong.enabled ? 'info' : h.playAlong.status === 'ready' ? 'ok' : 'warn', detail: h.playAlong.enabled ? h.playAlong.status : 'off' });
    if (h.soundFollow) checks.push({ name: 'Sound dial follow', status: !h.soundFollow.enabled ? 'info' : h.soundFollow.status === 'ready' ? 'ok' : 'warn', detail: h.soundFollow.enabled ? h.soundFollow.status : 'off' });
    if (h.looperError) checks.push({ name: 'Looper', status: 'warn', detail: clip(h.looperError) });
    if (h.midiClock?.error) checks.push({ name: 'MIDI clock out', status: 'warn', detail: clip(h.midiClock.error) });
    const t = s.tempo ?? {};
    const transport = !t.running ? 'stopped' : t.paused ? 'paused' : 'playing';
    checks.push({ name: 'Transport', status: 'info', detail: `${transport} · ${Math.round(t.bpm ?? 0)} bpm` });
    const beat = get('beat');
    const facts = [
      ['beat', beat ? `${beat.name} (${beat.bars} bars)` : '—'],
      ['drums', s.drums?.playingRequested ? 'on' : 'off'],
      ['looper', s.looper?.phase ?? '—'],
      ['voices', (s.instruments?.voices ?? []).map((v) => v.name).join(' · ') || '—'],
    ];
    const status = worst(checks);
    return { id: 'studio', name: 'Orchid Studio', status, summary: status === 'ok' ? `${transport}, everything connected` : 'running with issues', checks, facts };
  }

  function robot(now) {
    const src = get('source:robot');
    const r = get('robot');
    const checks = [];
    if (!src?.online || !r) {
      const tried = src?.ports?.join(', ') ?? '8081, 8080, 8090';
      checks.push({ name: 'Robot console', status: 'down', detail: `nothing answering on 127.0.0.1:${tried}` });
      return { id: 'robot', name: 'orchid-robot', status: 'down', summary: 'console not running', checks, facts: [] };
    }
    const age = now - r.receivedAt;
    checks.push({ name: 'Robot console', status: age < 2000 ? 'ok' : 'warn', detail: `127.0.0.1:${r.port} · ${Math.round(r.pollMs ?? 0)} ms · updated ${ago(age)}` });
    const sim = r.arms.some((a) => a.mode === 'simulation');
    if (sim) checks.push({ name: 'Mode', status: 'info', detail: 'simulation (no motors connected)' });
    const facts = [['port', String(r.port)], ['mode', r.arms[0]?.mode ?? '—']];
    for (const a of r.arms) {
      const label = a.arm === 'a' ? 'Keys arm (A)' : 'Chord arm (B)';
      let status = 'ok';
      const notes = [];
      if (a.phase === 'fault') { status = 'down'; notes.push(`stopped: ${clip(a.error || 'fault', 100)} (clear in the robot console: Hold & keep playing)`); }
      else if (a.error) notes.push(`last command refused: ${clip(a.error, 100)}`);
      if (!sim && !a.connected) { status = status === 'down' ? status : 'warn'; notes.push('not connected'); }
      if (!sim && a.connected && !a.calibrated) { status = status === 'down' ? status : 'warn'; notes.push('not calibrated'); }
      if (a.workerAlive === false) { status = status === 'down' ? status : 'warn'; notes.push('control worker stopped'); }
      const temps = a.joints.map((j) => j.temp).filter((t) => t != null);
      const hot = temps.length ? Math.max(...temps) : null;
      if (hot != null && hot >= 55) { status = status === 'down' ? status : 'warn'; notes.push(`motor ${hot}°C`); }
      const outside = a.joints.filter((j) => j.limit === 'outside').map((j) => j.name);
      if (outside.length) { status = status === 'down' ? status : 'warn'; notes.push(`outside limits: ${outside.join(', ')}`); }
      const doing = a.playing ? `playing ${a.sequence || a.selected || ''}` : a.phase === 'fault' ? (a.connected ? 'connected' : 'disconnected') : (a.phase ?? '').replace(/_/g, ' ');
      checks.push({ name: label, status, detail: [doing, ...notes].filter(Boolean).join(' · ') || 'idle' });
      facts.push([`${a.arm === 'a' ? 'keys' : 'chords'} arm`, `${a.connected ? 'connected' : 'disconnected'}${a.calibrated ? ' · calibrated' : ''}${a.voltage ? ` · ${a.voltage} V` : ''}${hot != null ? ` · max ${hot}°C` : ''}`]);
    }
    const status = worst(checks);
    return { id: 'robot', name: 'orchid-robot', status, summary: status === 'ok' ? (sim ? 'running in simulation' : 'both arms ready') : status === 'down' ? 'an arm is stopped' : 'needs attention', checks, facts };
  }

  async function hermes(now) {
    const src = get('source:hermes');
    const sess = get('hermes-session');
    const checks = [];
    checks.push({ name: 'Hermes state database', status: src?.online ? 'ok' : 'down', detail: src?.online ? 'readable' : clip(src?.error ?? 'not readable') });
    if (sess?.notSaved) {
      checks.push({
        name: 'Current session saved', status: 'warn',
        detail: 'not in state.db · stats from agent.log and the stream hook; reasoning only from the hook',
      });
    }

    const gw = await readGateway();
    if (!gw) {
      checks.push({ name: 'Messaging gateway', status: 'warn', detail: 'no gateway state found' });
    } else {
      const alive = pidAlive(gw.pid);
      const running = alive && gw.gateway_state === 'running';
      checks.push({ name: 'Messaging gateway', status: running ? 'ok' : 'down', detail: `${gw.gateway_state ?? 'unknown'}${alive ? '' : ' · process not running'} · ${gw.active_agents ?? 0} active agent(s)${gw.code_version ? ` · v${gw.code_version}` : ''}` });
      for (const [name, p] of Object.entries(gw.platforms ?? {})) {
        const st = !alive ? 'down' : p.error_message || p.needs_attention ? 'warn' : OK_PLATFORM_STATES.includes(p.state) ? 'ok' : 'warn';
        checks.push({ name: name === 'whatsapp' ? 'WhatsApp' : name, status: st, detail: `${p.state ?? 'unknown'}${p.needs_attention ? ' · needs attention' : ''}${p.error_message ? ` · ${clip(p.error_message, 100)}` : ''}${p.updated_at && !Number.isNaN(Date.parse(p.updated_at)) ? ` · since ${new Date(p.updated_at).toLocaleTimeString('en-GB')}` : ''}` });
      }
    }

    const calls = rings['hermes-calls'];
    const last = calls.at(-1);
    if (last) {
      const recent = calls.filter((c) => now - c.ts < 3600_000);
      const avg = recent.length ? recent.reduce((a, c) => a + c.latency, 0) / recent.length : null;
      checks.push({ name: 'Nebius Token Factory', status: 'ok', detail: `${last.model.split('/').pop()} · last call ${ago(now - last.ts)} · ${recent.length} calls/hr${avg ? ` · avg ${avg.toFixed(1)}s` : ''}` });
    } else {
      checks.push({ name: 'Nebius Token Factory', status: 'info', detail: 'no API calls seen yet' });
    }

    // Recent errors from Hermes' own error log (redacted).
    const lines = (await tail(join(hermesHome, 'logs', 'errors.log')))
      .map((l) => LOG_LINE.exec(l)).filter(Boolean)
      .map(([, ts, level, logger, msg]) => ({ at: new Date(ts.replace(' ', 'T')).getTime(), level, logger, msg }));
    const hour = lines.filter((e) => now - e.at < 3600_000);
    const errs = hour.filter((e) => e.level !== 'WARNING');
    checks.push({
      name: 'Errors (last hour)',
      status: errs.length ? 'warn' : 'ok',
      detail: `${errs.length} error(s), ${hour.length - errs.length} warning(s)${errs.length ? ` · latest: ${clip(errs.at(-1).msg, 110)}` : ''}`,
    });
    const hookAt = hookSeen();
    // Which local users' Hermes are connected (plugin 0.2+ sends a heartbeat naming them).
    const peers = hookClients().filter((c) => now - c.at < 120_000);
    const who = peers.length ? ` · from ${[...new Set(peers.map((c) => c.user || '?'))].join(', ')} (plugin ${[...new Set(peers.map((c) => c.plugin))].join('/')})` : '';
    const old = hookAt && now - hookAt < 600_000 && !peers.length;
    checks.push({
      name: 'Visualizer stream hook',
      status: old ? 'warn' : hookAt && now - hookAt < 600_000 ? 'ok' : 'info',
      detail: old ? `last data ${ago(now - hookAt)} · old plugin version: reinstall it for the full trace and Hermes' own stats`
        : hookAt ? `last data ${ago(now - hookAt)}${who}` : 'no data yet · install the plugin for this user and restart Hermes',
    });

    const facts = sess ? [
      ['session', `${sess.source ?? ''} · ${clip(sess.title ?? 'untitled', 60)}`],
      ['model', `${sess.model} · ${sess.providerName}`],
      ['context', sess.contextWindow && sess.contextUsed != null ? `${Math.round(((sess.contextWindow - sess.contextUsed) / sess.contextWindow) * 100)}% free (${Math.round(sess.contextUsed / 1000)}k used)` : '—'],
      ['agent', sess.turnActive ? 'working on a turn' : 'idle'],
    ] : [];
    const recentErrors = hour.slice(-5).reverse().map((e) => ({ at: e.at, level: e.level, text: `${e.logger}: ${clip(e.msg, 140)}` }));
    const status = worst(checks);
    return { id: 'hermes', name: 'Hermes Agent', status, summary: status === 'ok' ? 'agent, gateway and WhatsApp up' : status === 'down' ? 'part of Hermes is down' : 'running with issues', checks, facts, events: recentErrors };
  }

  function visualizer(now) {
    const m = media.status();
    const sched = media.snapshot();
    const checks = [
      { name: 'Visualizer server', status: 'ok', detail: `up ${ago(now - startedAt).replace(' ago', '')} · ${clients.size} screen(s) connected` },
      { name: 'Video schedule', status: 'info', detail: `${sched.schedule.enabled ? 'on' : 'off'} · ${Object.keys(m.next).length} scheduled${m.current ? ` · showing ${m.current.file}` : ''}` },
      (() => {
        const al = sched.alerts;
        const muted = Object.entries(al.ignore).filter(([, v]) => v).map(([k]) => k);
        const snoozed = al.snoozeUntil > now;
        return { name: 'Connectivity alerts', status: !al.enabled || snoozed ? 'warn' : 'ok', detail: !al.enabled ? 'off' : snoozed ? `snoozed until ${new Date(al.snoozeUntil).toLocaleTimeString('en-GB')}` : `on${muted.length ? ` · muted: ${muted.join(', ')}` : ''}` };
      })(),
      { name: 'Display', status: 'info', detail: `theme ${sched.visual.theme}${sched.visual.themeRotateMin ? ` (rotating ${sched.visual.themeRotateMin}m)` : ''} · look ${sched.visual.treatment}${sched.visual.rotateMin ? ` (rotating ${sched.visual.rotateMin}m)` : ''}` },
    ];
    return { id: 'visualizer', name: 'Orchid Signal', status: worst(checks), summary: `${clients.size} screen(s) connected`, checks, facts: [] };
  }

  async function report() {
    const now = Date.now();
    const systems = [studio(now), robot(now), await hermes(now), visualizer(now)];
    if (tips) {
      for (const sys of systems) {
        for (const c of sys.checks) {
          const failing = c.status === 'warn' || c.status === 'down' || (c.name === 'Visualizer stream hook' && /no data/.test(c.detail));
          if (failing) c.tips = tipsForCheck(c, tips);
        }
      }
    }
    return { now, overall: worst(systems.slice(0, 3)), systems };
  }
  report.connectivity = connectivity;
  return report;
}
