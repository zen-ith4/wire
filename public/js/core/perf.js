// ============================================================
// Opt-in navigation timing.
//
// Off by default and inert (every export is a no-op). To measure on any
// device, including the Capacitor app via chrome://inspect:
//
//   localStorage.setItem('wire_perf', '1')   then reload
//
// Each tab switch then logs one line:
//   [perf] files  click→content 412ms | spinner 380ms | api 3 calls, 2 in series
// and adds performance.mark/measure entries ("wire:nav:<view>") that show
// up in the DevTools Performance timeline.
//
//   click→content  tab click until no loading state is left in #content-area
//   spinner        how long a loading state was actually on screen
//   api            requests made through api() during the navigation
// ============================================================

let enabled = false;

try {
  enabled = localStorage.getItem('wire_perf') === '1';
} catch {
  enabled = false;
}

const NOOP = () => {};

let nav = null;
let observer = null;

function finish(reason) {
  if (!nav) return;

  const n = nav;
  nav = null;

  const end = performance.now();
  const spinnerMs = n.spinnerAt === null ? 0 : (n.spinnerGone ?? end) - n.spinnerAt;

  // Requests that had to finish before the end are "in series" if they did not overlap.
  const done = n.requests.filter((r) => r.end !== null).sort((a, b) => a.start - b.start);
  let series = 0;
  let cursor = -Infinity;
  for (const r of done) {
    if (r.start >= cursor) series++;
    cursor = Math.max(cursor, r.end);
  }

  try {
    performance.measure(`wire:nav:${n.view}`, { start: n.t0, end });
  } catch {
    /* older engines */
  }

  console.info(
    `[perf] ${n.view.padEnd(9)} click→content ${Math.round(end - n.t0)}ms` +
    ` | spinner ${Math.round(spinnerMs)}ms` +
    ` | api ${n.requests.length} calls, ${series} in series` +
    (reason === 'timeout' ? ' | (gave up waiting)' : '')
  );
}

function check() {
  if (!nav) return;

  const content = document.getElementById('content-area');
  const spinning = !!content && !!content.querySelector('.loading-state');
  const now = performance.now();

  if (spinning && nav.spinnerAt === null) nav.spinnerAt = now;
  if (!spinning && nav.spinnerAt !== null && nav.spinnerGone === null) nav.spinnerGone = now;

  if (!spinning) {
    // Content is in place; report after it has actually been painted.
    const n = nav;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (nav === n) finish('ready');
    }));
  }
}

export const perfNavStart = enabled
  ? (view) => {
      const content = document.getElementById('content-area');
      if (!content) return;

      if (nav) finish('superseded');
      nav = { view, t0: performance.now(), spinnerAt: null, spinnerGone: null, requests: [] };

      if (!observer) {
        observer = new MutationObserver(check);
        observer.observe(content, { childList: true, subtree: true });
      }

      setTimeout(() => nav && nav.view === view && finish('timeout'), 15000);
      // navigate() renders synchronously after this call; look once it has.
      queueMicrotask(check);
      setTimeout(check, 0);
    }
  : NOOP;

/** Returns a function to call when the request settles. */
export const perfApi = enabled
  ? () => {
      if (!nav) return NOOP;
      const rec = { start: performance.now(), end: null };
      nav.requests.push(rec);
      return () => { rec.end = performance.now(); };
    }
  : () => NOOP;
