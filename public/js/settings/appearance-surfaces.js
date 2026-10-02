// ============================================================
// Advanced appearance — per-surface transparency and blur
//
// The app's glass surfaces (sidebar, panels, header, modals,
// popovers, cards) already read their alpha and backdrop-filter
// from CSS. This module only owns the *user overrides*:
//
//   - one sparse JSON object in localStorage (same store every
//     other appearance preference uses, see theme.js);
//   - a handful of CSS custom properties on <html>:
//       --sf-<id>-alpha    background alpha (0..1)
//       --sf-<id>-filter   full backdrop-filter value, or `none`
//
// Nothing is written for a setting the user never touched, so
// the stylesheet's own fallbacks (`var(--sf-x-alpha, .42)`)
// keep the default look byte-for-byte identical to before this
// feature existed, and there is zero runtime cost by default.
//
// Changing a value updates a custom property; no component
// re-renders and no per-element JS runs.
// ============================================================

import {
  safeGetStorage,
  safeSetStorage
} from './theme.js';

const STORAGE_KEY = 'wire-appearance-surfaces';

// Backdrop blur is the expensive part. Phones/tablets get a lower
// ceiling on the slider, and blur is dropped entirely while an
// animated background is playing behind it (see effectiveFilter).
export const BLUR_MAX_DESKTOP = 30;
export const BLUR_MAX_LITE = 16;

/*
 * Only surfaces that exist in the current UI.
 *
 *   defaultAlpha / defaultBlur  mirror the values in the stylesheets
 *                               (the CSS fallbacks) — used to show the
 *                               correct starting position.
 *   minAlpha                    readability floor: how see-through this
 *                               surface is allowed to get.
 *   saturate                    extra filter kept on top of the blur.
 */
export const SURFACES = [
  {
    id: 'sidebar',
    label: 'Sidebar & top bar',
    hint: 'The navigation sidebar and the bar across the top',
    defaultAlpha: 0.42,
    defaultBlur: 0,
    minAlpha: 0.15
  },
  {
    id: 'panel',
    label: 'Side panels',
    hint: 'Conversation list and file sidebar',
    defaultAlpha: 0.62,
    defaultBlur: 12,
    minAlpha: 0.2
  },
  {
    id: 'main',
    label: 'Message area',
    hint: 'The chat pane and the Files pane. Phone layout keeps its solid conversation layer.',
    defaultAlpha: 0.55,
    defaultBlur: 12,
    minAlpha: 0.25
  },
  {
    id: 'header',
    label: 'Chat header',
    hint: 'The floating bar at the top of a conversation',
    defaultAlpha: 0.4,
    defaultBlur: 20,
    minAlpha: 0.25,
    saturate: 1.4
  },
  {
    id: 'modal',
    label: 'Dialogs',
    hint: 'Modal windows and confirmations',
    defaultAlpha: 0.92,
    defaultBlur: 20,
    minAlpha: 0.6
  },
  {
    id: 'popover',
    label: 'Menus & popovers',
    hint: 'Dropdowns, the emoji picker and the phone menu',
    defaultAlpha: 0.95,
    defaultBlur: 16,
    minAlpha: 0.7
  },
  {
    id: 'card',
    label: 'Cards & settings panels',
    hint: 'Settings, Files, Admin and other page cards',
    defaultAlpha: 0.78,
    defaultBlur: 12,
    minAlpha: 0.4
  }
];

const BY_ID = new Map(SURFACES.map(s => [s.id, s]));

// ------------------------------------------------------------
// Device capability
// ------------------------------------------------------------

export function isLiteDevice() {
  try {
    if (window.Capacitor?.isNativePlatform?.()) return true;
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export function getBlurMax() {
  return isLiteDevice()
    ? BLUR_MAX_LITE
    : BLUR_MAX_DESKTOP;
}

// ------------------------------------------------------------
// Slider <-> alpha mapping
//
// The UI speaks in "transparency %" (0 = solid). Default
// transparency is derived from the stylesheet default so an
// untouched slider sits exactly where the app looks today.
// ------------------------------------------------------------

export function defaultTransparency(surface) {
  return Math.round((1 - surface.defaultAlpha) * 100);
}

export function maxTransparency(surface) {
  return Math.floor((1 - surface.minAlpha) * 100);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ------------------------------------------------------------
// Persistence
// ------------------------------------------------------------

function readPrefs() {
  const empty = { blurAll: true, surfaces: {} };

  try {
    const raw = safeGetStorage(STORAGE_KEY);
    if (!raw) return empty;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;

    const out = {
      blurAll: parsed.blurAll !== false,
      surfaces: {}
    };

    for (const surface of SURFACES) {
      const p = parsed.surfaces?.[surface.id];
      if (!p || typeof p !== 'object') continue;

      const clean = {};

      if (Number.isFinite(p.transparency)) {
        clean.transparency = clamp(
          Math.round(p.transparency),
          0,
          maxTransparency(surface)
        );
      }

      if (Number.isFinite(p.blur)) {
        clean.blur = clamp(
          Math.round(p.blur),
          0,
          BLUR_MAX_DESKTOP
        );
      }

      if (typeof p.blurOn === 'boolean') {
        clean.blurOn = p.blurOn;
      }

      if (Object.keys(clean).length) {
        out.surfaces[surface.id] = clean;
      }
    }

    return out;
  } catch {
    return empty;
  }
}

function writePrefs(prefs) {
  const isDefault =
    prefs.blurAll &&
    Object.keys(prefs.surfaces).length === 0;

  if (isDefault) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Not required for the current session.
    }
    return;
  }

  safeSetStorage(
    STORAGE_KEY,
    JSON.stringify(prefs)
  );
}

// ------------------------------------------------------------
// Public read API (what the settings UI shows)
// ------------------------------------------------------------

export function getBlurAll() {
  return readPrefs().blurAll;
}

export function getSurfaceState(id) {
  const surface = BY_ID.get(id);
  if (!surface) return null;

  const p = readPrefs().surfaces[id] || {};

  const blur = p.blur ?? surface.defaultBlur;

  return {
    transparency:
      p.transparency ?? defaultTransparency(surface),

    blur: Math.min(
      blur > 0 ? blur : Math.max(surface.defaultBlur, 12),
      getBlurMax()
    ),

    blurOn:
      p.blurOn ?? surface.defaultBlur > 0
  };
}

// ------------------------------------------------------------
// Applying to CSS
// ------------------------------------------------------------

function alphaVar(id) {
  return `--sf-${id}-alpha`;
}

function filterVar(id) {
  return `--sf-${id}-filter`;
}

function isAnimatedBackgroundPlaying() {
  return (
    document.documentElement.dataset
      .customBgMotion === 'playing'
  );
}

function buildFilter(surface, px) {
  const extra = surface.saturate
    ? ` saturate(${surface.saturate})`
    : '';

  return `blur(${px}px)${extra}`;
}

export function applySurfaces() {
  const root = document.documentElement.style;
  const prefs = readPrefs();

  // Backdrop blur over an animating background re-blurs every
  // frame. On phones that is the single most expensive thing this
  // app could ask the GPU for, so it is switched off there.
  const forceOff =
    !prefs.blurAll ||
    (isLiteDevice() && isAnimatedBackgroundPlaying());

  const max = getBlurMax();

  for (const surface of SURFACES) {
    const p = prefs.surfaces[surface.id] || {};

    // ---- alpha ----
    if (typeof p.transparency === 'number') {
      const alpha = clamp(
        1 - p.transparency / 100,
        surface.minAlpha,
        1
      );

      root.setProperty(
        alphaVar(surface.id),
        alpha.toFixed(2)
      );
    } else {
      root.removeProperty(alphaVar(surface.id));
    }

    // ---- blur ----
    const touched =
      p.blurOn !== undefined ||
      p.blur !== undefined;

    if (forceOff) {
      root.setProperty(filterVar(surface.id), 'none');
      continue;
    }

    if (!touched) {
      root.removeProperty(filterVar(surface.id));
      continue;
    }

    const on = p.blurOn ?? surface.defaultBlur > 0;
    const px = Math.min(
      p.blur ??
        (surface.defaultBlur || 12),
      max
    );

    root.setProperty(
      filterVar(surface.id),
      on && px > 0
        ? buildFilter(surface, px)
        : 'none'
    );
  }
}

// ------------------------------------------------------------
// Public write API
// ------------------------------------------------------------

export function setSurface(id, patch) {
  const surface = BY_ID.get(id);
  if (!surface) return;

  const prefs = readPrefs();
  const next = { ...(prefs.surfaces[id] || {}) };

  if (Number.isFinite(patch.transparency)) {
    next.transparency = clamp(
      Math.round(patch.transparency),
      0,
      maxTransparency(surface)
    );
  }

  if (Number.isFinite(patch.blur)) {
    next.blur = clamp(
      Math.round(patch.blur),
      0,
      BLUR_MAX_DESKTOP
    );
  }

  if (typeof patch.blurOn === 'boolean') {
    next.blurOn = patch.blurOn;
  }

  // Back at the stylesheet default → forget the override.
  if (
    next.transparency ===
    defaultTransparency(surface)
  ) {
    delete next.transparency;
  }

  const defaultOn = surface.defaultBlur > 0;

  if (
    (next.blur === undefined ||
      next.blur === surface.defaultBlur) &&
    (next.blurOn === undefined ||
      next.blurOn === defaultOn)
  ) {
    delete next.blur;
    delete next.blurOn;
  }

  if (Object.keys(next).length) {
    prefs.surfaces[id] = next;
  } else {
    delete prefs.surfaces[id];
  }

  writePrefs(prefs);
  applySurfaces();
}

export function setBlurAll(enabled) {
  const prefs = readPrefs();
  prefs.blurAll = enabled !== false;

  writePrefs(prefs);
  applySurfaces();
}

export function resetSurfaces() {
  writePrefs({ blurAll: true, surfaces: {} });
  applySurfaces();
}

// ------------------------------------------------------------
// Startup
//
// Called once from app.js's bootstrap with the other local
// appearance initializers (before login, before first paint of
// the app), so the values are already in place when the user
// logs in or the layout changes. Theme/accent need nothing here:
// the surfaces are built from --ink-rgb / --void-rgb, which the
// existing theme tokens already flip.
// ------------------------------------------------------------

let listening = false;

export function initSurfaces() {
  applySurfaces();

  if (listening) return;
  listening = true;

  // Desktop <-> mobile layout, or a device gaining/losing touch:
  // blur ceiling and the animated-background fallback depend on it.
  try {
    for (const query of [
      '(pointer: coarse)',
      '(max-width: 900px)'
    ]) {
      window
        .matchMedia(query)
        .addEventListener(
          'change',
          applySurfaces
        );
    }
  } catch {
    // Older WebViews: values simply stay as last applied.
  }
}
