// controllers/apk.controller.js
//
// Backs the Android-only update flow (routes/apk.routes.js). This is
// deliberately separate from /api/version (routes/version.routes.js,
// controllers of which are untouched), which Electron already relies
// on for its own update flow — see config/constants.js for why the
// APK's version metadata is tracked independently instead of being
// assumed to match package.json or android/app/build.gradle.
//
// GET /api/apk/info      -> version metadata (no file bytes)
// GET /api/apk/download  -> streams apk-debug.apk itself
//
// Both are intentionally unauthenticated, mirroring /api/version:
// the Android client needs to be able to check for (and fetch) an
// update before a user has logged in, exactly like Electron's
// existing pre-login version check. Neither endpoint takes any
// request input that influences which file is read — the path is a
// single constant resolved once at startup (config/constants.js),
// so there is no path-traversal surface here.

const fs = require('fs');
const constants = require('../config/constants');

function apkExists() {
  try {
    return fs.statSync(constants.APK_PATH).isFile();
  } catch {
    return false;
  }
}

// GET /api/apk/info
//
// Never assumes the APK is present just because APK_VERSION_NAME is
// configured (or vice versa) — both are checked, so a stale env var
// left over from a previous deploy can't claim an update is
// available when the file itself was removed.
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
  res.setHeader('Content-Disposition', 'attachment; filename="apk-debug.apk"');
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
