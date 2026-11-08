// ============================================================
// Delegated action registry: the CSP-safe replacement for inline
// onclick="" attributes (script-src 'self' blocks those under
// CSP_ENFORCE=true).
//
// Markup carries a name, not code:
//   <button data-action="image-viewer-close">
// and the owning module says what that name does:
//   registerActions({ 'image-viewer-close': (el, e) => closeImageViewer() });
//
// One click listener on document dispatches every such element, so it
// also covers markup re-rendered later with innerHTML. Parameters travel
// as data-* attributes (data-user-id="5") and the handler parses them.
//
// Only the nearest [data-action] is looked at. Names this registry does
// not know are ignored silently, because other modules already run their
// own delegated listeners on data-action values (reactions, thread, group,
// confirm).
// ============================================================

const handlers = new Map();

export function registerActions(map) {
  for (const [name, fn] of Object.entries(map)) handlers.set(name, fn);
}

// Capture phase on purpose: this runs before any bubble-phase listener, so
// an element that calls stopPropagation() (the viewer bar, the image, the
// profile card content) still dispatches its actions, while keeping its
// clicks away from the document-level listeners in other modules.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = handlers.get(el.dataset.action);
    if (fn) fn(el, e);
  }, true);
}
