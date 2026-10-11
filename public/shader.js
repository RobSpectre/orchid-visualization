import { GLASS, PIXELS, AURORA } from './backgrounds.js';

// Full-screen WebGL2 nebula: domain-warped fbm folded through a kaleidoscope,
// with a tunnel of rings that advance one per beat. Drum hits feed uniforms
// that decay every frame, so the field breathes with the groove.

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uBeat;     // continuous beat position
uniform float uKick;     // 0..1, decays
uniform float uSnare;
uniform float uHat;
uniform float uNote;     // 0..1, last played pitch class / 12
uniform float uNoteHit;  // 0..1, decays
uniform float uThink;    // 0..1, agent token activity
uniform float uPlaying;  // 0 or 1, eased
out vec4 o;

const vec3 NAVY   = vec3(0.000, 0.102, 0.169);
const vec3 DEEP   = vec3(0.020, 0.169, 0.259);
const vec3 VIOLET = vec3(0.380, 0.306, 0.980);
const vec3 LIME   = vec3(0.878, 1.000, 0.310);
const vec3 MINT   = vec3(0.529, 0.929, 0.863);

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 6; i++) { v += a * noise(p); p = r * p * 2.03; a *= 0.5; }
  return v;
}
vec2 kaleido(vec2 p, float n) {
  float a = atan(p.y, p.x), r = length(p);
  float s = 6.28318 / n;
  a = mod(a, s);
  a = abs(a - s * 0.5);
  return vec2(cos(a), sin(a)) * r;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * 0.06;
  float beatPhase = fract(uBeat);
  float bar = floor(uBeat / 4.0);

  // Zoom punches on the kick, slow rotation drifts with the bar count.
  float zoom = 1.0 - 0.10 * uKick;
  vec2 p = uv * zoom;
  float rot = 0.04 * uBeat * uPlaying + t * 0.5;
  p = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * p;

  // Kaleidoscope folds: 6 at rest, more while the band plays.
  float folds = 6.0 + 2.0 * floor(mod(bar, 3.0)) * uPlaying;
  vec2 k = mix(p, kaleido(p, folds), 0.55 + 0.35 * uPlaying);

  // Domain warp.
  vec2 q = vec2(fbm(k * 1.6 + t), fbm(k * 1.6 - t + 4.1));
  vec2 r = vec2(fbm(k * 2.2 + 3.0 * q + vec2(1.7, 9.2) + 0.4 * uSnare),
                fbm(k * 2.2 + 3.0 * q + vec2(8.3, 2.8) - t));
  float f = fbm(k * 1.8 + 3.5 * r);

  vec3 col = mix(NAVY, DEEP, smoothstep(0.1, 0.8, f));
  col = mix(col, VIOLET, smoothstep(0.45, 0.95, length(q)) * (0.55 + 0.4 * uSnare));
  col = mix(col, MINT, smoothstep(0.6, 1.0, r.x) * 0.35 * (0.5 + uHat));
  // Note hits tint the cloud toward a hue around the pitch circle.
  vec3 noteCol = 0.5 + 0.5 * cos(6.28318 * (uNote + vec3(0.0, 0.33, 0.67)));
  col += noteCol * smoothstep(0.55, 1.0, f) * 0.35 * uNoteHit;

  // Tunnel rings, one per beat, rushing outward.
  float rad = length(uv);
  float lr = log(rad + 1e-3);
  float ringPos = fract(lr * 1.6 - uBeat * uPlaying - t * 0.6);
  float ring = smoothstep(0.035, 0.0, abs(ringPos - 0.5) - 0.002);
  float spokes = 0.5 + 0.5 * cos(atan(uv.y, uv.x) * folds + uBeat * 1.5708);
  col += LIME * ring * (0.10 + 0.55 * uKick) * smoothstep(0.05, 0.6, rad) * (0.4 + 0.6 * spokes) * uPlaying;

  // Agent thinking shows as drifting sparkle.
  float sp = step(0.9975 - 0.002 * uThink, hash(floor(gl_FragCoord.xy / 2.0) + floor(uTime * 12.0)));
  col += mix(MINT, LIME, hash(gl_FragCoord.xy)) * sp * (0.25 + uThink);

  // Core glow pulses with the beat.
  float pulse = exp(-beatPhase * 5.0) * uPlaying;
  col += LIME * 0.18 * pulse * exp(-rad * 4.0);
  col += VIOLET * 0.25 * exp(-rad * 2.2) * (0.3 + uKick);

  // Scanlines + vignette for the terminal-in-space feel.
  col *= 0.92 + 0.08 * sin(gl_FragCoord.y * 1.4);
  col *= smoothstep(1.35, 0.25, rad);
  o = vec4(col, 1.0);
}`;

// One WebGL context, one program per theme background, compiled on first use.
export function createNebula(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
  if (!gl) return null;
  const SOURCES = { nebula: FRAG, glass: GLASS, pixels: PIXELS, aurora: AURORA };
  const UNIFORMS = ['uRes', 'uTime', 'uBeat', 'uKick', 'uSnare', 'uHat', 'uNote', 'uNoteHit', 'uThink', 'uPlaying'];
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const vert = compile(gl.VERTEX_SHADER, VERT);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const programs = {};
  function program(mode) {
    if (programs[mode]) return programs[mode];
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, SOURCES[mode] ?? FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]));
    const loc = gl.getAttribLocation(prog, 'p');
    programs[mode] = { prog, u, loc };
    return programs[mode];
  }
  let current = program('nebula');

  // Render at reduced resolution; the fields are soft so they upscale cleanly.
  const scale = 0.5;
  function resize() {
    const w = Math.max(1, Math.floor(canvas.clientWidth * scale));
    const h = Math.max(1, Math.floor(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  return {
    setMode(mode) {
      try { current = program(mode); } catch (err) { console.warn('background shader failed', mode, err); current = program('nebula'); }
    },
    draw(s) {
      resize();
      const { prog, u, loc } = current;
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      gl.uniform1f(u.uTime, s.time);
      gl.uniform1f(u.uBeat, s.beat);
      gl.uniform1f(u.uKick, s.kick);
      gl.uniform1f(u.uSnare, s.snare);
      gl.uniform1f(u.uHat, s.hat);
      gl.uniform1f(u.uNote, s.note);
      gl.uniform1f(u.uNoteHit, s.noteHit);
      gl.uniform1f(u.uThink, s.think);
      gl.uniform1f(u.uPlaying, s.playing);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
