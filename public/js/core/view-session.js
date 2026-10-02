// ============================================================
// View ownership for #content-area.
//
// #content-area is ONE persistent node that every route refills
// (see core/router.js). Every view renderer is async: it paints a
// loading state, awaits the network, then writes the result into that
// same node. Without a rule about who is allowed to write, a slow
// response for view A lands *after* the user has already switched to
// view B and silently replaces B's content with A's — while the nav
// highlight, title and URL all say B. The tap looks "ignored".
//
// The rule enforced here: a render may only write to #content-area
// while it is still the newest render of the view the router has
// mounted. Renderers take a claim when they start and check it after
// every await, right before they touch the DOM:
//
//   const isCurrent = claimRender('files');
//   if (!isCurrent()) return;            // never started / superseded
//   ...
//   const data = await api(...);
//   if (!isCurrent()) return;            // user moved on while we waited
//   main.innerHTML = ...;
//
// A claim stops being current when
//   - the router mounts a different view (enterView), or
//   - a newer render of the same view starts (re-click, folder change,
//     post-action refresh) — latest wins, an older slower response can
//     never overwrite a newer one, or
//   - it was taken while a different view was mounted (a delayed
//     "refresh after save/upload" that fires after the user left) —
//     it is stale from the start.
// ============================================================

let mountedView = null;
let nextClaimId = 0;
const latestClaim = new Map();

/** Router only: `name` is now the view that owns #content-area. */
export function enterView(name) {
  mountedView = name;
}

/**
 * Take a claim for a render of view `name`. Call synchronously at the
 * top of the renderer. Returns `isCurrent()` — true only while this
 * render is still allowed to write to #content-area.
 */
export function claimRender(name) {
  const id = ++nextClaimId;
  latestClaim.set(name, id);
  return () => mountedView === name && latestClaim.get(name) === id;
}

/**
 * True while the user has text typed into a focused field inside
 * `container`. Views that repaint themselves from a background refresh
 * (stale-while-revalidate) use this to avoid wiping what is being typed.
 */
export function isUserTypingIn(container) {
  const a = document.activeElement;

  return !!(
    a &&
    container &&
    container.contains(a) &&
    (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') &&
    a.value
  );
}
