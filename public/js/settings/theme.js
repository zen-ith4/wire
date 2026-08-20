// ============================================================
// Accent theming + ambient background intensity
// ============================================================

export const ACCENT_PRESETS = [
  { name: 'Neutral', hex: '#5C5C6E', rgb: '92, 92, 110' },
  { name: 'Blue',    hex: '#5F84AD', rgb: '95, 132, 173' },
  { name: 'Emerald', hex: '#5F8B6F', rgb: '95, 139, 111' },
  { name: 'Purple',  hex: '#7D6F9A', rgb: '125, 111, 154' },
  { name: 'Orange',  hex: '#A8805D', rgb: '168, 128, 93' },
  { name: 'Red',     hex: '#9A5D5D', rgb: '154, 93, 93' },
];

export const AMBIENT_LEVELS = [0.05, 0.15, 0.28, 0.40, 0.55];

export const DEFAULT_AMBIENT_LEVEL = 3;

const LAYER_RATIOS = [1, 0.9, 0.5, 0.65, 0.6];

const ACCENT_STORAGE_KEY = 'filehub-accent';
const AMBIENT_STORAGE_KEY = 'filehub-ambient-level';

function safeGetStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage isn't required for the current session.
  }
}


// ============================================================
// Accent helpers
// ============================================================

export function getCurrentAccentHex() {
  const saved = safeGetStorage(ACCENT_STORAGE_KEY);

  if (
    typeof saved === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(saved)
  ) {
    return saved.toUpperCase();
  }

  const preset = ACCENT_PRESETS.find(
    p => p.name === saved
  );

  return preset?.hex || ACCENT_PRESETS[0].hex;
}


export function getCurrentAccentName() {
  const hex = getCurrentAccentHex();

  const preset = ACCENT_PRESETS.find(
    p => p.hex.toUpperCase() === hex.toUpperCase()
  );

  return preset?.name || null;
}


// ============================================================
// Ambient
// ============================================================

export function getCurrentAmbientLevel() {
  const raw = Number(
    safeGetStorage(AMBIENT_STORAGE_KEY)
  );

  return Number.isInteger(raw)
    && raw >= 0
    && raw < AMBIENT_LEVELS.length
      ? raw
      : DEFAULT_AMBIENT_LEVEL;
}


function hexToRgb(hex) {
  const clean = hex.replace('#', '');

  const value = Number.parseInt(clean, 16);

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}


function rgbStringFromHex(hex) {
  const { r, g, b } = hexToRgb(hex);

  return `${r}, ${g}, ${b}`;
}


// ============================================================
// Secondary atmospheric hue
//
// The ambient background now reads as one continuous field lit from
// two softly-different color temperatures (see paintUnderlay())
// rather than a single-hue wash. Deriving the second color from the
// active accent — instead of hardcoding e.g. "purple + blue" — means
// it stays coherent no matter which accent preset the user picks,
// including the desaturated "Neutral" default (low saturation in ==
// low saturation out, so it doesn't invent color that isn't there).
// ============================================================

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  return { h, s, l };
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }

  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  };
}

// Hue-shift ~40° and lift lightness/saturation slightly, so the
// second glow reads as a related-but-distinct light source (e.g.
// Blue -> blue-violet, Emerald -> teal, Red -> orange) instead of a
// duplicate of the accent.
function secondaryRgbString(rgbString) {
  const [r, g, b] = rgbString.split(',').map((n) => Number(n.trim()));
  const { h, s, l } = rgbToHsl(r, g, b);

  const shifted = hslToRgb(
    (h + 0.11) % 1,
    Math.min(1, s * 0.92 + 0.04),
    Math.min(0.8, l * 1.12 + 0.04)
  );

  return `${shifted.r}, ${shifted.g}, ${shifted.b}`;
}


let currentRgb =
  ACCENT_PRESETS[0].rgb;

let currentLevel =
  getCurrentAmbientLevel();


// ============================================================
// Ambient background
// ============================================================

function paintUnderlay() {
  const peak = AMBIENT_LEVELS[currentLevel];

  document.documentElement.style.setProperty(
    '--ambient-strength',
    peak
  );

  const underlay =
    document.getElementById('ambient-underlay');

  if (!underlay) return;

  const [
    a1,
    a2,
    a3,
    a4,
    a5
  ] = LAYER_RATIOS.map(
    r => (peak * r).toFixed(3)
  );

  // Five large, soft, overlapping fields (alternating the accent's
  // two hues) instead of a handful of separate small "bubbles" —
  // wide multi-stop falloffs mean neighboring fields fade into each
  // other with no ring/edge where they meet, and the oversized third
  // field bridges the middle of the viewport so the whole thing
  // reads as one continuous atmosphere rather than four corner glows.
  underlay.style.background = `
    radial-gradient(
      ellipse 140% 100% at 12% 0%,
      rgba(var(--indigo), ${a1}) 0%,
      rgba(var(--indigo), ${(peak * LAYER_RATIOS[0] * 0.5).toFixed(3)}) 26%,
      rgba(var(--indigo), ${(peak * LAYER_RATIOS[0] * 0.18).toFixed(3)}) 52%,
      transparent 78%
    ),
    radial-gradient(
      ellipse 150% 110% at 92% 100%,
      rgba(var(--indigo-2), ${a2}) 0%,
      rgba(var(--indigo-2), ${(peak * LAYER_RATIOS[1] * 0.5).toFixed(3)}) 26%,
      rgba(var(--indigo-2), ${(peak * LAYER_RATIOS[1] * 0.18).toFixed(3)}) 52%,
      transparent 78%
    ),
    radial-gradient(
      ellipse 120% 100% at 50% 42%,
      rgba(var(--indigo), ${a3}) 0%,
      rgba(var(--indigo), ${(peak * LAYER_RATIOS[2] * 0.45).toFixed(3)}) 30%,
      transparent 72%
    ),
    radial-gradient(
      ellipse 95% 105% at 4% 88%,
      rgba(var(--indigo-2), ${a4}) 0%,
      rgba(var(--indigo-2), ${(peak * LAYER_RATIOS[3] * 0.45).toFixed(3)}) 28%,
      transparent 68%
    ),
    radial-gradient(
      ellipse 90% 85% at 96% 8%,
      rgba(var(--indigo), ${a5}) 0%,
      rgba(var(--indigo), ${(peak * LAYER_RATIOS[4] * 0.45).toFixed(3)}) 28%,
      transparent 66%
    ),
    #050508
  `;
}


// ============================================================
// Apply arbitrary HEX accent
// ============================================================

export function applyAccent(
  hex,
  { persist = true } = {}
) {
  if (
    typeof hex !== 'string' ||
    !/^#[0-9a-fA-F]{6}$/.test(hex)
  ) {
    return false;
  }

  const normalized =
    hex.toUpperCase();

  const rgb =
    rgbStringFromHex(normalized);

  const root =
    document.documentElement;

  root.style.setProperty(
    '--indigo',
    rgb
  );

  root.style.setProperty(
    '--indigo-2',
    secondaryRgbString(rgb)
  );

  root.style.setProperty(
    '--cyan',
    rgb
  );

  root.style.setProperty(
    '--accent-bg',
    `rgba(${rgb}, 0.07)`
  );

  root.style.setProperty(
    '--accent-hover-bg',
    `rgba(${rgb}, 0.11)`
  );

  root.style.setProperty(
    '--accent-ring',
    `rgba(${rgb}, 0.42)`
  );

  root.style.setProperty(
    '--accent-border',
    `rgba(${rgb}, 0.28)`
  );

  root.style.setProperty(
    '--accent',
    rgb
  );

  currentRgb = rgb;

  paintUnderlay();

  if (persist) {
    safeSetStorage(
      ACCENT_STORAGE_KEY,
      normalized
    );
  }

  return true;
}


// ============================================================
// Preset
// ============================================================

export function applyAccentPreset(
  preset,
  options = {}
) {
  if (!preset?.hex) {
    return false;
  }

  return applyAccent(
    preset.hex,
    options
  );
}


// ============================================================
// Ambient
// ============================================================

export function applyAmbientLevel(
  levelIndex,
  { persist = true } = {}
) {
  if (
    !Number.isInteger(levelIndex) ||
    levelIndex < 0 ||
    levelIndex >= AMBIENT_LEVELS.length
  ) {
    return false;
  }

  currentLevel = levelIndex;

  paintUnderlay();

  if (persist) {
    safeSetStorage(
      AMBIENT_STORAGE_KEY,
      String(levelIndex)
    );
  }

  return true;
}


// ============================================================
// Initialization
// ============================================================

export function initAccent(
  userAccentColor = null
) {
  currentLevel =
    getCurrentAmbientLevel();

  let hex = null;

  // Server/database value has priority.
  if (
    typeof userAccentColor === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(userAccentColor)
  ) {
    hex = userAccentColor.toUpperCase();
  }

  // Otherwise use localStorage.
  if (!hex) {
    hex = getCurrentAccentHex();
  }

  applyAccent(
    hex,
    { persist: false }
  );

  return hex;
}


export function getCurrentAmbientLevelValue() {
  return AMBIENT_LEVELS[currentLevel];
}