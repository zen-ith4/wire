module.exports = `
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,

  role TEXT NOT NULL DEFAULT 'member'
    CHECK(role IN ('owner', 'admin', 'member')),

  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Bumped every time this group's Sender Keys are rotated (member
  -- removed/left — see group_key_distributions.epoch). Lets a client
  -- notice its locally-known epoch is behind the group's current one
  -- and self-heal by re-requesting KDMs, without the server ever
  -- reasoning about key material itself.
  key_epoch INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (group_id, user_id),

  FOREIGN KEY (group_id)
    REFERENCES groups(id)
    ON DELETE CASCADE,

  FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_members_user
ON group_members(user_id);
`;
