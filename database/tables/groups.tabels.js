module.exports = `
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  name TEXT NOT NULL
    CHECK(length(name) > 0 AND length(name) <= 100),

  avatar_path TEXT,

  -- Informational only (who first created the group). Nullable +
  -- ON DELETE SET NULL so deleting the creator's account never takes
  -- the group with it. Permissions NEVER read this column: the one
  -- real owner is the group_members row with role = 'owner'.
  created_by INTEGER,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON DELETE SET NULL
);
`;
