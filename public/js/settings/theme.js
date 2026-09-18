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

// ============================================================
// Background presets
//
// A small, fixed set of background *atmospheres* painted onto the
// existing #ambient-underlay layer (see paintUnderlay() /
// buildBackgroundCss() below) — not separate UI themes. Presets
// flagged `usesAccent: true` derive their color from the active
// accent (--indigo/--indigo-2), so they stay coherent with — and
// update live alongside — whatever accent the user has picked; the
// rest use their own fixed palette so they read the same regardless
// of accent.
// ============================================================

export const BACKGROUND_PRESETS = [
  { id: 'void',           name: 'Void',           usesAccent: false },
  { id: 'aurora',         name: 'Aurora',         usesAccent: false },
  { id: 'midnight',       name: 'Midnight',       usesAccent: false },
  { id: 'glass',          name: 'Glass',          usesAccent: false },
  { id: 'nebula',         name: 'Nebula',         usesAccent: false },
  { id: 'monochrome',     name: 'Monochrome',     usesAccent: false },
  { id: 'custom-accent',  name: 'Custom Accent',  usesAccent: true  },
  { id: 'accent-flow',    name: 'Accent Flow',    usesAccent: true  },
  { id: 'accent-glow',    name: 'Accent Glow',    usesAccent: true  },
  { id: 'accent-depth',   name: 'Accent Depth',   usesAccent: true  },
  { id: 'accent-horizon', name: 'Accent Horizon', usesAccent: true  },
  { id: 'accent-corner',  name: 'Accent Corner',  usesAccent: true  },
  { id: 'accent-orbit',   name: 'Accent Orbit',   usesAccent: true  },
  { id: 'accent-mesh',    name: 'Accent Mesh',    usesAccent: true  },
];

// If a saved id no longer matches any preset here — e.g. a user who
// previously had the now-removed "ambient" preset stored — callers
// fall back to this id (see getCurrentBackgroundTheme()) rather than
// breaking or rendering a nonexistent theme.
export const DEFAULT_BACKGROUND_ID = 'void';

const ACCENT_STORAGE_KEY = 'wire-accent';
const AMBIENT_STORAGE_KEY = 'wire-ambient-level';
const THEME_STORAGE_KEY = 'wire-theme';
const BUBBLE_ACCENT_STORAGE_KEY = 'wire-bubble-accent';
const BACKGROUND_STORAGE_KEY = 'wire-background-theme';

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
// Accent-based background presets pair --indigo with a second,
// softly-different color temperature (see buildBackgroundCss())
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

let currentBackgroundId =
  DEFAULT_BACKGROUND_ID;


// ============================================================
// Background compositions
//
// Each preset below is a distinct *lighting arrangement* — not just
// a recolored copy of the same top-glow/bottom-glow shape. They vary
// gradient type (radial vs linear), layer count, position, size,
// symmetry, and where stops fall, while staying within the same
// budget (a handful of static gradients, no filters beyond the
// existing global blur on #ambient-underlay, no animation).
// ============================================================

// Builds the CSS `background` value for a given preset id. `peak` is
// the raw ambient-intensity value (one of AMBIENT_LEVELS); `dark`
// says whether the current theme is dark so each fixed-palette
// preset can pick its light-mode variant instead of just laying the
// dark gradients on top of a light surface. Accent-based presets
// reference rgb(var(--indigo)/--indigo-2) directly so they keep
// tracking the live accent (including in preview swatches) without
// needing to know its value here.
function buildBackgroundCss(id, { peak, dark }) {
  switch (id) {

    // Almost flat. A single small, quickly-fading circle tucked into
    // one corner rather than a viewport-spanning shape — ambient
    // intensity is clamped very low rather than ignored outright, so
    // the control still does *something*, but barely.
    case 'void': {
      const p = (Math.min(peak, 0.08) * (dark ? 1 : 0.55)).toFixed(3);
      return `
        radial-gradient(circle at 14% 88%, rgba(var(--indigo), ${p}) 0%, transparent 40%),
        var(--void)
      `;
    }

    // One dominant off-center accent glow plus a small, much fainter
    // glow in the far corner — an asymmetric single light source,
    // while still tracking the live accent and respecting ambient
    // intensity.
    case 'custom-accent': {
      const p1 = peak.toFixed(3);
      const p2 = (peak * 0.55).toFixed(3);
      const p3 = (peak * 0.3).toFixed(3);
      return `
        radial-gradient(ellipse 100% 85% at 20% 15%, rgba(var(--indigo), ${p1}) 0%, rgba(var(--indigo), ${p2}) 40%, transparent 74%),
        radial-gradient(circle at 90% 94%, rgba(var(--indigo-2), ${p3}) 0%, transparent 42%),
        var(--void)
      `;
    }

    // A diagonal chain of three large, overlapping ellipses running
    // from one corner to the other (not a top-to-bottom sweep),
    // alternating accent/secondary-accent and fading in strength —
    // the fade toward transparent lets the near-black --void show
    // through, reading as the accent naturally darkening rather than
    // a hardcoded shade.
    case 'accent-flow': {
      const f = (dark ? 1 : 0.55) * peak;
      const p1 = f.toFixed(3);
      const p2 = (f * 0.8).toFixed(3);
      const p3 = (f * 0.6).toFixed(3);
      return `
        radial-gradient(ellipse 95% 75% at 10% 88%, rgba(var(--indigo), ${p1}) 0%, transparent 70%),
        radial-gradient(ellipse 105% 85% at 46% 42%, rgba(var(--indigo-2), ${p2}) 0%, transparent 72%),
        radial-gradient(ellipse 95% 75% at 84% 8%, rgba(var(--indigo), ${p3}) 0%, transparent 70%),
        var(--void)
      `;
    }

    // A single dominant, concentrated light source well off-center,
    // with a long smooth multi-stop fade rather than a hard edge —
    // reads as one atmospheric glow sinking into near-black rather
    // than a flat colored blob.
    case 'accent-glow': {
      const f = (dark ? 1 : 0.5) * peak;
      const p1 = f.toFixed(3);
      const p2 = (f * 0.62).toFixed(3);
      const p3 = (f * 0.32).toFixed(3);
      return `
        radial-gradient(ellipse 78% 68% at 70% 32%, rgba(var(--indigo), ${p1}) 0%, rgba(var(--indigo), ${p2}) 34%, rgba(var(--indigo), ${p3}) 60%, transparent 82%),
        var(--void)
      `;
    }

    // Several large layers at deliberately uneven sizes and asymmetric
    // positions, meant to read as different "distances" — the largest
    // (furthest) layer is the faintest, the smallest (closest) is the
    // strongest, rather than every layer sharing one intensity.
    case 'accent-depth': {
      const f = (dark ? 1 : 0.5) * peak;
      const pFar = (f * 0.35).toFixed(3);
      const pMid = (f * 0.55).toFixed(3);
      const pNear = (f * 0.8).toFixed(3);
      return `
        radial-gradient(ellipse 160% 140% at 32% 72%, rgba(var(--indigo), ${pFar}) 0%, transparent 76%),
        radial-gradient(ellipse 100% 90% at 78% 22%, rgba(var(--indigo-2), ${pMid}) 0%, transparent 68%),
        radial-gradient(ellipse 58% 52% at 14% 18%, rgba(var(--indigo), ${pNear}) 0%, transparent 62%),
        var(--void)
      `;
    }

    // A wide, near-horizontal band of light crossing the lower-middle
    // of the viewport (not the top or bottom edge), plus a soft
    // surrounding fill above it for depth — a single almost-flat
    // linear sweep rather than a radial glow.
    case 'accent-horizon': {
      const f = (dark ? 1 : 0.5) * peak;
      const pBand = f.toFixed(3);
      const pBand2 = (f * 0.75).toFixed(3);
      const pFill = (f * 0.3).toFixed(3);
      return `
        linear-gradient(4deg, transparent 28%, rgba(var(--indigo), ${pBand}) 46%, rgba(var(--indigo-2), ${pBand2}) 62%, transparent 82%),
        radial-gradient(ellipse 140% 100% at 50% 8%, rgba(var(--indigo), ${pFill}) 0%, transparent 72%),
        var(--void)
      `;
    }

    // One or two large sources planted exactly at opposite viewport
    // corners, spilling inward as if the light originates from just
    // outside the frame — most of the interior stays dark.
    case 'accent-corner': {
      const f = (dark ? 1 : 0.5) * peak;
      const p1 = f.toFixed(3);
      const p2 = (f * 0.7).toFixed(3);
      return `
        radial-gradient(ellipse 130% 100% at 0% 0%, rgba(var(--indigo), ${p1}) 0%, transparent 58%),
        radial-gradient(ellipse 115% 95% at 100% 100%, rgba(var(--indigo-2), ${p2}) 0%, transparent 55%),
        var(--void)
      `;
    }

    // Four huge, extremely soft ellipses ringing the viewport at
    // uneven intervals — an abstract orbital arrangement where every
    // layer overlaps its neighbors, kept faint enough that they read
    // as one atmosphere rather than distinct shapes.
    case 'accent-orbit': {
      const f = (dark ? 1 : 0.45) * peak;
      const pA = (f * 0.6).toFixed(3);
      const pB = (f * 0.55).toFixed(3);
      const pC = (f * 0.58).toFixed(3);
      const pD = (f * 0.5).toFixed(3);
      return `
        radial-gradient(ellipse 120% 100% at 18% 12%, rgba(var(--indigo), ${pA}) 0%, transparent 66%),
        radial-gradient(ellipse 130% 110% at 88% 28%, rgba(var(--indigo-2), ${pB}) 0%, transparent 67%),
        radial-gradient(ellipse 125% 105% at 68% 90%, rgba(var(--indigo), ${pC}) 0%, transparent 65%),
        radial-gradient(ellipse 115% 95% at 6% 74%, rgba(var(--indigo-2), ${pD}) 0%, transparent 64%),
        var(--void)
      `;
    }

    // Three very large, very-late-fading fields (transparent doesn't
    // arrive until 85%+) at scattered positions, so their edges
    // dissolve into each other and into --void instead of reading as
    // separate circles — one continuous woven field.
    case 'accent-mesh': {
      const f = (dark ? 1 : 0.5) * peak;
      const pA = (f * 0.55).toFixed(3);
      const pB = (f * 0.5).toFixed(3);
      const pC = (f * 0.45).toFixed(3);
      return `
        radial-gradient(ellipse 150% 130% at 25% 30%, rgba(var(--indigo), ${pA}) 0%, transparent 85%),
        radial-gradient(ellipse 140% 150% at 75% 65%, rgba(var(--indigo-2), ${pB}) 0%, transparent 85%),
        radial-gradient(ellipse 130% 120% at 55% 12%, rgba(var(--indigo), ${pC}) 0%, transparent 82%),
        var(--void)
      `;
    }

    // Broad flowing bands with multiple soft color transitions —
    // diagonal linear gradients (not radial ellipses), each carrying
    // its own hue journey inside a single layer, crossing at
    // different angles for a drifting, ribbon-like feel.
    case 'aurora': {
      const f = (dark ? 1 : 0.32) * peak;
      const p1 = (f * 0.85).toFixed(3);
      const p2 = (f * 0.7).toFixed(3);
      const p3 = (f * 0.6).toFixed(3);
      const p4 = (f * 0.45).toFixed(3);
      const teal = dark ? '95,190,175' : '150,215,200';
      const violet = dark ? '150,130,215' : '190,175,230';
      const pink = dark ? '195,150,180' : '225,190,210';
      const blue = dark ? '110,150,210' : '175,195,230';
      return `
        linear-gradient(118deg, transparent 4%, rgba(${teal},${p1}) 24%, rgba(${violet},${p2}) 46%, rgba(${pink},${p3}) 66%, transparent 88%),
        linear-gradient(205deg, transparent 15%, rgba(${blue},${p4}) 42%, transparent 78%),
        var(--void)
      `;
    }

    // Deep atmospheric lighting from one asymmetric source (a large
    // soft glow tucked into one upper corner) rather than symmetric
    // top/bottom edges, with a much smaller, dimmer counterpoint in
    // the opposite corner for a sense of depth.
    case 'midnight': {
      const f = (dark ? 1 : 0.24) * peak;
      const p1 = f.toFixed(3);
      const p2 = (f * 0.5).toFixed(3);
      const p3 = (f * 0.4).toFixed(3);
      const rgbMain = dark ? '32,42,108' : '90,112,196';
      const rgbFaint = dark ? '16,22,58' : '150,165,222';
      return `
        radial-gradient(ellipse 95% 85% at 84% 4%, rgba(${rgbMain}, ${p1}) 0%, rgba(${rgbMain}, ${p2}) 38%, transparent 72%),
        radial-gradient(circle at 6% 98%, rgba(${rgbFaint}, ${p3}) 0%, transparent 46%),
        var(--void)
      `;
    }

    // Layered translucent "frosted" light: a few soft panes of
    // varying size scattered off-axis, plus a faint diagonal sheen —
    // distributed across the viewport instead of hugging its edges.
    case 'glass': {
      const f = (dark ? 1 : 0.5) * peak;
      const p1 = (f * 0.95).toFixed(3);
      const p2 = (f * 0.7).toFixed(3);
      const p3 = (f * 0.35).toFixed(3);
      const rgbA = dark ? '215,220,232' : '255,255,255';
      const rgbB = dark ? '150,172,202' : '200,214,234';
      const rgbSheen = dark ? '235,238,245' : '255,255,255';
      return `
        linear-gradient(128deg, rgba(${rgbSheen}, ${p3}) 0%, transparent 32%),
        radial-gradient(ellipse 62% 46% at 18% 22%, rgba(${rgbA}, ${p1}) 0%, transparent 74%),
        radial-gradient(ellipse 55% 50% at 85% 78%, rgba(${rgbB}, ${p2}) 0%, transparent 76%),
        var(--void)
      `;
    }

    // Several extremely soft, large, overlapping fields scattered at
    // different positions and sizes — an organic scatter rather than
    // mirrored edges or a linear sweep.
    case 'nebula': {
      const f = (dark ? 1 : 0.26) * peak;
      const p1 = f.toFixed(3);
      const p2 = (f * 0.85).toFixed(3);
      const p3 = (f * 0.65).toFixed(3);
      const rgbA = dark ? '110,80,170' : '170,150,220';
      const rgbB = dark ? '65,92,178' : '145,170,225';
      const rgbC = dark ? '150,95,150' : '215,175,205';
      return `
        radial-gradient(ellipse 120% 95% at 18% 22%, rgba(${rgbA}, ${p1}) 0%, transparent 66%),
        radial-gradient(ellipse 105% 110% at 78% 58%, rgba(${rgbB}, ${p2}) 0%, transparent 68%),
        radial-gradient(ellipse 85% 70% at 42% 90%, rgba(${rgbC}, ${p3}) 0%, transparent 70%),
        var(--void)
      `;
    }

    // Neutral vignette: depth built purely from lightness, via a
    // single centered radial fading toward the edges, instead of
    // colored glows from any side.
    case 'monochrome': {
      const f = (dark ? 1 : 0.32) * peak;
      const p = (f * 0.75).toFixed(3);
      const rgb = dark ? '0,0,0' : '60,60,66';
      return `
        radial-gradient(ellipse 150% 130% at 50% 42%, transparent 0%, rgba(${rgb}, ${p}) 100%),
        var(--void)
      `;
    }

    default:
      return `var(--void)`;
  }
}


function paintUnderlay() {
  const peak = AMBIENT_LEVELS[currentLevel];

  document.documentElement.style.setProperty(
    '--ambient-strength',
    peak
  );

  const underlay =
    document.getElementById('ambient-underlay');

  if (!underlay) return;

  const dark =
    getCurrentTheme() === 'dark';

  underlay.style.background = buildBackgroundCss(
    currentBackgroundId,
    { peak, dark }
  );
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
// Background theme (selects which atmosphere paintUnderlay() draws)
// ============================================================

export function getCurrentBackgroundTheme() {
  const saved = safeGetStorage(BACKGROUND_STORAGE_KEY);

  const preset = BACKGROUND_PRESETS.find(
    p => p.id === saved
  );

  return preset?.id || DEFAULT_BACKGROUND_ID;
}


export function applyBackgroundTheme(
  id,
  { persist = true } = {}
) {
  const preset = BACKGROUND_PRESETS.find(
    p => p.id === id
  );

  if (!preset) return false;

  currentBackgroundId = preset.id;

  paintUnderlay();

  if (persist) {
    safeSetStorage(
      BACKGROUND_STORAGE_KEY,
      preset.id
    );
  }

  return true;
}


export function initBackgroundTheme() {
  currentBackgroundId =
    getCurrentBackgroundTheme();

  paintUnderlay();

  return currentBackgroundId;
}


// A small, cheap-to-compute preview of a preset for the Settings
// swatches — same gradient builder paintUnderlay() uses, at a fixed
// representative intensity so previews don't jump around as the
// user's actual ambient-intensity setting changes. Accent-based
// presets still read the live rgb(var(--indigo)) values, so their
// swatch reflects whatever accent is currently active.
export function getBackgroundPreviewCss(
  id,
  { dark = true } = {}
) {
  return buildBackgroundCss(
    id,
    { peak: AMBIENT_LEVELS[DEFAULT_AMBIENT_LEVEL], dark }
  );
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

  // Several background presets have distinct light/dark palettes
  // (see buildBackgroundCss()), so repaint on every theme switch.
  paintUnderlay();

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