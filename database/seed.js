const bcrypt = require('bcryptjs');
const constants = require('../config/constants');

function seedDatabase(db) {
  createDefaultAdmin(db);
}

function createDefaultAdmin(db) {
  const {
    DEFAULT_ADMIN_USER,
    DEFAULT_ADMIN_PASS
  } = constants;

  // FIX: Instead of throwing an error and crashing, we just silently return.
  // The Setup Wizard will handle creating the admin account interactively!
  if (!DEFAULT_ADMIN_USER || !DEFAULT_ADMIN_PASS) {
    return; 
  }

  const existing = db.prepare(`
    SELECT id 
    FROM users 
    WHERE username = ?
  `).get(DEFAULT_ADMIN_USER);

  if (existing) {
    return existing.id;
  }

  const hash = bcrypt.hashSync(
    DEFAULT_ADMIN_PASS,
    12
  );

  const info = db.prepare(`
    INSERT INTO users (
      username,
      password_hash,
      is_admin
    )
    VALUES (?, ?, 1)
  `).run(
    DEFAULT_ADMIN_USER,
    hash
  );

  console.log('✅ Default admin account created');

  return info.lastInsertRowid;
}

module.exports = {
  seedDatabase,
  createDefaultAdmin
};