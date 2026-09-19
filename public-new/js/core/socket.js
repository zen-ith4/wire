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
  removeDmMessage,
  loadDmConversations,
  refreshUnreadBadge,
  getDmActivePeer,
  showDmTyping,
  hideDmTyping,
  clearAllDmTyping,
} from '../chat/dm.js';

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
  });

  socket.on('disconnect', (reason, details) => {
    socketWarn(
      'DISCONNECTED:',
      reason,
      details || null
    );

    clearAllChatTyping();
    clearAllDmTyping();

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
    'dm:typing',
    handleDmTyping
  );

  socket.on(
    'dm:stop-typing',
    handleDmStopTyping
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
    ({ user_id } = {}) => {
      socketLog(
        'PRESENCE OFFLINE:',
        user_id
      );

      if (user_id != null) {
        setUserOffline(user_id);
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
