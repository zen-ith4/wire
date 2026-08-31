const Database = require('better-sqlite3');
const constants = require('./constants');

const { ensureSchema } = require('../database/schema');
const { seedDatabase } = require('../database/seed');

let db = null;

function initDatabase() {
  if (db) return db;

  db = new Database(constants.DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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