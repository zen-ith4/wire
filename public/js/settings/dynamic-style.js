// ============================================================
// Post-insertion styling for settings markup (CSP: no style="" in HTML).
//
// Settings markup carries data-* values; once the HTML is in the DOM,
// these values are applied through CSSOM (el.style.*), which the CSP
// allows. Keep this module free of imports: settings-render.js, settings-nav.js
// and settings.js all import it.
// ============================================================

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Apply every data-driven style under `root`. Call after assigning innerHTML.
 *   [data-bg-preview]   -> background (CSS gradient built by theme.js)
 *   [data-swatch-color] -> --swatch-color custom property (validated hex only)
 */
export function applyDynamicSettingsStyles(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  root.querySelectorAll('[data-bg-preview]').forEach((el) => {
    el.style.background = el.dataset.bgPreview || '';
  });

  root.querySelectorAll('[data-swatch-color]').forEach((el) => {
    const hex = el.dataset.swatchColor || '';
    if (HEX_COLOR.test(hex)) el.style.setProperty('--swatch-color', hex);
  });
}
