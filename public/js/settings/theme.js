// ============================================================
// Accent theming + ambient background intensity
// ============================================================

export const ACCENT_PRESETS = [
  { name: 'Neutral', hex: '#5C5C6E', rgb: '92, 92, 110' },
  { name: 'Blue', hex: '#5F84AD', rgb: '95, 132, 173' },
  { name: 'Emerald', hex: '#5F8B6F', rgb: '95, 139, 111' },
  { name: 'Purple', hex: '#7D6F9A', rgb: '125, 111, 154' },
  { name: 'Orange', hex: '#A8805D', rgb: '168, 128, 93' },
  { name: 'Red', hex: '#9A5D5D', rgb: '154, 93, 93' }
];

export const AMBIENT_LEVELS = [
  0.06,
  0.18,
  0.34,
  0.5,
  0.7
];

export const DEFAULT_AMBIENT_LEVEL = 3;


// ============================================================
// Background presets
//
// These are visual atmospheres painted onto #ambient-underlay.
// Accent-based presets follow the currently selected accent color.
// Fixed presets keep their own palette.
// ============================================================

export const BACKGROUND_PRESETS = [
  // Minimal
  { id: 'void', name: 'Void', usesAccent: false },
  { id: 'monochrome', name: 'Monochrome', usesAccent: false },
  { id: 'steel', name: 'Steel', usesAccent: false },

  // Natural
  { id: 'aurora', name: 'Aurora', usesAccent: false },
  { id: 'ocean', name: 'Ocean', usesAccent: false },
  { id: 'forest', name: 'Forest', usesAccent: false },
  { id: 'sunset', name: 'Sunset', usesAccent: false },
  { id: 'ember', name: 'Ember', usesAccent: false },
  { id: 'ice', name: 'Ice', usesAccent: false },

  // Space
  { id: 'midnight', name: 'Midnight', usesAccent: false },
  { id: 'deep-space', name: 'Deep Space', usesAccent: false },
  { id: 'nebula', name: 'Nebula', usesAccent: false },

  // Material
  { id: 'glass', name: 'Glass', usesAccent: false },

  // Additional fixed atmospheres
  { id: 'graphite', name: 'Graphite', usesAccent: false },
  { id: 'slate', name: 'Slate', usesAccent: false },
  { id: 'charcoal', name: 'Charcoal', usesAccent: false },
  { id: 'arctic', name: 'Arctic', usesAccent: false },
  { id: 'mist', name: 'Mist', usesAccent: false },
  { id: 'rain', name: 'Rain', usesAccent: false },
  { id: 'twilight', name: 'Twilight', usesAccent: false },
  { id: 'cosmic', name: 'Cosmic', usesAccent: false },
  { id: 'starlight', name: 'Starlight', usesAccent: false },
  { id: 'plasma', name: 'Plasma', usesAccent: false },
  { id: 'lavender', name: 'Lavender', usesAccent: false },
  { id: 'rose', name: 'Rose', usesAccent: false },
  { id: 'sand', name: 'Sand', usesAccent: false },
  { id: 'desert', name: 'Desert', usesAccent: false },
  { id: 'moss', name: 'Moss', usesAccent: false },
  { id: 'deep-green', name: 'Deep Green', usesAccent: false },
  { id: 'volcanic', name: 'Volcanic', usesAccent: false },
  { id: 'copper', name: 'Copper', usesAccent: false },

  // Accent atmospheres
  { id: 'custom-accent', name: 'Custom Accent', usesAccent: true },
  { id: 'accent-flow', name: 'Accent Flow', usesAccent: true },
  { id: 'accent-glow', name: 'Accent Glow', usesAccent: true },
  { id: 'accent-depth', name: 'Accent Depth', usesAccent: true },
  { id: 'accent-horizon', name: 'Accent Horizon', usesAccent: true },
  { id: 'accent-corner', name: 'Accent Corner', usesAccent: true },
  { id: 'accent-orbit', name: 'Accent Orbit', usesAccent: true },
  { id: 'accent-mesh', name: 'Accent Mesh', usesAccent: true },

  // Additional accent compositions
  { id: 'accent-sunrise', name: 'Accent Sunrise', usesAccent: true },
  { id: 'accent-pool', name: 'Accent Pool', usesAccent: true },
  { id: 'accent-split', name: 'Accent Split', usesAccent: true },
  { id: 'accent-ripple', name: 'Accent Ripple', usesAccent: true },
  { id: 'accent-lens', name: 'Accent Lens', usesAccent: true },
  { id: 'accent-veil', name: 'Accent Veil', usesAccent: true },
  { id: 'accent-pulse', name: 'Accent Pulse', usesAccent: true },
  { id: 'accent-frame', name: 'Accent Frame', usesAccent: true },
  { id: 'accent-drift', name: 'Accent Drift', usesAccent: true },
  { id: 'accent-prism', name: 'Accent Prism', usesAccent: true },
  { id: 'accent-eclipse', name: 'Accent Eclipse', usesAccent: true }
];

export const DEFAULT_BACKGROUND_ID = 'void';

const AMBIENT_STORAGE_KEY = 'wire-ambient-level';
const THEME_STORAGE_KEY = 'wire-theme';
const BUBBLE_ACCENT_STORAGE_KEY = 'wire-bubble-accent';
const BUBBLE_STYLE_STORAGE_KEY = 'wire-message-bubble-style';
const BACKGROUND_STORAGE_KEY = 'wire-background-theme';
const ANIMATIONS_STORAGE_KEY = 'wire-animations';
const FONT_STORAGE_KEY = 'wire-font-family';


// ============================================================
// Storage helpers
//
// Accent Color is intentionally NOT included here.
// Accent is account-scoped and comes from /api/me.
// All other appearance preferences remain local.
// ============================================================

export function safeGetStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}


export function safeSetStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage isn't required for the current session.
  }
}


// ============================================================
// Accent helpers
//
// IMPORTANT:
// Accent Color is account-scoped.
//
// There is deliberately NO:
//   - ACCENT_STORAGE_KEY
//   - localStorage read for Accent
//   - localStorage write for Accent
//
// The server value from /api/me is the source of truth.
// currentAccentHex is only runtime state for the current session.
// ============================================================

const DEFAULT_ACCENT_HEX =
  ACCENT_PRESETS[0].hex;

let currentAccentHex =
  DEFAULT_ACCENT_HEX;


function isValidAccentHex(value) {
  return (
    typeof value === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(value)
  );
}


export function getCurrentAccentHex() {
  return currentAccentHex;
}


export function getCurrentAccentName() {
  const hex =
    currentAccentHex;

  const preset =
    ACCENT_PRESETS.find(
      preset =>
        preset.hex.toUpperCase() ===
        hex.toUpperCase()
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

  return Number.isInteger(raw) &&
    raw >= 0 &&
    raw < AMBIENT_LEVELS.length
    ? raw
    : DEFAULT_AMBIENT_LEVEL;
}


export function hexToRgb(hex) {
  const clean =
    hex.replace('#', '');

  const value =
    Number.parseInt(clean, 16);

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}


export function rgbStringFromHex(hex) {
  const { r, g, b } =
    hexToRgb(hex);

  return `${r}, ${g}, ${b}`;
}


export function contrastTextFor(rgbString) {
  const [r, g, b] =
    rgbString
      .split(',')
      .map(value =>
        Number(value.trim())
      );

  const brightness =
    (r * 299 +
      g * 587 +
      b * 114) / 1000;

  return brightness > 150
    ? '#16161A'
    : '#FFFFFF';
}


// ============================================================
// Secondary atmospheric hue
// ============================================================

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  const max =
    Math.max(r, g, b);

  const min =
    Math.min(r, g, b);

  let h = 0;
  let s = 0;

  const l =
    (max + min) / 2;

  if (max !== min) {
    const d =
      max - min;

    s =
      l > 0.5
        ? d / (2 - max - min)
        : d / (max + min);

    switch (max) {
      case r:
        h =
          (g - b) / d +
          (g < b ? 6 : 0);
        break;

      case g:
        h =
          (b - r) / d + 2;
        break;

      default:
        h =
          (r - g) / d + 4;
        break;
    }

    h /= 6;
  }

  return {
    h,
    s,
    l
  };
}


function hslToRgb(h, s, l) {
  if (s === 0) {
    const value =
      Math.round(l * 255);

    return {
      r: value,
      g: value,
      b: value
    };
  }

  const hue2rgb =
    (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;

      if (t < 1 / 6) {
        return p +
          (q - p) * 6 * t;
      }

      if (t < 1 / 2) {
        return q;
      }

      if (t < 2 / 3) {
        return p +
          (q - p) *
            (2 / 3 - t) * 6;
      }

      return p;
    };

  const q =
    l < 0.5
      ? l * (1 + s)
      : l + s - l * s;

  const p =
    2 * l - q;

  return {
    r: Math.round(
      hue2rgb(
        p,
        q,
        h + 1 / 3
      ) * 255
    ),

    g: Math.round(
      hue2rgb(
        p,
        q,
        h
      ) * 255
    ),

    b: Math.round(
      hue2rgb(
        p,
        q,
        h - 1 / 3
      ) * 255
    )
  };
}


function secondaryRgbString(rgbString) {
  const [r, g, b] =
    rgbString
      .split(',')
      .map(value =>
        Number(value.trim())
      );

  const {
    h,
    s,
    l
  } =
    rgbToHsl(
      r,
      g,
      b
    );

  const shifted =
    hslToRgb(
      (h + 0.11) % 1,
      Math.min(
        1,
        s * 0.92 + 0.04
      ),
      Math.min(
        0.8,
        l * 1.12 + 0.04
      )
    );

  return `${shifted.r}, ${shifted.g}, ${shifted.b}`;
}


// ============================================================
// Runtime state
// ============================================================

let currentRgb =
  ACCENT_PRESETS[0].rgb;

let currentLevel =
  getCurrentAmbientLevel();

let currentBackgroundId =
  DEFAULT_BACKGROUND_ID;


// ============================================================
// Background intensity
//
// Light mode needs stronger atmospheric colors because the same
// alpha values that work on a dark surface become visually weak
// against a light surface.
//
// Dark mode keeps the original intensity exactly.
// Light mode gets a controlled boost with a hard ceiling so that
// backgrounds remain atmospheric instead of becoming opaque.
// ============================================================

function backgroundFactor(
  peak,
  dark,
  lightScale = 1.7
) {
  if (dark) {
    return peak;
  }

  let factor =
    peak * lightScale;

  if (peak === AMBIENT_LEVELS[2]) {
    factor *= 0.84;

    return Math.min(
      0.48,
      factor
    );
  }

  if (peak === AMBIENT_LEVELS[3]) {
    factor *= 0.78;

    return Math.min(
      0.58,
      factor
    );
  }

  return Math.min(
    0.68,
    factor
  );
}


// ============================================================
// Background compositions
// ============================================================

function buildBackgroundCss(id, { peak, dark }) {
  switch (id) {

    // ----------------------------------------------------------
    // Minimal
    // ----------------------------------------------------------

    case 'void': {
      const p = (
        Math.min(
          peak,
          dark ? 0.08 : 0.12
        )
      ).toFixed(3);

      return `
        radial-gradient(
          circle at 14% 88%,
          rgba(var(--indigo), ${p}) 0%,
          transparent 40%
        ),
        var(--void)
      `;
    }


    case 'monochrome': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.7
        );

      const p =
        (f * 0.75).toFixed(3);

      const rgb =
        dark
          ? '0,0,0'
          : '60,60,66';

      return `
        radial-gradient(
          ellipse 150% 130% at 50% 42%,
          transparent 0%,
          rgba(${rgb}, ${p}) 100%
        ),
        var(--void)
      `;
    }


    case 'steel': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.65
        );

      const p1 =
        (f * 0.75).toFixed(3);

      const p2 =
        (f * 0.4).toFixed(3);

      return `
        linear-gradient(
          135deg,
          rgba(150,165,185,${p1}) 0%,
          transparent 46%
        ),
        radial-gradient(
          ellipse 100% 80% at 80% 75%,
          rgba(90,110,145,${p2}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    // ----------------------------------------------------------
    // Natural
    // ----------------------------------------------------------

    case 'aurora': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.75
        );

      const p1 =
        (f * 0.85).toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      const p3 =
        (f * 0.6).toFixed(3);

      const p4 =
        (f * 0.45).toFixed(3);

      const teal =
        dark
          ? '95,190,175'
          : '150,215,200';

      const violet =
        dark
          ? '150,130,215'
          : '190,175,230';

      const pink =
        dark
          ? '195,150,180'
          : '225,190,210';

      const blue =
        dark
          ? '110,150,210'
          : '175,195,230';

      return `
        linear-gradient(
          118deg,
          transparent 4%,
          rgba(${teal},${p1}) 24%,
          rgba(${violet},${p2}) 46%,
          rgba(${pink},${p3}) 66%,
          transparent 88%
        ),
        linear-gradient(
          205deg,
          transparent 15%,
          rgba(${blue},${p4}) 42%,
          transparent 78%
        ),
        var(--void)
      `;
    }


    case 'ocean': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.8
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      const p3 =
        (f * 0.45).toFixed(3);

      return `
        radial-gradient(
          ellipse 120% 70% at 20% 85%,
          rgba(35,145,175,${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 90% 75% at 85% 15%,
          rgba(50,90,180,${p2}) 0%,
          transparent 70%
        ),
        linear-gradient(
          165deg,
          transparent 30%,
          rgba(40,175,165,${p3}) 70%,
          transparent 95%
        ),
        var(--void)
      `;
    }


    case 'forest': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.8
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.65).toFixed(3);

      return `
        radial-gradient(
          ellipse 115% 90% at 5% 15%,
          rgba(55,135,95,${p1}) 0%,
          transparent 70%
        ),
        radial-gradient(
          ellipse 100% 80% at 90% 90%,
          rgba(35,105,75,${p2}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    case 'sunset': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.75
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.65).toFixed(3);

      const p3 =
        (f * 0.35).toFixed(3);

      return `
        linear-gradient(
          155deg,
          transparent 18%,
          rgba(220,125,90,${p1}) 48%,
          rgba(185,105,155,${p2}) 68%,
          transparent 92%
        ),
        radial-gradient(
          ellipse 85% 55% at 82% 82%,
          rgba(245,165,95,${p3}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    case 'ember': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.8
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        radial-gradient(
          ellipse 95% 65% at 50% 110%,
          rgba(215,75,45,${p1}) 0%,
          rgba(175,55,40,${p2}) 38%,
          transparent 78%
        ),
        radial-gradient(
          circle at 12% 65%,
          rgba(235,120,55,${p2}) 0%,
          transparent 45%
        ),
        var(--void)
      `;
    }


    case 'ice': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.55
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        radial-gradient(
          ellipse 100% 80% at 15% 20%,
          rgba(155,205,235,${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 90% 75% at 85% 80%,
          rgba(125,165,220,${p2}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    // ----------------------------------------------------------
    // Space
    // ----------------------------------------------------------

    case 'midnight': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.9
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.5).toFixed(3);

      const p3 =
        (f * 0.4).toFixed(3);

      const rgbMain =
        dark
          ? '32,42,108'
          : '90,112,196';

      const rgbFaint =
        dark
          ? '16,22,58'
          : '150,165,222';

      return `
        radial-gradient(
          ellipse 95% 85% at 84% 4%,
          rgba(${rgbMain},${p1}) 0%,
          rgba(${rgbMain},${p2}) 38%,
          transparent 72%
        ),
        radial-gradient(
          circle at 6% 98%,
          rgba(${rgbFaint},${p3}) 0%,
          transparent 46%
        ),
        var(--void)
      `;
    }


    case 'deep-space': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.85
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.6).toFixed(3);

      return `
        radial-gradient(
          ellipse 120% 100% at 75% 25%,
          rgba(65,55,155,${p1}) 0%,
          transparent 75%
        ),
        radial-gradient(
          ellipse 90% 80% at 15% 80%,
          rgba(35,75,150,${p2}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    case 'nebula': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.8
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.85).toFixed(3);

      const p3 =
        (f * 0.65).toFixed(3);

      const rgbA =
        dark
          ? '110,80,170'
          : '170,150,220';

      const rgbB =
        dark
          ? '65,92,178'
          : '145,170,225';

      const rgbC =
        dark
          ? '150,95,150'
          : '215,175,205';

      return `
        radial-gradient(
          ellipse 120% 95% at 18% 22%,
          rgba(${rgbA},${p1}) 0%,
          transparent 66%
        ),
        radial-gradient(
          ellipse 105% 110% at 78% 58%,
          rgba(${rgbB},${p2}) 0%,
          transparent 68%
        ),
        radial-gradient(
          ellipse 85% 70% at 42% 90%,
          rgba(${rgbC},${p3}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    // ----------------------------------------------------------
    // Material
    // ----------------------------------------------------------

    case 'glass': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.35
        );

      const p1 =
        (f * 0.95).toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      const p3 =
        (f * 0.35).toFixed(3);

      const rgbA =
        dark
          ? '215,220,232'
          : '255,255,255';

      const rgbB =
        dark
          ? '150,172,202'
          : '200,214,234';

      const rgbSheen =
        dark
          ? '235,238,245'
          : '255,255,255';

      return `
        linear-gradient(
          128deg,
          rgba(${rgbSheen},${p3}) 0%,
          transparent 32%
        ),
        radial-gradient(
          ellipse 62% 46% at 18% 22%,
          rgba(${rgbA},${p1}) 0%,
          transparent 74%
        ),
        radial-gradient(
          ellipse 55% 50% at 85% 78%,
          rgba(${rgbB},${p2}) 0%,
          transparent 76%
        ),
        var(--void)
      `;
    }


    // ----------------------------------------------------------
    // Additional fixed atmospheres
    // ----------------------------------------------------------

    case 'graphite': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.6
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        radial-gradient(
          ellipse 120% 90% at 15% 10%,
          rgba(90,95,105,${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 100% 80% at 90% 90%,
          rgba(55,60,72,${p2}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'slate': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.55
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.65).toFixed(3);

      return `
        linear-gradient(
          145deg,
          rgba(75,90,115,${p1}) 0%,
          transparent 48%
        ),
        radial-gradient(
          ellipse 90% 80% at 85% 85%,
          rgba(65,75,100,${p2}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    case 'charcoal': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.7
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.5).toFixed(3);

      return `
        radial-gradient(
          ellipse 100% 100% at 50% 0%,
          rgba(75,78,88,${p1}) 0%,
          transparent 70%
        ),
        radial-gradient(
          circle at 20% 90%,
          rgba(35,38,45,${p2}) 0%,
          transparent 55%
        ),
        var(--void)
      `;
    }


    case 'arctic': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.5
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.65).toFixed(3);

      return `
        radial-gradient(
          ellipse 110% 80% at 15% 15%,
          rgba(150,205,235,${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 100% 85% at 90% 85%,
          rgba(115,170,220,${p2}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'mist': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.5
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        linear-gradient(
          120deg,
          transparent 10%,
          rgba(150,155,175,${p1}) 42%,
          rgba(110,120,145,${p2}) 62%,
          transparent 90%
        ),
        var(--void)
      `;
    }


    case 'rain': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.55
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        radial-gradient(
          ellipse 120% 70% at 50% 100%,
          rgba(70,105,140,${p1}) 0%,
          transparent 72%
        ),
        linear-gradient(
          165deg,
          rgba(55,75,100,${p2}) 0%,
          transparent 58%
        ),
        var(--void)
      `;
    }


    case 'twilight': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.7
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      const p3 =
        (f * 0.45).toFixed(3);

      return `
        linear-gradient(
          155deg,
          rgba(70,75,145,${p1}) 0%,
          rgba(105,70,125,${p2}) 48%,
          transparent 82%
        ),
        radial-gradient(
          ellipse 90% 60% at 80% 85%,
          rgba(185,105,125,${p3}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'cosmic': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.75
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      const p3 =
        (f * 0.5).toFixed(3);

      return `
        radial-gradient(
          ellipse 90% 75% at 20% 20%,
          rgba(95,70,170,${p1}) 0%,
          transparent 70%
        ),
        radial-gradient(
          ellipse 100% 90% at 85% 70%,
          rgba(55,85,170,${p2}) 0%,
          transparent 72%
        ),
        radial-gradient(
          circle at 50% 95%,
          rgba(155,80,150,${p3}) 0%,
          transparent 55%
        ),
        var(--void)
      `;
    }


    case 'starlight': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.6
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        radial-gradient(
          ellipse 75% 60% at 50% 15%,
          rgba(125,145,205,${p1}) 0%,
          transparent 70%
        ),
        radial-gradient(
          ellipse 100% 80% at 10% 90%,
          rgba(70,85,140,${p2}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    case 'plasma': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.75
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      const p3 =
        (f * 0.45).toFixed(3);

      return `
        radial-gradient(
          ellipse 80% 100% at 15% 50%,
          rgba(120,70,190,${p1}) 0%,
          transparent 70%
        ),
        radial-gradient(
          ellipse 85% 100% at 85% 50%,
          rgba(55,105,195,${p2}) 0%,
          transparent 72%
        ),
        linear-gradient(
          180deg,
          transparent 25%,
          rgba(175,70,150,${p3}) 70%,
          transparent 95%
        ),
        var(--void)
      `;
    }


    case 'lavender': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.65
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.6).toFixed(3);

      return `
        radial-gradient(
          ellipse 110% 85% at 20% 15%,
          rgba(145,120,190,${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 100% 80% at 85% 85%,
          rgba(110,95,165,${p2}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'rose': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.7
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.6).toFixed(3);

      return `
        radial-gradient(
          ellipse 100% 85% at 15% 20%,
          rgba(190,105,140,${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 90% 80% at 85% 85%,
          rgba(145,75,110,${p2}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'sand': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.75
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        radial-gradient(
          ellipse 120% 85% at 15% 90%,
          rgba(190,155,105,${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 100% 80% at 90% 10%,
          rgba(150,125,90,${p2}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'desert': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.75
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.6).toFixed(3);

      return `
        linear-gradient(
          150deg,
          rgba(190,125,75,${p1}) 0%,
          transparent 48%
        ),
        radial-gradient(
          ellipse 120% 70% at 80% 85%,
          rgba(220,165,90,${p2}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    case 'moss': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.75
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.6).toFixed(3);

      return `
        radial-gradient(
          ellipse 110% 85% at 10% 15%,
          rgba(105,130,75,${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 100% 80% at 90% 90%,
          rgba(70,100,65,${p2}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'deep-green': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.7
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.65).toFixed(3);

      return `
        radial-gradient(
          ellipse 100% 90% at 20% 20%,
          rgba(35,105,80,${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 100% 85% at 85% 85%,
          rgba(25,75,65,${p2}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'volcanic': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.75
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        radial-gradient(
          ellipse 100% 70% at 50% 110%,
          rgba(170,55,40,${p1}) 0%,
          rgba(110,45,40,${p2}) 38%,
          transparent 78%
        ),
        radial-gradient(
          circle at 85% 15%,
          rgba(125,65,45,${p2}) 0%,
          transparent 48%
        ),
        var(--void)
      `;
    }


    case 'copper': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.7
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.6).toFixed(3);

      return `
        linear-gradient(
          135deg,
          rgba(175,105,70,${p1}) 0%,
          transparent 52%
        ),
        radial-gradient(
          ellipse 100% 80% at 85% 85%,
          rgba(130,75,55,${p2}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    // ----------------------------------------------------------
    // Accent: classic compositions
    // ----------------------------------------------------------

    case 'custom-accent': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      const p3 =
        (f * 0.3).toFixed(3);

      return `
        radial-gradient(
          ellipse 100% 85% at 20% 15%,
          rgba(var(--indigo),${p1}) 0%,
          rgba(var(--indigo),${p2}) 40%,
          transparent 74%
        ),
        radial-gradient(
          circle at 90% 94%,
          rgba(var(--indigo-2),${p3}) 0%,
          transparent 42%
        ),
        var(--void)
      `;
    }


    case 'accent-flow': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.8).toFixed(3);

      const p3 =
        (f * 0.6).toFixed(3);

      return `
        radial-gradient(
          ellipse 95% 75% at 10% 88%,
          rgba(var(--indigo),${p1}) 0%,
          transparent 70%
        ),
        radial-gradient(
          ellipse 105% 85% at 46% 42%,
          rgba(var(--indigo-2),${p2}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 95% 75% at 84% 8%,
          rgba(var(--indigo),${p3}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'accent-glow': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.62).toFixed(3);

      const p3 =
        (f * 0.32).toFixed(3);

      return `
        radial-gradient(
          ellipse 78% 68% at 70% 32%,
          rgba(var(--indigo),${p1}) 0%,
          rgba(var(--indigo),${p2}) 34%,
          rgba(var(--indigo),${p3}) 60%,
          transparent 82%
        ),
        var(--void)
      `;
    }


    case 'accent-depth': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const pFar =
        (f * 0.35).toFixed(3);

      const pMid =
        (f * 0.55).toFixed(3);

      const pNear =
        (f * 0.8).toFixed(3);

      return `
        radial-gradient(
          ellipse 160% 140% at 32% 72%,
          rgba(var(--indigo),${pFar}) 0%,
          transparent 76%
        ),
        radial-gradient(
          ellipse 100% 90% at 78% 22%,
          rgba(var(--indigo-2),${pMid}) 0%,
          transparent 68%
        ),
        radial-gradient(
          ellipse 58% 52% at 14% 18%,
          rgba(var(--indigo),${pNear}) 0%,
          transparent 62%
        ),
        var(--void)
      `;
    }


    case 'accent-horizon': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const pBand =
        f.toFixed(3);

      const pBand2 =
        (f * 0.75).toFixed(3);

      const pFill =
        (f * 0.3).toFixed(3);

      return `
        linear-gradient(
          4deg,
          transparent 28%,
          rgba(var(--indigo),${pBand}) 46%,
          rgba(var(--indigo-2),${pBand2}) 62%,
          transparent 82%
        ),
        radial-gradient(
          ellipse 140% 100% at 50% 8%,
          rgba(var(--indigo),${pFill}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    case 'accent-corner': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      return `
        radial-gradient(
          ellipse 130% 100% at 0% 0%,
          rgba(var(--indigo),${p1}) 0%,
          transparent 58%
        ),
        radial-gradient(
          ellipse 115% 95% at 100% 100%,
          rgba(var(--indigo-2),${p2}) 0%,
          transparent 55%
        ),
        var(--void)
      `;
    }


    case 'accent-orbit': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.45
        );

      const pA =
        (f * 0.6).toFixed(3);

      const pB =
        (f * 0.55).toFixed(3);

      const pC =
        (f * 0.58).toFixed(3);

      const pD =
        (f * 0.5).toFixed(3);

      return `
        radial-gradient(
          ellipse 120% 100% at 18% 12%,
          rgba(var(--indigo),${pA}) 0%,
          transparent 66%
        ),
        radial-gradient(
          ellipse 130% 110% at 88% 28%,
          rgba(var(--indigo-2),${pB}) 0%,
          transparent 67%
        ),
        radial-gradient(
          ellipse 125% 105% at 68% 90%,
          rgba(var(--indigo),${pC}) 0%,
          transparent 65%
        ),
        radial-gradient(
          ellipse 115% 95% at 6% 74%,
          rgba(var(--indigo-2),${pD}) 0%,
          transparent 64%
        ),
        var(--void)
      `;
    }


    case 'accent-mesh': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const pA =
        (f * 0.55).toFixed(3);

      const pB =
        (f * 0.5).toFixed(3);

      const pC =
        (f * 0.45).toFixed(3);

      return `
        radial-gradient(
          ellipse 150% 130% at 25% 30%,
          rgba(var(--indigo),${pA}) 0%,
          transparent 85%
        ),
        radial-gradient(
          ellipse 140% 150% at 75% 65%,
          rgba(var(--indigo-2),${pB}) 0%,
          transparent 85%
        ),
        radial-gradient(
          ellipse 130% 120% at 55% 12%,
          rgba(var(--indigo),${pC}) 0%,
          transparent 82%
        ),
        var(--void)
      `;
    }


    // ----------------------------------------------------------
    // Accent: additional compositions
    // ----------------------------------------------------------

    case 'accent-sunrise': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        radial-gradient(
          ellipse 115% 75% at 50% 115%,
          rgba(var(--indigo),${p1}) 0%,
          rgba(var(--indigo-2),${p2}) 38%,
          transparent 78%
        ),
        var(--void)
      `;
    }


    case 'accent-pool': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.5).toFixed(3);

      return `
        radial-gradient(
          ellipse 135% 42% at 50% 72%,
          rgba(var(--indigo),${p1}) 0%,
          rgba(var(--indigo-2),${p2}) 42%,
          transparent 78%
        ),
        var(--void)
      `;
    }


    case 'accent-split': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      return `
        linear-gradient(
          135deg,
          rgba(var(--indigo),${p1}) 0%,
          transparent 43%,
          rgba(var(--indigo-2),${p2}) 100%
        ),
        var(--void)
      `;
    }


    case 'accent-ripple': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.6).toFixed(3);

      const p3 =
        (f * 0.3).toFixed(3);

      return `
        radial-gradient(
          circle at 72% 32%,
          rgba(var(--indigo),${p1}) 0%,
          rgba(var(--indigo),${p2}) 16%,
          transparent 30%,
          rgba(var(--indigo-2),${p3}) 43%,
          transparent 60%
        ),
        var(--void)
      `;
    }


    case 'accent-lens': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.65).toFixed(3);

      const p3 =
        (f * 0.25).toFixed(3);

      return `
        radial-gradient(
          ellipse 42% 30% at 62% 38%,
          rgba(var(--indigo),${p1}) 0%,
          rgba(var(--indigo),${p2}) 28%,
          rgba(var(--indigo-2),${p3}) 55%,
          transparent 78%
        ),
        var(--void)
      `;
    }


    case 'accent-veil': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.55).toFixed(3);

      return `
        linear-gradient(
          142deg,
          transparent 12%,
          rgba(var(--indigo),${p1}) 38%,
          rgba(var(--indigo-2),${p2}) 58%,
          transparent 88%
        ),
        var(--void)
      `;
    }


    case 'accent-pulse': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      return `
        radial-gradient(
          ellipse 75% 65% at 8% 50%,
          rgba(var(--indigo),${p1}) 0%,
          transparent 70%
        ),
        radial-gradient(
          ellipse 75% 65% at 92% 50%,
          rgba(var(--indigo-2),${p2}) 0%,
          transparent 70%
        ),
        var(--void)
      `;
    }


    case 'accent-frame': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.65).toFixed(3);

      return `
        radial-gradient(
          ellipse 120% 90% at 50% 50%,
          transparent 45%,
          rgba(var(--indigo),${p1}) 72%,
          rgba(var(--indigo-2),${p2}) 100%
        ),
        var(--void)
      `;
    }


    case 'accent-drift': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.72).toFixed(3);

      const p3 =
        (f * 0.48).toFixed(3);

      return `
        radial-gradient(
          ellipse 80% 55% at 12% 28%,
          rgba(var(--indigo),${p1}) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 75% 60% at 82% 48%,
          rgba(var(--indigo-2),${p2}) 0%,
          transparent 70%
        ),
        radial-gradient(
          ellipse 65% 50% at 48% 92%,
          rgba(var(--indigo),${p3}) 0%,
          transparent 68%
        ),
        var(--void)
      `;
    }


    case 'accent-prism': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.7).toFixed(3);

      const p3 =
        (f * 0.45).toFixed(3);

      return `
        linear-gradient(
          132deg,
          rgba(var(--indigo),${p1}) 0%,
          transparent 34%
        ),
        linear-gradient(
          218deg,
          rgba(var(--indigo-2),${p2}) 0%,
          transparent 42%
        ),
        radial-gradient(
          ellipse 70% 85% at 52% 50%,
          rgba(var(--indigo),${p3}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    case 'accent-eclipse': {
      const f =
        backgroundFactor(
          peak,
          dark,
          1.4
        );

      const p1 =
        f.toFixed(3);

      const p2 =
        (f * 0.68).toFixed(3);

      const p3 =
        (f * 0.35).toFixed(3);

      return `
        radial-gradient(
          circle at 52% 48%,
          var(--void) 0%,
          var(--void) 18%,
          rgba(var(--indigo),${p1}) 34%,
          rgba(var(--indigo-2),${p2}) 52%,
          transparent 76%
        ),
        radial-gradient(
          ellipse 120% 75% at 20% 90%,
          rgba(var(--indigo),${p3}) 0%,
          transparent 72%
        ),
        var(--void)
      `;
    }


    default:
      return 'var(--void)';
  }
}


// ============================================================
// Paint underlay
// ============================================================

function paintUnderlay() {
  const peak =
    AMBIENT_LEVELS[currentLevel];

  document.documentElement.style.setProperty(
    '--ambient-strength',
    peak
  );

  const dark =
    getCurrentTheme() === 'dark';

  const backgroundCss =
    buildBackgroundCss(
      currentBackgroundId,
      {
        peak,
        dark
      }
    );

  /*
   * Also published as a CSS variable so any surface that needs
   * its own copy of the site background paints the exact same
   * layers instead of re-deriving them.
   */
  document.documentElement.style.setProperty(
    '--ambient-bg',
    backgroundCss
  );

  const underlay =
    document.getElementById(
      'ambient-underlay'
    );

  if (!underlay) {
    return;
  }

  underlay.style.background =
    backgroundCss;
}


// ============================================================
// Apply arbitrary HEX accent
//
// Accent is account-scoped.
// This function changes runtime state only.
// It NEVER writes to localStorage.
// Persistence is handled by the account API in the settings layer.
// ============================================================

export function applyAccent(hex) {
  if (!isValidAccentHex(hex)) {
    return false;
  }

  const normalized =
    hex.toUpperCase();

  const rgb =
    rgbStringFromHex(
      normalized
    );

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

  currentAccentHex =
    normalized;

  currentRgb =
    rgb;

  paintUnderlay();

  return true;
}


// ============================================================
// Accent preset
// ============================================================

export function applyAccentPreset(preset) {
  if (!preset?.hex || !isValidAccentHex(preset.hex)) {
    return false;
  }

  return applyAccent(
    preset.hex
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

  currentLevel =
    levelIndex;

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
// Accent initialization
//
// userAccentColor comes from the authenticated user's /api/me
// response.
//
// No localStorage fallback exists.
// If the server has no valid accent, Neutral is used.
// ============================================================

export function initAccent(
  userAccentColor = null
) {
  currentLevel =
    getCurrentAmbientLevel();

  const hex =
    isValidAccentHex(
      userAccentColor
    )
      ? userAccentColor.toUpperCase()
      : DEFAULT_ACCENT_HEX;

  applyAccent(hex);

  return hex;
}


export function getCurrentAmbientLevelValue() {
  return AMBIENT_LEVELS[
    currentLevel
  ];
}


// ============================================================
// Background theme
// ============================================================

export function getCurrentBackgroundTheme() {
  const saved =
    safeGetStorage(
      BACKGROUND_STORAGE_KEY
    );

  const preset =
    BACKGROUND_PRESETS.find(
      preset =>
        preset.id === saved
    );

  return preset?.id ||
    DEFAULT_BACKGROUND_ID;
}


export function applyBackgroundTheme(
  id,
  { persist = true } = {}
) {
  const preset =
    BACKGROUND_PRESETS.find(
      preset =>
        preset.id === id
    );

  if (!preset) {
    return false;
  }

  currentBackgroundId =
    preset.id;

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


// ============================================================
// Background preview
// ============================================================

export function getBackgroundPreviewCss(
  id,
  { dark = true } = {}
) {
  return buildBackgroundCss(
    id,
    {
      peak:
        AMBIENT_LEVELS[
          DEFAULT_AMBIENT_LEVEL
        ],
      dark
    }
  );
}


// ============================================================
// Light / dark theme
// ============================================================

export function getCurrentTheme() {
  const saved =
    safeGetStorage(
      THEME_STORAGE_KEY
    );

  return saved === 'light'
    ? 'light'
    : 'dark';
}


export function applyTheme(
  theme,
  { persist = true } = {}
) {
  const value =
    theme === 'light'
      ? 'light'
      : 'dark';

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

  paintUnderlay();

  return value;
}


export function initTheme() {
  const theme =
    getCurrentTheme();

  applyTheme(
    theme,
    {
      persist: false
    }
  );

  return theme;
}


// ============================================================
// Use accent color for chat bubbles
// ============================================================

export function getUseAccentForBubbles() {
  const saved =
    safeGetStorage(
      BUBBLE_ACCENT_STORAGE_KEY
    );

  return saved === null
    ? true
    : saved !== 'off';
}


export function applyUseAccentForBubbles(
  enabled,
  { persist = true } = {}
) {
  const value =
    enabled !== false;

  if (persist) {
    safeSetStorage(
      BUBBLE_ACCENT_STORAGE_KEY,
      value
        ? 'on'
        : 'off'
    );
  }

  return value;
}


// ============================================================
// Message bubble style
// ============================================================

export const BUBBLE_STYLES = [
  'filled',
  'soft',
  'outline',
  'clean'
];

export const DEFAULT_BUBBLE_STYLE =
  'filled';


export function getMessageBubbleStyle() {
  const saved =
    safeGetStorage(
      BUBBLE_STYLE_STORAGE_KEY
    );

  return BUBBLE_STYLES.includes(saved)
    ? saved
    : DEFAULT_BUBBLE_STYLE;
}


export function applyMessageBubbleStyle(
  style,
  { persist = true } = {}
) {
  const value =
    BUBBLE_STYLES.includes(style)
      ? style
      : DEFAULT_BUBBLE_STYLE;

  document.documentElement.dataset
    .bubbleStyle = value;

  if (persist) {
    safeSetStorage(
      BUBBLE_STYLE_STORAGE_KEY,
      value
    );
  }

  return value;
}


export function initMessageBubbleStyle() {
  const style =
    getMessageBubbleStyle();

  applyMessageBubbleStyle(
    style,
    {
      persist: false
    }
  );

  return style;
}


// ============================================================
// Animations (global appearance toggle)
// ============================================================

const ANIMATIONS_ATTR =
  'data-animations';


export function getAnimationsEnabled() {
  const saved =
    safeGetStorage(
      ANIMATIONS_STORAGE_KEY
    );

  return saved === 'on';
}


export function applyAnimationsEnabled(
  enabled,
  { persist = true } = {}
) {
  const value =
    enabled === true;

  if (value) {
    document.documentElement.setAttribute(
      ANIMATIONS_ATTR,
      'on'
    );
  } else {
    document.documentElement.removeAttribute(
      ANIMATIONS_ATTR
    );
  }

  if (persist) {
    safeSetStorage(
      ANIMATIONS_STORAGE_KEY,
      value
        ? 'on'
        : 'off'
    );
  }

  return value;
}


export function initAnimations() {
  const enabled =
    getAnimationsEnabled();

  applyAnimationsEnabled(
    enabled,
    {
      persist: false
    }
  );

  return enabled;
}


// ============================================================
// Interface font
// ============================================================
//
// One authoritative source: the --wire-font-family custom
// property on <html>. css/core/reset.css points html/body at it
// and everything else inherits, so this module only has to
// (1) read + validate the stored id, (2) persist it and
// (3) update that one property.
//

export const DEFAULT_FONT_ID =
  'inter';

export const FONT_OPTIONS = {
  system:
    'system-ui, sans-serif',

  inter:
    '"Inter", "Vazirmatn", system-ui, sans-serif',

  'anthropic-sans':
    '"Anthropic Sans", "Vazirmatn", system-ui, sans-serif',

  'noto-sans':
    '"Noto Sans", "Vazirmatn", system-ui, sans-serif',

  vazirmatn:
    '"Vazirmatn", system-ui, sans-serif',

  roboto:
    '"Roboto", "Vazirmatn", Arial, sans-serif',

  'open-sans':
    '"Open Sans", "Vazirmatn", Arial, sans-serif',

  poppins:
    '"Poppins", "Vazirmatn", system-ui, sans-serif',

  monospace:
    'ui-monospace, "JetBrains Mono", monospace'
};

export function getFontFamily() {
  const saved =
    safeGetStorage(
      FONT_STORAGE_KEY
    );

  return Object.hasOwn(
    FONT_OPTIONS,
    saved
  )
    ? saved
    : DEFAULT_FONT_ID;
}


export function applyFontFamily(
  font,
  { persist = true } = {}
) {
  const value =
    Object.hasOwn(
      FONT_OPTIONS,
      font
    )
      ? font
      : DEFAULT_FONT_ID;

  const root =
    document.documentElement;

  root.style.setProperty(
    '--wire-font-family',
    FONT_OPTIONS[value]
  );

  root.dataset.font =
    value;

  if (persist) {
    safeSetStorage(
      FONT_STORAGE_KEY,
      value
    );
  }

  return value;
}


export function initFontFamily() {
  const font =
    getFontFamily();

  applyFontFamily(
    font,
    {
      persist: false
    }
  );

  return font;
}