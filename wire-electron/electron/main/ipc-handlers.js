'use strict';

/**
 * Every ipcMain handler the app exposes, in one place, so the whole
 * "what can the renderer ask the main process to do" surface is
 * auditable at a glance. All arguments are validated here - the
 * renderer/preload side is not trusted.
 *
 * Channel naming: "<namespace>:<action>".
 */

const { ipcMain, shell, app } = require('electron');
const configStore = require('./config-store');
const secureStore = require('./secure-store');
const { normalizeServerUrl, testServerConnection, fetchCertificateInfo } = require('./server-connection');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0 && v.length < 2048;
}

function isValidOrigin(v) {
  if (!isNonEmptyString(v)) return false;
  try {
    const parsed = new URL(v);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isPositiveInteger(v) {
  return Number.isInteger(v) && v > 0;
}

function unlockKeyStoreKey(origin, userId) {
  return `${origin}::${userId}`;
}

function registerIpcHandlers({ getMainWindow, navigateToServer, navigateToWelcome }) {
  ipcMain.handle('server:get-current', () => {
    return {
      url: configStore.get('serverUrl') || null,
      rememberServer: configStore.get('rememberServer') !== false,
    };
  });

  ipcMain.handle('server:test', async (event, rawUrl) => {
    if (!isNonEmptyString(rawUrl)) {
      return { status: 'invalid_url', message: 'Enter a server URL.' };
    }
    return testServerConnection(rawUrl, { allowPinnedFingerprint: true });
  });

  ipcMain.handle('server:connect', async (event, rawUrl, opts = {}) => {
    if (!isNonEmptyString(rawUrl)) {
      return { status: 'invalid_url', message: 'Enter a server URL.' };
    }

    const remember = opts && typeof opts.remember === 'boolean' ? opts.remember : true;
    const result = await testServerConnection(rawUrl, { allowPinnedFingerprint: true });

    if (result.status === 'invalid_url' || result.status === 'tls_error') {
      // Don't persist a URL we couldn't validate, and don't persist
      // through an unresolved certificate problem - the user needs to
      // explicitly decide via the trust-certificate flow first.
      return result;
    }

    configStore.set('serverUrl', result.url);
    configStore.set('rememberServer', remember);

    if (result.status === 'connected') {
      navigateToServer(result.url);
    }

    return result;
  });

  ipcMain.handle('server:forget', () => {
    configStore.set('serverUrl', null);
    navigateToWelcome();
    return { ok: true };
  });

  ipcMain.handle('server:get-certificate-info', async (event, rawUrl) => {
    if (!isNonEmptyString(rawUrl)) {
      throw new Error('Enter a server URL.');
    }
    return fetchCertificateInfo(rawUrl);
  });

  ipcMain.handle('server:trust-certificate', async (event, rawUrl, fingerprint256) => {
    if (!isNonEmptyString(rawUrl) || !isNonEmptyString(fingerprint256)) {
      return { ok: false, message: 'Missing certificate information.' };
    }

    const normalized = normalizeServerUrl(rawUrl);
    if (!normalized.ok || !normalized.origin.startsWith('https:')) {
      return { ok: false, message: 'Certificate pinning only applies to https:// servers.' };
    }

    // Re-fetch the live certificate ourselves rather than trusting a
    // fingerprint value handed to us by the renderer verbatim - the
    // renderer only ever *displays* what fetchCertificateInfo showed
    // it; the actual pin is set from a fresh read here.
    const live = await fetchCertificateInfo(normalized.origin);
    if (live.fingerprint256 !== fingerprint256) {
      return { ok: false, message: 'Certificate changed since it was displayed - please try again.' };
    }

    const trusted = { ...(configStore.get('trustedCertificates') || {}) };
    trusted[normalized.origin] = live.fingerprint256;
    configStore.set('trustedCertificates', trusted);

    return { ok: true };
  });

  /*
   * E2EE identity auto-unlock material.
   *
   * The renderer never sends a password or a private key over
   * these channels - only the PBKDF2-derived unlock key produced
   * by public/js/crypto/identity.js. See secure-store.js for what
   * actually happens to it (OS-level encryption via safeStorage,
   * or nothing at all if that isn't available on this machine).
   */

  ipcMain.handle('identity:store-unlock-key', (event, origin, userId, unlockKey) => {
    if (!isValidOrigin(origin) || !isPositiveInteger(userId) || !isNonEmptyString(unlockKey)) {
      return { ok: false };
    }
    const ok = secureStore.save(unlockKeyStoreKey(origin, userId), unlockKey);
    return { ok };
  });

  ipcMain.handle('identity:get-unlock-key', (event, origin, userId) => {
    if (!isValidOrigin(origin) || !isPositiveInteger(userId)) {
      return { unlockKey: null };
    }
    return { unlockKey: secureStore.load(unlockKeyStoreKey(origin, userId)) };
  });

  ipcMain.handle('identity:clear-unlock-key', (event, origin, userId) => {
    if (isValidOrigin(origin) && isPositiveInteger(userId)) {
      secureStore.clear(unlockKeyStoreKey(origin, userId));
    }
    return { ok: true };
  });

  ipcMain.handle('app:get-version', () => app.getVersion());

  ipcMain.handle('app:platform', () => process.platform);

  ipcMain.handle('app:open-external', async (event, rawUrl) => {
    if (!isNonEmptyString(rawUrl)) return { ok: false };

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false };
    }

    await shell.openExternal(parsed.href);
    return { ok: true };
  });

  ipcMain.handle('app:reload', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.reload();
    }
    return { ok: true };
  });
}

module.exports = { registerIpcHandlers };
