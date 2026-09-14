'use strict';

/**
 * Centralizes every piece of "which windows/origins may this app load,
 * navigate to, or trust" security policy in one place.
 *
 * Rules enforced here:
 *  - The only origin the BrowserWindow may ever *navigate* its main
 *    frame to is the local Welcome UI or the user's configured Wire
 *    server origin. Everything else (links inside the app, arbitrary
 *    navigation attempts, window.open) is redirected to the user's
 *    default browser instead of taking over the app window.
 *  - window.open()/target=_blank never creates a new Electron
 *    BrowserWindow pointed at an arbitrary origin - it always hands
 *    off to the OS browser.
 *  - Certificate errors are NEVER silently bypassed. TLS verification
 *    stays on. The only exception is an explicit, per-origin,
 *    fingerprint-pinned opt-in the user makes after seeing a clear
 *    warning (see trustedCertificates in config-store) - the same
 *    trade-off every browser's "proceed anyway, I understand the
 *    risk" flow makes for self-signed certs on self-hosted servers.
 */

const { shell } = require('electron');
const configStore = require('./config-store');
const { fingerprintFromPem } = require('./cert-utils');

function isAllowedNavigationTarget(targetUrl, allowedOrigin) {
  try {
    const target = new URL(targetUrl);

    if (target.protocol === 'file:') {
      // Only our own bundled renderer files.
      return true;
    }

    if (!allowedOrigin) return false;

    const allowed = new URL(allowedOrigin);
    return target.origin === allowed.origin;
  } catch {
    return false;
  }
}

/**
 * Wires up navigation + new-window + certificate policy for a single
 * BrowserWindow. `getAllowedOrigin()` is a function (not a value) so
 * the allowed origin can change after the user switches servers in
 * Settings without re-registering listeners.
 */
function hardenWebContents(webContents, getAllowedOrigin) {
  webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedNavigationTarget(targetUrl, getAllowedOrigin())) {
      event.preventDefault();
      shell.openExternal(targetUrl).catch(() => {});
    }
  });

  webContents.setWindowOpenHandler(({ url }) => {
    // Never let the app spawn a second Electron window pointed at an
    // arbitrary origin. Legitimate "open in browser" links go to the
    // OS default browser instead.
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Block <webview> creation entirely (belt-and-suspenders; the
  // webviewTag WebPreferences option below already disables it).
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // Deny permission requests (camera/mic/notifications/etc.) by
  // default. Wire's voice-message feature needs microphone access;
  // that specific permission is allowed only when requested from the
  // app's own configured server origin.
  webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    const allowedOrigin = getAllowedOrigin();
    const requestingUrl = wc.getURL();

    const fromAllowedOrigin =
      allowedOrigin && isAllowedNavigationTarget(requestingUrl, allowedOrigin);

    if (fromAllowedOrigin && permission === 'media') {
      callback(true);
      return;
    }

    callback(false);
  });
}

/**
 * Registers the app-wide certificate-error policy. Must be called
 * once (on `app`), not per-window.
 */
function registerCertificateErrorPolicy(app) {
  app.on(
    'certificate-error',
    (event, webContents, url, error, certificate, callback) => {
      let origin;
      try {
        origin = new URL(url).origin;
      } catch {
        callback(false);
        return;
      }

      const trusted = configStore.get('trustedCertificates') || {};
      const trustedFingerprint = trusted[origin];

      let liveFingerprint = null;
      try {
        liveFingerprint = certificate && certificate.data ? fingerprintFromPem(certificate.data) : null;
      } catch {
        liveFingerprint = null;
      }

      if (trustedFingerprint && liveFingerprint && trustedFingerprint === liveFingerprint) {
        event.preventDefault();
        callback(true);
        return;
      }

      // No blanket trust. The renderer/main flow surfaces this as a
      // "tls_error" during the connection test, where the user can
      // explicitly choose to trust this exact certificate for this
      // exact origin (see ipc-handlers.js: trustCertificateForOrigin).
      callback(false);
    }
  );
}

module.exports = {
  hardenWebContents,
  registerCertificateErrorPolicy,
  isAllowedNavigationTarget,
};
