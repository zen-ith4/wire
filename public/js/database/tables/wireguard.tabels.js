module.exports = `
CREATE TABLE IF NOT EXISTS wireguard_peers (
  public_key TEXT PRIMARY KEY,

  user_id INTEGER NOT NULL,

  name TEXT NOT NULL DEFAULT 'device',

  address TEXT,

  allowed_ips TEXT,

  last_handshake TEXT,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  enabled INTEGER NOT NULL DEFAULT 1
    CHECK(enabled IN (0,1)),

  FOREIGN KEY(user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);
`;