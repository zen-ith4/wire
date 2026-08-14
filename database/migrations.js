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
    attachment_mime: "attachment_mime TEXT"
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