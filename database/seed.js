const bcrypt = require('bcryptjs');
const constants = require('../config/constants');
const {
  deriveCredentialsNode,
  newKdfSalt,
  KDF_ITERATIONS
} = require('../utils/credentials');

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

  // Usernames are matched case-insensitively here: an existing 'Admin' (created
  // by an older build) must not be shadowed by a second 'admin'.
  const existing = db.prepare(`
    SELECT id 
    FROM users 
    WHERE username = ? COLLATE NOCASE
  `).get(DEFAULT_ADMIN_USER);

  if (existing) {
    return existing.id;
  }

  // F12: the seed is the one place where the SERVER HOST is handed a plaintext
  // password (by its operator, via the environment). It derives exactly what a
  // browser would (PBKDF2 + HKDF with a fresh salt) and stores bcrypt(authKey),
  // so the account is a normal scheme-2 account and logs in like any other.
  const kdfSalt = newKdfSalt();

  const { authKey } = deriveCredentialsNode(
    DEFAULT_ADMIN_PASS,
    kdfSalt,
    KDF_ITERATIONS
  );

  const hash = bcrypt.hashSync(
    authKey,
    Number(process.env.BCRYPT_ROUNDS) || 12
  );

  const info = db.prepare(`
    INSERT INTO users (
      username,
      password_hash,
      is_admin,
      auth_scheme,
      kdf_salt,
      kdf_iterations
    )
    VALUES (?, ?, 1, 2, ?, ?)
  `).run(
    String(DEFAULT_ADMIN_USER).trim().toLowerCase(),
    hash,
    kdfSalt,
    KDF_ITERATIONS
  );

  console.log('✅ Default admin account created');

  return info.lastInsertRowid;
}

module.exports = {
  seedDatabase,
  createDefaultAdmin
};