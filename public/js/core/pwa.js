// ============================================================
// Service Worker registration (browser / installed-PWA only).
//
// - Skipped in the native app: Capacitor already ships the frontend inside
//   the app, so a second cache would only duplicate it.
// - Skipped anywhere a worker cannot run (file://, insecure http, ...).
// - Registered after the page has loaded and gone idle, so installing the
//   cache never competes with the app's own start-up requests.
// - Updates are picked up on the next launch. When a new version has been
//   installed it is activated the next time the page is hidden; the running
//   page is never reloaded (a reload would force the E2EE unlock again).
// ============================================================

import { isNativeApp } from './server.js';

const UPDATE_CHECK_MS = 60 * 60 * 1000;

function whenIdle(fn) {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(fn, { timeout: 5000 });
  } else {
    setTimeout(fn, 2000);
  }
}

function activateWhenHidden(worker) {
  const activate = () => worker.postMessage({ type: 'SKIP_WAITING' });

  if (document.visibilityState === 'hidden') {
    activate();
    return;
  }

  const onChange = () => {
    if (document.visibilityState === 'hidden') {
      document.removeEventListener('visibilitychange', onChange);
      activate();
    }
  };
  document.addEventListener('visibilitychange', onChange);
}

function watchForUpdates(registration) {
  // Only a *replacement* needs the hand-off; the very first install has no
  // controller yet and simply becomes active.
  const handle = (worker) => {
    if (worker && navigator.serviceWorker.controller) activateWhenHidden(worker);
  };

  if (registration.waiting) handle(registration.waiting);

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') handle(installing);
    });
  });

  // Long-lived tabs/PWAs: look for a new version when the app comes back to
  // the foreground, at most once an hour.
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      Date.now() - lastCheck > UPDATE_CHECK_MS
    ) {
      lastCheck = Date.now();
      registration.update().catch(() => {});
    }
  });
}

export function registerServiceWorker() {
  if (
    !('serviceWorker' in navigator) ||
    !window.isSecureContext ||
    !/^https?:$/.test(location.protocol) ||
    isNativeApp()
  ) {
    return;
  }

  const start = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(watchForUpdates)
      .catch((e) => console.warn('[SW] Registration failed:', e));
  };

  if (document.readyState === 'complete') {
    whenIdle(start);
  } else {
    window.addEventListener('load', () => whenIdle(start), { once: true });
  }
}
