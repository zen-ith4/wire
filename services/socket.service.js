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
};