const { getDb } = require('../config/database');

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
    SELECT group_id, user_id, role, joined_at, key_epoch
    FROM group_members
    WHERE group_id = ? AND user_id = ?
  `).get(groupId, userId);
}

function getMembers(groupId) {
  return getDb().prepare(`
    SELECT gm.user_id, gm.role, gm.joined_at, gm.key_epoch,
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
};
