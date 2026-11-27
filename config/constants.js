const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const { isEmailEnabled } = require('../services/email.service');
const {
  secretProblem,
  isFirstRunSetupInProgress,
} = require('../utils/envSecrets');

const isProduction = process.env.NODE_ENV === 'production';

// DM E2EE: default floor for NEWLY REGISTERED accounts (docs/archive/e2ee-dm-hardening.md 5.1).
// Read in ONE place. Unset -> 2. Exactly "1"/"2" accepted. Anything else is fatal.
function getDmE2eeDefaultMinVersion() {
  const raw = process.env.DM_E2EE_DEFAULT_MIN_VERSION;
  if (raw === undefined) {
    return 2;
  }
  if (raw === '1') {
    return 1;
  }
  if (raw === '2') {
    return 2;
  }
  console.error(
    '❌ FATAL: DM_E2EE_DEFAULT_MIN_VERSION must be unset, "1", or "2" ' +
      '(got ' + JSON.stringify(raw) + ').'
  );
  process.exit(1);
}

// Example secrets that shipped in .env.example are defined in
// utils/envSecrets.js, shared with the setup pre-flight and the wizard, so
// there is one definition of "usable".

function fatal(message) {
  console.error('❌ FATAL: ' + message);
  process.exit(1);
}

function getJwtSecret() {
  if (process.env.JWT_SECRET) {
    const problem = secretProblem(process.env.JWT_SECRET);

    if (problem) {
      fatal(`JWT_SECRET is unsafe: ${problem}.`);
    }

    return process.env.JWT_SECRET;
  }

  if (isProduction) {
    console.error('❌ FATAL: JWT_SECRET is required in production.');
    process.exit(1);
  }

  const secret = crypto.randomBytes(32).toString('hex');

  console.warn(
    '⚠️  JWT_SECRET not set — using a random secret (all sessions will reset after restart).'
  );

  return secret;
}

// EMAIL_VERIFICATION_SECRET keys the HMAC of email OTP codes
// (services/emailVerification.service.js). Checked here so a bad value stops
// the server at startup instead of failing on the first verification email.
function checkEmailVerificationSecret() {
  const secret = process.env.EMAIL_VERIFICATION_SECRET;
  const emailEnabled = isEmailEnabled();

  if (!secret) {
    if (isProduction && emailEnabled) {
      fatal('EMAIL_VERIFICATION_SECRET is required in production when email is enabled.');
    }

    return;
  }

  const problem = secretProblem(secret);

  if (problem) {
    fatal(`EMAIL_VERIFICATION_SECRET is unsafe: ${problem}.`);
  }
}

checkEmailVerificationSecret();

// Validate that the value is a finite positive number; otherwise use the default.
function parseMaxMB(envName, def) {
  const n = Number(process.env[envName]);
  if (!Number.isFinite(n) || n <= 0) return def;
  return n;
}

const constants = {
  // ======================================================
  // Server
  // ======================================================

  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '10.10.0.7',
  NODE_ENV: process.env.NODE_ENV || 'development',

  // ======================================================
  // Database
  // ======================================================

  DB_PATH:
    process.env.DB_PATH ||
    path.join(__dirname, '..', 'data.db'),

  // ======================================================
  // Security
  // ======================================================

  ALLOWED_SUBNET:
    process.env.ALLOWED_SUBNET || '10.10.0.0/24',

  JWT_SECRET: getJwtSecret(),

  // Default DM E2EE floor for new accounts (docs/archive/e2ee-dm-hardening.md 5.1).
  DM_E2EE_DEFAULT_MIN_VERSION: getDmE2eeDefaultMinVersion(),

  // ======================================================
  // WireGuard
  // ======================================================

  WG_INTERFACE: process.env.WG_INTERFACE || 'wg0',

  // ======================================================
  // Push notifications (Android FCM) — avatar image
  // ======================================================
  //
  // Used only by services/push.service.js to build an absolute
  // avatarUrl for the FCM notification payload's
  // android.notification.imageUrl. Every other URL in this app is
  // relative/same-origin because it's only ever rendered inside the
  // WebView; FCM's own image-fetching infrastructure has no "current
  // origin" to resolve a relative URL against, so this is the one
  // place that genuinely needs an absolute, externally-reachable URL.
  //
  // Optional: if unset, sendDmPush() simply omits imageUrl and the
  // notification shows Android's normal default icon, exactly as
  // before this feature existed. Never guessed/derived from HOST,
  // since HOST here is a bind address (often a WireGuard LAN IP),
  // not necessarily the address a phone off that VPN can reach.
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL
    ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')
    : null,

  // ======================================================
  // Upload Limits (MB)
  // ======================================================

  UPLOAD_MAX_MB: parseMaxMB('UPLOAD_MAX_MB', 2048),
  CHAT_UPLOAD_MAX_MB: parseMaxMB('CHAT_UPLOAD_MAX_MB', 50),
  DM_UPLOAD_MAX_MB: parseMaxMB('DM_UPLOAD_MAX_MB', 50),
  AVATAR_MAX_MB: parseMaxMB('AVATAR_MAX_MB', 5),
  BANNER_MAX_MB: parseMaxMB('BANNER_MAX_MB', 8),
  GROUP_UPLOAD_MAX_MB: parseMaxMB('GROUP_UPLOAD_MAX_MB', 50),

  // ======================================================
  // Storage Directories
  // ======================================================

  USER_DATA_ROOT:
    process.env.USER_DATA_ROOT ||
    path.join(__dirname, '..', 'user-data'),

  // Folders an admin may share must sit inside one of these directories.
  // Comma-separated. Defaults to USER_DATA_ROOT only. See utils/folderPolicy.js.
  ALLOWED_FOLDER_ROOTS:
    (process.env.ALLOWED_FOLDER_ROOTS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .concat(
        process.env.ALLOWED_FOLDER_ROOTS
          ? []
          : [process.env.USER_DATA_ROOT || path.join(__dirname, '..', 'user-data')]
      ),

  CHAT_UPLOAD_DIR:
    process.env.CHAT_UPLOAD_DIR ||
    path.join(__dirname, '..', 'chat-uploads'),

  DM_UPLOAD_DIR:
    process.env.DM_UPLOAD_DIR ||
    path.join(__dirname, '..', 'dm-uploads'),

  AVATAR_DIR:
    process.env.AVATAR_DIR ||
    path.join(__dirname, '..', 'avatars'),

  BANNER_DIR:
    process.env.BANNER_DIR ||
    path.join(__dirname, '..', 'banners'),

  // ======================================================
  // E2EE group chat (routes/groups.routes.js, sockets/group.socket.js)
  // ======================================================
  //
  // Off by default: the routes/sockets exist but refuse every request
  // and /api/me reports groups_enabled=false, so no Groups UI appears.
  // Set GROUPS_ENABLED=true to turn the feature on.
  GROUPS_ENABLED: process.env.GROUPS_ENABLED === 'true',

  GROUP_UPLOAD_DIR:
    process.env.GROUP_UPLOAD_DIR ||
    path.join(__dirname, '..', 'group-uploads'),

  // ======================================================
  // Default Admin
  // ======================================================

  DEFAULT_ADMIN_USER: process.env.DEFAULT_ADMIN_USER,
  DEFAULT_ADMIN_PASS: process.env.DEFAULT_ADMIN_PASS,

  // ======================================================
  // Android APK update (routes/apk.routes.js)
  // ======================================================
  //
  // Resolved relative to THIS file's location (the backend's real
  // project root), never process.cwd() — the process may be started
  // from a different working directory (systemd, pm2, a parent
  // deploy script, ...), and cwd-relative resolution would then
  // silently look in the wrong place or, worse, let a manipulated
  // cwd be used for path construction.
  //
  // APK_VERSION_NAME / APK_VERSION_CODE are deliberately NOT derived
  // from package.json's version (used by /api/version for Electron)
  // or from android/app/build.gradle's versionName/versionCode.
  // Nothing in this project currently re-stamps either of those
  // automatically when a new app-debug.apk is dropped in, so trusting
  // either would risk telling Android clients about a "new version"
  // that doesn't match what's actually in the APK on disk (or vice
  // versa — silently hiding a real update). Until a build pipeline
  // wires these together, whoever publishes a new app-debug.apk must
  // also set these two env vars to match the version actually built
  // into that APK. If APK_VERSION_NAME is unset, the APK is treated
  // as unavailable/unpublished (see controllers/apk.controller.js)
  // rather than guessing.
  // Prefer the current build-artifact name (app-debug.apk). Fall back to the
  // pre-rename name (apk-debug.apk) when the new artifact is not present, so
  // the rename is not a breaking change for deployments that never re-pointed
  // their APK_PATH. An explicit APK_PATH env var always wins.
  APK_PATH:
    process.env.APK_PATH ||
    (fs.existsSync(path.join(__dirname, '..', 'app-debug.apk'))
      ? path.join(__dirname, '..', 'app-debug.apk')
      : path.join(__dirname, '..', 'apk-debug.apk')),

  APK_VERSION_NAME: process.env.APK_VERSION_NAME || null,

  APK_VERSION_CODE: process.env.APK_VERSION_CODE
    ? Number(process.env.APK_VERSION_CODE)
    : null,

  // Must match android/app/build.gradle's applicationId so the
  // Android client's native verification step (WireApkUpdatePlugin)
  // can confirm the downloaded APK is really Wire before offering to
  // install it.
  APK_PACKAGE_ID: process.env.APK_PACKAGE_ID || 'com.wireapp.arman',
};

// Refuse configurations that are clearly unsafe for a production launch.
// Development keeps its current behavior so the first-run/setup workflow
// remains usable locally.
if (constants.NODE_ENV === 'production') {
  const wildcardSubnet =
    constants.ALLOWED_SUBNET === '0.0.0.0/0' ||
    constants.ALLOWED_SUBNET === '::/0';

  if (wildcardSubnet) {
    console.error(
      '❌ FATAL: ALLOWED_SUBNET must be restricted in production.'
    );
    process.exit(1);
  }

  // A first run must reach the setup wizard before this can be required;
  // server.js sets the module flag only while the pre-flight is preparing
  // secrets for that wizard. Once setup completes, or for any direct
  // require of this module, the check is unchanged.
  if (
    process.env.SETUP_COMPLETED !== 'true' &&
    !isFirstRunSetupInProgress()
  ) {
    console.error(
      '❌ FATAL: SETUP_COMPLETED=true is required in production.'
    );
    process.exit(1);
  }
}

module.exports = Object.freeze(constants);
