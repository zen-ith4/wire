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

export const AMBIENT_LEVELS = [0.06, 0.18, 0.34, 0.5, 0.7];

export const DEFAULT_AMBIENT_LEVEL = 3;

const ACCENT_STORAGE_KEY = 'wire-accent';
const AMBIENT_STORAGE_KEY = 'wire-ambient-level';
const THEME_STORAGE_KEY = 'wire-theme';
const BUBBLE_ACCENT_STORAGE_KEY = 'wire-bubble-accent';

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


export function hexToRgb(hex) {
  const clean = hex.replace('#', '');

  const value = Number.parseInt(clean, 16);

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}


export function rgbStringFromHex(hex) {
  const { r, g, b } = hexToRgb(hex);

  return `${r}, ${g}, ${b}`;
}


// Perceived brightness (ITU-R BT.601), 0-255. Used to auto-pick
// black-or-white text for anything painted directly in the accent
// color, so a light/pale custom accent doesn't strand white text on
// a now-light background.
export function contrastTextFor(rgbString) {
  const [r, g, b] = rgbString
    .split(',')
    .map((n) => Number(n.trim()));

  const brightness =
    (r * 299 + g * 587 + b * 114) / 1000;

  return brightness > 150 ? '#16161A' : '#FFFFFF';
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
//
// Just two soft accent-colored glows, full viewport width: one
// hugging the top edge, one hugging the bottom edge. No corner/
// center blobs — those (plus the local glows every modal/toast/
// emoji-picker used to paint on top of their own translucent
// backgrounds) were what made the background read as separate
// circles cut off by container edges instead of one calm field.
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

  const mid = (peak * 0.45).toFixed(3);

  underlay.style.background = `
    radial-gradient(
      ellipse 110% 65% at 50% 0%,
      rgba(var(--indigo), ${peak}) 0%,
      rgba(var(--indigo), ${mid}) 45%,
      transparent 85%
    ),
    radial-gradient(
      ellipse 110% 65% at 50% 100%,
      rgba(var(--indigo-2), ${peak}) 0%,
      rgba(var(--indigo-2), ${mid}) 45%,
      transparent 85%
    ),
    var(--void)
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

  root.style.setProperty(
    '--accent-contrast',
    contrastTextFor(rgb)
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


// ============================================================
// Light / dark theme
// ============================================================

export function getCurrentTheme() {
  const saved = safeGetStorage(THEME_STORAGE_KEY);

  return saved === 'light' ? 'light' : 'dark';
}


export function applyTheme(
  theme,
  { persist = true } = {}
) {
  const value =
    theme === 'light' ? 'light' : 'dark';

  if (value === 'light') {
    document.documentElement.setAttribute(
      'data-theme',
      'light'
    );
  } else {
    document.documentElement.removeAttribute(
      'data-theme'
    );
  }

  if (persist) {
    safeSetStorage(
      THEME_STORAGE_KEY,
      value
    );
  }

  return value;
}


export function initTheme() {
  const theme =
    getCurrentTheme();

  applyTheme(
    theme,
    { persist: false }
  );

  return theme;
}


// ============================================================
// "Use accent color for chat bubbles" toggle
//
// ON (default): message bubbles keep painting with the viewer's
// accent color exactly as before (see js/chat/message-accent.js).
// OFF: message-accent.js skips painting --message-accent/-contrast
// entirely, so .chat-bubble falls back to its plain default colors
// (var(--ink2)/var(--text) — see features/messages.css) for the
// active theme. Nothing outside chat bubbles reads this flag; every
// other accent-colored element is untouched either way.
// ============================================================

export function getUseAccentForBubbles() {
  const saved = safeGetStorage(BUBBLE_ACCENT_STORAGE_KEY);

  // No stored value yet -> default ON, so existing behavior is
  // unchanged for everyone until they explicitly turn it off.
  return saved === null ? true : saved !== 'off';
}


export function applyUseAccentForBubbles(
  enabled,
  { persist = true } = {}
) {
  const value = enabled !== false;

  if (persist) {
    safeSetStorage(
      BUBBLE_ACCENT_STORAGE_KEY,
      value ? 'on' : 'off'
    );
  }

  return value;
}