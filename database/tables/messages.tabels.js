module.exports = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  user_id INTEGER NOT NULL,

  content TEXT NOT NULL
    CHECK(length(content) <= 2000),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  attachment_path TEXT,
  attachment_name TEXT,
  attachment_size INTEGER,
  attachment_mime TEXT,

  FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_user_id
ON messages(user_id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
ON messages(created_at);
`;