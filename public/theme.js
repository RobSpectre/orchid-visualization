// Themes: one palette object (P) that every canvas renderer reads live, plus
// per-theme CSS (body[data-theme]) and a background shader. Colours follow the
// Nebius Token Factory guidelines: Lime #DAFF33, Violet #5D52F6, Deep Blue
// #052B42, Lavender #C1C1FF, Light Blue #F0F8FF and the lime→cyan→periwinkle gradient.

const rgbCache = new Map();
function rgb(hex) {
  let v = rgbCache.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, v);
  }
  return v;
}
// Palette colour with alpha, for canvas strokes and fills.
export function a(hex, alpha) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

const BASE = {
  fontScale: 1,
  bg: '#001A2B', deep: '#052B42', void: '#000A12', keyDark: '#071A28',
};

export const THEMES = [
  {
    id: 'nebula', name: 'Nebula', blurb: 'deep-space nebula, kaleidoscope shader, mono',
    background: 'nebula',
    palette: {
      lime: '#E0FF4F', violet: '#614EFA', mint: '#87EDDC', mint2: '#AFF8EC', lavender: '#E0E4FF', hot: '#FF4FA3', ink: '#E0E4FF',
      font: "'JetBrains Mono', monospace",
    },
  },
  {
    id: 'glass', name: 'Glass Foundry', blurb: 'frosted glass slabs over a field of lit glass cubes',
    background: 'glass',
    palette: {
      lime: '#DAFF33', violet: '#6FA8F8', mint: '#7CF0D8', mint2: '#C9FBF0', lavender: '#C1C1FF', hot: '#62D9F2', ink: '#F0F8FF',
      font: "'Space Grotesk', sans-serif",
    },
  },
  {
    id: 'terminal', name: 'Inference Terminal', blurb: 'phosphor CRT, pixel-grid floor, >_ prompts',
    background: 'pixels',
    palette: {
      lime: '#DAFF33', violet: '#5D52F6', mint: '#7CF0D8', mint2: '#E8FFC2', lavender: '#C9F7A0', hot: '#F0F8FF', ink: '#E8FFC2',
      font: "'VT323', monospace", fontScale: 1.4, // pixel face runs small
    },
  },
  {
    id: 'signal', name: 'Signal', blurb: 'billboard gradient banner, outlined modules, aurora ribbons',
    background: 'aurora',
    palette: {
      lime: '#DAFF33', violet: '#8A8FF7', mint: '#8EF5C4', mint2: '#62D9F2', lavender: '#C1C1FF', hot: '#62D9F2', ink: '#F0F8FF',
      font: "'Space Grotesk', sans-serif",
    },
  },
];

// Live palette. Renderers read P.* every frame, so switching themes repaints everything.
export const P = { ...BASE, lanes: {}, layers: [] };

export function applyPalette(id) {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  Object.assign(P, BASE, t.palette);
  P.lanes = { kick: P.lime, snare: P.violet, hat: P.mint, perc: P.lavender };
  P.layers = [P.lime, P.mint, P.violet, P.hot, P.lavender, P.mint2];
  P.faint = a(P.ink, 0.08);
  P.dim = a(P.ink, 0.45);
  P.line = a(P.lime, 0.16);
  P.theme = t.id;
  P.background = t.background;
  return t;
}
applyPalette('nebula');
