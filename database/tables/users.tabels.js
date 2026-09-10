module.exports = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,

    email_verified INTEGER NOT NULL DEFAULT 0,
    email_2fa_enabled INTEGER NOT NULL DEFAULT 0,

    is_admin INTEGER NOT NULL DEFAULT 0,

    bio TEXT DEFAULT NULL,
    avatar_path TEXT DEFAULT NULL,
    banner_path TEXT DEFAULT NULL,
    accent_color TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username
ON users(username);

CREATE TABLE IF NOT EXISTS identity_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user_id INTEGER NOT NULL UNIQUE,

    public_key TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,

    kdf TEXT NOT NULL,
    kdf_params TEXT NOT NULL,

    salt TEXT NOT NULL,
    iv TEXT NOT NULL,

    version INTEGER NOT NULL DEFAULT 1,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_identity_keys_user_id
ON identity_keys(user_id);

CREATE TABLE IF NOT EXISTS email_verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user_id INTEGER NOT NULL,

    code_hash TEXT NOT NULL,

    expires_at INTEGER NOT NULL,

    attempts INTEGER NOT NULL DEFAULT 0,

    created_at INTEGER NOT NULL,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_verification_codes_user_id
ON email_verification_codes(user_id);

CREATE TABLE IF NOT EXISTS email_2fa_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user_id INTEGER NOT NULL,

    code_hash TEXT NOT NULL,

    expires_at INTEGER NOT NULL,

    attempts INTEGER NOT NULL DEFAULT 0,

    created_at INTEGER NOT NULL,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_2fa_codes_user_id
ON email_2fa_codes(user_id);
`;