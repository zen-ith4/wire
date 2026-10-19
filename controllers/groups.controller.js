const path = require('path');
const fs = require('fs');
const constants = require('../config/constants');
const { signMediaToken, MEDIA_TOKEN_TTL_SECONDS } = require('../utils/jwt');
const { clampLimit, withAttachmentFlag, withReactions } = require('../utils/helpers');

const {
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
  bumpEpochForRemainingMembers,
} = require('../services/groups.service');

const {
  getRecentGroupMessages,
  getGroupMessagesBefore,
  getGroupMessagesSince,
  findGroupMessageById,
  findGroupMessageWithUser,
  insertGroupMessage,
  insertGroupMessageWithAttachment,
  deleteGroupMessage,
} = require('../services/groupMessages.service');

const {
  submitKdmBatchChecked,
  getUndeliveredForUser,
  markDelivered,
  purgeKdmsForUser,
  isValidDeviceId,
  touchDevice,
} = require('../services/groupKdm.service');

const { findUserById } = require('../services/user.service');

const {
  toggleReaction,
  getReactionsForMessage,
  getReactionsForMessages,
} = require('../services/reaction.service');

const {
  emitNewGroupMessage,
  emitGroupMessageDeleted,
  emitGroupMembershipChanged,
  emitGroupKdmDelivered,
  emitGroupUpdated,
  emitGroupReactionUpdate,
  removeUserFromGroupRoom,
} = require('../services/socket.service');

// ---------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------
//
// Every handler below authorizes via group_members before touching
// anything else — see plan_prompt.md Phase 1: "Every endpoint/socket
// event authorizes via group_members before allowing read/write. No
// content-level logic on the server." These never look at message
// content; they only ever check who belongs to a group and what
// their role is.

function requireMembership(req, res, groupId) {
  const membership = getMembership(groupId, req.user.id);

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this group' });
    return null;
  }

  return membership;
}

function requireGroup(req, res, groupId) {
  const group = findGroupById(groupId);

  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return null;
  }

  return group;
}

function isElevated(role) {
  return role === 'owner' || role === 'admin';
}

function parseGroupId(req) {
  const id = Number.parseInt(req.params.groupId, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------
// Group management
// ---------------------------------------------------------------

function createGroupHandler(req, res) {
  const name = String(req.body?.name || '').trim().slice(0, 100);

  if (!name) {
    return res.status(400).json({ error: 'Group name is required' });
  }

  const group = createGroup(name, req.user.id);
  res.status(201).json(group);
}

function listGroupsHandler(req, res) {
  res.json(listGroupsForUser(req.user.id));
}

function getMembersHandler(req, res) {
  const groupId = parseGroupId(req);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
  if (!requireMembership(req, res, groupId)) return;

  res.json(getMembers(groupId));
}

// Adds one or more members and tells the rest of the group who just
// joined. The server never touches key material, so it cannot hand the
// newcomer anyone's existing Sender Key. Instead it bumps the group's
// key epoch (exactly as removal does): every member's client sees
// "my Sender Key is behind the group's epoch" — immediately via the
// membership-changed event if online, or the next time they open the
// group if not — and rotates, wrapping the fresh key for the CURRENT
// member list, newcomer included. Without this bump nobody ever created
// a KDM for the newcomer, so they could never read any existing sender
// (audit finding F-A). Older keys stay on each device, so history the
// newcomer was never given a key for stays unreadable (no backfill).
function addMemberHandler(req, res) {
  const groupId = parseGroupId(req);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });

  const membership = requireMembership(req, res, groupId);
  if (!membership) return;

  if (!isElevated(membership.role)) {
    return res.status(403).json({ error: 'Only the owner or an admin can add members' });
  }

  const rawIds = Array.isArray(req.body?.user_ids)
    ? req.body.user_ids
    : [req.body?.user_id];

  const userIds = [...new Set(
    rawIds
      .map(v => Number.parseInt(v, 10))
      .filter(id => Number.isInteger(id) && id > 0)
  )];

  if (userIds.length === 0) {
    return res.status(400).json({ error: 'user_id(s) required' });
  }

  const added = [];

  for (const userId of userIds) {
    const user = findUserById(userId);
    if (!user) continue;
    if (isMember(groupId, userId)) continue;

    addMember(groupId, userId, 'member');
    added.push(userId);
  }

  if (added.length > 0) {
    bumpEpochForRemainingMembers(groupId);

    emitGroupMembershipChanged(groupId, {
      type: 'added',
      user_ids: added,
      by_user_id: req.user.id,
    }, [...getMemberUserIds(groupId), ...added]);
  }

  res.json({ added });
}

// Removing a member (by an owner/admin) or leaving (self) both end
// up here: either way, every *remaining* member must rotate their
// Sender Key and redistribute it to the (now smaller) membership,
// including themselves (Section 3, step 4). bumpEpochForRemainingMembers
// is what lets a client later notice "the group's epoch moved past
// what I have" and self-heal if it misses the live socket event.
function removeMemberHandler(req, res) {
  const groupId = parseGroupId(req);
  const targetUserId = Number.parseInt(req.params.userId, 10);

  if (!groupId || !Number.isInteger(targetUserId)) {
    return res.status(400).json({ error: 'Invalid group or user id' });
  }

  const membership = requireMembership(req, res, groupId);
  if (!membership) return;

  const isSelf = targetUserId === req.user.id;

  if (!isSelf && !isElevated(membership.role)) {
    return res.status(403).json({ error: 'Only the owner or an admin can remove members' });
  }

  const target = getMembership(groupId, targetUserId);
  if (!target) {
    return res.status(404).json({ error: 'User is not a member of this group' });
  }

  // Group owner can't be removed by an admin, and can't remove
  // themself if they're the last owner without transferring
  // ownership first — leaving a group with no owner is a state this
  // endpoint deliberately refuses to create.
  if (target.role === 'owner' && !isSelf) {
    return res.status(403).json({ error: "The group owner can't be removed" });
  }

  if (target.role === 'owner' && isSelf && memberCount(groupId) > 1) {
    return res.status(400).json({
      error: 'Transfer ownership before leaving a group with other members',
    });
  }

  removeMember(groupId, targetUserId);
  purgeKdmsForUser(groupId, targetUserId);
  removeUserFromGroupRoom(targetUserId, groupId);

  const remaining = getMemberUserIds(groupId);

  if (remaining.length === 0) {
    // Last member left — nothing left to notify or rotate for.
    const { deleteGroup } = require('../services/groups.service');
    deleteGroup(groupId);
    return res.json({ removed: true, group_deleted: true });
  }

  bumpEpochForRemainingMembers(groupId);

  emitGroupMembershipChanged(groupId, {
    type: 'removed',
    user_id: targetUserId,
    by_user_id: req.user.id,
    self_initiated: isSelf,
  }, [...remaining, targetUserId]);

  res.json({ removed: true });
}

function leaveGroupHandler(req, res) {
  req.params.userId = String(req.user.id);
  return removeMemberHandler(req, res);
}

function renameGroupHandler(req, res) {
  const groupId = parseGroupId(req);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });

  const membership = requireMembership(req, res, groupId);
  if (!membership) return;

  if (!isElevated(membership.role)) {
    return res.status(403).json({ error: 'Only the owner or an admin can rename the group' });
  }

  const name = String(req.body?.name || '').trim().slice(0, 100);
  if (!name) {
    return res.status(400).json({ error: 'Group name is required' });
  }

  renameGroup(groupId, name);
  emitGroupUpdated(getMemberUserIds(groupId), { group_id: groupId, name });
  res.json({ success: true, name });
}

function setAvatarHandler(req, res) {
  const groupId = parseGroupId(req);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });

  const membership = requireMembership(req, res, groupId);
  if (!membership) return;

  if (!isElevated(membership.role)) {
    return res.status(403).json({ error: 'Only the owner or an admin can change the group avatar' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const group = findGroupById(groupId);

  if (group?.avatar_path) {
    const oldPath = path.join(constants.AVATAR_DIR, group.avatar_path);
    fs.unlink(oldPath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error('Failed to delete old group avatar:', err.message);
      }
    });
  }

  setGroupAvatar(groupId, req.file.filename);
  emitGroupUpdated(getMemberUserIds(groupId), { group_id: groupId, avatar_path: req.file.filename });
  res.json({ success: true, avatar_path: req.file.filename });
}

// ---------------------------------------------------------------
// Messages — the server relays and authorizes only. `content` is
// always an opaque Sender-Key AES-GCM envelope; nothing here ever
// parses, validates, or reasons about what's inside it.
// ---------------------------------------------------------------

function getRecentMessagesHandler(req, res) {
  const groupId = parseGroupId(req);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
  if (!requireMembership(req, res, groupId)) return;

  const limit = clampLimit(req.query.limit, 50, 100);
  const messages = getRecentGroupMessages(groupId, limit);
  const reactions = getReactionsForMessages('group', messages.map((m) => m.id));
  res.json(withReactions(withAttachmentFlag(messages), reactions));
}

function getMessagesBeforeHandler(req, res) {
  const groupId = parseGroupId(req);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
  if (!requireMembership(req, res, groupId)) return;

  const before = req.query.before;
  if (!before) return res.status(400).json({ error: 'before is required' });

  const limit = clampLimit(req.query.limit, 50, 100);
  const messages = getGroupMessagesBefore(groupId, before, limit);
  const reactions = getReactionsForMessages('group', messages.map((m) => m.id));
  res.json(withReactions(withAttachmentFlag(messages), reactions));
}

function getMessagesSinceHandler(req, res) {
  const groupId = parseGroupId(req);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
  if (!requireMembership(req, res, groupId)) return;

  const since = req.query.since;
  if (!since) return res.status(400).json({ error: 'since is required' });

  const limit = clampLimit(req.query.limit, 100, 200);
  const messages = getGroupMessagesSince(groupId, since, limit);
  const reactions = getReactionsForMessages('group', messages.map((m) => m.id));
  res.json(withReactions(withAttachmentFlag(messages), reactions));
}

// Same reply-target validation shape as dm.controller.js's
// normalizeDmReplyToId, scoped to this group instead of a DM pair.
function normalizeGroupReplyToId(value, groupId) {
  if (value === undefined || value === null || value === '') return null;

  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) return null;

  const target = findGroupMessageById(id);
  if (!target) return id; // already deleted — still a valid reply target

  return target.group_id === groupId ? id : null;
}

function sendMessageHandler(req, res) {
  const groupId = parseGroupId(req);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
  if (!requireMembership(req, res, groupId)) return;

  const content = req.body?.content;
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  // Matches group_messages.content's CHECK — rejected here with a
  // clean 400 instead of falling through to a raw SQLite constraint
  // error. Unlike direct_messages/messages, this is never truncated:
  // truncating an AES-GCM envelope mid-string would just produce
  // ciphertext nothing can decrypt, silently corrupting the message
  // instead of failing loudly.
  if (content.trim().length > 90000) {
    return res.status(400).json({ error: 'Message is too large' });
  }

  const replyToId = normalizeGroupReplyToId(req.body?.reply_to_id, groupId);
  const timestamp = new Date().toISOString();

  const info = insertGroupMessage(groupId, req.user.id, content.trim(), timestamp, replyToId);
  const fullMsg = findGroupMessageWithUser(info.lastInsertRowid);
  fullMsg.has_attachment = !!fullMsg.attachment_name;
  fullMsg.is_voice_message = Boolean(fullMsg.is_voice_message);
  fullMsg.reactions = [];

  emitNewGroupMessage(groupId, fullMsg, getMemberUserIds(groupId));
  res.json(fullMsg);
}

function deleteMessageHandler(req, res) {
  const groupId = parseGroupId(req);
  const messageId = Number.parseInt(req.params.messageId, 10);

  if (!groupId || !Number.isInteger(messageId)) {
    return res.status(400).json({ error: 'Invalid group or message id' });
  }

  const membership = requireMembership(req, res, groupId);
  if (!membership) return;

  const msg = findGroupMessageById(messageId);
  if (!msg || msg.group_id !== groupId) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const isOwnMessage = msg.sender_id === req.user.id;
  const canModerate = isElevated(membership.role) || req.user.is_admin;

  if (!isOwnMessage && !canModerate) {
    return res.status(403).json({ error: 'You can only delete your own messages' });
  }

  if (msg.attachment_path) {
    const filePath = path.join(constants.GROUP_UPLOAD_DIR, msg.attachment_path);
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error('Failed to delete group attachment:', err.message);
      }
    });
  }

  deleteGroupMessage(messageId);
  emitGroupMessageDeleted(groupId, { id: messageId, group_id: groupId }, getMemberUserIds(groupId));
  res.json({ success: true });
}

// ---------------------------------------------------------------
// Key Distribution Message mailbox — always opaque wrapped_key
// ciphertext in, opaque wrapped_key ciphertext out. See
// plan_prompt.md Section 3 and services/groupKdm.service.js.
// ---------------------------------------------------------------

// A client posts one Sender Key fan-out at a time: itself as
// sender, the epoch that key belongs to, and one wrapped_key per
// *current* member (including the sender's own user_id — Section
// 2.1's self-KDM). The server only checks that every named
// recipient is actually a member of this group right now; it has no
// way to (and must not attempt to) verify the wrapped_key contents
// themselves.
function submitKdmBatchHandler(req, res) {
  const groupId = parseGroupId(req);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
  if (!requireMembership(req, res, groupId)) return;

  const epoch = Number.parseInt(req.body?.epoch, 10);
  const recipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];

  if (!Number.isInteger(epoch) || epoch < 0) {
    return res.status(400).json({ error: 'Invalid epoch' });
  }

  if (recipients.length === 0) {
    return res.status(400).json({ error: 'At least one recipient is required' });
  }

  const items = [];

  for (const r of recipients) {
    const toUserId = Number.parseInt(r?.user_id, 10);
    const wrappedKey = r?.wrapped_key;

    if (!Number.isInteger(toUserId)) {
      return res.status(400).json({ error: `Recipient ${r?.user_id} is not a current member` });
    }

    if (typeof wrappedKey !== 'string' || !wrappedKey.trim()) {
      return res.status(400).json({ error: `Missing wrapped_key for recipient ${toUserId}` });
    }

    items.push({ toUserId, wrappedKey: wrappedKey.trim() });
  }

  // Membership of the sender and of every recipient, and the epoch, are
  // re-verified inside the insert transaction (F5): a removal that lands
  // while this request is being processed cannot let a KDM through.
  const result = submitKdmBatchChecked(groupId, req.user.id, epoch, items);

  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      ...(result.current_epoch != null ? { current_epoch: result.current_epoch } : {}),
    });
  }

  // Wake up online recipients immediately rather than making every
  // device wait for its next drain-on-connect — see
  // sockets/group.socket.js. The event carries no key material, just
  // "you have mail" so the client knows to call the drain endpoint.
  emitGroupKdmDelivered(groupId, items.map(i => i.toUserId));

  res.status(201).json({ success: true, count: items.length });
}

// Drains this user's undelivered mailbox, optionally scoped to one
// group. Marking delivered is a separate explicit step (see below)
// so a client that fetches but crashes before persisting the
// Sender Key locally doesn't lose the KDM — it's still there to
// drain again next time.
// Opaque per-browser-profile delivery cursor (see group_kdm_receipts). It is
// MANDATORY: absent or malformed -> 400. A valid id is registered (capped,
// rate-limited) before it can read or write receipts.
function resolveDeviceId(raw, res, userId) {
  if (!isValidDeviceId(raw)) {
    res.status(400).json({ error: 'device_id is required and must be valid' });
    return null;
  }

  const t = touchDevice(userId, raw);
  if (!t.ok) {
    if (t.retryAfterSec) res.set('Retry-After', String(t.retryAfterSec));
    res.status(t.status).json({ error: t.error });
    return null;
  }

  return { deviceId: raw };
}

function drainKdmsHandler(req, res) {
  const groupId = req.query.group_id ? Number.parseInt(req.query.group_id, 10) : null;

  if (groupId != null) {
    if (!Number.isInteger(groupId) || !requireMembership(req, res, groupId)) return;
  }

  const dev = resolveDeviceId(req.query.device_id, res, req.user.id);
  if (!dev) return;

  res.json(getUndeliveredForUser(req.user.id, groupId, dev.deviceId));
}

function ackKdmsHandler(req, res) {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(v => Number.parseInt(v, 10)).filter(Number.isInteger)
    : [];

  if (ids.length === 0) {
    return res.status(400).json({ error: 'ids required' });
  }

  const dev = resolveDeviceId(req.body?.device_id, res, req.user.id);
  if (!dev) return;

  markDelivered(ids, req.user.id, dev.deviceId);
  res.json({ success: true });
}

// Any current member can react to any message in the group — same
// reasoning as DM's toggleReactionHandler: reacting doesn't modify
// someone else's content the way delete does, so it isn't limited to
// the sender or an elevated role.
function toggleGroupReactionHandler(req, res) {
  const groupId = parseGroupId(req);
  const messageId = Number.parseInt(req.params.messageId, 10);

  if (!groupId || !Number.isInteger(messageId)) {
    return res.status(400).json({ error: 'Invalid group or message id' });
  }

  if (!requireMembership(req, res, groupId)) return;

  const emoji = (req.body?.emoji || '').trim();
  if (!emoji || emoji.length > 32) {
    return res.status(400).json({ error: 'Invalid emoji' });
  }

  const msg = findGroupMessageById(messageId);
  if (!msg || msg.group_id !== groupId) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const action = toggleReaction('group', messageId, req.user.id, emoji);
  const reactions = getReactionsForMessage('group', messageId);

  emitGroupReactionUpdate(groupId, {
    message_id: messageId,
    group_id: groupId,
    reactions,
  }, getMemberUserIds(groupId));

  res.json({ success: true, action, reactions });
}

// ---------------------------------------------------------------
// Attachments (Phase 4) — always encrypted; unlike DM there is no
// legacy/pre-encryption branch here since group attachments never
// existed before this. Mirrors dm.controller.js's
// sendMessageWithAttachment/getAttachmentMediaToken/getAttachment
// exactly, with group-membership authorization (requireMembership)
// in place of DM's sender/recipient check, and GROUP_UPLOAD_DIR in
// place of DM_UPLOAD_DIR.
// ---------------------------------------------------------------

// STEP 3C: the neutral values the server stores for a group file. The real
// name, mime, dimensions and voice flag travel inside the ENCRYPTED message
// plaintext (see docs/GROUP_ATTACHMENTS_E2EE.md section "3C"), so the server
// never learns them and never stores what the client sent.
const E2EE_GROUP_ATTACHMENT_NAME = 'encrypted-attachment';
const E2EE_GROUP_ATTACHMENT_MIME = 'application/octet-stream';

async function sendMessageWithAttachmentHandler(req, res) {
  const groupId = parseGroupId(req);
  const cleanup = () => {
    if (req.file) fs.unlink(req.file.path, () => {});
  };

  if (!groupId) {
    cleanup();
    return res.status(400).json({ error: 'Invalid group id' });
  }

  if (!requireMembership(req, res, groupId)) {
    cleanup();
    return;
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // See dm.controller.js's sendMessageWithAttachment for the full
  // reasoning: the uploaded bytes are this message's Sender-Key-
  // encrypted ciphertext (see
  // public/js/crypto/messages/attachment-crypto.js), so mime/
  // width/height can only ever come from the sender's client now,
  // never sniffed server-side.
  const attachmentIv = (req.body.attachment_iv || '').trim();

  if (!attachmentIv || !/^[A-Za-z0-9+/]+=*$/.test(attachmentIv) || attachmentIv.length > 64) {
    cleanup();
    return res.status(400).json({ error: 'attachment_iv (base64) is required' });
  }

  // STEP 3C: the group's real file name, mime type, dimensions and voice flag
  // live in the ENCRYPTED message plaintext, never in a server column. The
  // client cannot set them, so whatever it sent is ignored and the neutral
  // values are stored - the same posture the DM path takes (its
  // E2EE_ATTACHMENT_NAME constant in services/dm.service.js).
  const originalName = E2EE_GROUP_ATTACHMENT_NAME;
  const mime = E2EE_GROUP_ATTACHMENT_MIME;

  const width = null;
  const height = null;

  const content = (req.body.content || '').trim();

  if (content.length > 90000) {
    cleanup();
    return res.status(400).json({ error: 'Message is too large' });
  }

  const replyToId = normalizeGroupReplyToId(req.body?.reply_to_id, groupId);
  // Voice is out of scope in STEP 3C: the flag is always false, whatever the
  // client sent.
  const isVoiceMessage = false;
  const timestamp = new Date().toISOString();

  const info = insertGroupMessageWithAttachment(
    groupId,
    req.user.id,
    content,
    timestamp,
    req.file.filename,
    originalName,
    req.file.size,
    mime,
    replyToId,
    isVoiceMessage,
    width,
    height,
    attachmentIv
  );

  const fullMsg = findGroupMessageWithUser(info.lastInsertRowid);
  fullMsg.has_attachment = !!fullMsg.attachment_name;
  fullMsg.is_voice_message = Boolean(fullMsg.is_voice_message);
  fullMsg.reactions = [];

  emitNewGroupMessage(groupId, fullMsg, getMemberUserIds(groupId));
  res.json(fullMsg);
}

function getAttachmentMediaTokenHandler(req, res) {
  const groupId = parseGroupId(req);
  const messageId = Number(req.params.messageId);

  if (!groupId || !Number.isInteger(messageId)) {
    return res.status(400).json({ error: 'Invalid group or message id' });
  }

  if (!requireMembership(req, res, groupId)) return;

  const msg = findGroupMessageById(messageId);

  if (!msg || msg.group_id !== groupId || !msg.attachment_path) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const token = signMediaToken(req.user, {
    type: 'group',
    id: messageId,
  });

  res.json({
    token,
    expiresIn: MEDIA_TOKEN_TTL_SECONDS,
  });
}

function getAttachmentHandler(req, res) {
  const groupId = parseGroupId(req);
  const messageId = Number(req.params.messageId);

  if (!groupId || !Number.isInteger(messageId)) {
    return res.status(400).json({ error: 'Invalid group or message id' });
  }

  // mediaAuth only establishes *who* req.user is (session or media
  // token) — membership is what actually authorizes this request,
  // same division of responsibility as every other group endpoint.
  if (!requireMembership(req, res, groupId)) return;

  const msg = findGroupMessageById(messageId);

  if (!msg || msg.group_id !== groupId || !msg.attachment_path) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const filePath = path.join(constants.GROUP_UPLOAD_DIR, msg.attachment_path);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // Always opaque — see the identical, fuller reasoning in
  // dm.controller.js's getAttachment. Every group attachment is
  // encrypted (there's no legacy path here), so this is simpler
  // than DM's version: no branch needed at all.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(msg.attachment_name || 'file')}"`
  );

  const range = req.headers.range;

  if (!range) {
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  const start = match && match[1] ? parseInt(match[1], 10) : 0;
  const end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (start >= fileSize || end >= fileSize || start > end) {
    res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Content-Length', end - start + 1);
  res.setHeader('Accept-Ranges', 'bytes');
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

module.exports = {
  createGroupHandler,
  listGroupsHandler,
  getMembersHandler,
  addMemberHandler,
  removeMemberHandler,
  leaveGroupHandler,
  renameGroupHandler,
  setAvatarHandler,
  getRecentMessagesHandler,
  getMessagesBeforeHandler,
  getMessagesSinceHandler,
  sendMessageHandler,
  deleteMessageHandler,
  toggleGroupReactionHandler,
  submitKdmBatchHandler,
  drainKdmsHandler,
  ackKdmsHandler,
  sendMessageWithAttachmentHandler,
  getAttachmentMediaTokenHandler,
  getAttachmentHandler,
};
