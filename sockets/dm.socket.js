function setupDmSocket(io, socket) {
  // Most DM events are emitted from REST endpoints via socket.service
  // (see services/socket.service.js) since they have a DB row behind
  // them. Typing indicators are the one exception — they're ephemeral
  // UI state with nothing to persist, so they're handled natively here.

  // Peers this socket has told "I'm typing" without a matching
  // stop-typing yet, so a disconnect can clean all of them up.
  const typingPeers = new Set();

  function parseRecipientId(payload) {
    const id = parseInt(payload && payload.recipient_id, 10);
    return Number.isInteger(id) ? id : null;
  }

  socket.on('dm:typing', (payload) => {
    const recipientId = parseRecipientId(payload);
    if (recipientId === null) return;

    typingPeers.add(recipientId);

    socket.to(`user:${recipientId}`).emit('dm:typing', {
      sender_id: socket.user.id,
      sender_username: socket.user.username,
    });
  });

  socket.on('dm:stop-typing', (payload) => {
    const recipientId = parseRecipientId(payload);
    if (recipientId === null) return;

    typingPeers.delete(recipientId);

    socket.to(`user:${recipientId}`).emit('dm:stop-typing', {
      sender_id: socket.user.id,
    });
  });

  // Same "don't leave it stuck" cleanup as chat — notify every peer
  // this socket was mid-typing to when it disconnects.
  socket.on('disconnect', () => {
    typingPeers.forEach((recipientId) => {
      socket.to(`user:${recipientId}`).emit('dm:stop-typing', {
        sender_id: socket.user.id,
      });
    });
    typingPeers.clear();
  });
}

module.exports = { setupDmSocket };