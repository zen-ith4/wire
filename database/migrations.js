const { ensureCredentialSchema } = require('./credentialSchema');
const groupsTableSql = require('./tables/groups.tabels');

const VALID_COLUMNS = {
  users: {
    email: "email TEXT",
    email_verified: "email_verified INTEGER NOT NULL DEFAULT 0",
    email_2fa_enabled: "email_2fa_enabled INTEGER NOT NULL DEFAULT 0",
    is_active: "is_active INTEGER NOT NULL DEFAULT 1",

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
    last_seen_at: "last_seen_at TEXT DEFAULT NULL",

    // F12 login scheme (see database/credentialSchema.js and the design doc).
    // Existing rows become auth_scheme = 1 (legacy: bcrypt of the raw password);
    // every code path that creates an account sets 2 explicitly.
    auth_scheme: "auth_scheme INTEGER NOT NULL DEFAULT 1",
    kdf_salt: "kdf_salt TEXT",
    kdf_iterations: "kdf_iterations INTEGER",
    scheme_migrated_at: "scheme_migrated_at TEXT",
    legacy_last_login_at: "legacy_last_login_at TEXT",
    must_change_password: "must_change_password INTEGER NOT NULL DEFAULT 0",
    legacy_login_closed: "legacy_login_closed INTEGER NOT NULL DEFAULT 0",
    legacy_login_closed_at: "legacy_login_closed_at TEXT",
    // DM E2EE v2 floor (docs/e2ee-dm-hardening.md 5.1). Default 1 so every
    // existing row stays on v1 with no backfill. Raised only by
    // scripts/dm-e2ee-optin.mjs. 1C makes this a hard ratchet.
    dm_e2ee_min_version: "dm_e2ee_min_version INTEGER NOT NULL DEFAULT 1",

    // Session revocation (utils/jwt.js). Bumped on password change; every
    // session-token check compares the token's `tv` claim against it.
    token_version: "token_version INTEGER NOT NULL DEFAULT 0"
  },

  folders: {
    owner_id: "owner_id INTEGER"
  },

  group_members: {
    // Set (CURRENT_TIMESTAMP, same format as joined_at) whenever a member's
    // role changes. Auto-succession ranks admins by
    // COALESCE(role_changed_at, joined_at). NULL = role never changed.
    role_changed_at: "role_changed_at TEXT"
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


/*
 * The site has exactly one admin (users.is_admin = 1). Older databases may
 * have several. Keep the oldest admin and demote the rest to normal users, so
 * the unique index in indexes.js can be created. This is logged loudly
 * because it changes who holds the role.
 */
function enforceSingleAdmin(db) {
  const admins = db
    .prepare('SELECT id, username FROM users WHERE is_admin = 1 ORDER BY id')
    .all();

  if (admins.length <= 1) {
    return;
  }

  const [keep, ...demoted] = admins;

  db.prepare('UPDATE users SET is_admin = 0 WHERE is_admin = 1 AND id <> ?')
    .run(keep.id);

  console.warn(
    `⚠️  Found ${admins.length} admin accounts; the site allows exactly one. ` +
      `Kept "${keep.username}" (id ${keep.id}) as admin. ` +
      `Demoted to normal users: ${demoted.map(a => `"${a.username}" (id ${a.id})`).join(', ')}.`
  );
}

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

  // Must run before createIndexes(), which adds the one-admin unique index.
  enforceSingleAdmin(db);

  ensureCredentialSchema(db);

  // DM E2EE v2 ratchet (docs/e2ee-dm-hardening.md 5.1-5.5, STEP 1C).
  // Only raises, never lowers. Both triggers idempotent (IF NOT EXISTS).
  // Explicit IS NULL + typeof checks: NULL NOT IN (1,2) is NULL in SQLite,
  // and INTEGER affinity must not coerce '2' silently.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_users_dm_e2ee_min_version_upd
    BEFORE UPDATE OF dm_e2ee_min_version ON users
    WHEN NEW.dm_e2ee_min_version IS NULL
      OR typeof(NEW.dm_e2ee_min_version) <> 'integer'
      OR NEW.dm_e2ee_min_version NOT IN (1,2)
      OR NEW.dm_e2ee_min_version < OLD.dm_e2ee_min_version
    BEGIN SELECT RAISE(ABORT, 'dm_e2ee_min_version: invalid or lowering'); END;

    CREATE TRIGGER IF NOT EXISTS trg_users_dm_e2ee_min_version_ins
    BEFORE INSERT ON users
    WHEN NEW.dm_e2ee_min_version IS NULL
      OR typeof(NEW.dm_e2ee_min_version) <> 'integer'
      OR NEW.dm_e2ee_min_version NOT IN (1,2)
    BEGIN SELECT RAISE(ABORT, 'dm_e2ee_min_version: invalid'); END;
  `);
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


/*
 * groups.created_by used to be NOT NULL ... ON DELETE CASCADE, so deleting
 * the creator's account deleted the whole group even after ownership had
 * moved to someone else. It is now nullable with ON DELETE SET NULL (see
 * tables/groups.tabels.js). SQLite cannot alter a FOREIGN KEY, so an
 * existing database needs the table rebuilt.
 *
 * MUST be called OUTSIDE any transaction (database/schema.js does): the
 * foreign_keys pragma is a no-op inside one, and with foreign keys ON,
 * DROP TABLE groups would run an implicit DELETE that cascades into
 * group_members / group_messages / group_key_distributions and wipe them.
 * Idempotent: detects the old shape from the stored CREATE TABLE sql.
 */
function migrateGroupsCreatedByNullable(db) {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'groups'
  `).get();

  // Fresh install (table not created yet / already the new shape).
  if (!row || !/created_by\s+INTEGER\s+NOT\s+NULL/i.test(row.sql)) return;

  const createNew = groupsTableSql.replace(
    'CREATE TABLE IF NOT EXISTS groups (',
    'CREATE TABLE groups_new ('
  );
  if (createNew === groupsTableSql) {
    throw new Error('migrateGroupsCreatedByNullable: could not derive groups_new DDL');
  }

  const foreignKeysWereOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');

  try {
    const oldSeq = db.prepare(`
      SELECT seq FROM sqlite_sequence WHERE name = 'groups'
    `).get();

    db.transaction(() => {
      db.exec(createNew);

      db.exec(`
        INSERT INTO groups_new (id, name, avatar_path, created_by, created_at)
        SELECT id, name, avatar_path, created_by, created_at FROM groups
      `);

      db.exec('DROP TABLE groups');
      db.exec('ALTER TABLE groups_new RENAME TO groups');

      // Keep AUTOINCREMENT from ever reusing the id of a deleted group.
      if (oldSeq) {
        const cur = db.prepare(`
          SELECT seq FROM sqlite_sequence WHERE name = 'groups'
        `).get();
        if (cur) {
          db.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'groups'`)
            .run(oldSeq.seq);
        } else {
          db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('groups', ?)`)
            .run(oldSeq.seq);
        }
      }

      const violations = db.pragma('foreign_key_check');
      if (violations.length > 0) {
        throw new Error(
          `migrateGroupsCreatedByNullable: foreign_key_check found ${violations.length} violation(s)`
        );
      }
    })();
  } finally {
    if (foreignKeysWereOn) db.pragma('foreign_keys = ON');
  }
}


module.exports = {
  migrateGroupsCreatedByNullable,
  runMigrations
};