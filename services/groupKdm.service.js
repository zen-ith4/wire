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
// Delivery is per DEVICE (group_kdm_receipts): a device that signs in later
// still receives keys another device of the same account already consumed.
// deviceId is mandatory.
function getUndeliveredForUser(userId, groupId = null, deviceId) {
  if (!isValidDeviceId(deviceId)) {
    throw new Error('deviceId is required');
  }

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

  sql += ' AND NOT EXISTS (SELECT 1 FROM group_kdm_receipts r WHERE r.kdm_id = k.id AND r.device_id = ?)';
  params.push(deviceId);

  sql += ' ORDER BY k.created_at ASC, k.id ASC';

  return db.prepare(sql).all(...params);
}

// ---------------------------------------------------------------
// device_id registry (F6)
// ---------------------------------------------------------------
const DEVICE_CAP = Number(process.env.GROUP_DEVICE_CAP) || 20;
const DEVICE_NEW_PER_HOUR = Number(process.env.GROUP_DEVICE_NEW_PER_HOUR) || 20;
// An account is never throttled while it has fewer than this many registered
// devices: several browsers, a phone, a desktop app and private windows are
// normal. Tabs of one browser profile share ONE device id, so they never
// count at all.
const DEVICE_GRACE = Number(process.env.GROUP_DEVICE_GRACE) || 5;
const DEVICE_TTL_MS = (Number(process.env.GROUP_DEVICE_TTL_DAYS) || 90) * 86400_000;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function isValidDeviceId(v) {
  return typeof v === 'string' && DEVICE_ID_RE.test(v);
}

function deleteReceiptsForDevice(db, deviceId) {
  // Receipts carry no user id: a device id is only ever written under the
  // account that registered it (touchDevice runs before every write), and a
  // random 64-bit+ id colliding across accounts is not a case worth a column.
  db.prepare('DELETE FROM group_kdm_receipts WHERE device_id = ?').run(deviceId);
}

// Registers / refreshes a device id for a user. Known ids are never throttled.
// New ids: once the account has `grace` devices, at most `newPerHour` new ones
// per hour (429 + Retry-After); and at most `cap` in
// total (the least recently seen one is evicted together with its receipts, so
// a legitimate user who keeps clearing browser data never gets locked out).
function touchDevice(userId, deviceId, { cap = DEVICE_CAP, newPerHour = DEVICE_NEW_PER_HOUR, grace = DEVICE_GRACE, now = Date.now() } = {}) {
  const db = getDb();

  return db.transaction(() => {
    const known = db.prepare(
      'SELECT 1 FROM group_devices WHERE user_id = ? AND device_id = ?'
    ).get(userId, deviceId);

    if (known) {
      db.prepare(
        'UPDATE group_devices SET last_seen_at = ? WHERE user_id = ? AND device_id = ?'
      ).run(now, userId, deviceId);
      return { ok: true };
    }

    const total = db.prepare('SELECT COUNT(*) c FROM group_devices WHERE user_id = ?').get(userId).c;

    if (total >= grace) {
      const recent = db.prepare(
        'SELECT COUNT(*) c, MIN(created_at) oldest FROM group_devices WHERE user_id = ? AND created_at > ?'
      ).get(userId, now - 3600_000);

      if (recent.c >= newPerHour) {
        const retryAfterSec = Math.max(1, Math.ceil((recent.oldest + 3600_000 - now) / 1000));
        return { ok: false, status: 429, error: 'Too many new devices; try again later', retryAfterSec };
      }
    }

    if (total >= cap) {
      const victims = db.prepare(
        'SELECT device_id FROM group_devices WHERE user_id = ? ORDER BY last_seen_at ASC, created_at ASC LIMIT ?'
      ).all(userId, total - cap + 1);

      for (const v of victims) {
        db.prepare('DELETE FROM group_devices WHERE user_id = ? AND device_id = ?').run(userId, v.device_id);
        deleteReceiptsForDevice(db, v.device_id);
      }
    }

    db.prepare(
      'INSERT INTO group_devices (user_id, device_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)'
    ).run(userId, deviceId, now, now);

    return { ok: true };
  })();
}

// TTL pruning: devices not seen for `maxAgeMs` are forgotten together with
// their receipts, and receipts of ids nobody registered (orphans) are dropped.
// A pruned device that comes back simply re-registers and re-drains; consuming
// a KDM it already stored is idempotent on the client.
function pruneStaleDevices({ maxAgeMs = DEVICE_TTL_MS, now = Date.now() } = {}) {
  const db = getDb();

  return db.transaction(() => {
    const stale = db.prepare('SELECT user_id, device_id FROM group_devices WHERE last_seen_at < ?').all(now - maxAgeMs);

    for (const d of stale) {
      db.prepare('DELETE FROM group_devices WHERE user_id = ? AND device_id = ?').run(d.user_id, d.device_id);
      deleteReceiptsForDevice(db, d.device_id);
    }

    const orphans = db.prepare(
      'DELETE FROM group_kdm_receipts WHERE device_id NOT IN (SELECT device_id FROM group_devices)'
    ).run().changes;

    return { devices: stale.length, orphanReceipts: orphans };
  })();
}

let pruneTimer = null;
function startDevicePruner(intervalMs = 6 * 3600_000) {
  if (pruneTimer) return;
  try { pruneStaleDevices(); } catch (e) { console.error('[group-kdm] prune failed', e); }
  pruneTimer = setInterval(() => {
    try { pruneStaleDevices(); } catch (e) { console.error('[group-kdm] prune failed', e); }
  }, intervalMs);
  pruneTimer.unref?.();
}

// Marks a batch of KDM ids delivered TO ONE DEVICE, scoped to the requesting
// user so one user can never mark another user's KDM rows as delivered.
function markDelivered(ids, userId, deviceId) {
  if (!isValidDeviceId(deviceId)) {
    throw new Error('deviceId is required');
  }

  if (!ids || ids.length === 0) return;

  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');

  db.prepare(`
    INSERT OR IGNORE INTO group_kdm_receipts (kdm_id, device_id, delivered_at)
    SELECT id, ?, ? FROM group_key_distributions
    WHERE to_user_id = ? AND id IN (${placeholders})
  `).run(deviceId, new Date().toISOString(), userId, ...ids);
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
  isValidDeviceId,
  touchDevice,
  pruneStaleDevices,
  startDevicePruner,
};
