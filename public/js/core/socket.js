import { io } from '../vendor/socket.io-client.js';

import { getCurrentUser, getToken } from './auth.js';

import {
  getServerEndpoint
} from './server.js';

import {
  addChatMessage,
  removeChatMessage,
  showChatTyping,
  hideChatTyping,
  clearAllChatTyping
} from '../chat/chat.js';

import {
  addDmMessage,
  updateDmMessage,
  removeDmMessage,
  loadDmConversations,
  refreshUnreadBadge,
  getDmActivePeer,
  showDmTyping,
  hideDmTyping,
  clearAllDmTyping,
  markDmMessagesSeen,
} from '../chat/dm.js';

import {
  addGroupMessage,
  removeGroupMessage,
  showGroupTyping,
  hideGroupTyping,
  clearAllGroupTyping,
  applyGroupReactionUpdate,
  handleGroupMembershipChanged as onGroupMembershipChanged,
  handleGroupKdmDelivered as onGroupKdmDelivered,
  handleGroupUpdated as onGroupUpdated,
  handleGroupSocketConnected as onGroupSocketConnected,
  getActiveGroupId,
} from '../chat/group.js';

import {
  setOnlineSnapshot,
  setUserOnline,
  setUserOffline
} from '../chat/presence.js';

import { updateMessageReactions } from '../chat/reactions.js';

import {
  refreshAvatarEverywhere,
  refreshBannerEverywhere
} from '../ui/avatar.js';

let socket = null;

function socketLog(...args) {
  console.log('[Wire][Socket]', ...args);
}

function socketWarn(...args) {
  console.warn('[Wire][Socket]', ...args);
}

function socketError(...args) {
  console.error('[Wire][Socket]', ...args);
}

export function initSocket(token) {
  // Socket.IO is a singleton in this app. Never create a second
  // Manager/connection if initialization is requested again.
  if (socket) {
    socketLog('Already initialized:', {
      connected: socket.connected,
      active: socket.active,
      id: socket.id || null,
    });

    return socket;
  }

  const initialToken = getToken() || token;

  if (!initialToken) {
    socketWarn('Socket not initialized: no authentication token.');
    return null;
  }

  const serverEndpoint = getServerEndpoint();

  socketLog('Initializing...');
  socketLog('Endpoint:', serverEndpoint);
  socketLog('Initial token available:', Boolean(initialToken));

  socket = io(serverEndpoint, {
    // Register every handler before connecting.
    autoConnect: false,

    // Always use the newest token for new connections/reconnections.
    auth: (cb) => {
      const currentToken =
        getToken() || localStorage.getItem('token');

      socketLog(
        'Providing auth token:',
        Boolean(currentToken)
      );

      cb({
        token: currentToken || null
      });
    },

    // Prefer WebSocket, fall back to polling.
    transports: ['websocket', 'polling'],

    timeout: 10000,

    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5,
  });

  socket.on('connect', () => {
    socketLog('CONNECTED', {
      id: socket.id,
      transport:
        socket.io?.engine?.transport?.name || null,
      endpoint: serverEndpoint,
    });

    // Pull anything missed while disconnected (group messages/KDMs are
    // not replayed beyond the server's short recovery window). A no-op
    // until the Groups view has been opened in this session.
    void onGroupSocketConnected();
  });

  socket.on('disconnect', (reason, details) => {
    socketWarn(
      'DISCONNECTED:',
      reason,
      details || null
    );

    clearAllChatTyping();
    clearAllDmTyping();
    clearAllGroupTyping();

    setOnlineSnapshot([]);
  });

  socket.on('connect_error', (err) => {
    socketError('CONNECT ERROR:', {
      message: err?.message || null,
      description: err?.description || null,
      context: err?.context || null,
      active: socket?.active ?? null,
      connected: socket?.connected ?? null,
      transport:
        socket?.io?.engine?.transport?.name || null,
      endpoint: serverEndpoint,
    });
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    socketLog('RECONNECT ATTEMPT:', attempt);
  });

  socket.io.on('reconnect', (attempt) => {
    socketLog(
      'RECONNECTED after attempt:',
      attempt,
      {
        id: socket.id,
        transport:
          socket.io?.engine?.transport?.name || null,
      }
    );
  });

  socket.io.on('reconnect_error', (err) => {
    socketWarn(
      'RECONNECT ERROR:',
      err?.message || err
    );
  });

  socket.io.on('reconnect_failed', () => {
    socketError('RECONNECT FAILED PERMANENTLY.');
  });

  socket.io.on('open', () => {
    socketLog('ENGINE OPEN:', {
      transport:
        socket.io?.engine?.transport?.name || null,
    });
  });

  socket.io.on('close', (reason) => {
    socketWarn('ENGINE CLOSED:', reason);
  });

  socket.io.on('error', (error) => {
    socketError('ENGINE ERROR:', error);
  });

  socket.io.engine?.on?.('upgrade', () => {
    socketLog('TRANSPORT UPGRADED:', {
      transport:
        socket.io?.engine?.transport?.name || null,
    });
  });

  // Chat events
  socket.on(
    'new-chat-message',
    handleChatMessage
  );

  socket.on(
    'chat-message-deleted',
    handleChatMessageDeleted
  );

  socket.on(
    'chat:typing',
    handleChatTyping
  );

  socket.on(
    'chat:stop-typing',
    handleChatStopTyping
  );

  // DM events
  socket.on(
    'new-dm-message',
    handleDirectMessage
  );

  socket.on(
    'dm-message-deleted',
    handleDirectMessageDeleted
  );

  socket.on(
    'dm-message-edited',
    handleDirectMessageEdited
  );

  socket.on(
    'dm:typing',
    handleDmTyping
  );

  socket.on(
    'dm:stop-typing',
    handleDmStopTyping
  );

  // Read receipts ("seen" ticks) — see services/socket.service.js's
  // emitDmMessagesSeen. Only ever received here as the original
  // sender of the messages named in the payload.
  socket.on(
    'dm-messages-seen',
    handleDmMessagesSeen
  );

  // Presence
  socket.on(
    'presence:snapshot',
    ({ online_user_ids } = {}) => {
      const ids = Array.isArray(online_user_ids)
        ? online_user_ids
        : [];

      socketLog(
        'PRESENCE SNAPSHOT:',
        ids
      );

      setOnlineSnapshot(ids);
    }
  );

  socket.on(
    'presence:online',
    ({ user_id } = {}) => {
      socketLog(
        'PRESENCE ONLINE:',
        user_id
      );

      if (user_id != null) {
        setUserOnline(user_id);
      }
    }
  );

  socket.on(
    'presence:offline',
    ({ user_id, last_seen_at } = {}) => {
      socketLog(
        'PRESENCE OFFLINE:',
        user_id
      );

      if (user_id != null) {
        // A real disconnect carries the timestamp that was just
        // recorded; a live "I just hid my presence" event (settings
        // change while online) carries last_seen_at: null instead, so
        // this correctly blanks out anything shown for them too.
        setUserOffline(user_id, last_seen_at ?? null);
      }
    }
  );

  // Reactions
  socket.on(
    'chat-reaction-update',
    ({ message_id, reactions }) => {
      updateMessageReactions(
        'chat',
        message_id,
        reactions
      );
    }
  );

  socket.on(
    'dm-reaction-update',
    ({ message_id, reactions }) => {
      updateMessageReactions(
        'dm',
        message_id,
        reactions
      );
    }
  );

  // Group events
  socket.on(
    'new-group-message',
    handleGroupMessage
  );

  socket.on(
    'group-message-deleted',
    handleGroupMessageDeleted
  );

  socket.on(
    'group:typing',
    handleGroupTypingEvent
  );

  socket.on(
    'group:stop-typing',
    handleGroupStopTypingEvent
  );

  socket.on(
    'group-reaction-update',
    ({ group_id, message_id, reactions }) => {
      applyGroupReactionUpdate(
        group_id,
        message_id,
        reactions
      );
    }
  );

  socket.on(
    'group:membership-changed',
    onGroupMembershipChanged
  );

  socket.on(
    'group:kdm-delivered',
    onGroupKdmDelivered
  );

  socket.on(
    'group:updated',
    onGroupUpdated
  );

  // Profile updates
  socket.on(
    'profile:avatar-updated',
    handleProfileAvatarUpdated
  );

  socket.on(
    'profile:banner-updated',
    handleProfileBannerUpdated
  );

  socketLog(
    'Handlers registered. Connecting...'
  );

  socket.connect();

  return socket;
}

export function getSocket() {
  return socket;
}

/*
 * Tears down the singleton Socket.IO connection, if one was opened.
 *
 * Used when startup is aborted after initSocket() already ran (e.g. a
 * later step in startApplication() throws) and the app is falling back
 * to the login screen: without this, the old socket would keep running
 * in the background with stale/duplicate listeners, AND initSocket()'s
 * own singleton guard ("if (socket) return socket;") would silently
 * refuse to create a new connection on the next successful startup.
 */
export function disconnectSocket() {
  if (!socket) {
    return;
  }

  socketLog('Disconnecting and tearing down socket instance...');

  try {
    socket.removeAllListeners();
    socket.disconnect();
  } catch (err) {
    socketError('Error while tearing down socket:', err);
  }

  socket = null;

  // Mirror the same cleanup the 'disconnect' handler does, in case the
  // socket was torn down before ever reaching a connected state (so
  // that handler never got a chance to run).
  clearAllChatTyping();
  clearAllDmTyping();
  clearAllGroupTyping();
  setOnlineSnapshot([]);
}

function handleChatMessage(message) {
  const container =
    document.getElementById('chat-messages');

  if (!container) {
    return;
  }

  addChatMessage(message);

  const input =
    document.getElementById('chat-input');

  if (
    input &&
    message.user_id === getCurrentUser()?.id
  ) {
    input.value = '';
  }
}

function handleDirectMessage(message) {
  const currentUser = getCurrentUser();
  const activePeer = getDmActivePeer();

  const isRelevant =
    activePeer &&
    (
      message.sender_id === activePeer.id ||
      message.recipient_id === activePeer.id
    );

  addDmMessage(message);

  if (
    document.getElementById('dm-messages') &&
    isRelevant
  ) {
    const input =
      document.getElementById('dm-input');

    if (
      input &&
      message.sender_id === currentUser?.id
    ) {
      input.value = '';
    }
  }

  if (
    document.getElementById('dm-conv-list')
  ) {
    loadDmConversations();
  }

  refreshUnreadBadge();
}

function handleChatMessageDeleted({ id }) {
  removeChatMessage(id);
}

// The sender's own edit also arrives here (emitDirectMessageEdited
// fans out to both sender and recipient rooms — see
// services/socket.service.js) — updateDmMessage() is naturally a
// no-op for a conversation/message this client doesn't have cached,
// so there's no need to special-case "was this my own edit" here.
function handleDirectMessageEdited(message) {
  void updateDmMessage(message);
}

function handleDirectMessageDeleted({ id }) {
  removeDmMessage(id);

  if (
    document.getElementById('dm-conv-list')
  ) {
    loadDmConversations();
  }

  refreshUnreadBadge();
}

function handleChatTyping({
  user_id,
  username
}) {
  // The server excludes the sender's own socket.
  // This also prevents another tab of the same account
  // from displaying its own typing indicator.
  if (
    user_id === getCurrentUser()?.id
  ) {
    return;
  }

  showChatTyping(
    user_id,
    username
  );
}

function handleChatStopTyping({ user_id }) {
  hideChatTyping(user_id);
}

function handleDmTyping({
  sender_id,
  sender_username
}) {
  showDmTyping(
    sender_id,
    sender_username
  );
}

function handleDmStopTyping({
  sender_id
}) {
  hideDmTyping(sender_id);
}

function handleDmMessagesSeen({
  reader_id,
  message_ids,
  seen_at
} = {}) {
  if (reader_id == null || !Array.isArray(message_ids) || message_ids.length === 0) {
    return;
  }

  markDmMessagesSeen({ reader_id, message_ids, seen_at });
}

function handleProfileAvatarUpdated({
  user_id
}) {
  refreshAvatarEverywhere(user_id);
}

function handleProfileBannerUpdated({
  user_id
}) {
  refreshBannerEverywhere(user_id);
}

function handleGroupMessage(message) {
  addGroupMessage(message);

  const input =
    document.getElementById('group-input');

  if (
    input &&
    message.group_id === getActiveGroupId() &&
    message.sender_id === getCurrentUser()?.id
  ) {
    input.value = '';
  }
}

function handleGroupMessageDeleted({ id, group_id }) {
  removeGroupMessage(group_id, id);
}

function handleGroupTypingEvent({
  group_id,
  sender_id,
  sender_username
}) {
  // Same reasoning as handleChatTyping: the server already excludes
  // the sender's own socket, but a second tab of the same account
  // would still see it without this guard.
  if (
    sender_id === getCurrentUser()?.id
  ) {
    return;
  }

  showGroupTyping(
    group_id,
    sender_id,
    sender_username
  );
}

function handleGroupStopTypingEvent({ group_id, sender_id }) {
  hideGroupTyping(group_id, sender_id);
}
