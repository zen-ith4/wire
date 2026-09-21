// ============================================================
// Sidebar resize
//
// The sidebar can be resized freely while expanded.
//
// Magnetic collapse:
//   - Expanded sidebar can be resized freely.
//   - Once it reaches COLLAPSE_THRESHOLD, it snaps to
//     COLLAPSED_WIDTH.
//   - While collapsed, it stays at COLLAPSED_WIDTH until the
//     collapse/expand cooldown has passed and the user drags
//     back above the collapse threshold.
//
// Cooldown:
//   - Prevents rapid expanded <-> collapsed state changes while
//     the pointer is moving around the threshold.
//   - The cooldown applies only to STATE CHANGES, not normal
//     sidebar resizing.
//
// The collapsed state is represented by the `sidebar-collapsed`
// class on <html>. CSS handles the icon-only presentation.
// ============================================================

const STORAGE_KEY = 'wire-sidebar-width';

// Matches --sidebar-width's default in tokens.css.
const DEFAULT_WIDTH = 224;

// Physical width limits for the sidebar.
const MIN_WIDTH = 64;
const MAX_WIDTH = 420;

// When an expanded sidebar reaches this width or below,
// it magnetically snaps into icon-only mode.
//
// This is intentionally large enough to prevent labels such as
// "Shared Folders" from being left partially visible.
const COLLAPSE_THRESHOLD = 170;

// Final width of icon-only mode.
const COLLAPSED_WIDTH = 64;

// Minimum time between collapse/expand state changes.
//
// This does NOT throttle normal resizing.
// It only prevents the sidebar from repeatedly switching
// between expanded and collapsed states around the threshold.
const COLLAPSE_COOLDOWN = 500;

// The sidebar is hidden on mobile and replaced by the mobile
// navigation, so resizing it there does not make sense.
const MOBILE_BREAKPOINT = 900;


// ============================================================
// Safe localStorage helpers
// ============================================================

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
// Width helpers
// ============================================================

function clamp(width) {
  return Math.min(
    MAX_WIDTH,
    Math.max(MIN_WIDTH, width)
  );
}


// ============================================================
// Apply sidebar width + collapsed state
// ============================================================

function applyWidth(width) {
  const finalWidth = clamp(width);

  document.documentElement.style.setProperty(
    '--sidebar-width',
    `${finalWidth}px`
  );

  document.documentElement.classList.toggle(
    'sidebar-collapsed',
    finalWidth === COLLAPSED_WIDTH
  );
}


// ============================================================
// Restore saved width
// ============================================================

function getStoredWidth() {
  const raw = Number(
    safeGetStorage(STORAGE_KEY)
  );

  return Number.isFinite(raw) && raw > 0
    ? clamp(raw)
    : DEFAULT_WIDTH;
}


// ============================================================
// Initialization
// ============================================================

export function initSidebarResize() {
  // Restore the saved width immediately, before the rest of
  // bootstrap runs, so there is no visible flash of the default
  // width.
  applyWidth(getStoredWidth());

  const handle = document.getElementById(
    'sidebar-resize-handle'
  );

  const sidebar = document.getElementById(
    'sidebar'
  );

  if (!handle || !sidebar) return;

  let dragging = false;

  // Pointer position when the current drag started.
  let startX = 0;

  // Sidebar width when the current drag started.
  let startWidth = 0;

  // Current collapsed state for this drag session.
  let collapsed = false;

  // Timestamp of the last state transition.
  //
  // performance.now() is used instead of Date.now() because
  // it provides a monotonic timer suitable for elapsed-time
  // comparisons.
  let lastStateChangeAt = -Infinity;


  // ============================================================
  // State transition cooldown
  // ============================================================

  function canChangeState(now) {
    return (
      now - lastStateChangeAt >=
      COLLAPSE_COOLDOWN
    );
  }

  function markStateChange(now) {
    lastStateChangeAt = now;
  }


  // ============================================================
  // Pointer movement
  // ============================================================

  function onPointerMove(e) {
    if (!dragging) return;

    const deltaX = e.clientX - startX;

    const rawWidth =
      startWidth + deltaX;

    const now = performance.now();


    // ----------------------------------------------------------
    // EXPANDED -> COLLAPSED
    // ----------------------------------------------------------

    if (!collapsed) {
      // Normal resize while above the threshold.
      if (rawWidth > COLLAPSE_THRESHOLD) {
        applyWidth(clamp(rawWidth));
        return;
      }

      // We reached the collapse threshold.
      //
      // However, don't allow another state transition until the
      // cooldown has elapsed.
      if (!canChangeState(now)) {
        applyWidth(
          Math.max(
            COLLAPSE_THRESHOLD,
            clamp(rawWidth)
          )
        );

        return;
      }

      // Enter icon-only mode.
      collapsed = true;

      markStateChange(now);

      applyWidth(COLLAPSED_WIDTH);

      return;
    }


    // ----------------------------------------------------------
    // COLLAPSED -> EXPANDED
    // ----------------------------------------------------------

    // While collapsed, keep the sidebar locked to the icon-only
    // width during the cooldown period.
    if (!canChangeState(now)) {
      applyWidth(COLLAPSED_WIDTH);
      return;
    }

    // After the cooldown, moving back above the collapse
    // threshold releases the magnetic collapsed state.
    if (rawWidth > COLLAPSE_THRESHOLD) {
      collapsed = false;

      markStateChange(now);

      applyWidth(
        clamp(
          Math.max(
            COLLAPSE_THRESHOLD,
            rawWidth
          )
        )
      );

      return;
    }

    // Still inside the collapsed region.
    applyWidth(COLLAPSED_WIDTH);
  }


  // ============================================================
  // End drag
  // ============================================================

  function stopDragging(e) {
    if (!dragging) return;

    dragging = false;

    handle.classList.remove('active');

    document.body.classList.remove(
      'sidebar-resizing'
    );


    // ----------------------------------------------------------
    // Release pointer capture
    // ----------------------------------------------------------

    if (
      e &&
      handle.releasePointerCapture &&
      e.pointerId !== undefined
    ) {
      try {
        handle.releasePointerCapture(
          e.pointerId
        );
      } catch {
        // Pointer may already have been released.
      }
    }


    // ----------------------------------------------------------
    // Persist final width
    // ----------------------------------------------------------

    const finalWidth = collapsed
      ? COLLAPSED_WIDTH
      : clamp(
          Math.round(
            sidebar.getBoundingClientRect().width
          )
        );

    applyWidth(finalWidth);

    safeSetStorage(
      STORAGE_KEY,
      String(finalWidth)
    );


    // ----------------------------------------------------------
    // Remove temporary global listeners
    // ----------------------------------------------------------

    window.removeEventListener(
      'pointermove',
      onPointerMove
    );

    window.removeEventListener(
      'pointerup',
      stopDragging
    );

    window.removeEventListener(
      'pointercancel',
      stopDragging
    );
  }


  // ============================================================
  // Start drag
  // ============================================================

  handle.addEventListener(
    'pointerdown',
    (e) => {
      // Left mouse button / primary touch point only.
      if (e.button !== 0) return;

      // Sidebar is replaced by mobile navigation below this
      // breakpoint.
      if (
        window.innerWidth <=
        MOBILE_BREAKPOINT
      ) {
        return;
      }


      dragging = true;

      startX = e.clientX;

      startWidth =
        sidebar.getBoundingClientRect().width;

      // Restore the current state from the actual sidebar width.
      collapsed =
        startWidth <= COLLAPSED_WIDTH;


      // Start a fresh cooldown window for this drag session.
      //
      // This prevents an immediate state transition caused by
      // grabbing the handle again right after the previous
      // transition.
      lastStateChangeAt = performance.now();


      handle.classList.add('active');

      document.body.classList.add(
        'sidebar-resizing'
      );


      // --------------------------------------------------------
      // Pointer capture
      // --------------------------------------------------------

      if (handle.setPointerCapture) {
        try {
          handle.setPointerCapture(
            e.pointerId
          );
        } catch {
          // Window listeners still handle the drag.
        }
      }


      // --------------------------------------------------------
      // Global drag listeners
      // --------------------------------------------------------

      window.addEventListener(
        'pointermove',
        onPointerMove
      );

      window.addEventListener(
        'pointerup',
        stopDragging
      );

      window.addEventListener(
        'pointercancel',
        stopDragging
      );


      e.preventDefault();
    }
  );


  // ============================================================
  // Double-click = restore default expanded width
  // ============================================================

  handle.addEventListener(
    'dblclick',
    () => {
      collapsed = false;

      applyWidth(DEFAULT_WIDTH);

      safeSetStorage(
        STORAGE_KEY,
        String(DEFAULT_WIDTH)
      );

      // Reset the state-change timer so the next drag gets a
      // clean cooldown period.
      lastStateChangeAt =
        performance.now();
    }
  );
}