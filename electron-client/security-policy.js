'use strict';

/**
 * Pure security decision logic for the Electron main process.
 *
 * This module has NO Electron imports: it is pure JavaScript that can be
 * unit-tested in plain Node without launching Electron. main.js imports it
 * and applies its decisions to BrowserWindow events, net.request calls,
 * IPC handlers, and permission handlers.
 *
 * Rules (Phase 2, server-loaded UI; no custom protocol / bundling):
 *
 * 1. HTTPS-only for packaged builds. `http:` is allowed only when
 *    `isPackaged === false` AND the host is localhost/127.0.0.1/[::1].
 *    No setting or env override can relax this.
 * 2. `url.origin` is never compared directly: for `file:` URLs origin is
 *    opaque; for `wire-bundled://` (future) it is "null". Use
 *    `originKey()` = `protocol + '//' + host`.
 * 3. The connect screen is matched by exact file path (via
 *    `pathToFileURL(path).pathname`), not by origin — `file://` collapses
 *    every local file to the same opaque origin.
 * 4. net.request redirects: `redirect: 'manual'`; follow only if the
 *    `redirectUrl` is the same origin as the configured server AND passes
 *    the HTTPS rule; otherwise abort.
 */

const { pathToFileURL } = require('node:url');

/**
 * Returns true if the URL uses a scheme allowed by the openExternal
 * allowlist: only http: and https: may be handed to the OS.
 */
function isAllowedExternalScheme(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalized origin key: `protocol + '//' + host`. Never use URL.origin
 * directly — it is opaque for file: and "null" for wire-bundled://.
 */
function originKey(url) {
  const u = new URL(url);
  return u.protocol + '//' + u.host;
}

/**
 * Whether a scheme/host is permitted under the HTTPS rule.
 *
 * Packaged: only https: (wss: for sockets — handled by callers that inspect
 * the scheme separately). Unpackaged: http:/ws: only on loopback hosts.
 */
function isAllowedAddress(u, isPackaged) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return false;
  }
  if (u.protocol === 'http:') {
    if (isPackaged) return false;
    // Hostname may include brackets for IPv6 ([::1]); strip them for compare.
    const host = u.hostname.replace(/[\[\]]/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }
  return true; // https: always allowed
}

/**
 * Parse and validate a server address against the HTTPS rule. Returns the
 * normalized origin string or throws with a user-friendly message.
 *
 * A bare address without a scheme now defaults to https:// (not http://),
 * so packaged builds accept it by default. Explicit loopback http:// still
 * works in unpackaged builds.
 */
function normalizeServerAddress(rawInput, isPackaged) {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new Error('Please enter a server address.');
  }

  let input = rawInput.trim();
  if (!input) {
    throw new Error('Please enter a server address.');
  }

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    input = 'https://' + input; // Default to https://
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(
      "That doesn't look like a valid address. Try formats like https://example.com or 192.168.1.100:3000"
    );
  }

  if (!isAllowedAddress(parsed, isPackaged)) {
    if (isPackaged) {
      throw new Error(
        'Packaged builds only support https:// servers. Use https:// or contact your server operator.'
      );
    }
    throw new Error(
      'Plain http:// is only allowed for localhost, 127.0.0.1 or [::1] in unpackaged builds.'
    );
  }

  if (!parsed.hostname) {
    throw new Error('Please include a host or IP address.');
  }

  return parsed.origin;
}

/**
 * Build net.request options with redirect: 'manual'. The caller handles the
 * 'redirect' event using onRedirect() below.
 */
function buildRequestOptions(serverUrl, path) {
  const url =
    serverUrl.endsWith('/') && path.startsWith('/')
      ? serverUrl.slice(0, -1) + path
      : serverUrl + path;
  return { method: 'GET', url, redirect: 'manual' };
}

/**
 * Handle a net.request 'redirect' event.
 *
 * Electron 45 passes (statusCode, method, redirectUrl, responseHeaders) to
 * the 'redirect' handler. The request object exposes followRedirect() and
 * abort() synchronously.
 *
 * Follows the redirect synchronously only when redirectUrl is the same
 * origin as allowedOrigin AND passes the HTTPS rule; otherwise aborts.
 *
 * Returns an object { follow: boolean, reason?: string }.
 */
function onRedirect(redirectUrl, allowedOrigin, isPackaged) {
  try {
    const target = new URL(redirectUrl);
    if (target.origin !== allowedOrigin) {
      return { follow: false, reason: 'redirects to a different origin' };
    }
    if (!isAllowedAddress(target, isPackaged)) {
      return { follow: false, reason: 'redirect target violates the HTTPS rule' };
    }
    return { follow: true, reason: null };
  } catch {
    return { follow: false, reason: 'invalid redirect URL' };
  }
}

/**
 * Connect screen pathname, computed once. loadFile(path, { query }) appends
 * ?auto=1 etc., so only the pathname is compared — the query/hash are ignored.
 */
function connectScreenPathname(connectScreenPath) {
  return pathToFileURL(connectScreenPath).pathname;
}

/**
 * Whether a navigation target is the connect screen: exact file: pathname,
 * any query/hash allowed.
 */
function isConnectScreenUrl(targetUrl, connectScreenPathname) {
  try {
    const u = new URL(targetUrl);
    return u.protocol === 'file:' && u.pathname === connectScreenPathname;
  } catch {
    return false;
  }
}

/**
 * Whether an IPC sender frame is trusted.
 *
 * Phase 2: allowedOrigins = [originKey(currentServerOrigin)] plus the
 * connect screen matched by exact file path (isConnectScreenSender).
 * Phase 4: allowedOrigins = ['wire-bundled://app'] only.
 *
 * WebFrameMain has no "protocol" property; protocol is derived from f.url.
 */
function senderIsTrusted(event, allowedOrigins, connectScreenPathname) {
  const f = event.senderFrame;
  if (!f || f !== event.sender.mainFrame) return false; // top frame only

  // Connect screen: exact file path, never originKey (file:// collapses
  // every local file to the same opaque origin). Derive protocol from f.url
  // since WebFrameMain has no .protocol property.
  if (connectScreenPathname) {
    try {
      const url = new URL(f.url);
      if (url.protocol === 'file:' && url.pathname === connectScreenPathname) {
        return true;
      }
    } catch {
      return false;
    }
  }

  try {
    return allowedOrigins.includes(originKey(f.url));
  } catch {
    return false;
  }
}

/**
 * Whether a permission request should be allowed.
 *
 * Phase 2:
 * - media: allow only `audio` (microphone), only when the requesting
 *   frame's origin equals the current server origin (top frame only).
 * - clipboard write (Electron reports it as `clipboard-read`) and fullscreen:
 *   allow narrowly for current server origin main frame.
 * - camera, screen sharing (display-capture), notifications in the
 *   renderer, and everything else: denied.
 */
function isPermissionAllowed(permission, details, currentServerOrigin) {
  // Main frame only: a cross-origin iframe embedded by the server must never
  // inherit the app's microphone/clipboard/fullscreen grants.
  if (!details || details.isMainFrame === false) return false;

  const requestingUrl =
    details && details.requestingUrl ? details.requestingUrl : null;
  if (!requestingUrl) return false;

  let origin;
  try {
    origin = originKey(requestingUrl);
  } catch {
    return false;
  }

  if (origin !== currentServerOrigin) return false;

  if (permission === 'media') {
    const mediaTypes = details.mediaTypes || [];
    return mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio');
  }

  // Clipboard write and fullscreen: allowed narrowly for the current server
  // origin main frame.
  //
  // Electron 45 (Chromium 130) reports `navigator.clipboard.writeText()` — the
  // only clipboard call the web UI makes — as the `clipboard-read` permission
  // (Chromium's CLIPBOARD_READ_WRITE type), verified by E2E. Denying it breaks
  // the app's copy buttons, so it is granted together with the older
  // `clipboard-write` and Chromium's `clipboard-sanitized-write` names. The
  // grant is origin- and main-frame-scoped like the rest of the list.
  // `fullscreen` has an `automatic-fullscreen` variant (fullscreen without a
  // user gesture, used by media elements); it is the same capability.
  if (
    permission === 'clipboard-write' ||
    permission === 'clipboard-sanitized-write' ||
    permission === 'clipboard-read' ||
    permission === 'fullscreen' ||
    permission === 'automatic-fullscreen'
  ) {
    return true;
  }

  return false;
}

/**
 * Linux safeStorage backends that do not protect data with an OS keyring.
 *
 * `basic_text` means Chromium's public hardcoded password; `unknown` means
 * Electron could not determine the backend. For remember-me both are
 * equivalent to "no OS-level secure storage" and must be refused.
 */
function isUnprotectedStorageBackend(platform, backend) {
  return (
    platform === 'linux' &&
    (backend === 'basic_text' || backend === 'unknown')
  );
}

/**
 * Chromium's Linux "v10" ciphertext prefix marks AES-128-CBC data encrypted
 * with the public hardcoded password ("peanuts"), not a keyring-held key.
 * Such data is readable by anyone and must never be persisted for remember-me.
 */
function hasV10Prefix(ciphertext) {
  if (!ciphertext || typeof ciphertext.length !== 'number') return false;
  const bytes = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  return bytes.length >= 3 && bytes.subarray(0, 3).toString('latin1') === 'v10';
}

/**
 * Remove unprotected (v10) records from a parsed unlock-key store.
 * Mutates the object and returns the number of records removed.
 */
function pruneUnprotectedRecords(store) {
  if (!store || typeof store !== 'object') return 0;
  let removed = 0;
  for (const key of Object.keys(store)) {
    let bytes;
    try {
      bytes = Buffer.from(String(store[key]), 'base64');
    } catch {
      continue;
    }
    if (hasV10Prefix(bytes)) {
      delete store[key];
      removed++;
    }
  }
  return removed;
}

module.exports = {
  isAllowedExternalScheme,
  originKey,
  isAllowedAddress,
  normalizeServerAddress,
  buildRequestOptions,
  onRedirect,
  connectScreenPathname,
  isConnectScreenUrl,
  senderIsTrusted,
  isPermissionAllowed,
  isUnprotectedStorageBackend,
  hasV10Prefix,
  pruneUnprotectedRecords,
};
