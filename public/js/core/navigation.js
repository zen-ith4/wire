// ============================================================
// In-route navigation context — DM conversation selection and
// overlay screens (image viewer, files viewer, preview, profile
// card).
//
// Router-level history (files / chat / messages / settings / admin /
// share-link) continues to live entirely in core/router.js's own
// navigationStack, unchanged. That stack answers "which top-level
// screen was I on before this one" and "should Android Back exit the
// app". This module answers the finer-grained question underneath
// it: "what did I open *within* the current screen, and in what
// order, so Back can unwind it one step at a time".
//
// This module is intentionally dependency-free (no imports of
// router.js or any UI module) so it can be imported from anywhere
// (router.js, dm.js, image-viewer.js, files/viewer.js, preview.js,
// profile-card.js) without creating import cycles. Callers hand it
// plain functions to call back into (close/restore), rather than this
// module reaching into their modules itself.
//
// Two kinds of entry:
//
//   { type: 'overlay', key, close() }
//     A modal-like screen stacked on top of whatever is behind it
//     (image viewer, files viewer, preview, profile card, the "New
//     message" picker). Back always just closes it — the screen
//     behind it was never hidden, so there's nothing to restore.
//
//   { type: 'dm', key: 'messages', params: { id, username },
//     restore(params), deactivate() }
//     A conversation selected within the Messages route. Back pops it
//     and either restores the conversation now on top (switching back
//     to it) or, if none is left, deactivates (returns to the bare
//     conversation list).
//
// Both kinds sit in one LIFO stack so they interleave correctly, e.g.
// DM Alice -> Image Viewer -> Back closes only the image viewer and
// reveals DM Alice untouched.
// ============================================================

let stack = [];

function describe(entry) {
  return entry
    ? { type: entry.type, key: entry.key, params: entry.params }
    : null;
}

function log(action, detail) {
  console.log(`[nav] ${action}`, detail);
}

// ---------------------------------------------------------------
// Generic stack primitives
// ---------------------------------------------------------------

export function pushEntry(entry) {
  stack.push(entry);
  log('PUSH', describe(entry));
  return entry;
}

export function popEntry() {
  const entry = stack.pop();
  log('POP', describe(entry));
  return entry;
}

export function peekEntry() {
  return stack.length ? stack[stack.length - 1] : null;
}

export function hasContext() {
  return stack.length > 0;
}

// Drops everything, closing any overlays on the way out so their own
// modals don't linger. Called by router.js right before it renders a
// genuinely different top-level screen — any DM selection or overlay
// belonging to the *previous* screen is no longer meaningful.
export function resetContext(reason) {
  if (!stack.length) return;

  const dropped = stack;
  stack = [];

  for (const entry of dropped) {
    if (entry.type === 'overlay') {
      try {
        entry.close?.();
      } catch (err) {
        console.error('[nav] overlay close failed during reset:', err);
      }
    }
  }

  log('CLEAR', reason || '');
}

// ---------------------------------------------------------------
// Overlay helpers
// ---------------------------------------------------------------

// Registers an overlay as open. A second push for the same key while
// one is already tracked is a no-op — opening an already-open overlay
// (e.g. clicking another image while the lightbox is up) updates its
// content in place, it doesn't stack a second history entry.
export function pushOverlay(key, close) {
  if (stack.some((e) => e.type === 'overlay' && e.key === key)) {
    return;
  }

  pushEntry({ type: 'overlay', key, close });
}

// Removes a tracked overlay, wherever it sits in the stack. Every
// overlay's own close() path (X button, backdrop click, Escape, or
// Android Back) calls this so the stack can never go stale — closing
// an overlay any way other than Back still keeps history in sync.
export function closeOverlay(key) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].type === 'overlay' && stack[i].key === key) {
      const [removed] = stack.splice(i, 1);
      log('REMOVE', describe(removed));
      return removed;
    }
  }

  return null;
}

// ---------------------------------------------------------------
// Android Back
// ---------------------------------------------------------------

// Called by router.js's single Android Back listener before it looks
// at its own route-level stack. Returns true if it handled the press
// (closed an overlay or restored/deactivated a context entry) — the
// caller stops there. Returns false when there is nothing here to
// unwind, so the caller should fall through to route-level history.
export function handleBack() {
  const top = peekEntry();

  if (!top) {
    return false;
  }

  if (top.type === 'overlay') {
    log('BACK -> close overlay', describe(top));

    try {
      top.close?.();
    } catch (err) {
      console.error('[nav] overlay close failed:', err);
    }

    // Overlays are expected to self-remove via closeOverlay() as part
    // of their own close() path. This is a safety net in case one
    // doesn't, so the stack can never get stuck on a dead entry.
    if (peekEntry() === top) {
      popEntry();
    }

    return true;
  }

  // Any non-overlay context entry (currently just 'dm'): pop it, then
  // either restore whatever the same kind of entry is now on top, or
  // deactivate — there is nothing left of that kind underneath.
  const popped = popEntry();
  const next = peekEntry();

  if (next && next.type === popped.type) {
    log('RESTORE', describe(next));

    try {
      next.restore?.(next.params);
    } catch (err) {
      console.error('[nav] restore failed:', err);
    }
  } else {
    log('BACK -> deactivate', describe(popped));

    try {
      popped.deactivate?.();
    } catch (err) {
      console.error('[nav] deactivate failed:', err);
    }
  }

  return true;
}

// ---------------------------------------------------------------
// Debug helper — same convention as window.__wireNavigationStack in
// router.js.
// ---------------------------------------------------------------

window.__wireNavContext = function () {
  return stack.map(describe);
};
