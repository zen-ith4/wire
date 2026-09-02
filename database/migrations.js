const VALID_COLUMNS = {
  users: {
    bio: "bio TEXT",
    avatar_path: "avatar_path TEXT",
    banner_path: "banner_path TEXT",
    accent_color: "accent_color TEXT DEFAULT NULL",
    is_active: "is_active INTEGER DEFAULT 1"
  },

  folders: {
    owner_id: "owner_id INTEGER"
  },

  messages: {
    attachment_path: "attachment_path TEXT",
    attachment_name: "attachment_name TEXT",
    attachment_size: "attachment_size INTEGER",
    attachment_mime: "attachment_mime TEXT",
    reply_to_id: "reply_to_id INTEGER",
    // Distinguishes a recorded voice message from a normal uploaded
    // audio attachment. Both share the same attachment_* columns
    // (same upload/storage/streaming pipeline) — this flag is only
    // consulted by the frontend to decide which player component to
    // mount (dedicated voice-message player vs. the generic audio
    // attachment player). Not inferable from attachment_mime alone,
    // since a user-uploaded file can legitimately be audio/webm too.
    is_voice_message: "is_voice_message INTEGER NOT NULL DEFAULT 0"
  },

  direct_messages: {
    reply_to_id: "reply_to_id INTEGER",
    is_voice_message: "is_voice_message INTEGER NOT NULL DEFAULT 0"
  }
};

function runMigrations(db) {

  for (const [table, columns] of Object.entries(VALID_COLUMNS)) {

    const existing = new Set(
      db.prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(c => c.name)
    );

    for (const [column, ddl] of Object.entries(columns)) {

      if (!existing.has(column)) {
        db.exec(
          `ALTER TABLE ${table} ADD COLUMN ${ddl}`
        );
      }

    }
  }
}

module.exports = {
  runMigrations
};