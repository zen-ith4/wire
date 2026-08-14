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

  underlay.style.background = `
    radial-gradient(
      ellipse 100% 80% at 20% 10%,
      rgba(var(--indigo), ${a1}) 0%,
      transparent 55%
    ),
    radial-gradient(
      ellipse 120% 90% at 85% 90%,
      rgba(var(--indigo), ${a2}) 0%,
      transparent 55%
    ),
    radial-gradient(
      ellipse 80% 70% at 50% 40%,
      rgba(var(--indigo), ${a3}) 0%,
      transparent 60%
    ),
    radial-gradient(
      ellipse 60% 100% at 10% 80%,
      rgba(var(--indigo), ${a4}) 0%,
      transparent 50%
    ),
    radial-gradient(
      ellipse 70% 60% at 90% 15%,
      rgba(var(--indigo), ${a5}) 0%,
      transparent 50%
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