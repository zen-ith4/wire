// utils/semver.js
//
// Minimal, dependency-free semantic version comparison.
//
// Used by the Android APK update flow (routes/apk.routes.js,
// controllers/apk.controller.js) to decide whether the version the
// server reports is actually newer than what a client already has.
// Explicitly NOT a lexicographic string comparison — "1.9.0" must
// compare as older than "1.10.0", which a plain string/`<` compare
// gets wrong.
//
// Accepts versions with an optional leading "v" and an optional
// "-prerelease"/"+build" suffix (the suffix is ignored for ordering
// purposes; only the numeric MAJOR.MINOR.PATCH triplet is compared).
// Missing/non-numeric parts default to 0, so "1.2" and "1.2.0" are
// treated as equal.

/**
 * Parses a version string into a [major, minor, patch] numeric triplet.
 * Never throws: anything unparseable resolves to [0, 0, 0].
 */
function parseVersion(version) {
  const raw = String(version ?? '').trim();

  // Strip a leading "v" (e.g. "v1.2.3") and any -prerelease/+build suffix.
  const core = raw
    .replace(/^v/i, '')
    .split(/[-+]/)[0];

  const parts = core.split('.').map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });

  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Compares two version strings numerically.
 *
 * Returns:
 *   -1 if `a` < `b`
 *    0 if `a` === `b`
 *    1 if `a` > `b`
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);

  for (let i = 0; i < 3; i++) {
    if (va[i] > vb[i]) return 1;
    if (va[i] < vb[i]) return -1;
  }

  return 0;
}

/** True when `remoteVersion` is strictly newer than `currentVersion`. */
function isNewerVersion(remoteVersion, currentVersion) {
  return compareVersions(remoteVersion, currentVersion) > 0;
}

module.exports = {
  parseVersion,
  compareVersions,
  isNewerVersion,
};
