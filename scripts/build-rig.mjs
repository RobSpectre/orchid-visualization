// Builds the 3D rig the arm view renders: both SO101 arms (official URDF and
// meshes, vendor/so101, Apache-2.0) on the Nebius Orchid plate (vendor/plate),
// plus the Orchid's key layout. Meshes are simplified by vertex clustering and
// quantised so the whole rig is about 1 MB.
//
//   node scripts/build-rig.mjs                       → public/models/rig.json + rig.bin
//   node scripts/build-rig.mjs --robot ~/workspace/orchid-robot
//       first refreshes vendor/taught-presses.json from orchid-robot's taught
//       motions (read-only), e.g. after keys or chord buttons were re-taught.
//
// World frame: the plate's own frame (Z up), in metres, centred on the plate.
// Arm mounts come from matching the SO101 base's four mounting holes to the
// holes on the plate pads (orchid-robot's measurement).
//
// The Orchid is modelled as the real unit (Telepathic Instruments ORC-1 product
// photos; orchid-robot's measured 299 × 184 × 43 mm) in its real place, the
// plate pocket: a low front deck with the 2×4 chord buttons on the left (top row
// Dim/Min/Maj/Sus, bottom row 6/m7/M7/9), the voicing dials, and one octave of
// keys on the right; a sloped control strip behind (Sound, Perform, FX, Key,
// OLED, Bass, Loop, BPM, Options, Volume) and a top with speaker slots.
//
// Each arm's joint zeros come from a hand-centred calibration, so its model can
// be ~2 cm off (orchid-robot says so). To make the arms meet the keys, each
// arm gets small joint-zero corrections (pan, lift, elbow, wrist), fitted so its
// taught presses (measured with the key bottomed out) land on the right keys
// and buttons at their pressed height. The corrections go in rig.json and are
// applied to live and demo angles alike.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SO101 = `${ROOT}vendor/so101/`;
const PLATE = `${ROOT}vendor/plate/orchid-plate-v2.stl`;
const OUT = `${ROOT}public/models/`;
const TAUGHT = `${ROOT}vendor/taught-presses.json`;

// Plate frame (mm) → world (m): centre the plate on the origin.
const PLATE_CENTRE = [0, 638.85, 0];
const mm = ([x, y, z = 0]) => [(x - PLATE_CENTRE[0]) / 1000, (y - PLATE_CENTRE[1]) / 1000, (z - PLATE_CENTRE[2]) / 1000];

// Arm mounts (plate frame, mm), as measured in orchid-robot (orchid_demo/layout.py):
// the SO101 base's four holes fit each pad's M5 sockets within 0.1 mm; base_link
// is 2.4 mm above the rib bottoms, which sit on the socket slot floor.
// Keys arm on the right mount, Chord arm on the left (orchid-robot's slots a / b).
const MOUNTS = {
  a: { xyz: mm([200.19, 776.69, 4.85]), yaw: -120, name: 'Keys arm' },
  b: { xyz: mm([-200.19, 776.69, 4.85]), yaw: -60, name: 'Chord arm' },
};

// Taught poses are saved in LeRobot degrees (0 at the middle of each joint's
// calibrated range; gripper 0–100). The model's joint zero is raw tick 2047 (the
// hand-centred midpoint), as orchid-robot's own model and live telemetry use, so
// convert with that arm's calibration (orchid_demo/kinematics.py urdf_angles).
function modelDegrees(pose, cal) {
  const out = {};
  for (const [name, v] of Object.entries(pose)) {
    if (name === 'gripper') { out[name] = (-0.174533 + (Math.max(0, Math.min(100, v)) / 100) * (1.74533 + 0.174533)) * 180 / Math.PI; continue; }
    const [lo, hi] = cal[name];
    out[name] = ((v * 4095) / 360 + (lo + hi) / 2 - 2047) * 360 / 4096;
  }
  return out;
}

const WHITE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const BLACK = ['C#', 'D#', 'F#', 'G#', 'A#'];
const CHORDS = [['chord.dim', 'chord.min', 'chord.maj', 'chord.sus'], ['chord.6', 'chord.m7', 'chord.M7', 'chord.9']];
const TRAVEL = 0.004; // how far a key or button moves when pressed

// The real Orchid, in its own millimetres: x from the left edge (0–299), y back
// from the front edge (0–184), z up from the pocket floor. Proportions from the
// product photos; key pitch 20.8 mm (orchid-robot's fitted key layout).
const ORCHID_AT = [-149.5, 591.1 - 92, 0.61]; // pocket centre (0, 591.1) on the plate, floor z 0.61 (layout.py)
const O = { w: 299, d: 184, h: 43 };
const DECK_Z = 18, WELL_Z = 13, PANEL_Y = 105, TOP_Y = 150; // deck top, key bed, control strip start, top start
const PITCH = 20.8, KEYS_X = 293 - 7 * PITCH; // keyboard runs to 6 mm from the right edge
const KEY = { white: { w: 19.6, y0: 0, y1: 98, top: 21 }, black: { w: 11, y0: 44, y1: 98, top: 30 } };
const BLACK_AT = { 'C#': 1 - 0.08, 'D#': 2 + 0.08, 'F#': 4 - 0.1, 'G#': 5, 'A#': 6 + 0.1 }; // in pitches from the keyboard's left edge
const CHORD_GRID = { x0: 30, pitch: 21.5, rows: [80, 58.5], size: 18, top: 22, travel: 3 };

// --robot: refresh the taught poses from orchid-robot (read-only): the taught
// motions from its databases, and each follower's calibration from its API.
const robotArg = process.argv.indexOf('--robot');
if (robotArg > 0) {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = process.argv[robotArg + 1].replace(/^~/, process.env.HOME);
  const portArg = process.argv.indexOf('--robot-port');
  const ports = portArg > 0 ? [Number(process.argv[portArg + 1])] : [8081, 8080, 8090];
  const arms = {};
  for (const [arm, db] of [['a', 'data/hardware/operator.sqlite3'], ['b', 'data/arm-b/hardware/operator.sqlite3']]) {
    if (!existsSync(`${dir}/${db}`)) continue;
    let state = null;
    for (const port of ports) {
      try { state = await (await fetch(`http://127.0.0.1:${port}/api/state?arm=${arm}`, { signal: AbortSignal.timeout(1500) })).json(); break; } catch { /* next port */ }
    }
    if (!state?.calibration) throw new Error(`orchid-robot is not answering on ${ports.join('/')}: it is needed for arm ${arm}'s calibration`);
    const cal = Object.fromEntries(Object.entries(state.calibration).map(([k, v]) => [k, [v.range_min, v.range_max]]));
    const con = new DatabaseSync(`${dir}/${db}`, { readOnly: true });
    const controls = {};
    for (const table of ['notes', 'controls']) {
      let rows = [];
      try { rows = con.prepare(`select entry from ${table} where entry != 'null'`).all(); } catch { /* table absent */ }
      for (const { entry } of rows) {
        const e = JSON.parse(entry);
        const pose = (k) => e.points?.[k] && (e.points[k].measured ?? e.points[k].goal);
        if (!pose('touch') || !pose('press')) continue;
        if (state.calibration_id && e.calibration_sha256 && !e.calibration_sha256.startsWith(state.calibration_id)) {
          console.warn(`skipping ${e.control_id}: taught with a different calibration than arm ${arm} has now`);
          continue;
        }
        controls[e.control_id] = { hover: pose('hover'), touch: pose('touch'), press: pose('press') };
      }
    }
    con.close();
    arms[arm] = { calibrationId: state.calibration_id, calibration: cal, controls };
  }
  writeFileSync(TAUGHT, `${JSON.stringify({ source: 'orchid-robot taught motions (hover/touch/press, LeRobot degrees) + follower calibration ranges', exportedAt: new Date().toISOString(), arms }, null, 1)}\n`);
  console.log('taught presses:', Object.entries(arms).map(([a, x]) => `${a}: ${Object.keys(x.controls).join(' ')}`).join(' | '));
}

// ------------------------------------------------------------------ URDF
const urdf = readFileSync(`${SO101}so101_new_calib.urdf`, 'utf8');
const nums = (s) => s.trim().split(/\s+/).map(Number);
const links = {};
for (const [, name, body] of urdf.matchAll(/<link name="(\w+)">([\s\S]*?)<\/link>/g)) {
  links[name] = [...body.matchAll(/<visual>([\s\S]*?)<\/visual>/g)].map(([, v]) => ({
    xyz: nums(/xyz="([^"]+)"/.exec(v)[1]),
    rpy: nums(/rpy="([^"]+)"/.exec(v)[1]),
    mesh: /assets\/(\w+)\.stl/.exec(v)[1],
    kind: /material name="sts3215"/.test(v) ? 'motor' : 'printed',
  }));
}
const joints = [...urdf.matchAll(/<joint name="(\w+)" type="(\w+)">([\s\S]*?)<\/joint>/g)].map(([, name, type, b]) => ({
  name, type,
  parent: /parent link="(\w+)"/.exec(b)[1],
  child: /child link="(\w+)"/.exec(b)[1],
  xyz: nums(/origin xyz="([^"]+)"/.exec(b)[1]),
  rpy: nums(/rpy="([^"]+)"/.exec(b)[1]),
}));

// ------------------------------------------------------------------ meshes
function readStl(path, scale) {
  const b = readFileSync(path);
  const n = b.readUInt32LE(80);
  if (84 + n * 50 !== b.length) throw new Error(`not a binary STL: ${path}`);
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) pos[i * 9 + k] = b.readFloatLE(84 + i * 50 + 12 + k * 4) * scale;
  return pos;
}

// Vertex clustering: snap vertices to a grid, average each cell, drop
// triangles that collapse. Keeps silhouettes and edges, loses fine fillets.
function simplify(tri, cell) {
  const key = new Map();
  const sum = [];
  const ids = new Uint32Array(tri.length / 3);
  for (let v = 0; v < tri.length / 3; v++) {
    const x = tri[v * 3], y = tri[v * 3 + 1], z = tri[v * 3 + 2];
    const k = `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
    let id = key.get(k);
    if (id === undefined) { id = sum.length; key.set(k, id); sum.push([0, 0, 0, 0]); }
    const s = sum[id]; s[0] += x; s[1] += y; s[2] += z; s[3]++;
    ids[v] = id;
  }
  const seen = new Set();
  const idx = [];
  for (let t = 0; t < ids.length; t += 3) {
    const a = ids[t], b = ids[t + 1], c = ids[t + 2];
    if (a === b || b === c || a === c) continue;
    const k = [a, b, c].sort((p, q) => p - q).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    idx.push(a, b, c);
  }
  const pos = new Float32Array(sum.length * 3);
  sum.forEach((s, i) => { pos[i * 3] = s[0] / s[3]; pos[i * 3 + 1] = s[1] / s[3]; pos[i * 3 + 2] = s[2] / s[3]; });
  return { pos, idx };
}

const chunks = [];
let offset = 0;
const push = (typed) => {
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (buf.length % 4)) % 4;
  chunks.push(buf, Buffer.alloc(pad));
  const at = offset;
  offset += buf.length + pad;
  return at;
};

function addMesh(name, tri, cell) {
  const { pos, idx } = simplify(tri, cell);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  const q = new Uint16Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) q[i + k] = Math.round(((pos[i + k] - min[k]) / ((max[k] - min[k]) || 1)) * 65535);
  const vcount = pos.length / 3;
  const wide = vcount > 65535;
  const I = wide ? Uint32Array.from(idx) : Uint16Array.from(idx);
  return { name, vcount, icount: idx.length, min, max, wide, pos: push(q), idx: push(I), tris: idx.length / 3, from: tri.length / 9 };
}

const meshes = {};
const used = [...new Set(Object.values(links).flat().map((v) => v.mesh))];
for (const name of used) meshes[name] = addMesh(name, readStl(`${SO101}assets/${name}.stl`, 1), 0.0011);

// Plate: plate frame mm → world metres, centred.
const plateRaw = readStl(PLATE, 1);
for (let i = 0; i < plateRaw.length; i += 3) {
  plateRaw[i] = (plateRaw[i] - PLATE_CENTRE[0]) / 1000;
  plateRaw[i + 1] = (plateRaw[i + 1] - PLATE_CENTRE[1]) / 1000;
  plateRaw[i + 2] = (plateRaw[i + 2] - PLATE_CENTRE[2]) / 1000;
}
meshes.plate = addMesh('plate', plateRaw, 0.0016);

const ORCHID = fitOrchid(JSON.parse(readFileSync(TAUGHT, 'utf8')).arms);
for (const [arm, zero] of Object.entries(ORCHID.zeros)) MOUNTS[arm].zero = zero;
const { zeros: _zeros, report: fitReport, ...orchidOut } = ORCHID;

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}rig.bin`, Buffer.concat(chunks));
writeFileSync(`${OUT}rig.json`, JSON.stringify({
  note: 'Generated by scripts/build-rig.mjs. SO101 model: TheRobotStudio/SO-ARM100 (Apache-2.0). Plate: Nebius SR101 Orchid plate v2.',
  meshes: Object.fromEntries(Object.entries(meshes).map(([k, m]) => [k, { vcount: m.vcount, icount: m.icount, min: m.min, max: m.max, wide: m.wide, pos: m.pos, idx: m.idx }])),
  links, joints, mounts: MOUNTS, orchid: orchidOut,
}));

for (const [arm, r] of Object.entries(fitReport)) console.log(`arm ${arm}: joint-zero correction ${JSON.stringify(MOUNTS[arm].zero)} · press error ${r.before} → ${r.after} mm`);
const total = Object.values(meshes).reduce((s, m) => s + m.tris, 0);
const from = Object.values(meshes).reduce((s, m) => s + m.from, 0);
for (const m of Object.values(meshes)) console.log(m.name.padEnd(36), String(m.from).padStart(7), '→', String(m.tris).padStart(6), 'tris');
console.log(`total ${from} → ${total} triangles, rig.bin ${(offset / 1024).toFixed(0)} KB`);

// ------------------------------------------------------------------ Orchid + arm corrections
function orchidLayout() {
  const P = ([x, y, z = 0]) => mm([ORCHID_AT[0] + x, ORCHID_AT[1] + y, ORCHID_AT[2] + z]);
  const at = (x, y, z) => P([x, y, z]);
  const whiteKeys = WHITE.map((note, i) => { const [x, y] = at(KEYS_X + PITCH * (i + 0.5), (KEY.white.y0 + KEY.white.y1) / 2); return { note, x, y }; });
  const blackKeys = BLACK.map((note) => { const [x, y] = at(KEYS_X + PITCH * BLACK_AT[note], (KEY.black.y0 + KEY.black.y1) / 2); return { note, x, y }; });
  const chords = CHORDS.flatMap((row, r) => row.map((control, i) => {
    const [x, y] = at(CHORD_GRID.x0 + CHORD_GRID.pitch * i, CHORD_GRID.rows[r]);
    return { control, x, y };
  }));
  const slopeZ = (y) => DECK_Z + ((y - PANEL_Y) / (TOP_Y - PANEL_Y)) * (O.h - DECK_Z);
  const panelY = 128, tilt = Math.atan2(O.h - DECK_Z, TOP_Y - PANEL_Y);
  const knob = (x, y, r, h, tint, onPanel) => ({ xyz: at(x, y, onPanel ? slopeZ(y) : DECK_Z), r: r / 1000, h: h / 1000, tint, tilt: onPanel ? tilt : 0 });
  const z = (v) => (ORCHID_AT[2] + v) / 1000;
  return {
    // Body: base slab, left deck block, right rim, the control strip's profile (y, z) and the top.
    body: {
      x0: P([0, 0])[0], x1: P([O.w, 0])[0], y0: P([0, 0])[1], floor: z(0),
      wellX0: P([KEYS_X - 4, 0])[0], wellX1: P([KEYS_X + 7 * PITCH + 1, 0])[0], wellY1: P([0, PANEL_Y])[1],
      deckZ: z(DECK_Z), wellZ: z(WELL_Z),
      profile: [[0, 0], [PANEL_Y, 0], [PANEL_Y, DECK_Z], [TOP_Y, O.h], [O.d, O.h], [O.d, 0]].map(([y, h]) => [P([0, y])[1], z(h)]),
      top: z(O.h),
    },
    whiteKeys, blackKeys, chords,
    whiteKey: { w: KEY.white.w / 1000, y0: P([0, KEY.white.y0])[1], y1: P([0, KEY.white.y1])[1], base: z(WELL_Z), top: z(KEY.white.top) },
    blackKey: { w: KEY.black.w / 1000, y0: P([0, KEY.black.y0])[1], y1: P([0, KEY.black.y1])[1], base: z(WELL_Z), top: z(KEY.black.top) },
    chordButton: { w: CHORD_GRID.size / 1000, base: z(DECK_Z), top: z(CHORD_GRID.top), travel: CHORD_GRID.travel / 1000 },
    knobs: [
      knob(122, 66, 13, 9, 'dial'), knob(106, 34, 8, 7, 'dial'), // voicing dials
      ...[['sound', 40], ['perform', 60], ['fx', 80]].map(([, x]) => knob(x, panelY, 5.5, 8, 'accent', true)),
      knob(102, panelY, 5, 8, 'plain', true),
      knob(186, panelY, 5.5, 8, 'hot', true),
      ...[208, 230, 252, 274].map((x) => knob(x, panelY, 5, 8, 'plain', true)),
    ],
    display: { xyz: at(150, panelY, slopeZ(panelY)), w: 0.024, d: 0.012, tilt },
    grille: [...Array(8)].map((_, i) => ({ xyz: at(200 + i * 11, 168, O.h), w: 0.004, d: 0.024 })),
    travel: TRAVEL,
  };
}

// Where each control is pressed, and how deep: its footprint on the deck and
// the height the fingertip reaches when the key is bottomed out.
function targets(o) {
  const t = {};
  for (const k of o.whiteKeys) t[k.note] = { x: k.x, hw: o.whiteKey.w / 2, slack: o.whiteKey.w / 4, y0: o.whiteKey.y0, y1: o.whiteKey.y0 + 0.06, z: o.whiteKey.top - TRAVEL };
  for (const k of o.blackKeys) t[k.note] = { x: k.x, hw: o.blackKey.w / 2, slack: 0, y0: o.blackKey.y0, y1: o.blackKey.y1, z: o.blackKey.top - TRAVEL };
  for (const c of o.chords) t[c.control] = { x: c.x, hw: o.chordButton.w / 2, slack: 0, centre: true, y0: c.y - o.chordButton.w / 2, y1: c.y + o.chordButton.w / 2, z: o.chordButton.top - o.chordButton.travel };
  return t;
}

function fitOrchid(taught) {
  const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((t, _, k) => t + A[i][k] * B[k][j], 0)));
  const T = ([x, y, z], [r, p, w]) => {
    const [cr, sr, cp, sp, cw, sw] = [Math.cos(r), Math.sin(r), Math.cos(p), Math.sin(p), Math.cos(w), Math.sin(w)];
    return [[cw * cp, cw * sp * sr - sw * cr, cw * sp * cr + sw * sr, x], [sw * cp, sw * sp * sr + cw * cr, sw * sp * cr - cw * sr, y], [-sp, cp * sr, cp * cr, z], [0, 0, 0, 1]];
  };
  const Rz = (q) => [[Math.cos(q), -Math.sin(q), 0, 0], [Math.sin(q), Math.cos(q), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  // Gripper vertices (fixed and moving jaw), decimated for speed: the fit runs thousands of poses.
  const jawVerts = {};
  for (const link of ['gripper_link', 'moving_jaw_so101_v1_link']) {
    jawVerts[link] = links[link].filter((v) => v.kind !== 'motor').map((v) => {
      const raw = readStl(`${SO101}assets/${v.mesh}.stl`, 1);
      return { v, pts: simplify(raw, 0.002).pos };
    });
  }
  // Contact point: lowest gripper vertex at a pose (model degrees).
  const contact = (arm, deg) => {
    const m = MOUNTS[arm];
    const W = { base_link: mul(T(m.xyz, [0, 0, 0]), Rz((m.yaw * Math.PI) / 180)) };
    for (let pass = 0; pass < joints.length; pass++) for (const j of joints) {
      if (!W[j.parent] || W[j.child]) continue;
      let M = mul(W[j.parent], T(j.xyz, j.rpy));
      if (j.type === 'revolute') M = mul(M, Rz(((deg[j.name] ?? 0) * Math.PI) / 180));
      W[j.child] = M;
    }
    let best = null;
    for (const [link, parts] of Object.entries(jawVerts)) for (const { v, pts } of parts) {
      const M = mul(W[link], T(v.xyz, v.rpy));
      for (let i = 0; i < pts.length; i += 3) {
        const z = M[2][0] * pts[i] + M[2][1] * pts[i + 1] + M[2][2] * pts[i + 2] + M[2][3];
        if (best && z >= best[2]) continue;
        best = [M[0][0] * pts[i] + M[0][1] * pts[i + 1] + M[0][2] * pts[i + 2] + M[0][3], M[1][0] * pts[i] + M[1][1] * pts[i + 1] + M[1][2] * pts[i + 2] + M[1][3], z];
      }
    }
    return best;
  };
  const o = orchidLayout();
  const tg = targets(o);
  const FIT = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex'];
  const zeros = {}, contacts = {}, report = {};
  for (const [arm, { calibration, controls }] of Object.entries(taught)) {
    const presses = Object.entries(controls).filter(([id]) => tg[id]).map(([id, t]) => [id, modelDegrees(t.press, calibration)]);
    const shifted = (deg, off) => ({ ...deg, ...Object.fromEntries(FIT.map((n, i) => [n, deg[n] + off[i]])) });
    // Cost (mm²): how far each press stop is outside its key's footprint, plus its
    // height error; a small pull toward zero keeps the corrections minimal.
    const cost = (off) => {
      let c = 0;
      for (const [id, deg] of presses) {
        const p = contact(arm, shifted(deg, off)), k = tg[id];
        // Chord buttons and black keys are pressed near their centre; white keys anywhere across their front half.
        const dx = Math.max(0, Math.abs(p[0] - k.x) - k.slack);
        const dy = k.centre ? p[1] - (k.y0 + k.y1) / 2 : Math.max(0, k.y0 - p[1], p[1] - k.y1);
        const dz = p[2] - k.z;
        c += (dx * dx + dy * dy + dz * dz) * 1e6;
      }
      return c / presses.length + 0.3 * off.reduce((t, v) => t + v * v, 0);
    };
    const off = nelderMead(cost, nelderMead(cost, [0, 0, 0, 0], 3), 1); // restart once to settle
    zeros[arm] = Object.fromEntries(FIT.map((n, i) => [n, +off[i].toFixed(2)]));
    report[arm] = { before: Math.sqrt(cost([0, 0, 0, 0])).toFixed(1), after: Math.sqrt(cost(off)).toFixed(1) };
    for (const [id, deg] of presses) contacts[id] = contact(arm, shifted(deg, off));
  }
  return { ...o, zeros, contacts, report };
}

// Nelder–Mead simplex minimiser (small, dependency-free).
function nelderMead(f, x0, step, iters = 400) {
  const n = x0.length;
  let s = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step : v)))].map((x) => ({ x, f: f(x) }));
  for (let it = 0; it < iters; it++) {
    s.sort((a, b) => a.f - b.f);
    if (Math.abs(s[n].f - s[0].f) < 1e-4) break;
    const c = s.slice(0, n).reduce((acc, p) => acc.map((v, i) => v + p.x[i] / n), Array(n).fill(0));
    const at = (t) => c.map((v, i) => v + t * (s[n].x[i] - v));
    const r = { x: at(-1) }; r.f = f(r.x);
    if (r.f < s[0].f) { const e = { x: at(-2) }; e.f = f(e.x); s[n] = e.f < r.f ? e : r; continue; }
    if (r.f < s[n - 1].f) { s[n] = r; continue; }
    const k = { x: at(0.5) }; k.f = f(k.x);
    if (k.f < s[n].f) { s[n] = k; continue; }
    s = s.map((p, i) => (i === 0 ? p : { x: p.x.map((v, j) => s[0].x[j] + (v - s[0].x[j]) / 2), f: 0 })).map((p, i) => (i === 0 ? p : { x: p.x, f: f(p.x) }));
  }
  s.sort((a, b) => a.f - b.f);
  return s[0].x;
}
