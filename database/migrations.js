const VALID_COLUMNS = {
  users: {
    email: "email TEXT",
    email_verified: "email_verified INTEGER NOT NULL DEFAULT 0",
    email_2fa_enabled: "email_2fa_enabled INTEGER NOT NULL DEFAULT 0",
    is_active: "is_active INTEGER NOT NULL DEFAULT 1",
    kdf_salt: "kdf_salt TEXT",
    kdf_iterations: "kdf_iterations INTEGER",

    bio: "bio TEXT",
    avatar_path: "avatar_path TEXT",
    banner_path: "banner_path TEXT",
    accent_color: "accent_color TEXT DEFAULT NULL",

    // Presence & read-receipt privacy (see services/user.service.js and
    // config/socket.js). Both default to enabled so existing accounts
    // keep today's behavior after upgrading.
    show_last_seen: "show_last_seen INTEGER NOT NULL DEFAULT 1",
    send_read_receipts: "send_read_receipts INTEGER NOT NULL DEFAULT 1",

    // Persisted so "Last seen" survives a server restart / the user
    // simply never having connected since upgrading. Online/offline
    // itself stays in-memory only (services/presence.service.js) —
    // this is only the timestamp of their last disconnect.
    last_seen_at: "last_seen_at TEXT DEFAULT NULL"
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
    attachment_height: "attachment_height INTEGER",

    // End-to-end encrypted DM attachments (see dm.controller.js).
    // NULL for every pre-existing (legacy plaintext) attachment row.
    attachment_meta: "attachment_meta TEXT",
    attachment_iv: "attachment_iv TEXT",

    // Read-receipt ("seen tick") visible to the SENDER. Distinct from
    // read_at (below): read_at is the recipient's own read/unread
    // state and is always set when they open the conversation;
    // seen_at is only ever set alongside it when the recipient had
    // "Send Read Receipts" enabled at that moment, so disabling the
    // setting can never retroactively hide or reveal anything (see
    // dm.service.js's markRead).
    seen_at: "seen_at TEXT DEFAULT NULL",

    // Set only when the sender edits a text DM after sending it (see
    // dm.service.js's updateDmMessageContent). Null for every message
    // that has never been edited, including all pre-existing rows —
    // no backfill needed since NULL is exactly "never edited".
    edited_at: "edited_at TEXT DEFAULT NULL"
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

  migrateMessageReactionsToAllowGroup(db);
}

/*
 * message_reactions.message_type's CHECK constraint originally only
 * allowed ('chat', 'dm') — group reactions (Phase 3) need 'group'
 * added too. SQLite has no ALTER TABLE for CHECK constraints, so an
 * existing database needs the standard SQLite rebuild: create a new
 * table with the constraint we actually want, copy every row across
 * unchanged, drop the old table, rename the new one into place.
 *
 * Detected (rather than tracked via a version number this codebase
 * doesn't otherwise keep) by reading the table's own stored CREATE
 * TABLE SQL back from sqlite_master and checking whether 'group' is
 * already part of it — idempotent, and correct for both "never
 * migrated" and "already migrated" without any extra state.
 */
function migrateMessageReactionsToAllowGroup(db) {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'message_reactions'
  `).get();

  // Fresh install: tables/messageReactions.tabels.js already created
  // it with 'group' included — nothing to migrate.
  if (!row || row.sql.includes("'group'")) return;

  const transaction = db.transaction(() => {
    db.exec(`
      CREATE TABLE message_reactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        message_type TEXT NOT NULL CHECK(message_type IN ('chat', 'dm', 'group')),
        message_id INTEGER NOT NULL,

        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,

        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(message_type, message_id, user_id, emoji)
      );

      INSERT INTO message_reactions_new
        SELECT id, message_type, message_id, user_id, emoji, created_at
        FROM message_reactions;

      DROP TABLE message_reactions;

      ALTER TABLE message_reactions_new RENAME TO message_reactions;

      CREATE INDEX IF NOT EXISTS idx_message_reactions_lookup
      ON message_reactions(message_type, message_id);
    `);
  });

  transaction();
}


module.exports = {
  runMigrations
};