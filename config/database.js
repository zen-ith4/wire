const Database = require('better-sqlite3');
const constants = require('./constants');

const { ensureSchema } = require('../database/schema');
const { seedDatabase } = require('../database/seed');
const { backupBeforeCredentialMigration } = require('../database/backup');

let db = null;

function initDatabase() {
  if (db) return db;

  db = new Database(constants.DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // better-sqlite3 defaults busy_timeout to 5000ms already, but that
  // default was only ever implicit — nothing in this codebase stated
  // it, so there was no documented, intentional value to tune as
  // write concurrency grows. Setting it explicitly doesn't change
  // current behavior (same 5s value, WAL mode untouched), it just
  // makes the timeout a real, documented setting instead of "whatever
  // the driver happens to default to".
  //
  // What busy_timeout actually does: if a writer finds the database
  // locked by another writer, SQLite retries for up to this many ms
  // before giving up and throwing SQLITE_BUSY. WAL mode already lets
  // readers proceed without blocking on a writer, so this timeout
  // only ever matters for writer-vs-writer contention (e.g. two
  // concurrent chat sends). 5s is a reasonable default for a chat/
  // file app: long enough to ride out a brief burst of concurrent
  // writes without surfacing a user-facing error, short enough that
  // a genuinely stuck request doesn't hang the caller indefinitely.
  db.pragma('busy_timeout = 5000');

  // F12: snapshot an existing database BEFORE its first credential-scheme upgrade.
  // Throws (server refuses to start) if the backup cannot be written.
  backupBeforeCredentialMigration(db, constants.DB_PATH);

  ensureSchema(db);

  seedDatabase(db);

  // require بعد از آماده شدن db
  const { createMissingDrives } = require('../services/drive.service');

  createMissingDrives(db);

  return db;
}

function getDb() {
  if (!db) {
    throw new Error(
      'Database not initialized. Call initDatabase() first.'
    );
  }

  return db;
}

module.exports = {
  initDatabase,
  getDb
};