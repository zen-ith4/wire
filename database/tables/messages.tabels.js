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

  -- Marks an audio attachment as a recorded voice message (vs. a
  -- normal uploaded audio file) so the frontend knows which player
  -- component to render. See migrations.js for the upgrade path on
  -- existing databases.
  is_voice_message INTEGER NOT NULL DEFAULT 0,

  -- Message this one is replying to (if any). Deliberately NOT a
  -- FOREIGN KEY with ON DELETE CASCADE/SET NULL: when the original
  -- message is deleted we want this id to keep pointing at it, so the
  -- reply pipeline can still detect "was a reply" and show a graceful
  -- "Original message deleted" fallback instead of silently losing
  -- that fact (see chat.service.js's CHAT_SELECT LEFT JOIN).
  reply_to_id INTEGER,

  FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_user_id
ON messages(user_id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
ON messages(created_at);
`;