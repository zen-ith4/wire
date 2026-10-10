// F12 admin tools: where is each account in the credential migration, and closing
// the legacy (raw-password) login for accounts that never migrated.
//
// Closing is only ever possible for accounts still on scheme 1 (a migrated account
// has no raw-verifiable credential left to close). A closed account answers the
// legacy login exactly like a wrong password. Bulk closing is limited to
// NON-admin, not-yet-migrated, still-open accounts that have been inactive for
// `days` (no legacy login since, or none ever and created before the cutoff), and
// must be confirmed with the exact number the admin was shown (confirm_count).

const { getDb } = require('../config/database');

const DEFAULT_INACTIVE_DAYS = 90;
const MAX_INACTIVE_DAYS = 3650;

function normalizeDays(days) {
  const n = days === undefined || days === null || days === '' ? DEFAULT_INACTIVE_DAYS : Number(days);

  if (!Number.isInteger(n) || n < 1 || n > MAX_INACTIVE_DAYS) {
    const e = new Error(`days must be an integer between 1 and ${MAX_INACTIVE_DAYS}`);
    e.code = 'INVALID_DAYS';
    throw e;
  }

  return n;
}

// SQLite datetime('now', '-N days') formatted like CURRENT_TIMESTAMP columns.
const CANDIDATE_WHERE = `
  auth_scheme = 1
  AND legacy_login_closed = 0
  AND is_active = 1
  AND is_admin = 0
  AND id != ?
  AND COALESCE(legacy_last_login_at, created_at) < datetime('now', ?)
`;

function listCredentialStatus() {
  const db = getDb();

  const users = db.prepare(`
    SELECT
      id,
      username,
      is_admin,
      is_active,
      auth_scheme,
      scheme_migrated_at,
      legacy_last_login_at,
      legacy_login_closed,
      legacy_login_closed_at,
      must_change_password,
      created_at
    FROM users
    ORDER BY username
  `).all();

  const summary = {
    total: users.length,
    migrated: users.filter((u) => u.auth_scheme === 2).length,
    legacy_open: users.filter((u) => u.auth_scheme === 1 && !u.legacy_login_closed).length,
    legacy_closed: users.filter((u) => u.auth_scheme === 1 && u.legacy_login_closed).length,
    must_change_password: users.filter((u) => u.must_change_password).length,
  };

  return { summary, users };
}

function inactiveLegacyCandidates(days, excludeUserId) {
  const d = normalizeDays(days);

  const users = getDb().prepare(`
    SELECT
      id,
      username,
      created_at,
      legacy_last_login_at,
      COALESCE(legacy_last_login_at, created_at) AS last_activity
    FROM users
    WHERE ${CANDIDATE_WHERE}
    ORDER BY username
  `).all(excludeUserId ?? 0, `-${d} days`);

  return { days: d, count: users.length, users };
}

function setLegacyLoginClosed(userId, closed) {
  const db = getDb();

  const user = db.prepare('SELECT id, username, auth_scheme FROM users WHERE id = ?').get(userId);

  if (!user) {
    const e = new Error('User not found');
    e.code = 'NOT_FOUND';
    throw e;
  }

  if (user.auth_scheme !== 1) {
    const e = new Error('This account already migrated; there is no legacy login to close or reopen');
    e.code = 'NOT_LEGACY';
    throw e;
  }

  db.transaction(() => {
    if (closed) {
      db.prepare(`
        UPDATE users SET legacy_login_closed = 1, legacy_login_closed_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(userId);

      // an outstanding migration ticket belongs to the login being closed
      db.prepare('DELETE FROM auth_migration_tickets WHERE user_id = ?').run(userId);
    } else {
      db.prepare(`
        UPDATE users SET legacy_login_closed = 0, legacy_login_closed_at = NULL WHERE id = ?
      `).run(userId);
    }
  })();

  return { id: user.id, username: user.username, legacy_login_closed: Boolean(closed) };
}

function closeInactiveLegacy(days, confirmCount, excludeUserId) {
  const d = normalizeDays(days);
  const db = getDb();

  return db.transaction(() => {
    const ids = db.prepare(`
      SELECT id FROM users WHERE ${CANDIDATE_WHERE}
    `).all(excludeUserId ?? 0, `-${d} days`).map((r) => r.id);

    if (!Number.isInteger(confirmCount) || confirmCount !== ids.length) {
      const e = new Error(`The number of affected accounts is ${ids.length}, not ${confirmCount}. Review the preview and confirm again.`);
      e.code = 'COUNT_MISMATCH';
      e.count = ids.length;
      throw e;
    }

    const close = db.prepare(`
      UPDATE users SET legacy_login_closed = 1, legacy_login_closed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND auth_scheme = 1 AND legacy_login_closed = 0
    `);
    const dropTicket = db.prepare('DELETE FROM auth_migration_tickets WHERE user_id = ?');

    let closed = 0;
    for (const id of ids) {
      closed += close.run(id).changes;
      dropTicket.run(id);
    }

    return { closed, days: d };
  })();
}

module.exports = {
  DEFAULT_INACTIVE_DAYS,
  listCredentialStatus,
  inactiveLegacyCandidates,
  setLegacyLoginClosed,
  closeInactiveLegacy,
};
