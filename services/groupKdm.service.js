const { getDb } = require('../config/database');

// One row = one Sender Key, pairwise-wrapped for exactly one
// recipient (which may be the sender themself — see plan_prompt.md
// 2.1). This layer never looks inside wrapped_key.

function insertKdm(groupId, fromUserId, toUserId, wrappedKey, epoch) {
  return getDb().prepare(`
    INSERT INTO group_key_distributions (group_id, from_user_id, to_user_id, wrapped_key, epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(groupId, fromUserId, toUserId, wrappedKey, epoch);
}

// Fan-out helper: same Sender Key, wrapped once per recipient by the
// caller (wrapping is client-side ECDH — the caller passes one
// wrapped_key per recipient, already produced for that recipient's
// identity public key), inserted as one row each in a single
// transaction so a KDM round never leaves half its recipients
// without a row if something fails partway through.
function insertKdmBatch(groupId, fromUserId, epoch, recipients) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO group_key_distributions (group_id, from_user_id, to_user_id, wrapped_key, epoch)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((items) => {
    for (const { toUserId, wrappedKey } of items) {
      insert.run(groupId, fromUserId, toUserId, wrappedKey, epoch);
    }
  });

  transaction(recipients);
}

// Validated, atomic KDM fan-out (F5). Everything that decides whether the
// batch may land is read INSIDE the same transaction that inserts it, so a
// membership change can never slip between "check" and "write":
//   - the sender must be a current member of the group,
//   - `epoch` must equal the sender's current key_epoch (a key tagged with a
//     past/future epoch is never stored),
//   - every recipient must be a current member.
// All-or-nothing: on any failure no row is written.
// Returns {ok:true, count} or {ok:false, status, error}.
function submitKdmBatchChecked(groupId, fromUserId, epoch, recipients) {
  const db = getDb();

  const run = db.transaction((items) => {
    const sender = db.prepare(
      'SELECT key_epoch FROM group_members WHERE group_id = ? AND user_id = ?'
    ).get(groupId, fromUserId);

    if (!sender) {
      return { ok: false, status: 403, error: 'Not a member of this group' };
    }

    if (sender.key_epoch !== epoch) {
      return { ok: false, status: 409, error: 'Stale epoch', current_epoch: sender.key_epoch };
    }

    const isMemberStmt = db.prepare(
      'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'
    );

    for (const { toUserId } of items) {
      if (!isMemberStmt.get(groupId, toUserId)) {
        return { ok: false, status: 400, error: `Recipient ${toUserId} is not a current member` };
      }
    }

    const insert = db.prepare(`
      INSERT INTO group_key_distributions (group_id, from_user_id, to_user_id, wrapped_key, epoch)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const { toUserId, wrappedKey } of items) {
      insert.run(groupId, fromUserId, toUserId, wrappedKey, epoch);
    }

    return { ok: true, count: items.length };
  });

  return run(recipients);
}

// Everything this user (or, with deviceId, this DEVICE) has not yet
// consumed, restricted to groups the user is CURRENTLY a member of. The
// membership join matters: without it a user who was removed from a group
// could still drain KDM rows addressed to them for that group.
//
// deviceId omitted -> legacy per-account semantics (delivered_at).
// deviceId given   -> per-device semantics (group_kdm_receipts); a device
//                     that signs in later still receives keys another
//                     device of the same account already consumed.
function getUndeliveredForUser(userId, groupId = null, deviceId = null) {
  const db = getDb();

  const params = [userId];
  let sql = `
    SELECT k.id, k.group_id, k.from_user_id, k.to_user_id, k.wrapped_key, k.epoch, k.created_at
    FROM group_key_distributions k
    JOIN group_members m ON m.group_id = k.group_id AND m.user_id = k.to_user_id
    WHERE k.to_user_id = ?
  `;

  if (groupId != null) {
    sql += ' AND k.group_id = ?';
    params.push(groupId);
  }

  if (deviceId) {
    sql += ' AND NOT EXISTS (SELECT 1 FROM group_kdm_receipts r WHERE r.kdm_id = k.id AND r.device_id = ?)';
    params.push(deviceId);
  } else {
    sql += ' AND k.delivered_at IS NULL';
  }

  sql += ' ORDER BY k.created_at ASC, k.id ASC';

  return db.prepare(sql).all(...params);
}

// Marks a batch of KDM ids delivered, scoped to the requesting user
// so one user draining their mailbox can never mark another user's
// KDM rows as delivered. With deviceId only that device's receipt is
// written.
function markDelivered(ids, userId, deviceId = null) {
  if (!ids || ids.length === 0) return;

  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');

  if (deviceId) {
    db.prepare(`
      INSERT OR IGNORE INTO group_kdm_receipts (kdm_id, device_id, delivered_at)
      SELECT id, ?, ? FROM group_key_distributions
      WHERE to_user_id = ? AND id IN (${placeholders})
    `).run(deviceId, new Date().toISOString(), userId, ...ids);
    return;
  }

  db.prepare(`
    UPDATE group_key_distributions
    SET delivered_at = ?
    WHERE to_user_id = ? AND id IN (${placeholders})
  `).run(new Date().toISOString(), userId, ...ids);
}

// Drops every KDM addressed to a user for one group (called when they are
// removed or leave) so nothing wrapped for them lingers in the mailbox.
function purgeKdmsForUser(groupId, userId) {
  getDb().prepare(
    'DELETE FROM group_key_distributions WHERE group_id = ? AND to_user_id = ?'
  ).run(groupId, userId);
}

module.exports = {
  insertKdm,
  insertKdmBatch,
  submitKdmBatchChecked,
  getUndeliveredForUser,
  markDelivered,
  purgeKdmsForUser,
};
