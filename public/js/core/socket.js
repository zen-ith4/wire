import { getCurrentUser, getToken } from './auth.js';

import { addChatMessage, removeChatMessage, showChatTyping, hideChatTyping, clearAllChatTyping } from '../chat/chat.js';

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

import { setOnlineSnapshot, setUserOnline, setUserOffline } from '../chat/presence.js';
import { updateMessageReactions } from '../chat/reactions.js';
import { refreshAvatarEverywhere, refreshBannerEverywhere } from '../ui/avatar.js';

let socket = null;

export function initSocket(token) {
  // Socket.IO is a singleton in this app. Never create a second Manager/
  // connection if initialization is requested again during app startup or
  // after a view/router lifecycle event.
  if (socket) {
    return socket;
  }

  // The auth module is the source of truth. The argument is kept for
  // backwards compatibility with the existing initSocket(token) call, but
  // reconnections must read the current token so a refreshed/replaced token
  // is never stuck behind a stale closure value.
  const initialToken = getToken() || token;

  if (!initialToken) {
    console.warn('Socket not initialized: no authentication token.');
    return null;
  }

  socket = io({
    // Do not connect until every handler below has been registered. This
    // removes a small startup race where autoConnect could fail before our
    // diagnostics/cleanup handlers were attached.
    autoConnect: false,

    // Socket.IO calls this for every new connection attempt, including
    // reconnects. Always provide the newest token from auth.js/localStorage.
    auth: (cb) => {
      const currentToken = getToken() || localStorage.getItem('token');
      cb({ token: currentToken || null });
    },

    // WebSocket is preferred, while polling remains a fallback for networks
    // that temporarily cannot establish a WebSocket transport.
    transports: ['websocket', 'polling'],

    // A dead/unreachable upstream should fail quickly enough for the
    // reconnect loop to recover instead of leaving the UI waiting forever.
    timeout: 10000,

    // Back off between reconnect attempts so a temporary Caddy/upstream
    // failure cannot create a tight reconnect storm.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5,
  });

  socket.on('connect', () => {
    console.log(`Socket connected (${socket.id}) via ${socket.io.engine.transport.name}`);
  });

  socket.on('disconnect', (reason, details) => {
    console.warn('Socket disconnected:', reason, details || '');

    // Without this, a typing indicator could stay stuck on screen
    // for the whole reconnect gap if the 'stop-typing' event that
    // would have cleared it never made it through.
    clearAllChatTyping();
    clearAllDmTyping();

    // We no longer have live presence data while disconnected —
    // showing stale "online" dots would be misleading. A fresh
    // 'presence:snapshot' arrives automatically once reconnected.
    setOnlineSnapshot([]);
  });

  socket.on('connect_error', (err) => {
    // Never log the JWT. Socket.IO errors can include request/transport
    // details, so keep diagnostics useful without exposing credentials.
    console.warn('Socket connection failed:', err.message, {
      description: err.description,
      context: err.context,
      active: socket.active,
      transport: socket.io?.engine?.transport?.name || null,
    });
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    console.log(`Socket reconnect attempt #${attempt}`);
  });

  socket.io.on('reconnect', (attempt) => {
    console.log(`Socket reconnected after ${attempt} attempt(s)`);
  });

  socket.io.on('reconnect_error', (err) => {
    console.warn('Socket reconnect failed:', err.message);
  });

  socket.io.on('reconnect_failed', () => {
    console.error('Socket reconnect failed permanently.');
  });

  socket.on('new-chat-message', handleChatMessage);

  socket.on('new-dm-message', handleDirectMessage);

  socket.on('chat-message-deleted', handleChatMessageDeleted);

  socket.on('dm-message-deleted', handleDirectMessageDeleted);

  socket.on('chat:typing', handleChatTyping);

  socket.on('chat:stop-typing', handleChatStopTyping);

  socket.on('dm:typing', handleDmTyping);

  socket.on('dm:stop-typing', handleDmStopTyping);

  socket.on('presence:snapshot', ({ online_user_ids }) => setOnlineSnapshot(online_user_ids || []));

  socket.on('presence:online', ({ user_id }) => setUserOnline(user_id));

  socket.on('presence:offline', ({ user_id }) => setUserOffline(user_id));

  socket.on('chat-reaction-update', ({ message_id, reactions }) => {
    updateMessageReactions('chat', message_id, reactions);
  });

  socket.on('dm-reaction-update', ({ message_id, reactions }) => {
    updateMessageReactions('dm', message_id, reactions);
  });

  socket.on('profile:avatar-updated', handleProfileAvatarUpdated);

  socket.on('profile:banner-updated', handleProfileBannerUpdated);

  // All handlers are now attached, so start the first connection.
  socket.connect();

  return socket;
}

export function getSocket() {
  return socket;
}

function handleChatMessage(message) {
  const container = document.getElementById('chat-messages');

  if (!container) {
    return;
  }

  addChatMessage(message);

  const input = document.getElementById('chat-input');

  if (input && message.user_id === getCurrentUser()?.id) {
    input.value = '';
  }
}

function handleDirectMessage(message) {
  const currentUser = getCurrentUser();

  // addDmMessage() now always updates that peer's conversation
  // cache (if one exists from earlier this session) regardless of
  // which thread is on screen, and only touches the DOM when the
  // message's conversation happens to be the currently-open one —
  // so it's called unconditionally rather than gated on an
  // isRelevant check here. This is what lets a conversation that
  // isn't currently open still stay caught up while the user is
  // looking at a different thread, instead of needing a full
  // refetch the next time it's reopened.
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
    const input = document.getElementById('dm-input');

    if (input && message.sender_id === currentUser?.id) {
      input.value = '';
    }
  }

  if (document.getElementById('dm-conv-list')) {
    loadDmConversations();
  }

  refreshUnreadBadge();
}

function handleChatMessageDeleted({ id }) {
  removeChatMessage(id);
}

function handleDirectMessageDeleted({ id }) {
  removeDmMessage(id);

  if (document.getElementById('dm-conv-list')) {
    loadDmConversations();
  }

  refreshUnreadBadge();
}

function handleChatTyping({ user_id, username }) {
  // The server already excludes the sender's own socket via
  // socket.to(), but a user connected from two tabs would otherwise
  // see their own "is typing" from their other tab — skip that too.
  if (user_id === getCurrentUser()?.id) return;
  showChatTyping(user_id, username);
}

function handleChatStopTyping({ user_id }) {
  hideChatTyping(user_id);
}

function handleDmTyping({ sender_id, sender_username }) {
  showDmTyping(sender_id, sender_username);
}

function handleDmStopTyping({ sender_id }) {
  hideDmTyping(sender_id);
}

// The server broadcasts these to every connected client (see
// services/socket.service.js), including every socket the uploading
// user themselves has open. That last part is intentional, not just
// tolerated: settings.js's own refreshAvatarEverywhere() call after a
// successful upload only ever reaches the tab that made the request -
// if that same account is also open in a second tab/device (or just
// has the DM list / a profile card showing their own avatar open
// elsewhere), nothing local updates that view. Re-running the refresh
// unconditionally here is what actually covers those cases; the one
// downside is a single harmless extra fetch in the originating tab
// (invalidateAvatar()/invalidateBanner() + a re-fetch of something
// already fresh), which is cheap and one-shot, not a repeating cost.
function handleProfileAvatarUpdated({ user_id }) {
  refreshAvatarEverywhere(user_id);
}

function handleProfileBannerUpdated({ user_id }) {
  refreshBannerEverywhere(user_id);
}