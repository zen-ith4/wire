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
// - The page reloads once after the new worker takes control, so the user
//   automatically starts using the new application shell.
// ============================================================

import { isNativeApp } from './server.js';

const UPDATE_CHECK_MS = 60 * 60 * 1000;

let reloadAfterUpdate = false;
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
   * controllerchange is emitted when a newly activated worker takes control
   * of the current page.
   *
   * The first SW installation normally has no previous controller, so there
   * is nothing to reload for. We only reload after we explicitly know that
   * this is a replacement.
   */
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadAfterUpdate || swReloading) {
      return;
    }

    swReloading = true;
    window.location.reload();
  });
}

function watchForUpdates(registration) {
  /*
   * Only a replacement needs a hand-off.
   *
   * The first installation has no existing controller and therefore should
   * not reload the page.
   */
  const handle = (worker) => {
    if (!worker || !navigator.serviceWorker.controller) {
      return;
    }

    /*
     * The SW itself now calls skipWaiting() after the entire shell has
     * installed successfully, so we no longer need to wait for the page
     * to become hidden.
     *
     * Mark this as a replacement before the controller changes.
     */
    reloadAfterUpdate = true;
  };

  if (registration.waiting) {
    handle(registration.waiting);
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;

    if (!installing) {
      return;
    }

    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') {
        handle(installing);
      }
    });
  });

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
   * Listen before registration so we cannot miss a controllerchange caused
   * by a fast installation/activation.
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
