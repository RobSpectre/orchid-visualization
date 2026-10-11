// Background shaders for the themes. Same uniforms as the nebula shader, so
// every background reacts to the kick, snare, hats, notes, agent activity and
// Studio's transport (uPlaying eases to 0 when Studio pauses).

const HEAD = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uBeat;
uniform float uKick;
uniform float uSnare;
uniform float uHat;
uniform float uNote;
uniform float uNoteHit;
uniform float uThink;
uniform float uPlaying;
out vec4 o;

const vec3 DEEP   = vec3(0.020, 0.169, 0.259);   // #052B42
const vec3 LIME   = vec3(0.855, 1.000, 0.200);   // #DAFF33
const vec3 VIOLET = vec3(0.365, 0.322, 0.965);   // #5D52F6
const vec3 LAV    = vec3(0.757, 0.757, 1.000);   // #C1C1FF
const vec3 LBLUE  = vec3(0.941, 0.973, 1.000);   // #F0F8FF

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// The brand gradient: lime -> mint -> cyan -> sky -> periwinkle
vec3 brand(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.855, 1.0, 0.2), c1 = vec3(0.56, 0.96, 0.77), c2 = vec3(0.38, 0.85, 0.95), c3 = vec3(0.44, 0.66, 0.97), c4 = vec3(0.54, 0.56, 0.97);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
`;

// Glass Foundry: a tilted wall of glass cubes (from the brand imagery). A lit
// band of cubes climbs the wall in a staircase, one step per beat; the kick
// lifts the whole wall, hats sparkle single cubes, notes tint the glass.
export const GLASS = HEAD + `
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  // soft studio light like the guideline backgrounds
  vec3 col = mix(vec3(0.012, 0.07, 0.11), DEEP, smoothstep(-0.8, 0.6, uv.y));
  col += vec3(0.05, 0.22, 0.25) * exp(-length(uv - vec2(-0.6, 0.35)) * 1.6);
  col += VIOLET * 0.12 * exp(-length(uv - vec2(0.55, -0.1)) * 1.8);

  // tilt the wall in perspective
  float persp = 1.0 / (1.0 + uv.y * 0.35);
  vec2 g = vec2(uv.x * persp, uv.y * persp);
  float a = -0.42;
  g = mat2(cos(a), -sin(a), sin(a), cos(a)) * g;
  g = g * 5.2 + vec2(uTime * 0.05, uTime * 0.02);
  vec2 id = floor(g);
  vec2 p = fract(g) - 0.5;
  float h = hash(id);

  // staircase band: a diagonal that advances one cell per beat
  float diag = id.x + id.y;
  float band = fract((diag - uBeat * uPlaying) / 9.0);
  float lit = smoothstep(0.22, 0.0, band) * uPlaying;
  lit += step(0.965, h) * (0.35 + 0.65 * fract(h * 37.0 + uTime * 0.2));       // ambient stray cubes
  lit += step(0.985, hash(id + floor(uTime * 9.0))) * uHat * 1.5;               // hat sparkle
  lit += uKick * 0.35 * smoothstep(1.4, 0.0, length(uv));                       // kick lifts the centre
  lit = clamp(lit, 0.0, 1.6);

  float d = sdRoundBox(p, vec2(0.40), 0.11);
  vec3 tint = mix(vec3(0.38, 0.85, 0.95), brand(fract(uNote + h * 0.3)), 0.6 * uNoteHit);
  // glass body: dark core, bright refractive rim, specular glint
  float inside = smoothstep(0.01, -0.01, d);
  float rim = smoothstep(0.0, -0.03, d) - smoothstep(-0.03, -0.12, d);
  float core = smoothstep(-0.05, -0.38, d);
  vec3 glass = tint * (0.06 + 0.5 * lit) * (1.0 - core * 0.55);
  glass += tint * rim * (0.25 + 0.9 * lit);
  glass += LBLUE * exp(-length(p - vec2(-0.2, 0.22)) * 10.0) * (0.15 + 0.6 * lit);
  glass += LIME * rim * lit * uKick * 0.6;
  col = mix(col, col * 0.6 + glass, inside);
  // bloom around lit cubes
  col += tint * exp(-max(d, 0.0) * 22.0) * lit * 0.35 * (1.0 - inside);
  // depth fog and vignette
  col *= smoothstep(1.4, 0.2, length(uv));
  o = vec4(col, 1.0);
}`;

// Inference Terminal: a glowing pixel-grid floor running to the horizon (from
// the ">_" brand image). Rows rush toward you at the tempo; the kick flashes
// the near rows lime; the sky holds faint pixel stars. Rendered in chunky pixels.
export const PIXELS = HEAD + `
void main() {
  float px = max(2.0, floor(uRes.y / 270.0));
  vec2 fc = floor(gl_FragCoord.xy / px) * px;
  vec2 uv = fc / uRes;
  float horizon = 0.46;
  vec3 col = vec3(0.004, 0.035, 0.055);
  if (uv.y < horizon) {
    float y = horizon - uv.y;
    float z = 0.18 / y;                                     // depth
    float x = (uv.x - 0.5) * z * (uRes.x / uRes.y) * 2.2;
    float travel = uBeat * uPlaying * 1.0 + uTime * 0.05;
    vec2 cell = vec2(x * 1.6, z * 1.1 - travel);
    vec2 id = floor(cell), f = fract(cell);
    float gap = step(0.12, f.x) * step(f.x, 0.88) * step(0.12, f.y) * step(f.y, 0.88);
    float h = hash(id);
    float on = step(0.82, h) * (0.45 + 0.55 * sin(uTime * 1.3 + h * 40.0) * 0.5 + 0.5);
    // beat row: the row that crosses the camera on each beat lights up
    float row = fract((z * 1.1 - travel) / 4.0);
    on += smoothstep(0.06, 0.0, abs(row - 0.02)) * uPlaying * 0.9;
    on += uKick * smoothstep(3.0, 0.6, z) * 1.2;
    on += step(0.97, hash(id + floor(uTime * 8.0))) * uHat * 1.4;
    vec3 tint = mix(vec3(0.38, 0.85, 0.95), VIOLET, step(0.5, fract(h * 7.0)));
    tint = mix(tint, LIME, step(0.85, fract(h * 13.0)) + uKick * smoothstep(3.0, 0.6, z) * 0.8);
    float fog = exp(-z * 0.22);
    vec3 tile = tint * gap * (0.06 + on) * fog;
    vec3 lines = vec3(0.38, 0.85, 0.95) * (1.0 - gap) * 0.10 * fog;
    col += tile + lines;
  } else {
    float sy = uv.y - horizon;
    col = mix(vec3(0.012, 0.08, 0.13), vec3(0.004, 0.02, 0.04), smoothstep(0.0, 0.5, sy));
    vec2 sc = floor(fc / (px * 2.0));
    col += LBLUE * step(0.996, hash(sc)) * (0.35 + 0.65 * fract(hash(sc + 1.0) + uTime * 0.3));
    // horizon glow
    col += mix(LIME, vec3(0.38, 0.85, 0.95), 0.6) * exp(-sy * 40.0) * (0.35 + uKick * 0.5);
    col += VIOLET * exp(-sy * 6.0) * 0.18;
  }
  // agent activity: thin scan bar sweeping up
  float scan = fract(uTime * 0.12);
  col += LIME * smoothstep(0.004, 0.0, abs(uv.y - scan)) * 0.25 * uThink;
  // CRT: scanlines + vignette
  col *= 0.86 + 0.14 * step(0.5, fract(gl_FragCoord.y / (px * 2.0)));
  vec2 v = gl_FragCoord.xy / uRes - 0.5;
  col *= 1.0 - dot(v, v) * 1.1;
  o = vec4(col, 1.0);
}`;

// Signal: slow aurora ribbons in the brand gradient over deep blue, with the
// soft studio glows of the guideline backdrops. Ribbons swell with the kick,
// shimmer with hats, and the ribbon nearest the played pitch brightens.
export const AURORA = HEAD + `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float ar = uRes.x / uRes.y;
  vec2 q = vec2(uv.x * ar, uv.y);
  vec3 col = mix(vec3(0.01, 0.06, 0.1), DEEP, uv.y);
  col += vec3(0.05, 0.22, 0.24) * exp(-length(q - vec2(0.2, 0.9)) * 1.4);
  col += VIOLET * 0.22 * exp(-length(q - vec2(ar * 0.55, 0.65)) * 1.6);
  float t = uTime * 0.35 + uBeat * 0.08 * uPlaying;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float y = 0.5 + 0.17 * sin(uv.x * 2.1 + t + fi * 1.7) + 0.07 * sin(uv.x * 5.3 - t * 1.4 + fi * 2.3);
    y += (fi - 2.0) * 0.07;
    y += uKick * 0.025 * sin(uv.x * 14.0 + fi);
    float d = abs(uv.y - y);
    float thick = 0.010 + 0.006 * sin(uv.x * 9.0 + t * 2.0 + fi) + uKick * 0.01;
    float glow = exp(-d * d / (thick * thick)) * (0.32 + 0.3 * uPlaying);
    float wide = exp(-d * 9.0) * 0.07;
    float sel = 1.0 - smoothstep(0.0, 0.25, abs(uNote - fi / 5.0));
    float gain = 0.6 + sel * uNoteHit * 1.4 + uSnare * 0.4;
    float shimmer = 1.0 + uHat * 0.8 * (noise(vec2(uv.x * 80.0, uTime * 6.0 + fi)) - 0.5);
    vec3 c = brand(uv.x * 0.85 + fi * 0.04 + 0.05 * sin(t));
    col += c * (glow * gain * shimmer + wide);
  }
  col += LIME * 0.04 * uThink * noise(uv * 40.0 + uTime);
  col *= 1.0 - 0.35 * pow(length(uv - 0.5) * 1.3, 2.0);
  o = vec4(col, 1.0);
}`;
