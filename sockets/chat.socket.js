function setupChatSocket(io, socket) {
  // Typing indicator. No DB lookups needed — the JWT payload already
  // attached to the socket at connection time (see config/socket.js)
  // has everything other clients need to render "X is typing…".
  //
  // socket.to(room) broadcasts to everyone in the room *except* the
  // emitting socket, so the sender never receives their own event.
  socket.on('chat:typing', () => {
    socket.to('chat').emit('chat:typing', {
      user_id: socket.user.id,
      username: socket.user.username,
    });
  });

  socket.on('chat:stop-typing', () => {
    socket.to('chat').emit('chat:stop-typing', {
      user_id: socket.user.id,
    });
  });

  // If this socket disconnects mid-typing (closed tab, dropped
  // connection), make sure their indicator doesn't get stuck on
  // everyone else's screen forever.
  socket.on('disconnect', () => {
    socket.to('chat').emit('chat:stop-typing', {
      user_id: socket.user.id,
    });
  });
}

module.exports = {
  setupChatSocket,
};