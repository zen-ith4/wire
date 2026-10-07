// database/backup.js
//
// Safety net for the one-way F12 credential migration. Before the FIRST schema
// upgrade of an existing database (users table present, `auth_scheme` column
// not yet there) the whole database is copied with SQLite's `VACUUM INTO`, which
// produces a consistent snapshot even while the file is in WAL mode.
//
//   data.db  ->  data.db.pre-f12.<UTC timestamp>
//
// The upgrade is NOT allowed to continue if the backup cannot be written: the
// error propagates and the server refuses to start. Rollback = stop the new
// build, restore this file, start the previous build (users who migrated after
// the backup lose those changes, and their v2 identities are unreadable by the
// old code, so restore the backup rather than the live file).

const fs = require('fs');

function timestamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function needsCredentialMigration(db) {
  const hasUsers = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'"
  ).get();

  if (!hasUsers) return false; // fresh database: nothing to protect

  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);

  return !cols.includes('auth_scheme');
}

/**
 * @param {import('better-sqlite3').Database} db an OPEN connection to the database
 * @param {string} dbPath its file path (':memory:' / '' are skipped)
 * @returns {string|null} path of the backup, or null when none was needed
 */
function backupBeforeCredentialMigration(db, dbPath, now = new Date()) {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file::memory:')) return null;
  if (!needsCredentialMigration(db)) return null;

  const target = `${dbPath}.pre-f12.${timestamp(now)}`;

  if (fs.existsSync(target)) {
    throw new Error(`[db] backup target already exists, refusing to migrate: ${target}`);
  }

  // VACUUM INTO cannot run inside a transaction; callers invoke this before ensureSchema().
  db.prepare('VACUUM INTO ?').run(target);

  const rows = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`[db] pre-migration backup written: ${target} (${rows} users)`);

  return target;
}

module.exports = { backupBeforeCredentialMigration, needsCredentialMigration };
