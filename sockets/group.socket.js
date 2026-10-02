const constants = require('../config/constants');
const { getMembership } = require('../services/groups.service');

// All of the events that carry real content (new message, message
// deleted, reaction update, membership changed, KDM delivered) are
// emitted from the REST handlers via socket.service.js, the same
// split chat/dm.socket.js already use — they have a DB row/
// authorization check behind them. This module only owns what's
// genuinely ephemeral and per-connection: which group rooms this
// socket cares about right now, and typing indicators.
function setupGroupSocket(io, socket) {
  if (!constants.GROUPS_ENABLED) return;

  // Groups this socket has joined a room for, so a disconnect can
  // clean up typing state for all of them (same pattern as
  // dm.socket.js's typingPeers).
  const joinedGroups = new Set();
  const typingGroups = new Set();

  function isAuthorized(groupId) {
    return !!getMembership(groupId, socket.user.id);
  }

  function parseGroupId(payload) {
    const id = Number.parseInt(payload && payload.group_id, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  // Joining a group's socket room is purely a convenience for
  // anything that *does* want a group-scoped room in a later phase
  // (e.g. presence-in-thread, read receipts) — actual message/
  // membership/KDM delivery already reaches every member via their
  // `user:<id>` room (see socket.service.js) regardless of whether
  // they've joined here, so a client that never calls this still
  // gets everything.
  socket.on('group:join', (payload) => {
    const groupId = parseGroupId(payload);
    if (groupId === null || !isAuthorized(groupId)) return;

    socket.join(`group:${groupId}`);
    joinedGroups.add(groupId);
  });

  socket.on('group:leave-room', (payload) => {
    const groupId = parseGroupId(payload);
    if (groupId === null) return;

    socket.leave(`group:${groupId}`);
    joinedGroups.delete(groupId);
  });

  socket.on('group:typing', (payload) => {
    const groupId = parseGroupId(payload);
    if (groupId === null || !isAuthorized(groupId)) return;

    typingGroups.add(groupId);

    socket.to(`group:${groupId}`).emit('group:typing', {
      group_id: groupId,
      sender_id: socket.user.id,
      sender_username: socket.user.username,
    });
  });

  socket.on('group:stop-typing', (payload) => {
    const groupId = parseGroupId(payload);
    if (groupId === null) return;

    typingGroups.delete(groupId);

    socket.to(`group:${groupId}`).emit('group:stop-typing', {
      group_id: groupId,
      sender_id: socket.user.id,
    });
  });

  socket.on('disconnect', () => {
    typingGroups.forEach((groupId) => {
      socket.to(`group:${groupId}`).emit('group:stop-typing', {
        group_id: groupId,
        sender_id: socket.user.id,
      });
    });
    typingGroups.clear();
    joinedGroups.clear();
  });
}

module.exports = { setupGroupSocket };
