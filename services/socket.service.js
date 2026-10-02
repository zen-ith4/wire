let ioInstance = null;

const { sendDmPush } = require('./push.service');

function setIo(io) {
  ioInstance = io;
}

function getIo() {
  if (!ioInstance) {
    throw new Error('Socket.IO has not been initialized.');
  }

  return ioInstance;
}

function emit(room, event, payload) {
  getIo()
    .to(room)
    .emit(event, payload);
}

function emitNewChatMessage(message) {
  emit(
    'chat',
    'new-chat-message',
    message
  );
}

function emitNewDirectMessage(message) {
  emit(
    `user:${message.sender_id}`,
    'new-dm-message',
    message
  );

  emit(
    `user:${message.recipient_id}`,
    'new-dm-message',
    message
  );

  // Fire-and-forget: an FCM push (for the recipient's backgrounded/
  // killed Android devices — see services/push.service.js) is
  // additional delivery alongside the Socket.IO emit above, never a
  // replacement for it, and must never delay or break it. Whether a
  // sender should also get a push on their own other devices isn't
  // needed here — sendDmPush only ever looks up tokens for
  // message.recipient_id.
  sendDmPush(message).catch((e) => {
    console.error('[Push] sendDmPush threw:', e.message);
  });
}

function emitChatMessageDeleted(id) {
  emit(
    'chat',
    'chat-message-deleted',
    { id }
  );
}

// Read receipts ("seen" ticks) — told only to the original sender
// (the one whose messages just got read), never broadcast, and only
// ever called by dm.controller.js when markRead() actually found
// unread messages AND the reader currently has "Send Read Receipts"
// enabled. See services/dm.service.js's markRead for why this can
// never fire for a message read while the setting was off.
function emitDmMessagesSeen({ sender_id, reader_id, message_ids, seen_at }) {
  emit(
    `user:${sender_id}`,
    'dm-messages-seen',
    { reader_id, message_ids, seen_at }
  );
}

function emitDirectMessageDeleted(message) {
  emit(
    `user:${message.sender_id}`,
    'dm-message-deleted',
    message
  );

  emit(
    `user:${message.recipient_id}`,
    'dm-message-deleted',
    message
  );
}

// Same fan-out as emitDirectMessageDeleted above: both participants
// need the update (the sender to see their own edit reflected back,
// the recipient to get the new content in realtime), and the payload
// is a full findDmMessageWithUser() row, so the recipient has
// everything needed to decrypt it the same way any other incoming
// DM is decrypted — no separate "edit payload" shape.
function emitDirectMessageEdited(message) {
  emit(
    `user:${message.sender_id}`,
    'dm-message-edited',
    message
  );

  emit(
    `user:${message.recipient_id}`,
    'dm-message-edited',
    message
  );
}

function emitChatReactionUpdate(payload) {
  emit(
    'chat',
    'chat-reaction-update',
    payload
  );
}

function emitDirectReactionUpdate(message) {
  emit(
    `user:${message.sender_id}`,
    'dm-reaction-update',
    message
  );

  emit(
    `user:${message.recipient_id}`,
    'dm-reaction-update',
    message
  );
}

// Profile picture/banner changes need to reach *every* connected
// client, not just a DM pair or the chat participants - the changed
// user's avatar/banner can be visible anywhere in the UI (DM headers,
// profile cards, conversation lists, chat messages, etc.), for anyone
// currently online. 'chat' is the one room every authenticated socket
// already joins on connect (see config/socket.js), so it doubles as
// the app's general-broadcast room - the same room presence:online/
// presence:offline already use for the same reason.
function emitProfileAvatarUpdate(userId) {
  emit(
    'chat',
    'profile:avatar-updated',
    { user_id: userId }
  );
}

function emitProfileBannerUpdate(userId) {
  emit(
    'chat',
    'profile:banner-updated',
    { user_id: userId }
  );
}

// ---------------------------------------------------------------
// Groups
// ---------------------------------------------------------------
//
// Unlike chat's single shared 'chat' room, a group has no room every
// member is guaranteed to already be in — group.socket.js joins a
// per-group room (`group:<id>`) only once a client explicitly says
// it's viewing that group. Emitting to `user:<id>` for every current
// member instead means these events reach every one of that user's
// tabs/devices regardless of whether they currently have the group
// thread open — membership changes and KDM delivery in particular
// need to reach a device even when the group isn't the active view.
function emitToUsers(userIds, event, payload) {
  const io = getIo();
  for (const userId of userIds) {
    io.to(`user:${userId}`).emit(event, payload);
  }
}

// A removed member's sockets must leave the group's Socket.IO room, or they
// keep receiving room broadcasts (typing events) for a group they no longer
// belong to. Membership is re-checked on join/emit, but an already-joined
// socket stays in the room until told otherwise.
function removeUserFromGroupRoom(userId, groupId) {
  getIo().in(`user:${userId}`).socketsLeave(`group:${groupId}`);
}

function emitNewGroupMessage(groupId, message, memberUserIds) {
  emitToUsers(memberUserIds, 'new-group-message', message);
}

function emitGroupMessageDeleted(groupId, payload, memberUserIds) {
  emitToUsers(memberUserIds, 'group-message-deleted', payload);
}

function emitGroupReactionUpdate(groupId, payload, memberUserIds) {
  emitToUsers(memberUserIds, 'group-reaction-update', payload);
}

// notifyUserIds intentionally includes anyone who just left/was
// removed, in addition to remaining members — a departing member's
// other devices still need to know they no longer belong (e.g. to
// stop trying to decrypt/rotate for a group they've left), even
// though they won't receive anything sent to the group afterward.
function emitGroupMembershipChanged(groupId, payload, notifyUserIds) {
  emitToUsers(notifyUserIds, 'group:membership-changed', {
    group_id: groupId,
    ...payload,
  });
}

// Carries no key material — just tells the named recipients' other
// devices "you have undelivered KDMs, go drain your mailbox" (see
// controllers/groups.controller.js's drainKdmsHandler). Delivering
// the actual wrapped_key only ever happens over the authenticated
// REST drain endpoint, never over the socket itself.
function emitGroupKdmDelivered(groupId, recipientUserIds) {
  emitToUsers(recipientUserIds, 'group:kdm-delivered', { group_id: groupId });
}

function emitGroupUpdated(memberUserIds, payload) {
  emitToUsers(memberUserIds, 'group:updated', payload);
}

module.exports = {
  setIo,
  getIo,
  emit,
  emitNewChatMessage,
  emitNewDirectMessage,
  emitChatMessageDeleted,
  emitDirectMessageDeleted,
  emitDirectMessageEdited,
  emitDmMessagesSeen,
  emitChatReactionUpdate,
  emitDirectReactionUpdate,
  emitProfileAvatarUpdate,
  emitProfileBannerUpdate,
  emitNewGroupMessage,
  emitGroupMessageDeleted,
  emitGroupReactionUpdate,
  emitGroupMembershipChanged,
  removeUserFromGroupRoom,
  emitGroupKdmDelivered,
  emitGroupUpdated,
};