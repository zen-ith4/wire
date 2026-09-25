// ============================================================
// Service Worker registration (browser / installed-PWA only).
//
// - Skipped in the native app: Capacitor already ships the frontend inside
//   the app, so a second cache would only duplicate it.
// - Skipped anywhere a worker cannot run (file://, insecure http, ...).
// - Registered after the page has loaded and gone idle, so installing the
//   cache never competes with the app's own start-up requests.
// - A newly installed worker is activated immediately after its shell has
//   been fully verified and precached.
// - The page reloads once after a replacement worker takes control, so the
//   user automatically starts using the new application shell.
// - The first-ever SW installation never reloads the page.
// ============================================================

import { isNativeApp } from './server.js';

const UPDATE_CHECK_MS = 60 * 60 * 1000;

let hasExistingController = false;
let swReloading = false;

function whenIdle(fn) {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(fn, { timeout: 5000 });
  } else {
    setTimeout(fn, 2000);
  }
}

function watchForControllerChange() {
  /*
   * Capture this BEFORE registration.
   *
   * First-ever installation:
   *   controller === null
   *
   * Existing application already controlled by a SW:
   *   controller !== null
   *
   * Only the second case should trigger an automatic reload.
   */
  hasExistingController = Boolean(
    navigator.serviceWorker.controller
  );

  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => {
      /*
       * First installation must not reload the current page.
       *
       * Replacement installation must reload exactly once.
       */
      if (!hasExistingController || swReloading) {
        return;
      }

      swReloading = true;

      window.location.reload();
    }
  );
}

function watchForUpdates(registration) {
  /*
   * The SW itself handles:
   *
   *   precache()
   *       ↓
   *   skipWaiting()
   *       ↓
   *   activate
   *       ↓
   *   clients.claim()
   *
   * We only need to monitor registration.update() for long-lived pages.
   *
   * controllerchange above handles the actual hand-off and reload.
   */

  /*
   * Long-lived tabs/PWAs: look for a new version when the app comes back to
   * the foreground, at most once an hour.
   */
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

  /*
   * Register the controllerchange listener before registration so a fast
   * install/activation cannot be missed.
   */
  watchForControllerChange();

  const start = () => {
    navigator.serviceWorker
      .register('/sw.js', {
        scope: '/',
        updateViaCache: 'none'
      })
      .then(watchForUpdates)
      .catch((e) => {
        console.warn('[SW] Registration failed:', e);
      });
  };

  if (document.readyState === 'complete') {
    whenIdle(start);
  } else {
    window.addEventListener(
      'load',
      () => whenIdle(start),
      { once: true }
    );
  }
}