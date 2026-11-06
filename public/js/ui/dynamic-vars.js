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
  const all = (sel) => {
    const out = root.matches && root.matches(sel) ? [root] : [];
    return out.concat(Array.from(root.querySelectorAll(sel)));
  };

  all('[data-sound-volume]').forEach((el) => {
    const pct = clampPercent(el.dataset.soundVolume);
    if (pct !== null) el.style.setProperty('--sound-volume', `${pct}%`);
  });

  all('[data-swatch]').forEach((el) => {
    const hex = el.dataset.swatch || '';
    if (HEX_COLOR.test(hex)) el.style.setProperty('--swatch', hex);
  });

  all('[data-progress]').forEach((el) => {
    const pct = clampPercent(el.dataset.progress);
    if (pct !== null) el.style.width = `${pct}%`;
  });

  all('[data-aspect]').forEach((el) => {
    const ratio = String(el.dataset.aspect || '').trim();
    if (/^\d+(\.\d+)?(\s*\/\s*\d+(\.\d+)?)?$/.test(ratio)) el.style.aspectRatio = ratio;
  });
}

/**
 * Applies data-driven values to every element the app inserts later, so
 * call sites that build markup with innerHTML / insertAdjacentHTML need no
 * manual hook. Installed once at boot (js/core/app.js).
 */
let observerInstalled = false;
export function installDynamicVarsObserver() {
  if (observerInstalled || typeof MutationObserver === 'undefined') return;
  const start = () => {
    if (observerInstalled || !document.body) return;
    observerInstalled = true;
    new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node.nodeType === 1) applyDynamicVars(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    applyDynamicVars(document.body);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
