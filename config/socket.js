const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const { JWT_SECRET } = require('./constants');
const { getDb } = require('./database');
const { setupChatSocket } = require('../sockets/chat.socket');
const { setupDmSocket } = require('../sockets/dm.socket');
const { setupGroupSocket } = require('../sockets/group.socket');
const { setIo } = require('../services/socket.service');
const { markOnline, markOffline, getOnlineUserIds } = require('../services/presence.service');
const {
  isShowLastSeenEnabled,
  filterVisiblePresenceIds,
  recordLastSeen,
} = require('../services/user.service');

function setupSocketIO(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || false,
    },

    // Keep a short amount of connection state so a transient network drop
    // does not unnecessarily lose recoverable Socket.IO events. This is an
    // in-memory optimization and does not replace normal REST/API loading.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },

    // Keep heartbeat failures bounded so dead upstream/client connections
    // are detected promptly and presence can be corrected.
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // ===== Authentication =====
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication required'));
    }

    try {
      const user = jwt.verify(token, JWT_SECRET);

      if (!user || user.id == null) {
        return next(new Error('Invalid token payload'));
      }

      const account = getDb()
        .prepare('SELECT id, is_active FROM users WHERE id = ?')
        .get(user.id);

      if (!account || account.is_active === 0) {
        return next(new Error('Account is inactive'));
      }

      socket.user = user;
      next();
    } catch (err) {
      // Do not log the token itself. The client receives only a generic
      // authentication error, while the server keeps the useful reason.
      console.warn(`Socket authentication failed (${err.name || 'JWT error'})`);
      next(new Error('Invalid or expired token'));
    }
  });

  setIo(io);

  // ===== Connections =====
  io.on('connection', (socket) => {
    const userId = socket.user.id;

    socket.join(`user:${userId}`);
    socket.join('chat');

    console.log(`User ${userId} connected`);

    // Presence: only announce "online" the first time this user's
    // connection count goes from 0 -> 1 (they might have several
    // tabs/devices open — we don't want each one flipping the status).
    // markOnline() itself always ref-counts the real connection; the
    // "Show Last Seen & Online Status" setting only gates whether that
    // change is ever broadcast to anyone else (see filterVisiblePresenceIds
    // below for the snapshot side of the same rule).
    const justCameOnline = markOnline(userId);
    if (justCameOnline && isShowLastSeenEnabled(userId)) {
      socket.to('chat').emit('presence:online', { user_id: userId });
    }

    // A newly-connected client has no way to know who was already
    // online before it connected — Socket.IO events only describe
    // changes going forward — so seed it with the current snapshot.
    // Filtered the same way live events are: a user with presence
    // hidden must never appear online through this endpoint either.
    socket.emit('presence:snapshot', {
      online_user_ids: filterVisiblePresenceIds(getOnlineUserIds()),
    });

    setupChatSocket(io, socket);
    setupDmSocket(io, socket);
    setupGroupSocket(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(`User ${userId} disconnected (${reason})`);

      const justWentOffline = markOffline(userId);
      if (justWentOffline) {
        // Recorded unconditionally — visibility of this value to other
        // users is enforced at read time (findUserById / getUserProfile),
        // not by refusing to persist it. That way re-enabling the
        // setting later immediately shows an accurate "Last seen".
        const lastSeenAt = recordLastSeen(userId);

        if (isShowLastSeenEnabled(userId)) {
          socket.to('chat').emit('presence:offline', { user_id: userId, last_seen_at: lastSeenAt });
        }
      }
    });

    socket.on('error', (err) => {
      console.error(`Socket error (${userId}): ${err.message}`);
    });
  });

  return io;
}

module.exports = {
  setupSocketIO,
};
