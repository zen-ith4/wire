const path = require('path');
const crypto = require('crypto');

const isProduction = process.env.NODE_ENV === 'production';

function getJwtSecret() {
  if (process.env.JWT_SECRET) {
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

  UPLOAD_MAX_MB: Number(process.env.UPLOAD_MAX_MB) || 2048,
  CHAT_UPLOAD_MAX_MB: Number(process.env.CHAT_UPLOAD_MAX_MB) || 50,
  DM_UPLOAD_MAX_MB: Number(process.env.DM_UPLOAD_MAX_MB) || 50,
  AVATAR_MAX_MB: Number(process.env.AVATAR_MAX_MB) || 5,
  BANNER_MAX_MB: Number(process.env.BANNER_MAX_MB) || 8,

  // ======================================================
  // Storage Directories
  // ======================================================

  USER_DATA_ROOT:
    process.env.USER_DATA_ROOT ||
    path.join(__dirname, '..', 'user-data'),

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
  // Default Admin
  // ======================================================

  DEFAULT_ADMIN_USER: process.env.DEFAULT_ADMIN_USER,
  DEFAULT_ADMIN_PASS: process.env.DEFAULT_ADMIN_PASS,
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

  if (process.env.SETUP_COMPLETED !== 'true') {
    console.error(
      '❌ FATAL: SETUP_COMPLETED=true is required in production.'
    );
    process.exit(1);
  }
}

module.exports = Object.freeze(constants);
