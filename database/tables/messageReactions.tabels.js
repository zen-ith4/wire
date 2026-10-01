module.exports = `
CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    message_type TEXT NOT NULL CHECK(message_type IN ('chat', 'dm', 'group')),
    message_id INTEGER NOT NULL,

    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(message_type, message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_lookup
ON message_reactions(message_type, message_id);
`;
