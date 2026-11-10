// controllers/apk.controller.js
//
// Backs the Android-only update flow (routes/apk.routes.js). This is
// deliberately separate from /api/version (routes/version.routes.js,
// controllers of which are untouched), which Electron already relies
// on for its own update flow — see config/constants.js for why the
// APK's version metadata is tracked independently instead of being
// assumed to match package.json or android/app/build.gradle.
//
// GET /api/apk/info      -> version metadata + SHA-256 of the APK (no bytes)
// GET /api/apk/download  -> streams app-debug.apk itself
//
// Both are intentionally unauthenticated, mirroring /api/version:
// the Android client needs to be able to check for (and fetch) an
// update before a user has logged in, exactly like Electron's
// existing pre-login version check. Neither endpoint takes any
// request input that influences which file is read — the path is a
// single constant resolved once at startup (config/constants.js),
// so there is no path-traversal surface here.

const fs = require('fs');
const { createHash } = require('crypto');
const constants = require('../config/constants');

function apkExists() {
  try {
    return fs.statSync(constants.APK_PATH).isFile();
  } catch {
    return false;
  }
}

// SHA-256 of the shipped APK, hex-encoded. Computed once (on the first
// /api/apk/info request — i.e. at startup for a running server) and cached by
// (size, mtimeMs), so it is only re-hashed when the file actually changes.
// This is the integrity contract the Android client checks before installing:
// see public/js/core/appUpdate.js. Keying on size+mtimeMs means a hot-swapped
// build (a new deploy dropped in as app-debug.apk) is caught without re-reading
// 8 MB on every version check, and a build whose bytes changed but whose mtime
// resolution happened to coincide is still caught because the size differs. If
// whose mtime resolution happened to coincide is still caught because the size
// differs. If recomputation throws, we clear the cache and report null so the
// client fails closed rather than trusting a stale hash.
let apkHashCache = null; // { size, mtimeMs, sha256 }

function apkSha256() {
  let stats;
  try {
    stats = fs.statSync(constants.APK_PATH);
  } catch {
    return null;
  }

  if (apkHashCache && apkHashCache.size === stats.size && apkHashCache.mtimeMs === stats.mtimeMs) {
    return apkHashCache.sha256;
  }

  try {
    const buf = fs.readFileSync(constants.APK_PATH);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    apkHashCache = { size: stats.size, mtimeMs: stats.mtimeMs, sha256 };
    return sha256;
  } catch (err) {
    apkHashCache = null;
    console.error(`[apk] failed to hash ${constants.APK_PATH}:`, err.message);
    return null;
  }
}

// GET /api/apk/info
//
// Never assumes the APK is present just because APK_VERSION_NAME is
// configured (or vice versa) — both are checked, so a stale env var
// left over from a previous deploy can't claim an update is
// available when the file itself was removed.
//
// Returns a SHA-256 of the exact bytes /api/apk/download streams. The
// Android client (public/js/core/appUpdate.js) re-hashes what it
// downloads and refuses to install unless it matches — this is what
// closes the hole where a server that advertises a newer versionCode
// could serve a different (malicious) build than it advertised.
function getApkInfo(req, res) {
  const hasFile = apkExists();
  const hasVersion = Boolean(constants.APK_VERSION_NAME);

  if (!hasFile || !hasVersion) {
    return res.json({ available: false });
  }

  let size = null;
  try {
    size = fs.statSync(constants.APK_PATH).size;
  } catch {
    // Disappeared between the two stats (rare race) — still report
    // the metadata we have; the download endpoint will 404 if it's
    // really gone by the time the client asks for it.
  }

  res.json({
    available: true,
    packageId: constants.APK_PACKAGE_ID,
    versionName: constants.APK_VERSION_NAME,
    versionCode: constants.APK_VERSION_CODE,
    size,
    sha256: apkSha256(),
  });
}

// GET /api/apk/download
//
// Streams the APK rather than loading it into memory. res.sendFile()
// (used the same way as utils/streamMedia.js's sendInlineMedia for
// the Files viewer) hands the actual streaming to Express' `send`,
// which supports Range requests — useful here too, since it lets an
// interrupted APK download resume instead of restarting from zero.
function downloadApk(req, res) {
  if (!apkExists()) {
    return res.status(404).json({ error: 'Update package not available' });
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="app-debug.apk"');
  // Cache-busting isn't needed for correctness (the client always
  // compares versionCode before installing anything it downloads),
  // but a shared/CDN cache serving a stale build to everyone would be
  // a bad failure mode, so this is never cached.
  res.setHeader('Cache-Control', 'private, no-store');

  res.sendFile(
    constants.APK_PATH,
    {
      cacheControl: false,
      acceptRanges: true,
    },
    (err) => {
      if (!err || res.headersSent) return;

      const status = Number.isInteger(err.status) ? err.status : 500;

      res.status(status).json({
        error:
          status === 404
            ? 'Update package not available'
            : status === 416
              ? 'Range not satisfiable'
              : 'Failed to serve update package',
      });
    }
  );
}

module.exports = {
  getApkInfo,
  downloadApk,
};
