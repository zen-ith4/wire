// database/credentialSchema.js
//
// F12 (login scheme) schema pieces that are not plain `ADD COLUMN`s:
// the migration-ticket and key-rotation tables, and the triggers that make the
// invariants hold even if a controller has a bug. Everything is idempotent
// (IF NOT EXISTS) and runs inside ensureSchema()'s transaction.
//
// users.auth_scheme: 1 = legacy (password_hash = bcrypt(raw password)),
//                    2 = bcrypt(authKey), the server never sees the password.
// New columns themselves are declared in database/migrations.js (VALID_COLUMNS).

const MIN_KDF_ITERATIONS = 600000;

function ensureCredentialSchema(db) {
  db.exec(`
    -- One active single-use ticket per user, issued only by a successful
    -- legacy login (after email verification / 2FA). Only the SHA-256 is stored.
    CREATE TABLE IF NOT EXISTS auth_migration_tickets (
      user_id INTEGER PRIMARY KEY,
      ticket_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Audit log of explicit identity key rotations (the public key is write-once
    -- otherwise).
    CREATE TABLE IF NOT EXISTS identity_key_rotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      old_public_key TEXT NOT NULL,
      new_public_key TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_identity_key_rotations_user
    ON identity_key_rotations(user_id);

    -- Anti-downgrade: the scheme only ever goes up.
    CREATE TRIGGER IF NOT EXISTS trg_users_auth_scheme_monotonic
    BEFORE UPDATE OF auth_scheme ON users
    WHEN NEW.auth_scheme < OLD.auth_scheme
    BEGIN
      SELECT RAISE(ABORT, 'auth_scheme downgrade refused');
    END;

    -- A scheme-2 account must always carry its KDF parameters, at or above the floor.
    CREATE TRIGGER IF NOT EXISTS trg_users_scheme2_params_insert
    BEFORE INSERT ON users
    WHEN NEW.auth_scheme = 2 AND (
      NEW.kdf_salt IS NULL OR NEW.kdf_iterations IS NULL OR NEW.kdf_iterations < ${MIN_KDF_ITERATIONS}
    )
    BEGIN
      SELECT RAISE(ABORT, 'scheme 2 requires kdf_salt and kdf_iterations >= ${MIN_KDF_ITERATIONS}');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_users_scheme2_params_update
    BEFORE UPDATE OF auth_scheme, kdf_salt, kdf_iterations ON users
    WHEN NEW.auth_scheme = 2 AND (
      NEW.kdf_salt IS NULL OR NEW.kdf_iterations IS NULL OR NEW.kdf_iterations < ${MIN_KDF_ITERATIONS}
    )
    BEGIN
      SELECT RAISE(ABORT, 'scheme 2 requires kdf_salt and kdf_iterations >= ${MIN_KDF_ITERATIONS}');
    END;

    -- The identity record format never goes backwards either (v2 -> v1).
    CREATE TRIGGER IF NOT EXISTS trg_identity_keys_version_monotonic
    BEFORE UPDATE OF version ON identity_keys
    WHEN NEW.version < OLD.version
    BEGIN
      SELECT RAISE(ABORT, 'identity version downgrade refused');
    END;
  `);
}

module.exports = { ensureCredentialSchema, MIN_KDF_ITERATIONS };
