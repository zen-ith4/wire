const { getDb } = require('../config/database');

// A token belongs to exactly one device installation, so it's the
// natural unique key — see database/tables/pushTokens.tabels.js. A
// device re-registering (app reopened, token refreshed, or the same
// device logging in as a *different* user after a previous logout —
// the FCM token itself doesn't change on logout) always resolves to
// one row per token, re-owned by whichever user just registered it.
// One user can still have many rows, one per device.
function upsertPushToken(userId, token, platform) {
  const now = new Date().toISOString();

  getDb()
    .prepare(
      `
      INSERT INTO push_tokens (user_id, token, platform, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = excluded.updated_at
      `
    )
    .run(userId, token, platform, now, now);
}

// Only ever deletes a token scoped to the calling user — a token that
// exists but belongs to someone else (already re-registered on
// another account) is left untouched rather than deleted out from
// under them.
function deletePushToken(userId, token) {
  return getDb()
    .prepare(
      `DELETE FROM push_tokens WHERE user_id = ? AND token = ?`
    )
    .run(userId, token);
}

function deleteAllPushTokensForUser(userId) {
  return getDb()
    .prepare(`DELETE FROM push_tokens WHERE user_id = ?`)
    .run(userId);
}

function getPushTokensForUser(userId) {
  return getDb()
    .prepare(`SELECT token, platform FROM push_tokens WHERE user_id = ?`)
    .all(userId);
}

// A single stale/invalid token reported by FCM (app uninstalled,
// token expired) is removed regardless of which user currently owns
// the row — see services/push.service.js's send-result handling.
function deletePushTokenByValue(token) {
  return getDb()
    .prepare(`DELETE FROM push_tokens WHERE token = ?`)
    .run(token);
}

module.exports = {
  upsertPushToken,
  deletePushToken,
  deleteAllPushTokensForUser,
  getPushTokensForUser,
  deletePushTokenByValue,
};
