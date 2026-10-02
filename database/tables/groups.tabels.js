module.exports = `
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  name TEXT NOT NULL
    CHECK(length(name) > 0 AND length(name) <= 100),

  avatar_path TEXT,

  created_by INTEGER NOT NULL,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON DELETE CASCADE
);
`;
