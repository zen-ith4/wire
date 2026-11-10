// ============================================================
// Android APK self-update flow (Capacitor native only).
//
// This is a completely separate mechanism from core/pwa.js's Service
// Worker update flow — that one refreshes the cached web app shell
// (used by the browser/PWA and, via Electron's own update bridge, by
// the desktop app). Neither mechanism triggers the other. On Android
// there is no installed web shell to refresh; the only thing that can
// be "updated" is the installed .apk itself, which is what this file
// does.
//
//   1. Read the installed app's own version (native, via @capacitor/app
//      — never the remote frontend/package.json version).
//   2. Ask the CURRENTLY SELECTED server (core/server.js) whether it
//      has a newer APK (GET /api/apk/info). A server that doesn't run
//      this endpoint, or has no APK published, simply looks like "no
//      update" — this must never break the app for servers that don't
//      support Android updates at all.
//   3. Compare versions numerically (never lexicographically).
//   4. If newer, ask the user (same styled confirm dialog Electron's
//      update flow already uses) — never download anything without
//      explicit consent, and never more than once per version per
//      session.
//   5. On acceptance: download via the existing @capacitor/file-transfer
//      plugin into an app-private cache folder (never shared/public
//      storage), then hand off to the native WireApkUpdatePlugin
//      (android/.../WireApkUpdatePlugin.java) to verify the file
//      (package id / version / signing certificate) and finally open
//      Android's own package installer. Android — not this code —
//      owns the actual install confirmation and execution.
// ============================================================

import { isNativeApp, resolveServerUrl } from './server.js';
import { showConfirm } from '../ui/confirm.js';
import { showToast } from './utils.js';
import { App } from '../vendor/capacitor-app.js';
import { Filesystem, Directory, FileTransfer } from '../vendor/capacitor.js';

const UPDATE_DIR = 'updates';
const APK_FILENAME = 'apk-debug.apk';

// Same numeric MAJOR.MINOR.PATCH comparison as the backend's
// utils/semver.js (duplicated rather than shared: this file ships as
// a browser ES module, that one as a CommonJS Node module).
function parseVersion(version) {
  const raw = String(version ?? '').trim();
  const core = raw.replace(/^v/i, '').split(/[-+]/)[0];
  const parts = core.split('.').map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isNewerVersion(remote, current) {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Same lookup pattern used by notification-manager.js /
// push-registration.js for their own ad-hoc native plugins.
function getCapacitorPlugin(name) {
  try {
    return window.Capacitor?.Plugins?.[name] || null;
  } catch (e) {
    console.warn(`[AppUpdate] Failed to access Capacitor plugin "${name}":`, e);
    return null;
  }
}

// Tracks the server version a prompt/flow has already run for this
// session, so a repeated check (e.g. app resume) can't stack a second
// dialog or re-download on top of one already declined/in progress.
let handledVersion = null;

async function getInstalledVersion() {
  const info = await App.getInfo();
  return info?.version || '0.0.0';
}

async function fetchRemoteApkInfo() {
  try {
    const res = await fetch(resolveServerUrl('/api/apk/info'));

    if (!res.ok) {
      // Server doesn't have this endpoint, or it errored — treat the
      // same as "no update available" rather than surfacing an error
      // for something the user never asked to check.
      return null;
    }

    return await res.json();
  } catch (e) {
    console.warn('[AppUpdate] Version check failed:', e);
    return null;
  }
}

async function ensureInstallPermission(plugin) {
  let permission;

  try {
    permission = await plugin.canRequestInstall();
  } catch (e) {
    console.warn('[AppUpdate] canRequestInstall failed:', e);
    return true; // Fail open; installApk() itself still enforces this.
  }

  if (permission?.granted) return true;

  const openSettings = await showConfirm(
    'Wire needs permission to install updates from this app. Open settings now?',
    {
      title: 'Permission required',
      confirmText: 'Open settings',
      cancelText: 'Cancel',
      danger: false,
    }
  );

  if (openSettings) {
    try {
      await plugin.openInstallPermissionSettings();
    } catch (e) {
      console.warn('[AppUpdate] Could not open install-permission settings:', e);
    }
    showToast('Grant the permission, then try updating again', 'info');
  }

  return false;
}

async function downloadApk() {
  try {
    await Filesystem.mkdir({
      path: UPDATE_DIR,
      directory: Directory.Cache,
      recursive: true,
    });
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    if (!message.includes('exist')) throw error;
  }

  const { uri: destinationUri } = await Filesystem.getUri({
    path: `${UPDATE_DIR}/${APK_FILENAME}`,
    directory: Directory.Cache,
  });

  const downloadId = `apk-update-${Date.now()}`;
  let progressListener = null;

  try {
    window.__wireDownloadProgress?.start(downloadId, APK_FILENAME);

    progressListener = await FileTransfer.addListener('progress', (progress) => {
      if (!progress) return;
      window.__wireDownloadProgress?.progress(downloadId, {
        bytes: Number(progress.bytes) || 0,
        contentLength: Number(progress.contentLength) || 0,
      });
    });

    await FileTransfer.downloadFile({
      url: resolveServerUrl('/api/apk/download'),
      path: destinationUri,
      progress: true,
      connectTimeout: 60_000,
      readTimeout: 180_000,
    });

    window.__wireDownloadProgress?.finish(downloadId);
    return destinationUri;
  } catch (error) {
    window.__wireDownloadProgress?.fail(downloadId);
    throw error;
  } finally {
    if (progressListener) {
      try {
        await progressListener.remove();
      } catch (error) {
        console.warn('[AppUpdate] Failed to remove progress listener:', error);
      }
    }
  }
}

async function downloadAndInstall(expectedSha256) {
  const plugin = getCapacitorPlugin('WireApkUpdate');

  if (!plugin) {
    showToast('Updates are not supported in this build', 'error');
    return;
  }

  if (!(await ensureInstallPermission(plugin))) {
    return;
  }

  // Integrity gate — fail closed. The server is supposed to advertise the
  // SHA-256 it would serve in /api/apk/info, and when it cannot it answers
  // { available: false } (see controllers/apk.controller.js). This client
  // therefore REFUSES TO INSTALL an update that has no advertised hash — no
  // legacy "signature-only" fallback. An install this client cannot verify is
  // worse than no install at all, so a missing hash is treated like a mismatch.
  if (!expectedSha256) {
    console.error('[AppUpdate] Refusing to install: the server advertised no SHA-256.');
    showToast('Update rejected: no integrity check from this server', 'error');
    return;
  }

  let apkPath;
  try {
    apkPath = await downloadApk();
  } catch (error) {
    console.error('[AppUpdate] Download failed:', error);
    showToast(
      'Update download failed: ' + (error?.message || 'network error'),
      'error'
    );
    return;
  }

  // Integrity gate — checked BEFORE the native signature check and before
  // install. The server advertised the expected SHA-256 in /api/apk/info; we
  // re-hash exactly what we downloaded and compare. A mismatch aborts here, so
  // a hostile server that advertised a newer version but served a different
  // (malicious) build can't get it installed. Fail closed: any failure to read
  // or hash the file is treated as a mismatch. The advertised hash is mandatory
  // (enforced before download above); when present it must match the bytes we
  // actually downloaded.
  let actualSha256;
  try {
    actualSha256 = await readApkSha256();
  } catch (hashError) {
    console.error('[AppUpdate] Could not hash the downloaded update:', hashError);
    showToast('Could not verify the update', 'error');
    return;
  }

  if (actualSha256 !== expectedSha256) {
    console.error(
      `[AppUpdate] SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`
    );
    showToast('Update rejected: integrity check failed', 'error');
    return;
  }

  let verification;
  try {
    verification = await plugin.verifyApk({ path: apkPath });
  } catch (error) {
    console.error('[AppUpdate] Verification failed:', error);
    showToast('Could not verify the downloaded update', 'error');
    return;
  }

  if (!verification?.valid) {
    console.error('[AppUpdate] Rejected downloaded APK:', verification?.reason);
    showToast(
      'Update rejected: ' + (verification?.reason || 'invalid package'),
      'error'
    );
    return;
  }

  try {
    await plugin.installApk({ path: apkPath });
  } catch (error) {
    console.error('[AppUpdate] Failed to launch installer:', error);
    showToast('Could not launch the installer', 'error');
  }
}

// SHA-256 of a byte array, hex-encoded, via Web Crypto. The group crypto in
// this repo already relies on crypto.subtle in the same WebView, so it is
// available here.
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

// Read the downloaded APK back from the app-private cache and return its
// SHA-256. On native Capacitor Filesystem.readFile returns the bytes
// base64-encoded by default; decode to raw bytes before hashing.
async function readApkSha256() {
  const { data } = await Filesystem.readFile({
    path: `${UPDATE_DIR}/${APK_FILENAME}`,
    directory: Directory.Cache,
  });

  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return sha256Hex(bytes);
}

/**
 * Checks the currently selected server for a newer APK and, if the
 * user accepts, downloads/verifies/installs it. Safe to call
 * repeatedly (e.g. on every app resume) — see `handledVersion` above.
 * Never throws: every failure path is reported via showToast() or
 * silently treated as "no update" when appropriate.
 */
export async function checkForAndroidUpdate() {
  if (!isNativeApp()) return;

  let installedVersion;
  try {
    installedVersion = await getInstalledVersion();
  } catch (error) {
    console.warn('[AppUpdate] Could not read installed app version:', error);
    return;
  }

  const remote = await fetchRemoteApkInfo();

  if (!remote?.available || !remote.versionName) return;
  if (!isNewerVersion(remote.versionName, installedVersion)) return;
  if (handledVersion === remote.versionName) return;

  handledVersion = remote.versionName;

  const accepted = await showConfirm(
    `Current version: ${installedVersion}. Available version: ` +
      `${remote.versionName}. Download and install the update?`,
    {
      title: `New version ${remote.versionName} is available`,
      confirmText: 'Update',
      cancelText: 'Not now',
      danger: false,
    }
  );

  if (!accepted) return;

  await downloadAndInstall(remote.sha256);
}

/** Entry point for core/app.js — fires the check without blocking bootstrap. */
export function initAndroidUpdateCheck() {
  if (!isNativeApp()) return;

  checkForAndroidUpdate().catch((error) => {
    console.error('[AppUpdate] Update check failed:', error);
  });
}
