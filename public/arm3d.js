// SO101 digital twin: both arms on the Nebius Orchid plate around the Orchid,
// rendered as a hologram and posed live from orchid-robot's joint angles.
//
// The rig (meshes, URDF joints, mounts, Orchid layout) is built offline by
// scripts/build-rig.mjs into models/rig.json + rig.bin. The look:
//   - parts drawn as a see-through shell with a bright fresnel rim and crisp
//     feature edges; motors tint orange as they heat up;
//   - a scan band sweeping up the rig; comet trails off each fingertip;
//   - the Orchid's keys and chord buttons light up when pressed (by the robot
//     or a person), with a ripple where the fingertip lands;
//   - a slow orbiting camera that leans toward whichever arm is playing.
// If WebGL or the model is unavailable, the 2D view (robotview.js) is used.

import * as THREE from './vendor/three/three.module.min.js';
import { S, on, NOTE_NAMES } from './state.js';
import { P, a as pa } from './theme.js';
import { createRobotView } from './robotview.js';

const rad = (d) => (d * Math.PI) / 180;
const FONT = (px, w = 400) => `${w} ${px * P.fontScale}px ${P.font}`;
const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];
const CHORD_LABEL = { 'chord.dim': 'Dim', 'chord.min': 'Min', 'chord.maj': 'Maj', 'chord.sus': 'Sus', 'chord.6': '6', 'chord.m7': 'm7', 'chord.M7': 'M7', 'chord.9': '9' };
const CHORD_CONTROL = Object.fromEntries(Object.entries(CHORD_LABEL).map(([k, v]) => [v, k]));
// Which joint each link's motor drives (for the temperature tint).
const MOTOR_JOINT = { base_link: 'shoulder_pan', shoulder_link: 'shoulder_lift', upper_arm_link: 'elbow_flex', lower_arm_link: 'wrist_flex', wrist_link: 'wrist_roll', gripper_link: 'gripper' };
const TRAIL = 110;

// ------------------------------------------------------------------ materials
// Everything is drawn additively (glow on the dark panel). A depth-only
// pre-pass keeps the hologram readable: only the front surface glows.
const shared = { uScan: { value: 0 } };
const VERT = `
  varying vec3 vN; varying vec3 vV; varying float vZ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vZ = wp.z;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const SHELL_FRAG = `
  uniform vec3 uColor; uniform vec3 uHot; uniform float uHeat; uniform float uBase; uniform float uRim; uniform float uScan;
  varying vec3 vN; varying vec3 vV; varying float vZ;
  void main() {
    float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float band = exp(-pow((vZ - uScan) / 0.005, 2.0));
    float a = uBase + uRim * pow(f, 2.4) + band * 0.35;
    gl_FragColor = vec4(mix(uColor, uHot, uHeat) * a, a * 0.25);
  }`;
const LINE_VERT = `
  varying float vZ;
  void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vZ = wp.z; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const LINE_FRAG = `
  uniform vec3 uColor; uniform vec3 uHot; uniform float uHeat; uniform float uOpacity; uniform float uScan;
  varying float vZ;
  void main() {
    float band = exp(-pow((vZ - uScan) / 0.004, 2.0));
    float a = uOpacity * (1.0 + band * 1.5);
    gl_FragColor = vec4(mix(uColor, uHot, uHeat) * a, a * 0.5);
  }`;
const additive = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor };
// Pure light (trails, ripples): adds colour, leaves the canvas alpha alone so
// faded (black) ends stay invisible over the panel.
const light = { ...additive, blendSrcAlpha: THREE.ZeroFactor };

function shellMat(base, rim) {
  return new THREE.ShaderMaterial({
    ...additive, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color() }, uHot: { value: new THREE.Color('#ff7a3a') }, uHeat: { value: 0 }, uBase: { value: base }, uRim: { value: rim }, uScan: shared.uScan },
    vertexShader: VERT, fragmentShader: SHELL_FRAG,
  });
}
function lineMat(opacity) {
  return new THREE.ShaderMaterial({
    ...additive,
    uniforms: { uColor: { value: new THREE.Color() }, uHot: { value: new THREE.Color('#ff7a3a') }, uHeat: { value: 0 }, uOpacity: { value: opacity }, uScan: shared.uScan },
    vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
  });
}
const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

// ------------------------------------------------------------------ rig
async function loadRig() {
  const [rig, bin] = await Promise.all([
    fetch('/models/rig.json').then((r) => { if (!r.ok) throw new Error('rig.json'); return r.json(); }),
    fetch('/models/rig.bin').then((r) => { if (!r.ok) throw new Error('rig.bin'); return r.arrayBuffer(); }),
  ]);
  const cache = {};
  rig.geometry = (name) => {
    if (cache[name]) return cache[name];
    const m = rig.meshes[name];
    const q = new Uint16Array(bin, m.pos, m.vcount * 3);
    const pos = new Float32Array(m.vcount * 3);
    for (let i = 0; i < pos.length; i++) { const k = i % 3; pos[i] = m.min[k] + (q[i] / 65535) * (m.max[k] - m.min[k]); }
    const idx = m.wide ? new Uint32Array(bin, m.idx, m.icount) : new Uint16Array(bin, m.idx, m.icount);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx.slice(), 1));
    g.computeVertexNormals();
    return (cache[name] = { g, edges: new THREE.EdgesGeometry(g, 32) });
  };
  return rig;
}

// One glowing part: depth pre-pass + shell + edges.
function part(geo, shell, line) {
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(geo.g, depthMat));
  const s = new THREE.Mesh(geo.g, shell); s.renderOrder = 1; grp.add(s);
  const e = new THREE.LineSegments(geo.edges, line); e.renderOrder = 2; grp.add(e);
  return grp;
}

function buildArm(rig, mount) {
  const mats = { shell: shellMat(0.03, 0.55), line: lineMat(0.55), motors: {} };
  const root = new THREE.Group();
  root.position.fromArray(mount.xyz);
  root.rotation.z = rad(mount.yaw);
  const links = { base_link: new THREE.Group() };
  root.add(links.base_link);
  const rotors = {};
  let pending = [...rig.joints];
  while (pending.length) {
    const before = pending.length;
    pending = pending.filter((j) => {
      const parent = links[j.parent];
      if (!parent) return true;
      const origin = new THREE.Group();
      origin.position.fromArray(j.xyz);
      origin.rotation.set(j.rpy[0], j.rpy[1], j.rpy[2], 'ZYX'); // URDF rpy: R = Rz·Ry·Rx
      parent.add(origin);
      const child = new THREE.Group();
      origin.add(child);
      if (j.type === 'revolute') rotors[j.name] = child;
      links[j.child] = child;
      return false;
    });
    if (pending.length === before) break;
  }
  for (const [name, visuals] of Object.entries(rig.links)) {
    const link = links[name];
    if (!link) continue;
    for (const v of visuals) {
      let shell = mats.shell, line = mats.line;
      if (v.kind === 'motor') {
        const joint = MOTOR_JOINT[name];
        mats.motors[joint] ??= { shell: shellMat(0.02, 0.4), line: lineMat(0.4) };
        ({ shell, line } = mats.motors[joint]);
      }
      const p = part(rig.geometry(v.mesh), shell, line);
      p.position.fromArray(v.xyz);
      p.rotation.set(v.rpy[0], v.rpy[1], v.rpy[2], 'ZYX');
      link.add(p);
    }
  }
  // Fingertip trail
  const trailPos = new Float32Array(TRAIL * 3), trailCol = new Float32Array(TRAIL * 3);
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  tg.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
  const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, ...light }));
  trail.frustumCulled = false;
  trail.renderOrder = 3;
  return { root, rotors, tip: links.gripper_frame_link, mats, trail, trailPts: [], j: null, zero: mount.zero ?? {} };
}

// The Orchid ORC-1 as build-rig.mjs lays it out from the product photos: a low
// front deck (chord buttons, voicing dials) with the keyboard set in on the
// right, a sloped control strip behind (knobs, OLED) and a top with speaker slots.
function buildOrchid(rig) {
  const o = rig.orchid, b = o.body;
  const grp = new THREE.Group();
  const body = shellMat(0.015, 0.25), bodyLine = lineMat(0.22);
  const accent = { lime: { shell: shellMat(0.05, 0.4), line: lineMat(0.5) }, hot: { shell: shellMat(0.05, 0.4), line: lineMat(0.5) } };
  const add = (g, shell, line, x, y, z, tilt = 0) => {
    const p = part({ g, edges: new THREE.EdgesGeometry(g, 25) }, shell, line);
    p.position.set(x, y, z);
    p.rotation.x = tilt;
    grp.add(p);
    return p;
  };
  const slab = (x0, y0, z0, x1, y1, z1) => add(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), body, bodyLine, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  slab(b.x0, b.y0, b.floor, b.x1, b.wellY1, b.wellZ); // base under the front deck
  slab(b.x0, b.y0, b.wellZ, b.wellX0, b.wellY1, b.deckZ); // chord deck (left)
  slab(b.wellX1, b.y0, b.wellZ, b.x1, b.wellY1, b.deckZ); // rim right of the keys
  // Control strip and top: the side profile (y, z) extruded across the width.
  const shape = new THREE.Shape(b.profile.map(([y, z]) => new THREE.Vector2(y, z)));
  const strip = new THREE.ExtrudeGeometry(shape, { depth: b.x1 - b.x0, bevelEnabled: false });
  const pos = strip.attributes.position;
  for (let i = 0; i < pos.count; i++) { // shape (x, y) = world (y, z); extrusion depth runs along world x
    pos.setXYZ(i, b.x0 + pos.getZ(i), pos.getX(i), pos.getY(i));
  }
  strip.computeVertexNormals();
  add(strip, body, bodyLine, 0, 0, 0);

  const keys = {}; // id -> { mat, line, level, obj, base, h }
  const addKey = (id, x, y, w, d, base, top) => {
    const h = top - base;
    const mat = shellMat(0.04, 0.35), line = lineMat(0.35);
    const k = add(new THREE.BoxGeometry(w, d, h), mat, line, x, y, base + h / 2);
    keys[id] = { mat, line, level: 0, obj: k, base, h };
  };
  const W = o.whiteKey, B = o.blackKey, C = o.chordButton;
  for (const k of o.whiteKeys) addKey(k.note, k.x, (W.y0 + W.y1) / 2, W.w, W.y1 - W.y0, W.base, W.top);
  for (const k of o.blackKeys) addKey(k.note, k.x, (B.y0 + B.y1) / 2, B.w, B.y1 - B.y0, B.base, B.top);
  for (const c of o.chords) addKey(c.control, c.x, c.y, C.w, C.w, C.base, C.top);
  for (const kn of o.knobs ?? []) {
    const g = new THREE.CylinderGeometry(kn.r, kn.r * 1.08, kn.h, 36);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, kn.h / 2);
    const m = kn.tint === 'accent' ? accent.lime : kn.tint === 'hot' ? accent.hot : { shell: body, line: bodyLine };
    add(g, m.shell, m.line, ...kn.xyz, kn.tilt);
  }
  const screenMat = shellMat(0.1, 0), screenLine = lineMat(0.45);
  if (o.display) add(new THREE.PlaneGeometry(o.display.w, o.display.d), screenMat, screenLine, o.display.xyz[0], o.display.xyz[1], o.display.xyz[2] + 0.0005, o.display.tilt);
  for (const g of o.grille ?? []) {
    const slot = new THREE.BoxGeometry(g.w, g.d, 0.0005);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(slot), bodyLine);
    e.position.set(g.xyz[0], g.xyz[1], g.xyz[2] + 0.0003);
    e.renderOrder = 2;
    grp.add(e);
  }
  return { grp, keys, body, bodyLine, screenMat, screenLine, accent };
}

// ------------------------------------------------------------------ view
export function createArmView(hud, metaEl) {
  const fallback = createRobotView(hud, metaEl);
  let view = null;
  let failed = false;

  const gl = document.createElement('canvas');
  gl.className = 'robot-gl';
  hud.before(gl);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
  } catch {
    failed = true;
    gl.remove();
  }
  if (!failed) {
    loadRig().then((rig) => { view = buildScene(rig); }).catch((err) => {
      console.warn('arm 3D view unavailable, using 2D:', err);
      failed = true;
      gl.remove();
    });
  }

  function buildScene(rig) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1.6, 0.01, 5);
    camera.up.set(0, 0, 1);
    const plateShell = shellMat(0.006, 0.12), plateLine = lineMat(0.2);
    scene.add(part(rig.geometry('plate'), plateShell, plateLine));
    const orchid = buildOrchid(rig);
    scene.add(orchid.grp);
    const arms = { a: buildArm(rig, rig.mounts.a), b: buildArm(rig, rig.mounts.b) };
    for (const arm of Object.values(arms)) { scene.add(arm.root); scene.add(arm.trail); }
    // Press ripples on the Orchid surface
    const rippleG = new THREE.RingGeometry(0.85, 1, 64);
    const ripples = [];
    const ripple = (pos, color) => {
      const m = new THREE.MeshBasicMaterial({ color, ...light, side: THREE.DoubleSide });
      const r = new THREE.Mesh(rippleG, m);
      r.position.copy(pos);
      r.renderOrder = 4;
      scene.add(r);
      ripples.push({ r, t: performance.now() });
    };
    // Floating labels at press points (drawn on the HUD)
    const labels = [];
    const cam = { az: -Math.PI / 2, focus: new THREE.Vector3(0, -0.01, 0.07), dist: 0.9 };
    return { rig, scene, camera, plateShell, plateLine, orchid, arms, ripple, ripples, labels, cam };
  }

  // Robot press: ripple + label at the fingertip, light the target control.
  on('robot-press', (p) => {
    if (!view) return;
    const arm = view.arms[p.arm];
    if (!arm) return;
    // Mark the activated control where it is pressed (its taught contact point,
    // on the key's top surface); fall back to the fingertip.
    const o = view.rig.orchid;
    const c = o.contacts?.[p.control];
    const top = p.control?.startsWith('chord.') ? o.chordButton.top : p.control?.includes('#') ? o.blackKey.top : o.whiteKey.top;
    const pos = c ? new THREE.Vector3(c[0], c[1], top + 0.001) : arm.tip.getWorldPosition(new THREE.Vector3());
    view.ripple(pos, new THREE.Color(P.hot));
    const label = p.control?.startsWith('chord.') ? CHORD_LABEL[p.control] ?? p.control : p.control ?? '';
    view.labels.push({ pos, label, t: performance.now(), color: p.arm === 'a' ? P.lime : P.mint });
    const key = view.orchid.keys[p.control];
    if (key) key.level = 1;
  });

  let last = performance.now();
  let palette = '';
  const v3 = new THREE.Vector3();

  function setColors() {
    const sig = [P.lime, P.mint, P.violet, P.lavender, P.ink, P.hot].join();
    if (sig === palette) return;
    palette = sig;
    const { arms, orchid, plateShell, plateLine } = view;
    for (const [id, arm] of Object.entries(arms)) {
      const c = id === 'a' ? P.lime : P.mint;
      arm.mats.shell.uniforms.uColor.value.set(c);
      arm.mats.line.uniforms.uColor.value.set(c);
      for (const m of Object.values(arm.mats.motors)) { m.shell.uniforms.uColor.value.set(P.lavender); m.line.uniforms.uColor.value.set(P.lavender); }
    }
    plateShell.uniforms.uColor.value.set(P.violet);
    plateLine.uniforms.uColor.value.set(P.lavender);
    orchid.body.uniforms.uColor.value.set(P.lavender);
    orchid.bodyLine.uniforms.uColor.value.set(P.lavender);
    orchid.screenMat.uniforms.uColor.value.set(P.mint);
    orchid.screenLine.uniforms.uColor.value.set(P.mint);
    for (const [k, c] of [['lime', P.lime], ['hot', P.hot]]) { orchid.accent[k].shell.uniforms.uColor.value.set(c); orchid.accent[k].line.uniforms.uColor.value.set(c); }
    for (const k of Object.values(orchid.keys)) { k.mat.uniforms.uColor.value.set(P.ink); k.line.uniforms.uColor.value.set(P.ink); k.mat.uniforms.uHot.value.set(P.hot); k.line.uniforms.uHot.value.set(P.hot); }
  }

  function poseArm(arm, data, now, dt, offline) {
    const target = {};
    for (const n of JOINTS) {
      const deg = offline ? null : data?.joints?.find((x) => x.name === n)?.deg;
      // No data: a slow idle breath around the rest pose.
      target[n] = deg ?? ({ shoulder_lift: -6 + Math.sin(now / 1500) * 5, elbow_flex: 20 + Math.sin(now / 1300) * 6, wrist_flex: 80 + Math.sin(now / 1700) * 5 }[n] ?? 0);
    }
    target.gripper = Math.max(-10, Math.min(100, target.gripper));
    // Per-arm joint-zero corrections (build-rig.mjs fits them so taught presses meet the keys).
    if (!offline) for (const [n, d] of Object.entries(arm.zero)) target[n] += d;
    if (!arm.j) arm.j = { ...target };
    const k = 1 - Math.exp(-dt / 90); // state arrives at ~4 Hz; glide between samples
    for (const n of JOINTS) {
      arm.j[n] += (target[n] - arm.j[n]) * k;
      if (arm.rotors[n]) arm.rotors[n].rotation.z = rad(arm.j[n]);
    }
    // Motor heat: 35 °C cool → 60 °C hot
    for (const [joint, m] of Object.entries(arm.mats.motors)) {
      const t = data?.joints?.find((x) => x.name === joint)?.temp;
      const h = t == null ? 0 : Math.max(0, Math.min(1, (t - 35) / 25));
      m.shell.uniforms.uHeat.value = h; m.line.uniforms.uHeat.value = h;
    }
    const dim = offline ? 0.35 : 1;
    arm.mats.shell.uniforms.uRim.value = 0.55 * dim;
    arm.mats.line.uniforms.uOpacity.value = (data?.playing ? 0.75 : 0.55) * dim;
  }

  function updateTrail(arm, now, color) {
    arm.root.updateMatrixWorld(true);
    const p = arm.tip.getWorldPosition(new THREE.Vector3());
    arm.trailPts.push({ p, t: now });
    while (arm.trailPts.length > TRAIL) arm.trailPts.shift();
    const pos = arm.trail.geometry.attributes.position, col = arm.trail.geometry.attributes.color;
    const c = new THREE.Color(color);
    const n = arm.trailPts.length;
    for (let i = 0; i < TRAIL; i++) {
      const e = arm.trailPts[Math.max(0, n - TRAIL + i)] ?? arm.trailPts[0];
      pos.setXYZ(i, e.p.x, e.p.y, e.p.z);
      const life = Math.max(0, 1 - (now - e.t) / 1600) ** 1.5;
      col.setXYZ(i, c.r * life, c.g * life, c.b * life);
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    return p;
  }

  // Key lights: robot presses (set to 1 on press), live Orchid keys, held chord.
  function lightKeys(dt, chordHeld) {
    const { keys } = view.orchid;
    const now = performance.now();
    const human = {};
    for (const [pc, k] of S.keysDown) {
      const age = k.released ? (now - k.released) / 600 : 0;
      human[NOTE_NAMES[pc]] = Math.max(0, 1 - age) * (0.6 + 0.4 * (k.vel ?? 0.7));
    }
    if (S.chordLit && now - S.chordLit.at < 1200) human[CHORD_CONTROL[S.chordLit.name]] = 1 - (now - S.chordLit.at) / 1200;
    if (chordHeld) human[chordHeld] = Math.max(human[chordHeld] ?? 0, 0.7);
    for (const [id, k] of Object.entries(keys)) {
      k.level = Math.max(human[id] ?? 0, k.level * Math.exp(-dt / 500));
      k.mat.uniforms.uHeat.value = k.level; k.line.uniforms.uHeat.value = k.level;
      k.mat.uniforms.uBase.value = 0.04 + k.level * 0.5;
      k.obj.position.z = k.base + k.h / 2 - k.level * (view.rig.orchid.travel ?? 0.004); // keys go down when pressed
    }
  }

  function moveCamera(now, dt, w, h, focusTip) {
    const { camera, cam } = view;
    camera.aspect = w / h;
    // Fit the plate (≈0.51 × 0.37 m, seen from ~40° up) plus the raised arms.
    const t = Math.tan(rad(camera.fov) / 2);
    let dist = Math.max(0.215 / t, 0.26 / (t * camera.aspect));
    const az = -Math.PI / 2 + Math.sin((now / 26000) * Math.PI * 2) * 0.42;
    const el = 0.66 + Math.sin((now / 37000) * Math.PI * 2) * 0.1;
    const goal = new THREE.Vector3(0, 0.0, 0.08);
    if (focusTip) { goal.lerp(focusTip, 0.25); dist *= 0.9; } // lean in on the playing arm
    const k = 1 - Math.exp(-dt / 900);
    cam.focus.lerp(goal, k);
    cam.dist += (dist - cam.dist) * k;
    camera.position.set(
      cam.focus.x + cam.dist * Math.cos(el) * Math.cos(az),
      cam.focus.y + cam.dist * Math.cos(el) * Math.sin(az),
      cam.focus.z + cam.dist * Math.sin(el),
    );
    camera.lookAt(cam.focus);
    camera.updateProjectionMatrix();
  }

  const describe = (a, isChord, offline) => {
    if (!a || offline) return { line: 'offline', progress: null };
    const what = a.sequence || (isChord ? CHORD_LABEL[a.chordHeld] ?? CHORD_LABEL[a.selected] ?? a.selected : a.selected) || '—';
    return { line: (a.playing ? `▶ ${what}` : `${(a.phase || '').replace(/_/g, ' ')} · ${what}`).slice(0, 34), progress: a.playing ? a.progress : null };
  };

  function drawHud(ctx, w, h, A, B, offline, now) {
    const pad = 10;
    const block = (x, align, title, color, arm, d) => {
      ctx.textAlign = align; ctx.textBaseline = 'top';
      ctx.font = FONT(11, 800); ctx.fillStyle = color;
      ctx.fillText(title, x, pad);
      ctx.font = FONT(10);
      ctx.fillStyle = offline ? P.hot : pa(P.ink, 0.65);
      ctx.fillText(offline ? 'NO SIGNAL' : arm?.playing ? '● LIVE' : 'STANDBY', x, pad + 15);
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = pa(P.ink, 0.8);
      ctx.font = FONT(11, 600);
      ctx.fillText(d.line, x, h - pad - 4);
      const bw = Math.min(160, w * 0.3);
      const bx = align === 'left' ? x : x - bw;
      ctx.fillStyle = pa(P.ink, 0.12); ctx.fillRect(bx, h - pad, bw, 2);
      if (d.progress != null) { ctx.fillStyle = P.hot; ctx.fillRect(bx, h - pad, bw * d.progress, 2); }
    };
    // Camera looks from the player's side: the Chord arm (left mount) is on the left.
    block(pad, 'left', 'CHORD ARM', P.mint, B, describe(B, true, offline));
    block(w - pad, 'right', 'KEYS ARM', P.lime, A, describe(A, false, offline));
    // Press labels float up from the fingertip
    for (let i = view.labels.length - 1; i >= 0; i--) {
      const l = view.labels[i];
      const t = (now - l.t) / 1400;
      if (t >= 1) { view.labels.splice(i, 1); continue; }
      v3.copy(l.pos).project(view.camera);
      const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h - 14 - t * 26;
      ctx.globalAlpha = 1 - t * t;
      ctx.font = FONT(16, 800); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = l.color; ctx.fillText(l.label, x, y);
      ctx.globalAlpha = 1;
    }
  }

  return function draw(now) {
    if (failed || !view) return fallback(now);
    const dt = Math.min(100, now - last);
    last = now;
    const w = hud.clientWidth, h = hud.clientHeight;
    if (!w || !h) return;
    // Keep the GL canvas exactly under the HUD canvas.
    const box = `${hud.offsetLeft}px,${hud.offsetTop}px,${w}px,${h}px`;
    if (gl.dataset.box !== box) {
      gl.dataset.box = box;
      Object.assign(gl.style, { left: `${hud.offsetLeft}px`, top: `${hud.offsetTop}px`, width: `${w}px`, height: `${h}px` });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(w, h, false);
    }
    setColors();

    const r = S.robot;
    const offline = !r || (!S.demo && S.sources.robot?.online === false);
    metaEl.textContent = offline ? 'offline · start orchid-robot' : `${r.arms[0]?.mode ?? ''}${typeof r.port === 'number' ? ` · :${r.port}` : ''}`;
    const A = r?.arms?.find((x) => x.arm === 'a');
    const B = r?.arms?.find((x) => x.arm === 'b');

    shared.uScan.value = 0.035 + ((now / 3200) % 1) * 0.3; // starts above the Orchid: a band on the flat plate would flood it
    poseArm(view.arms.a, A, now, dt, offline || A?.connected === false);
    poseArm(view.arms.b, B, now, dt, offline || B?.connected === false);
    const tipA = updateTrail(view.arms.a, now, P.lime);
    const tipB = updateTrail(view.arms.b, now, P.mint);
    lightKeys(dt, B?.chordHeld);
    for (let i = view.ripples.length - 1; i >= 0; i--) {
      const rp = view.ripples[i];
      const t = (now - rp.t) / 900;
      if (t >= 1) { view.scene.remove(rp.r); rp.r.material.dispose(); view.ripples.splice(i, 1); continue; }
      rp.r.scale.setScalar(0.004 + t * 0.03);
      rp.r.material.color.set(P.hot).multiplyScalar(1 - t);
    }
    const focus = A?.playing && !B?.playing ? tipA : B?.playing && !A?.playing ? tipB : null;
    moveCamera(now, dt, w, h, focus);
    renderer.render(view.scene, view.camera);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (hud.width !== Math.round(w * dpr) || hud.height !== Math.round(h * dpr)) { hud.width = Math.round(w * dpr); hud.height = Math.round(h * dpr); }
    const ctx = hud.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawHud(ctx, w, h, A, B, offline, now);
  };
}
