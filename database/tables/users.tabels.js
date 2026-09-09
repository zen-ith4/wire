module.exports = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,

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
`