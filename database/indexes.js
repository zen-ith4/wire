function createIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_created_at
    ON messages(created_at);

    CREATE INDEX IF NOT EXISTS idx_messages_user
    ON messages(user_id);

    CREATE INDEX IF NOT EXISTS idx_dm_created_at
    ON direct_messages(created_at);

    CREATE INDEX IF NOT EXISTS idx_dm_sender_recipient
    ON direct_messages(sender_id, recipient_id);

    CREATE INDEX IF NOT EXISTS idx_dm_recipient_sender
    ON direct_messages(recipient_id, sender_id);

    CREATE INDEX IF NOT EXISTS idx_dm_unread
    ON direct_messages(recipient_id, read_at);

    CREATE INDEX IF NOT EXISTS idx_messages_reply_to
    ON messages(reply_to_id);

    CREATE INDEX IF NOT EXISTS idx_dm_reply_to
    ON direct_messages(reply_to_id);

    CREATE INDEX IF NOT EXISTS idx_email_verification_codes_user_id
    ON email_verification_codes(user_id);

    -- At most one owner per group, enforced by the database. Role
    -- changes that hand ownership over must demote/remove the old owner
    -- first (services/groups.service.js does, inside a transaction).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_one_owner
    ON group_members(group_id)
    WHERE role = 'owner';
  `);
}

module.exports = {
  createIndexes
};