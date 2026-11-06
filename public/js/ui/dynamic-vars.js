// ============================================================
// Applies data-driven CSS values after markup is inserted (CSP: no style=""
// attributes in HTML). Values travel as data-* attributes and are set through
// CSSOM (el.style.*), which the CSP allows. Every value is validated or clamped
// before it is used.
// ============================================================

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function clampPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/**
 * Call after assigning innerHTML (or after a template is inserted).
 *   [data-sound-volume]  -> --sound-volume: N%      (range-slider fill)
 *   [data-swatch]        -> --swatch: #hex          (validated)
 *   [data-progress]      -> width: N%               (upload progress)
 *   [data-aspect]        -> aspect-ratio: N / M     (validated)
 */
export function applyDynamicVars(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  root.querySelectorAll('[data-sound-volume]').forEach((el) => {
    const pct = clampPercent(el.dataset.soundVolume);
    if (pct !== null) el.style.setProperty('--sound-volume', `${pct}%`);
  });

  root.querySelectorAll('[data-swatch]').forEach((el) => {
    const hex = el.dataset.swatch || '';
    if (HEX_COLOR.test(hex)) el.style.setProperty('--swatch', hex);
  });

  root.querySelectorAll('[data-progress]').forEach((el) => {
    const pct = clampPercent(el.dataset.progress);
    if (pct !== null) el.style.width = `${pct}%`;
  });

  root.querySelectorAll('[data-aspect]').forEach((el) => {
    const ratio = String(el.dataset.aspect || '').trim();
    if (/^\d+(\.\d+)?(\s*\/\s*\d+(\.\d+)?)?$/.test(ratio)) el.style.aspectRatio = ratio;
  });
}
