const fs = require('fs');
const path = require('path');
const { getDb } = require('../config/database');
const constants = require('../config/constants');

// همهٔ کوئری‌های خام گروه‌ها اینجاست — کنترلر هیچ SQL ننویسد.
// (See dm.service.js / chat.service.js for the same split.)

const GROUP_SELECT = `
  SELECT g.id, g.name, g.avatar_path, g.created_by, g.created_at
  FROM groups g
`;

function createGroup(name, createdBy) {
  const db = getDb();

  const transaction = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO groups (name, created_by)
      VALUES (?, ?)
    `).run(name, createdBy);

    const groupId = info.lastInsertRowid;

    // Creator is always the first member, as owner. This happens in
    // the same transaction as the INSERT so a group can never
    // momentarily exist with zero members.
    db.prepare(`
      INSERT INTO group_members (group_id, user_id, role)
      VALUES (?, ?, 'owner')
    `).run(groupId, createdBy);

    return groupId;
  });

  const groupId = transaction();
  return findGroupById(groupId);
}

function findGroupById(groupId) {
  return getDb().prepare(`${GROUP_SELECT} WHERE g.id = ?`).get(groupId);
}

// Groups the given user currently belongs to, with their role and
// current key_epoch in that group — a client needs both right away
// to know whether it's missing a Sender Key rotation (see
// group_members.key_epoch).
function listGroupsForUser(userId) {
  return getDb().prepare(`
    SELECT g.id, g.name, g.avatar_path, g.created_by, g.created_at,
           gm.role, gm.key_epoch, gm.joined_at
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at DESC
  `).all(userId);
}

function isMember(groupId, userId) {
  return !!getDb().prepare(`
    SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?
  `).get(groupId, userId);
}

function getMembership(groupId, userId) {
  return getDb().prepare(`
    SELECT group_id, user_id, role, joined_at, role_changed_at, key_epoch
    FROM group_members
    WHERE group_id = ? AND user_id = ?
  `).get(groupId, userId);
}

function getMembers(groupId) {
  return getDb().prepare(`
    SELECT gm.user_id, gm.role, gm.joined_at, gm.role_changed_at, gm.key_epoch,
           u.username, u.avatar_path, u.accent_color
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at ASC
  `).all(groupId);
}

function getMemberUserIds(groupId) {
  return getDb().prepare(`
    SELECT user_id FROM group_members WHERE group_id = ?
  `).all(groupId).map(r => r.user_id);
}

function memberCount(groupId) {
  return getDb().prepare(`
    SELECT COUNT(*) c FROM group_members WHERE group_id = ?
  `).get(groupId).c;
}

// Adds a member at the group's *current* epoch (not 0) — a newcomer
// only ever needs to be caught up to the Sender Keys in flight right
// now (Section 3, step 5: "no backfill"), and starting them at the
// group's live epoch is what lets the self-heal check in Phase 3
// ("is my epoch behind the group's?") work correctly for a member
// who joined mid-lifetime rather than at epoch 0.
function addMember(groupId, userId, role = 'member') {
  const currentEpoch = getDb().prepare(`
    SELECT COALESCE(MAX(key_epoch), 0) e FROM group_members WHERE group_id = ?
  `).get(groupId).e;

  return getDb().prepare(`
    INSERT INTO group_members (group_id, user_id, role, key_epoch)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(group_id, user_id) DO NOTHING
  `).run(groupId, userId, role, currentEpoch);
}

function removeMember(groupId, userId) {
  return getDb().prepare(`
    DELETE FROM group_members WHERE group_id = ? AND user_id = ?
  `).run(groupId, userId);
}

function renameGroup(groupId, name) {
  return getDb().prepare(`
    UPDATE groups SET name = ? WHERE id = ?
  `).run(name, groupId);
}

function setGroupAvatar(groupId, avatarPath) {
  return getDb().prepare(`
    UPDATE groups SET avatar_path = ? WHERE id = ?
  `).run(avatarPath, groupId);
}

function deleteGroup(groupId) {
  // ON DELETE CASCADE on group_members / group_messages /
  // group_key_distributions takes care of the rest.
  return getDb().prepare(`DELETE FROM groups WHERE id = ?`).run(groupId);
}

// Bumps every remaining member's key_epoch by 1 in one statement —
// used whenever a member is removed/leaves and the remaining members
// must rotate their Sender Key (Section 3, step 4). This only moves
// the *counter* remaining members can compare themselves against;
// it does not itself create or distribute the new Sender Key — that
// happens client-side (Phase 2) once each remaining member's client
// notices its local epoch is behind this and rotates + redistributes.
function bumpEpochForRemainingMembers(groupId) {
  return getDb().prepare(`
    UPDATE group_members SET key_epoch = key_epoch + 1 WHERE group_id = ?
  `).run(groupId);
}

// ---------------------------------------------------------------
// Roles, ownership and succession
// ---------------------------------------------------------------
//
// The one real owner of a group is the group_members row with
// role = 'owner' (a unique index guarantees at most one per group).
// groups.created_by is informational only and is never consulted for
// permissions. role_changed_at uses CURRENT_TIMESTAMP so it compares
// correctly against joined_at (same text format).

function unlinkQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to delete group file:', err.message);
    }
  }
}

// Who inherits ownership when the current owner goes away: the oldest
// admin (by when they became admin, falling back to when they joined),
// else the oldest plain member. Returns a user id or null. Ties break on
// user_id so the result is deterministic. Call it while the departing
// owner is already out of the group (or pass them as excludeUserId).
function pickSuccessor(groupId, excludeUserId = null) {
  const db = getDb();

  const admin = db.prepare(`
    SELECT user_id FROM group_members
    WHERE group_id = ? AND role = 'admin' AND user_id IS NOT ?
    ORDER BY COALESCE(role_changed_at, joined_at) ASC, joined_at ASC, user_id ASC
    LIMIT 1
  `).get(groupId, excludeUserId);
  if (admin) return admin.user_id;

  const member = db.prepare(`
    SELECT user_id FROM group_members
    WHERE group_id = ? AND role = 'member' AND user_id IS NOT ?
    ORDER BY joined_at ASC, user_id ASC
    LIMIT 1
  `).get(groupId, excludeUserId);

  return member ? member.user_id : null;
}

// Owner -> someone else, atomically. The old owner is demoted to admin
// BEFORE the target is promoted so the one-owner unique index is never
// violated mid-way. Re-validates inside the transaction.
// Returns { ok: true } or { ok: false, reason }.
function transferOwnership(groupId, fromUserId, toUserId) {
  const db = getDb();

  return db.transaction(() => {
    const from = getMembership(groupId, fromUserId);
    if (!from || from.role !== 'owner') return { ok: false, reason: 'not_owner' };
    if (fromUserId === toUserId) return { ok: false, reason: 'self' };

    const target = getMembership(groupId, toUserId);
    if (!target) return { ok: false, reason: 'not_member' };

    db.prepare(`
      UPDATE group_members
      SET role = 'admin', role_changed_at = CURRENT_TIMESTAMP
      WHERE group_id = ? AND user_id = ?
    `).run(groupId, fromUserId);

    db.prepare(`
      UPDATE group_members
      SET role = 'owner', role_changed_at = CURRENT_TIMESTAMP
      WHERE group_id = ? AND user_id = ?
    `).run(groupId, toUserId);

    return { ok: true };
  })();
}

// member -> admin. Only changes a row that is currently 'member'; the
// caller checks the target's membership/role first for a clear error.
function promoteToAdmin(groupId, userId) {
  return getDb().prepare(`
    UPDATE group_members
    SET role = 'admin', role_changed_at = CURRENT_TIMESTAMP
    WHERE group_id = ? AND user_id = ? AND role = 'member'
  `).run(groupId, userId);
}

// admin -> member. Only changes a row that is currently 'admin'.
function demoteAdmin(groupId, userId) {
  return getDb().prepare(`
    UPDATE group_members
    SET role = 'member', role_changed_at = CURRENT_TIMESTAMP
    WHERE group_id = ? AND user_id = ? AND role = 'admin'
  `).run(groupId, userId);
}

// Deletes a group and everything that hangs off it, in one transaction.
// ON DELETE CASCADE covers group_members / group_messages /
// group_key_distributions (+ receipts); message_reactions has no FK to
// group_messages, so group reactions are removed explicitly. Returns the
// absolute paths of files (attachments, avatar) the caller should unlink
// AFTER this returns — never inside the transaction.
function deleteGroupWithCleanup(groupId) {
  const db = getDb();

  return db.transaction(() => {
    const files = [];

    const group = findGroupById(groupId);
    if (!group) return { deleted: false, files };

    if (group.avatar_path) {
      files.push(path.join(constants.AVATAR_DIR, group.avatar_path));
    }

    const attachments = db.prepare(`
      SELECT attachment_path FROM group_messages
      WHERE group_id = ? AND attachment_path IS NOT NULL
    `).all(groupId);
    for (const row of attachments) {
      files.push(path.join(constants.GROUP_UPLOAD_DIR, row.attachment_path));
    }

    db.prepare(`
      DELETE FROM message_reactions
      WHERE message_type = 'group'
        AND message_id IN (SELECT id FROM group_messages WHERE group_id = ?)
    `).run(groupId);

    db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);

    return { deleted: true, files };
  })();
}

// Removes a member (leave / kick / account deletion) and keeps the group
// consistent in ONE transaction:
//   - last member out  -> the whole group is deleted;
//   - the OWNER leaves -> ownership goes to pickSuccessor() first, so the
//     group is never left without an owner.
// Does NOT bump key_epoch, purge KDMs or emit sockets — the caller does
// (bumpEpochForRemainingMembers etc.), as before.
// Returns null if the user is not a member, else
// { groupDeleted, successorId, files }.
function removeMemberWithSuccession(groupId, userId) {
  const db = getDb();

  return db.transaction(() => {
    const target = getMembership(groupId, userId);
    if (!target) return null;

    if (memberCount(groupId) === 1) {
      const { files } = deleteGroupWithCleanup(groupId);
      return { groupDeleted: true, successorId: null, files };
    }

    // Remove first so a successor can take the (unique) owner slot.
    removeMember(groupId, userId);

    let successorId = null;
    if (target.role === 'owner') {
      successorId = pickSuccessor(groupId);
      db.prepare(`
        UPDATE group_members
        SET role = 'owner', role_changed_at = CURRENT_TIMESTAMP
        WHERE group_id = ? AND user_id = ?
      `).run(groupId, successorId);
    }

    return { groupDeleted: false, successorId, files: [] };
  })();
}

// Account deletion: for every group the user OWNS, hand ownership on (or
// delete the group if they are its only member) and remove their
// membership, bumping the epoch for whoever stays so Sender Keys rotate.
// Runs BEFORE the user row is deleted. Returns one descriptor per group so
// the caller can notify clients; unlinks nothing itself.
function prepareOwnedGroupsForUserDeletion(userId) {
  const db = getDb();

  const memberships = db.prepare(`
    SELECT group_id, role FROM group_members WHERE user_id = ?
  `).all(userId);

  return db.transaction(() => {
    const results = [];

    for (const { group_id: groupId } of memberships) {
      const outcome = removeMemberWithSuccession(groupId, userId);
      if (!outcome) continue;

      let remaining = [];
      if (!outcome.groupDeleted) {
        bumpEpochForRemainingMembers(groupId);
        remaining = getMemberUserIds(groupId);
      }

      results.push({
        groupId,
        groupDeleted: outcome.groupDeleted,
        successorId: outcome.successorId,
        remaining,
        files: outcome.files,
      });
    }

    return results;
  })();
}

module.exports = {
  createGroup,
  findGroupById,
  listGroupsForUser,
  isMember,
  getMembership,
  getMembers,
  getMemberUserIds,
  memberCount,
  addMember,
  removeMember,
  renameGroup,
  setGroupAvatar,
  deleteGroup,
  bumpEpochForRemainingMembers,
  pickSuccessor,
  transferOwnership,
  promoteToAdmin,
  demoteAdmin,
  deleteGroupWithCleanup,
  removeMemberWithSuccession,
  prepareOwnedGroupsForUserDeletion,
  unlinkQuietly,
};
