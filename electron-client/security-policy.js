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
    input = 'http://' + input;
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(
      "That doesn't look like a valid address. Try formats like 192.168.1.100:3000 or https://example.com"
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
 * Handle a net.request 'redirect' event. Follows the redirect synchronously
 * only when redirectUrl is the same origin as the configured server and
 * passes the HTTPS rule; otherwise aborts.
 *
 * Returns an object { follow: boolean, reason?: string }. main.js calls
 * event.followRedirect() or event.abort() synchronously inside the handler.
 */
function onRedirect(redirectUrl, currentServerOrigin, isPackaged) {
  try {
    const target = new URL(redirectUrl);
    if (target.origin !== currentServerOrigin) {
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
 */
function senderIsTrusted(event, allowedOrigins, connectScreenPathname) {
  const f = event.senderFrame;
  if (!f || f !== event.sender.mainFrame) return false; // top frame only

  // Connect screen: exact file path, never originKey (file:// collapses
  // every local file to the same opaque origin).
  if (connectScreenPathname && f.protocol === 'file:') {
    try {
      return new URL(f.url).pathname === connectScreenPathname;
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
 * Phase 2: allow only `media` with `audio` (microphone), only when the
 * requesting frame's origin equals the current server origin (top frame
 * only). Deny camera, screen sharing (display-capture), notifications in
 * the renderer, and everything else.
 */
function isPermissionAllowed(permission, details, currentServerOrigin) {
  if (permission !== 'media') return false;

  const requestingUrl = details && details.requestingUrl ? details.requestingUrl : null;
  if (!requestingUrl) return false;

  let origin;
  try {
    origin = originKey(requestingUrl);
  } catch {
    return false;
  }

  if (origin !== currentServerOrigin) return false;

  const mediaTypes = details.mediaTypes || [];
  return mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio');
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
};
