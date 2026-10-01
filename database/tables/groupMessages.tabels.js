module.exports = `
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  group_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,

  -- Sender-Key AES-GCM envelope (JSON: {version, algorithm, iv,
  -- ciphertext, senderKeyId, counter, ...}), never plaintext. Sized
  -- for the stringified envelope, not the plaintext it wraps — a
  -- JSON-wrapped, base64-encoded AES-GCM ciphertext is meaningfully
  -- larger than the plaintext that went in (see
  -- public/js/crypto/messages/payload.js's MAX_CIPHERTEXT_LENGTH,
  -- 64KB base64). 90000 gives headroom above that plus JSON framing
  -- overhead without being unbounded.
  content TEXT NOT NULL DEFAULT ''
    CHECK(length(content) <= 90000),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  attachment_path TEXT,
  attachment_name TEXT,
  attachment_size INTEGER,
  attachment_mime TEXT,
  attachment_width INTEGER,
  attachment_height INTEGER,

  -- Phase 4: AES-GCM IV (base64) used to encrypt the attachment
  -- bytes with this message's own Sender Key — a fresh IV distinct
  -- from the message text's own counter-derived nonce (reusing a
  -- nonce under the same key breaks AES-GCM entirely). NULL when
  -- there's no attachment.
  attachment_iv TEXT,

  is_voice_message INTEGER NOT NULL DEFAULT 0,

  -- Same reasoning as direct_messages.reply_to_id: no FOREIGN KEY
  -- cascade/null-on-delete, so a reply can still show a graceful
  -- "Original message deleted" fallback after the original is gone.
  reply_to_id INTEGER,

  -- Sender receives ON DELETE CASCADE from users (removing an
  -- account removes their message rows), matching direct_messages.
  -- Removing a *group* (group_id) intentionally cascades too --
  -- there is no server-side plaintext to preserve either way, so
  -- there is nothing worth orphaning these rows for.
  FOREIGN KEY (sender_id)
    REFERENCES users(id)
    ON DELETE CASCADE,

  FOREIGN KEY (group_id)
    REFERENCES groups(id)
    ON DELETE CASCADE,

  CHECK(
    length(content) > 0
    OR attachment_path IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_group_messages_group_created
ON group_messages(group_id, created_at);

CREATE INDEX IF NOT EXISTS idx_group_messages_reply_to
ON group_messages(reply_to_id);
`;
