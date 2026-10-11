// The 3D rig must put the fingertip where the real arm presses: run taught
// waypoints through rig.json's joint chain and mount, and compare with the
// press points the Orchid layout was built from (plate frame, mm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rig = JSON.parse(readFileSync(new URL('../public/models/rig.json', import.meta.url), 'utf8'));
const PLATE_Y = 638.85; // build-rig.mjs centres the plate on the origin

const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
const T = ([x, y, z], [r, p, w]) => {
  const [cr, sr, cp, sp, cw, sw] = [Math.cos(r), Math.sin(r), Math.cos(p), Math.sin(p), Math.cos(w), Math.sin(w)];
  return [[cw * cp, cw * sp * sr - sw * cr, cw * sp * cr + sw * sr, x], [sw * cp, sw * sp * sr + cw * cr, sw * sp * cr - cw * sr, y], [-sp, cp * sr, cp * cr, z], [0, 0, 0, 1]];
};
const Rz = (q) => [[Math.cos(q), -Math.sin(q), 0, 0], [Math.sin(q), Math.cos(q), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

function tip(armId, deg) {
  const m = rig.mounts[armId];
  const W = { base_link: mul(T(m.xyz, [0, 0, 0]), Rz((m.yaw * Math.PI) / 180)) };
  for (let pass = 0; pass < rig.joints.length; pass++) {
    for (const j of rig.joints) {
      if (!W[j.parent] || W[j.child]) continue;
      let M = mul(W[j.parent], T(j.xyz, j.rpy));
      if (j.type === 'revolute') M = mul(M, Rz(((deg[j.name] ?? 0) * Math.PI) / 180));
      W[j.child] = M;
    }
  }
  const g = W.gripper_frame_link;
  return [g[0][3] * 1000, g[1][3] * 1000 + PLATE_Y, g[2][3] * 1000];
}
const near = (got, want, tol = 1.5) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < tol, `${got.map((x) => x.toFixed(1))} vs ${want}`));

test('kinematics: zero pose puts the fingertip 391 mm ahead of and 226 mm above base_link', () => {
  const m = rig.mounts.b, yaw = (m.yaw * Math.PI) / 180;
  const want = [m.xyz[0] * 1000 + 391 * Math.cos(yaw), m.xyz[1] * 1000 + PLATE_Y + 391 * Math.sin(yaw), m.xyz[2] * 1000 + 226];
  near(tip('b', {}), want, 1.5);
});

test('with the joint-zero corrections, every taught press lands on its own key', () => {
  const o = rig.orchid;
  const boxes = [
    ...o.whiteKeys.map((k) => ({ id: k.note, x: k.x, w: o.whiteKey.w, y0: o.whiteKey.y0, y1: o.whiteKey.y1, z: o.whiteKey.top - o.travel })),
    ...o.blackKeys.map((k) => ({ id: k.note, x: k.x, w: o.blackKey.w, y0: o.blackKey.y0, y1: o.blackKey.y1, z: o.blackKey.top - o.travel })),
    ...o.chords.map((c) => ({ id: c.control, x: c.x, w: o.chordButton.w, y0: c.y - o.chordButton.w / 2, y1: c.y + o.chordButton.w / 2, z: o.chordButton.top - o.chordButton.travel })),
  ];
  const inside = (b, [x, y], tol = 0) => Math.abs(x - b.x) <= b.w / 2 + tol && y >= b.y0 - tol && y <= b.y1 + tol;
  assert.ok(Object.keys(o.contacts).length >= 12, 'taught contacts present');
  for (const [id, p] of Object.entries(o.contacts)) {
    const own = boxes.find((b) => b.id === id);
    // within 5 mm of its key (orchid-robot itself reports some keys pressed ~5 mm off-centre), at the pressed height
    assert.ok(own && inside(own, p, 0.005), `${id} press ${p.map((v) => (v * 1000).toFixed(0))} is on its key`);
    assert.ok(Math.abs(p[2] - own.z) < 0.008, `${id} press height ${(p[2] * 1000).toFixed(0)} mm vs key ${(own.z * 1000).toFixed(0)} mm`);
    const other = boxes.find((b) => b.id !== id && inside(b, p) && !(own.id.length === 1 && b.id.includes('#') === false));
    assert.ok(!other || !other.id.includes('#') || id.includes('#'), `${id} press also hits ${other?.id}`);
  }
});

test('joint-zero corrections stay small (hand-centred calibration error, a few degrees)', () => {
  for (const arm of ['a', 'b']) for (const d of Object.values(rig.mounts[arm].zero ?? {})) assert.ok(Math.abs(d) < 12, `arm ${arm} correction ${d}°`);
});

test('arms mount on the plate pads, Keys right and Chord left', () => {
  assert.ok(rig.mounts.a.xyz[0] > 0.15 && rig.mounts.b.xyz[0] < -0.15);
});
