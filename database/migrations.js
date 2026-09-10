const VALID_COLUMNS = {
  users: {
    email: "email TEXT",
    email_verified: "email_verified INTEGER NOT NULL DEFAULT 0",
    email_2fa_enabled: "email_2fa_enabled INTEGER NOT NULL DEFAULT 0",
    is_active: "is_active INTEGER NOT NULL DEFAULT 1",

    bio: "bio TEXT",
    avatar_path: "avatar_path TEXT",
    banner_path: "banner_path TEXT",
    accent_color: "accent_color TEXT DEFAULT NULL"
  },

  folders: {
    owner_id: "owner_id INTEGER"
  },

  messages: {
    attachment_path: "attachment_path TEXT",
    attachment_name: "attachment_name TEXT",
    attachment_size: "attachment_size INTEGER",
    attachment_mime: "attachment_mime TEXT",
    attachment_width: "attachment_width INTEGER",
    attachment_height: "attachment_height INTEGER",
    reply_to_id: "reply_to_id INTEGER",
    is_voice_message: "is_voice_message INTEGER NOT NULL DEFAULT 0"
  },

  direct_messages: {
    reply_to_id: "reply_to_id INTEGER",
    is_voice_message: "is_voice_message INTEGER NOT NULL DEFAULT 0",
    attachment_width: "attachment_width INTEGER",
    attachment_height: "attachment_height INTEGER"
  }
};


function runMigrations(db) {
  for (const [table, columns] of Object.entries(VALID_COLUMNS)) {
    const existing = new Set(
      db.prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(column => column.name)
    );

    for (const [column, ddl] of Object.entries(columns)) {
      if (!existing.has(column)) {
        db.exec(
          `ALTER TABLE ${table} ADD COLUMN ${ddl}`
        );
      }
    }
  }

  /*
   * Existing databases may have users with NULL email.
   *
   * SQLite UNIQUE allows multiple NULL values, so this index
   * keeps real email addresses unique without affecting
   * existing accounts that have no email.
   */
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
    ON users(email)
    WHERE email IS NOT NULL
  `);
}


module.exports = {
  runMigrations
};