// ============================================================
// Sidebar resize (drag handle between .sidebar and .main)
// Mirrors the storage/apply pattern used in settings/theme.js
// (safeGetStorage/safeSetStorage + a "wire-*" localStorage key).
// ============================================================

const STORAGE_KEY = 'wire-sidebar-width';

// Matches --sidebar-width's default in tokens.css.
const DEFAULT_WIDTH = 224;

const MIN_WIDTH = 180;
const MAX_WIDTH = 420;

// Sidebar becomes a fixed overlay drawer below this width (see
// responsive.css) — resizing doesn't make sense there.
const MOBILE_BREAKPOINT = 900;

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

function clamp(width) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

function applyWidth(width) {
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
}

function getStoredWidth() {
  const raw = Number(safeGetStorage(STORAGE_KEY));
  return Number.isFinite(raw) && raw > 0 ? clamp(raw) : DEFAULT_WIDTH;
}

export function initSidebarResize() {
  // Restore the saved width immediately (before the rest of bootstrap
  // runs) so there's no visible flash of the default width.
  applyWidth(getStoredWidth());

  const handle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.getElementById('sidebar');

  if (!handle || !sidebar) return;

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  function onPointerMove(e) {
    if (!dragging) return;
    applyWidth(clamp(startWidth + (e.clientX - startX)));
  }

  function stopDragging(e) {
    if (!dragging) return;
    dragging = false;

    handle.classList.remove('active');
    document.body.classList.remove('sidebar-resizing');

    if (e && handle.releasePointerCapture && e.pointerId !== undefined) {
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer may already be released.
      }
    }

    const finalWidth = clamp(Math.round(sidebar.getBoundingClientRect().width));
    safeSetStorage(STORAGE_KEY, String(finalWidth));

    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDragging);
    window.removeEventListener('pointercancel', stopDragging);
  }

  handle.addEventListener('pointerdown', (e) => {
    // Left mouse button / primary touch point only.
    if (e.button !== 0) return;
    // Sidebar is an overlay drawer on mobile — nothing to resize there.
    if (window.innerWidth <= MOBILE_BREAKPOINT) return;

    dragging = true;
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;

    handle.classList.add('active');
    document.body.classList.add('sidebar-resizing');

    if (handle.setPointerCapture) {
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // Ignore — pointermove/pointerup listeners on window still work.
      }
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);

    e.preventDefault();
  });

  // Double-click restores the default width.
  handle.addEventListener('dblclick', () => {
    applyWidth(DEFAULT_WIDTH);
    safeSetStorage(STORAGE_KEY, String(DEFAULT_WIDTH));
  });
}
