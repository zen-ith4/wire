let ioInstance = null;

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
}

function emitChatMessageDeleted(id) {
  emit(
    'chat',
    'chat-message-deleted',
    { id }
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

module.exports = {
  setIo,
  getIo,
  emit,
  emitNewChatMessage,
  emitNewDirectMessage,
  emitChatMessageDeleted,
  emitDirectMessageDeleted,
  emitChatReactionUpdate,
  emitDirectReactionUpdate,
};