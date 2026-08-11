module.exports = `
CREATE TABLE IF NOT EXISTS user_folders (
  user_id INTEGER NOT NULL,
  folder_id INTEGER NOT NULL,

  can_write INTEGER NOT NULL DEFAULT 0
    CHECK(can_write IN (0,1)),

  created_at TEXT DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id, folder_id),

  FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,

  FOREIGN KEY (folder_id)
    REFERENCES folders(id)
    ON DELETE CASCADE
);
`;