// Read-only poller for orchid-robot (127.0.0.1:8080 by default).
// Only GET /api/state is used: it never takes the operator lease, never
// receives the CSRF token and never sends a heartbeat.

const POLL_MS = 250;
import { redact } from './redact.mjs';

const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];

function compact(arm, s) {
  const motors = s.motor_status ?? {};
  const teach = s.teach ?? null;
  const playing = s.phase === 'teach_play' && teach?.mode === 'playing';
  return {
    arm,
    phase: s.phase,
    message: redact(s.message),
    error: redact(typeof s.error === 'string' ? s.error : s.error ? JSON.stringify(s.error) : null),
    mode: s.mode,
    connected: s.connected,
    calibrated: s.calibrated,
    selected: s.selected,
    playing,
    teachMode: teach?.mode ?? null,
    progress: teach?.progress ?? null,
    sequence: teach?.sequence ?? null,
    chordHeld: teach?.chord_held ?? null,
    speed: teach?.speed ?? s.teach_settings?.speed ?? null,
    atHome: s.at_home,
    parked: s.parked,
    joints: JOINTS.map((name) => ({
      name,
      // The SO101 model's joint angle in degrees: orchid-robot's pose_angles
      // (raw tick 2047 = 0; the gripper mapped onto the model's jaw range), else
      // the same from raw ticks. Note: not LeRobot degrees (those are zeroed at
      // the middle of each calibrated range).
      deg: s.pose_angles?.[name] != null ? (s.pose_angles[name] * 180) / Math.PI
        : motors[name]?.degrees_from_midpoint
          ?? (s.position?.[name] != null ? ((s.position[name] - 2047) / 4096) * 360 : null),
      target: motors[name]?.target_ticks ?? null,
      torque: motors[name]?.torque_enabled ?? null,
      temp: motors[name]?.temperature_c ?? null,
      limit: motors[name]?.limit_status ?? null,
    })),
    voltage: s.voltage ?? null,
    workerAlive: s.worker_alive ?? null,
    leaseLive: s.lease_live ?? null,
    keyCheck: s.key_check ? { status: s.key_check.status, summary: redact(s.key_check.summary) } : null,
    events: (s.events ?? []).slice(0, 8).map((e) => ({ id: e.id, created: e.created, kind: e.kind, message: redact(e.message) })),
  };
}

// The Hermes orchid skill runs the console on 8081; the app defaults to 8080.
export function startRobot({ ports = [8081, 8080, 8090], emit }) {
  let portIndex = 0;
  let online = null;
  const base = () => `http://127.0.0.1:${ports[portIndex]}`;

  async function fetchArm(arm) {
    const res = await fetch(`${base()}/api/state?arm=${arm}`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`robot ${arm}: HTTP ${res.status}`);
    return compact(arm, await res.json());
  }

  async function poll() {
    try {
      const t0 = performance.now();
      const arms = await Promise.all([fetchArm('a'), fetchArm('b').catch(() => null)]);
      const pollMs = performance.now() - t0;
      if (online !== true) emit('source', { name: 'robot', online: true, error: null, port: ports[portIndex] });
      online = true;
      emit('robot', { receivedAt: Date.now(), pollMs, port: ports[portIndex], arms: arms.filter(Boolean) });
    } catch (err) {
      if (online !== false) emit('source', { name: 'robot', online: false, error: err.message, ports });
      online = false;
      portIndex = (portIndex + 1) % ports.length;
    }
  }

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await poll(); } finally { busy = false; }
  }, POLL_MS);
  poll();
  return { stop: () => clearInterval(timer), get online() { return online; } };
}
