module.exports = `
CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,

  content TEXT NOT NULL DEFAULT ''
    CHECK(length(content) <= 2000),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  read_at TEXT,

  attachment_path TEXT,
  attachment_name TEXT,
  attachment_size INTEGER,
  attachment_mime TEXT,
  attachment_width INTEGER,
  attachment_height INTEGER,

  -- Same reasoning as messages.is_voice_message (see that table).
  is_voice_message INTEGER NOT NULL DEFAULT 0,

  -- Same reasoning as messages.reply_to_id (see that table): no
  -- FOREIGN KEY cascade/null-on-delete, so a reply can still show a
  -- graceful "Original message deleted" fallback after the original
  -- is gone instead of losing the fact that this was a reply at all.
  reply_to_id INTEGER,

  -- Set only when the sender edits this message after sending it.
  -- NULL means never edited. See migrations.js for how this column
  -- is added to pre-existing databases.
  edited_at TEXT DEFAULT NULL,

  FOREIGN KEY (sender_id)
    REFERENCES users(id)
    ON DELETE CASCADE,

  FOREIGN KEY (recipient_id)
    REFERENCES users(id)
    ON DELETE CASCADE,

  CHECK(
    length(content) > 0
    OR attachment_path IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_dm_conversation
ON direct_messages(sender_id, recipient_id);

CREATE INDEX IF NOT EXISTS idx_dm_recipient
ON direct_messages(recipient_id);
`;