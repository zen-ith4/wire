// ============================================================
// Accent theming + ambient background intensity
//
// Two independent, separately-persisted preferences:
//   - accent color (the interactive-accent CSS variables + the hue
//     of the ambient glow)
//   - ambient intensity (how strong that glow is — 5 discrete
//     levels, deliberately large jumps between them so picking a
//     different level actually reads as a different level, not a
//     barely-perceptible nudge)
//
// Both are applied at app bootstrap (see app.js) so they're correct
// from the very first paint, including on the login screen.
// ============================================================

export const ACCENT_PRESETS = [
  { name: 'Neutral', hex: '#5C5C6E', rgb: '92, 92, 110' },
  { name: 'Blue',    hex: '#5F84AD', rgb: '95, 132, 173' },
  { name: 'Emerald', hex: '#5F8B6F', rgb: '95, 139, 111' },
  { name: 'Purple',  hex: '#7D6F9A', rgb: '125, 111, 154' },
  { name: 'Orange',  hex: '#A8805D', rgb: '168, 128, 93' },
  { name: 'Red',     hex: '#9A5D5D', rgb: '154, 93, 93' },
];

// Peak alpha (the gradient layer's strongest stop) for each of the 5
// intensity levels. The gaps between them widen on purpose (10 → 13
// → 12 → 15 points) rather than stepping evenly, since small equal
// increments (e.g. 5/8/11/14/17) don't read as a visible change on
// screen — these are chosen to actually look different level to level.
export const AMBIENT_LEVELS = [0.05, 0.15, 0.28, 0.40, 0.55];
export const DEFAULT_AMBIENT_LEVEL = 2; // index into AMBIENT_LEVELS (0-based) — "level 3 of 5"

// The other four gradient layers keep the same ratio to the peak
// layer that the original hand-tuned design used, so raising the
// level scales the whole glow proportionally instead of distorting
// its shape.
const LAYER_RATIOS = [1, 0.9, 0.5, 0.65, 0.6];

const ACCENT_STORAGE_KEY = 'filehub-accent';
const AMBIENT_STORAGE_KEY = 'filehub-ambient-level';

function safeGetStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    // Private-browsing / storage-disabled edge cases shouldn't break
    // the app — just fall back to the default silently.
    return null;
  }
}

function safeSetStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    // Same as above — persistence is a nice-to-have, not required
    // for the preference to apply for the current session.
  }
}

export function getCurrentAccentName() {
  return safeGetStorage(ACCENT_STORAGE_KEY) || ACCENT_PRESETS[0].name;
}

export function getCurrentAmbientLevel() {
  const raw = Number(safeGetStorage(AMBIENT_STORAGE_KEY));
  return Number.isInteger(raw) && raw >= 0 && raw < AMBIENT_LEVELS.length ? raw : DEFAULT_AMBIENT_LEVEL;
}

// Module state — the underlay needs both the current color and the
// current intensity to repaint itself, but each is changed
// independently (picking a new accent shouldn't reset the chosen
// intensity, and vice versa).
let currentRgb = ACCENT_PRESETS.find(p => p.name === getCurrentAccentName())?.rgb || ACCENT_PRESETS[0].rgb;
let currentLevel = getCurrentAmbientLevel();

function paintUnderlay() {
  const underlay = document.getElementById('ambient-underlay');
  if (!underlay) return;

  const peak = AMBIENT_LEVELS[currentLevel];
  const [a1, a2, a3, a4, a5] = LAYER_RATIOS.map(r => (peak * r).toFixed(3));

  underlay.style.background = `
    radial-gradient(ellipse 100% 80% at 20% 10%, rgba(${currentRgb}, ${a1}) 0%, transparent 55%),
    radial-gradient(ellipse 120% 90% at 85% 90%, rgba(${currentRgb}, ${a2}) 0%, transparent 55%),
    radial-gradient(ellipse 80% 70% at 50% 40%, rgba(${currentRgb}, ${a3}) 0%, transparent 60%),
    radial-gradient(ellipse 60% 100% at 10% 80%, rgba(${currentRgb}, ${a4}) 0%, transparent 50%),
    radial-gradient(ellipse 70% 60% at 90% 15%, rgba(${currentRgb}, ${a5}) 0%, transparent 50%),
    #050508`;
}

/**
 * Applies a preset's colors to the CSS custom properties every
 * accent-aware rule in style.css reads from, and repaints the
 * ambient underlay to match (same hue, current intensity level).
 */
export function applyAccentPreset(preset, { persist = true } = {}) {
  const root = document.documentElement;

  root.style.setProperty('--indigo', preset.rgb);
  root.style.setProperty('--cyan', preset.rgb);
  root.style.setProperty('--accent-bg', `rgba(${preset.rgb}, 0.07)`);
  root.style.setProperty('--accent-hover-bg', `rgba(${preset.rgb}, 0.11)`);
  root.style.setProperty('--accent-ring', `rgba(${preset.rgb}, 0.42)`);
  root.style.setProperty('--accent-border', `rgba(${preset.rgb}, 0.28)`);

  currentRgb = preset.rgb;
  paintUnderlay();

  if (persist) {
    safeSetStorage(ACCENT_STORAGE_KEY, preset.name);
  }
}

/**
 * Sets the ambient glow's intensity (0-4, see AMBIENT_LEVELS) without
 * touching the currently-selected accent color.
 */
export function applyAmbientLevel(levelIndex, { persist = true } = {}) {
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex >= AMBIENT_LEVELS.length) return;

  currentLevel = levelIndex;
  paintUnderlay();

  if (persist) {
    safeSetStorage(AMBIENT_STORAGE_KEY, String(levelIndex));
  }
}

/**
 * Call once at app bootstrap — reads any saved accent + ambient
 * level (or falls back to defaults) and applies both immediately.
 */
export function initAccent() {
  const savedName = getCurrentAccentName();
  const preset = ACCENT_PRESETS.find(p => p.name === savedName) || ACCENT_PRESETS[0];
  currentLevel = getCurrentAmbientLevel();
  applyAccentPreset(preset, { persist: false });
  return preset;
}
