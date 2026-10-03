module.exports = `
-- Durable mailbox for Key Distribution Messages (KDMs): each row is
-- one Sender Key, pairwise-wrapped (existing DM ECDH+AES-GCM
-- envelope) for exactly one recipient. The server never sees the
-- Sender Key itself -- wrapped_key is opaque ciphertext it only
-- stores and relays. See plan_prompt.md section 3 for the full
-- Sender Keys scheme. A KDM row is addressed to an ACCOUNT (identity
-- keys are portable per-account, so one wrap decrypts on every device
-- of that user), but DELIVERY is tracked per device: see
-- group_kdm_receipts below. Each device mints its own Sender Key, so a
-- member with N devices produces N keys per epoch.
CREATE TABLE IF NOT EXISTS group_key_distributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  group_id INTEGER NOT NULL,

  from_user_id INTEGER NOT NULL,
  to_user_id INTEGER NOT NULL,

  wrapped_key TEXT NOT NULL,

  -- Rotation generation this Sender Key belongs to. Paired with
  -- group_members.key_epoch so a client can tell whether the KDM(s)
  -- it has drained are for the group's *current* Sender Key
  -- generation, or a stale one it should ignore / re-request past.
  epoch INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT,

  FOREIGN KEY (group_id)
    REFERENCES groups(id)
    ON DELETE CASCADE,

  FOREIGN KEY (from_user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,

  FOREIGN KEY (to_user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

-- Primary access pattern: "give me everything undelivered addressed
-- to me in this group" (draining on connect/reconnect/membership
-- change, per Phase 3).
CREATE INDEX IF NOT EXISTS idx_gkd_recipient_undelivered
ON group_key_distributions(to_user_id, group_id, delivered_at);

CREATE INDEX IF NOT EXISTS idx_gkd_group_epoch
ON group_key_distributions(group_id, epoch);

-- Per-DEVICE delivery receipts. delivered_at above is per ACCOUNT: the first
-- device to ack a KDM consumed it for every other device of that account,
-- so a second device (phone, new browser) never received keys the first had
-- already drained and could not decrypt those senders at all (MD-4).
-- device_id is an opaque random id each client generates once per browser
-- profile; it is only a delivery cursor, not an identity or credential.
-- Clients that send no device_id keep using delivered_at (legacy behaviour).
CREATE TABLE IF NOT EXISTS group_kdm_receipts (
  kdm_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (kdm_id, device_id),

  FOREIGN KEY (kdm_id)
    REFERENCES group_key_distributions(id)
    ON DELETE CASCADE
);

-- Registry of the device ids each user has presented (F6). device_id is only
-- a delivery cursor, but unbounded distinct ids would let one account grow
-- group_kdm_receipts without limit and force full-mailbox re-downloads, so the
-- server caps the number of ids per user (least recently seen is evicted with
-- its receipts), rate-limits creation of new ids, and prunes stale ones.
CREATE TABLE IF NOT EXISTS group_devices (
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,

  PRIMARY KEY (user_id, device_id),

  FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_devices_seen
ON group_devices(last_seen_at);
`;
