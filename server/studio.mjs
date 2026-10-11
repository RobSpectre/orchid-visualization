// Read-only poller for Orchid Studio's local API (127.0.0.1:8765).
// Studio rejects browser cross-origin requests, so the visualizer's server
// fetches it and forwards compact snapshots over SSE.

const STATUS_MS = 125;
const KEYS_MS = 60;
const EVENTS_MS = 500;
const CATALOG_MS = 60_000;
const VOICES = ['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'Live', 'Play Along'];
// Only these Studio event fields reach the browser (errors can carry paths).
const EVENT_FIELDS = ['event', 'event_id', 'kind', 'preset', 'slot', 'bpm', 'settings'];

export function startStudio({ port = 8765, emit, log }) {
  const base = `http://127.0.0.1:${port}`;
  let online = null;
  let beatKey = null;
  let keyCursor = null;
  let eventCursor = null;
  let catalog = null;        // slot number -> {name, kind}
  let catalogAt = 0;

  async function command(body) {
    // Node's fetch sends no Origin header, which Studio requires for local clients.
    const res = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    const json = await res.json();
    if (json.status !== 'ok') throw new Error(json.error || `studio ${body.command} failed`);
    return json;
  }

  async function loadCatalog() {
    if (catalog && Date.now() - catalogAt < CATALOG_MS) return;
    catalogAt = Date.now();
    try {
      const r = await command({ command: 'sounds-list' });
      catalog = new Map((r.sounds ?? []).map((x) => [x.number, { name: x.name, kind: x.kind }]));
    } catch (err) {
      log?.(`studio sounds-list: ${err.message}`);
    }
  }

  // "Sound 045" -> slot 45 -> "Opening Credits". Unknown labels pass through.
  function voices(inst) {
    return (inst.labels ?? []).map((label, i) => {
      const number = Number(/(\d+)\s*$/.exec(label ?? '')?.[1]) || null;
      const entry = number != null ? catalog?.get(number) : null;
      return { voice: VOICES[i] ?? `Slot ${i + 1}`, slot: i + 1, label, number, name: entry?.name ?? label, kind: entry?.kind ?? null };
    });
  }

  function setOnline(value, error) {
    if (online === value) return;
    online = value;
    emit('source', { name: 'studio', online: value, error: error ? String(error.message || error) : null });
    if (!value) {
      catalog = null;
      beatKey = null;
      keyCursor = null;
      eventCursor = null;
    }
  }

  async function pollStatus() {
    try {
      const t0 = performance.now();
      const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(1500) });
      const s = await res.json();
      const pollMs = performance.now() - t0;
      // Studio answering with an error (or mid-restart) is not a usable snapshot.
      if (s.status !== 'ok' || !s.tempo) throw new Error(s.error || `studio status ${res.status} without transport`);
      setOnline(true);
      loadCatalog();
      const seq = s.drums?.sequencer ?? {};
      const doc = seq.document ?? null;
      // The beat document is ~20 KB; forward it only when it changes.
      const key = doc ? `${doc.id}:${doc.bars}:${doc.swing}:${doc.hits?.length}:${JSON.stringify(doc.lanes)}` : null;
      if (key !== beatKey) {
        beatKey = key;
        emit('beat', doc);
      }
      const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) : null);
      emit('studio', {
        receivedAt: Date.now(),
        pollMs,
        // Component health for the status page (error strings are Studio's own messages).
        health: {
          orchid: pick(s.orchid_connection, ['input', 'connected', 'state', 'error', 'stale']),
          keyMonitor: pick(s.key_monitor, ['enabled', 'status', 'error', 'presses']),
          playAlong: pick(s.play_along, ['enabled', 'status']),
          soundFollow: pick(s.sound_follow, ['enabled', 'status']),
          instruments: pick(s.instruments, ['enabled', 'engine', 'error']),
          midiClock: pick(s.midi_clock, ['enabled', 'running', 'error']),
          looperError: s.looper?.error ?? null,
          drumsEnabled: s.drums_enabled,
        },
        playing: s.playing,
        connection: s.orchid_connection ? { connected: s.orchid_connection.connected, state: s.orchid_connection.state } : null,
        tempo: s.tempo,
        mixer: s.mixer,
        performance: s.performance,
        performanceDefaults: s.performance_defaults,
        instruments: s.instruments ? { labels: s.instruments.labels, voices: voices(s.instruments), selected: s.instruments.selected_slot, engine: s.instruments.engine } : null,
        keyMonitor: s.key_monitor,
        looper: s.looper && {
          running: s.looper.running,
          phase: s.looper.phase,
          beat: s.looper.beat,
          position: s.looper.position,
          bars: s.looper.settings?.bars,
          recordSlot: s.looper.record_slot,
          beatsUntilRecord: s.looper.beats_until_record,
          heldNotes: s.looper.held_notes,
          layers: (s.looper.layers ?? []).map((l) => ({
            slot: l.slot, name: l.name, muted: l.muted, mode: l.mode,
            notes: (l.notes ?? []).map((n) => [n.beat, n.duration, n.note, n.velocity]),
          })),
        },
        drums: s.drums && {
          playingRequested: s.drums.playing_requested,
          beat: s.drums.beat,
          volume: s.drums.volume,
          running: seq.running,
          position: seq.position,
          anchor: seq.anchor,
          activeBeat: seq.active_beat,
          pendingBeat: seq.pending_beat,
          switchAt: seq.switch_at,
          hitsSent: seq.hits_sent,
        },
      });
    } catch (err) {
      setOnline(false, err);
    }
  }

  async function pollKeys() {
    if (!online) return;
    try {
      const r = await command({ command: 'key-events', after: keyCursor ?? 0 });
      const first = keyCursor === null;
      keyCursor = r.last_key_event_id ?? keyCursor;
      // Skip history on (re)connect; only animate presses that happen while we watch.
      if (first || !r.events?.length) return;
      // Map Studio's monotonic clock onto wall time so the browser can place hits.
      const wall = Date.now();
      emit('keys', r.events.map((e) => ({ ...e, at: wall - (r.now - e.t) * 1000 })));
    } catch (err) {
      // key-events errors when the key monitor is disabled; that's not an outage.
      if (keyCursor === null) keyCursor = 0;
      log?.(`studio key-events: ${err.message}`);
    }
  }

  async function pollEvents() {
    if (!online) return;
    try {
      const r = await command({ command: 'events', after: eventCursor ?? 0 });
      const first = eventCursor === null;
      eventCursor = r.last_event_id ?? eventCursor;
      if (!first && r.events?.length) {
        emit('studio-events', r.events.map((e) => Object.fromEntries(EVENT_FIELDS.filter((k) => k in e).map((k) => [k, e[k]]))));
      }
    } catch (err) {
      log?.(`studio events: ${err.message}`);
    }
  }

  const loop = (fn, ms) => {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try { await fn(); } finally { busy = false; }
    };
    tick();
    return setInterval(tick, ms);
  };
  const timers = [loop(pollStatus, STATUS_MS), loop(pollKeys, KEYS_MS), loop(pollEvents, EVENTS_MS)];
  return { stop: () => timers.forEach(clearInterval), get online() { return online; } };
}
