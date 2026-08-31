import { getCurrentUser } from './auth.js';

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
  if (socket) {
    return socket;
  }

  socket = io({
    auth: {
      token,
    },
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    console.log('Socket connected');
  });

  socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
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
    console.warn('Socket connection failed:', err.message);
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

  // Was `window.dmActivePeer`, which nothing ever set — dm.js only
  // ever kept this as a private module variable, so real-time DM
  // delivery to an already-open thread silently never worked. Fixed
  // via the exported getter instead of a global.
  const activePeer = getDmActivePeer();

  const isRelevant =
    activePeer &&
    (
      message.sender_id === activePeer.id ||
      message.recipient_id === activePeer.id
    );

  if (
    document.getElementById('dm-messages') &&
    isRelevant
  ) {
    addDmMessage(message);

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