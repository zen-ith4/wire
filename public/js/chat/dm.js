import { newChatFabHtml, bindNewChatFab } from '../ui/new-chat-fab.js';
import { api } from '../core/api.js';
import { ICONS } from '../icons.js';
import {
  showToast,
  emptyState,
  loadingState,
  escapeHtml,
  linkifyHtml,
  escapeAttr,
  formatDate,
  insertAtCursor,
  animateRemoval
} from '../core/utils.js';
import {
  renderAttachment,
  loadChatImage,
  mountAttachmentMedia,
  cleanupImageUrls,
  revokeAttachmentImage,
  imageDownloadButtonHtml
} from '../media/attachments.js';
import { avatarHtml } from '../ui/avatar.js';
import { getCurrentUser } from '../core/auth.js';
import { claimRender } from '../core/view-session.js';
import { showConfirm } from '../ui/confirm.js';
import { openEmojiPicker } from '../ui/emoji-picker.js';
import { renderReactionsRow, reactButtonHtml, onReactionsUpdated } from './reactions.js';
import { isEmojiPickerOpen } from '../ui/emoji-picker.js';
import {
  buildReplyQuoteHtml,
  buildReplyPreview
} from './reply.js';
import { bindSwipeToReply } from './swipe-reply.js';
import {
  createLayoutBuilder,
  repairSeam,
  findFirstUnreadId,
  formatTime,
  formatFullDateTime
} from './dm-layout.js';
import { copyText } from '../files/links.js';
import {
  TAP_IGNORE_SELECTOR,
  isTouchClick,
  placeActionBar,
  bindContextMenu
} from './tap-reveal.js';
import {
  getDmTapTimestampEnabled
} from '../settings/theme.js';
import {
  createTypingEmitter,
  createTypingIndicator,
  wireTypingInput
} from './typing.js';
import { getSocket } from '../core/socket.js';
import {
  isUserOnline,
  setUserOnline,
  onPresenceChange,
  getPresenceStatusText,
  setLastSeenAt,
  refreshPresenceDisplay
} from './presence.js';
import { createComposer } from './composer.js';
import { setMessageAccent } from './message-accent.js';
import {
  encryptOutgoingMessage,
  decryptIncomingMessage
} from '../crypto/messages/message-crypto.js';
import { maybeNotifyDM } from '../notifications/notification-manager.js';
import { messageSoundManager } from '../notifications/message-sounds.js';
import {
  pushEntry as pushNavEntry,
  peekEntry as peekNavEntry,
  pushOverlay,
  closeOverlay,
} from '../core/navigation.js';

// ---------- Per-conversation message cache ----------
const dmCache = new Map();
let dmActivePeer = null;
let dmEntry = null;
let dmComposer = null;
const dmConvMap = new Map();

// Last conversation list, previews already decrypted. A tab switch
// paints from this synchronously and refreshes in the background
// (see showDm / loadDmConversations). Memory only; cleared on logout.
let dmPreparedConvs = [];
let dmConvsLoaded = false;

// IntersectionObserver that auto-triggers loadOlderDm() when the
// "Load older messages" row scrolls near the top of #dm-messages —
// see attachLoadMoreObserver()/observeLoadMoreRowIfPresent() below.
// One instance per open thread; torn down/recreated whenever the
// thread is rebuilt (new conversation, or logout).
let dmLoadMoreObserver = null;

window.addEventListener('wire:logout', () => {
  dmCache.clear();
  dmConvMap.clear();
  dmPreparedConvs = [];
  dmConvsLoaded = false;
  dmActivePeer = null;
  dmEntry = null;
  dmLoadMoreObserver?.disconnect();
  dmLoadMoreObserver = null;
});

// Keep cached DM messages in step with reaction changes so reopening a
// conversation from the cache never shows stale reactions.
onReactionsUpdated((scope, messageId, reactions) => {
  if (scope !== 'dm') return;
  for (const entry of dmCache.values()) {
    const cached = entry.byId.get(messageId);
    if (cached) cached.reactions = reactions;
  }
});

// ---------- Helpers ----------
function canLoadMoreDm() {
  return !!(
    dmActivePeer &&
    dmEntry &&
    dmEntry.oldest &&
    dmEntry.hasMore &&
    !dmEntry.loadingOlder
  );
}

function getOrCreateDmCacheEntry(peerId, username) {
  let entry = dmCache.get(peerId);
  if (!entry) {
    entry = {
      username,
      messages: [],
      ids: new Set(),
      byId: new Map(),
      oldest: null,
      hasMore: true,
      initialized: false,
      loadingOlder: false,
      scrollTop: 0,
      atBottom: true,
      // First unread message of the peer (see settleUnread below) and
      // whether the "New messages" marker has been shown for it yet.
      unreadFromId: null,
      unreadShown: false
    };
    dmCache.set(peerId, entry);
  } else if (username) {
    entry.username = username;
  }
  return entry;
}

const DM_NEAR_BOTTOM_PX = 80;
function isNearBottom(container) {
  return (
    container.scrollHeight -
    container.scrollTop -
    container.clientHeight
  ) <= DM_NEAR_BOTTOM_PX;
}

function saveDmScrollState() {
  if (!dmEntry) return;

  const container = document.getElementById('dm-messages');
  if (!container) return;

  dmEntry.scrollTop = container.scrollTop;
  dmEntry.atBottom = isNearBottom(container);
}

// ---------- Auto-load older messages on scroll ----------
// Reuses the exact same "Load older messages" row/click handler
// (buildLoadMoreEl(loadOlderDm)) as the sentinel: rather than a
// parallel scroll-position/pixel-threshold system, we just watch that
// row with IntersectionObserver and invoke the same callback the
// button already used. loadOlderDm()'s own canLoadMoreDm() guard
// (entry.loadingOlder / entry.hasMore) is what actually prevents
// duplicate/concurrent requests — the observer may fire more than
// once while the row is in view.
function attachLoadMoreObserver(container) {
  dmLoadMoreObserver?.disconnect();
  dmLoadMoreObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void loadOlderDm();
      }
    },
    // Root margin on top only: fires a bit before the row is actually
    // on-screen so the next page is ready by the time the user gets
    // there, without needing a hard-coded scrollTop threshold.
    { root: container, rootMargin: '200px 0px 0px 0px', threshold: 0 }
  );
  observeLoadMoreRowIfPresent(container);
}

function observeLoadMoreRowIfPresent(container) {
  if (!dmLoadMoreObserver || !container) return;
  // There is ever only one load-more row at a time, so disconnecting
  // before re-observing is enough — no stale targets pile up.
  dmLoadMoreObserver.disconnect();
  const row = container.querySelector('#chat-load-more-row');
  if (row) dmLoadMoreObserver.observe(row);
}

// ---------- Floating "jump to latest" button ----------
function refreshJumpToLatestButton() {
  const btn = document.getElementById('dm-jump-latest');
  if (!btn || !dmEntry) return;

  btn.classList.toggle('visible', !dmEntry.atBottom);
  // Reaching the bottom clears any "new messages" indicator — there's
  // nothing unread left below the fold at that point.
  if (dmEntry.atBottom) btn.classList.remove('has-new');
}

window.dmJumpToLatest = function () {
  const container = document.getElementById('dm-messages');
  if (!container || !dmEntry) return;

  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  dmEntry.atBottom = true;
  refreshJumpToLatestButton();
};

// The unread marker belongs to one visit of a conversation: it is
// computed when the messages are fetched (or when a message arrives
// while the thread is closed), shown while the thread stays open, and
// dropped once the user leaves — the server has marked those messages
// read by then. A boundary that was never shown yet is kept.
function settleUnread(entry) {
  if (entry && entry.unreadShown) {
    entry.unreadFromId = null;
    entry.unreadShown = false;
  }
}

function currentUserId() {
  return Number(getCurrentUser()?.id);
}

// Message data behind a rendered row (null for rows without any, e.g.
// the "Unable to decrypt" placeholder) — what dm-layout.js needs to
// re-derive grouping for rows below a changed seam.
function dmMsgOfRow(row) {
  return row && dmEntry
    ? dmEntry.byId.get(Number(row.dataset.msgId)) || null
    : null;
}

export function getDmActivePeer() {
  return dmActivePeer;
}

// ---------- E2EE ----------

function parseDmPayload(content) {
  if (typeof content !== 'string') {
    return null;
  }

  try {
    const payload = JSON.parse(content);

    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      payload.encryption &&
      typeof payload.encryption === 'object'
    ) {
      return payload;
    }

    return null;
  } catch {
    return null;
  }
}

function isEncryptedDmContent(content) {
  return !!parseDmPayload(content);
}

async function decryptDmMessage(msg) {
  if (!msg) {
    throw new Error('Invalid DM message');
  }

  const currentUser = getCurrentUser();

  if (!currentUser) {
    throw new Error('Current user is unavailable');
  }

  const currentUserId = Number(currentUser.id);

  if (
    !Number.isInteger(currentUserId) ||
    currentUserId <= 0
  ) {
    throw new Error(
      `Invalid current user ID for DM ${msg.id}`
    );
  }

  const senderId = Number(msg.sender_id);
  const recipientId = Number(msg.recipient_id);

  if (
    !Number.isInteger(senderId) ||
    senderId <= 0 ||
    !Number.isInteger(recipientId) ||
    recipientId <= 0
  ) {
    throw new Error(
      `Invalid DM IDs for message ${msg.id}`
    );
  }

  if (
    senderId !== currentUserId &&
    recipientId !== currentUserId
  ) {
    throw new Error(
      `DM ${msg.id} does not belong to current user`
    );
  }

  const peerId =
    senderId === currentUserId
      ? recipientId
      : senderId;

  if (
    !Number.isInteger(peerId) ||
    peerId <= 0
  ) {
    throw new Error(
      `Invalid peer ID for DM ${msg.id}`
    );
  }

  // ----------------------------------------------------------
  // Decrypt main message content
  // ----------------------------------------------------------

  let decryptedContent = msg.content;

  if (msg.content) {
    const payload = parseDmPayload(msg.content);

    // Legacy/plaintext message
    if (payload) {
      if (
        payload.encryption.version !== 1 ||
        payload.encryption.algorithm !== 'AES-GCM'
      ) {
        throw new Error(
          `Unsupported encryption format for DM ${msg.id}`
        );
      }

      decryptedContent = await decryptIncomingMessage(
        payload,
        peerId
      );

      if (typeof decryptedContent !== 'string') {
        throw new Error(
          `Invalid plaintext returned for DM ${msg.id}`
        );
      }

      // Defense in depth.
      if (isEncryptedDmContent(decryptedContent)) {
        throw new Error(
          `Crypto layer returned encrypted data for DM ${msg.id}`
        );
      }
    }
  }

  // ----------------------------------------------------------
  // Decrypt reply_to.content
  // ----------------------------------------------------------

  let decryptedReplyTo = msg.reply_to;

  if (
    msg.reply_to &&
    typeof msg.reply_to === 'object'
  ) {
    decryptedReplyTo = {
      ...msg.reply_to,
    };

    const replyContent = msg.reply_to.content;

    if (typeof replyContent === 'string' && replyContent.length > 0) {
      const replyPayload = parseDmPayload(replyContent);

      // Only decrypt content that is actually an encrypted
      // DM payload. Legacy/plaintext replies remain unchanged.
      if (replyPayload) {
        if (
          replyPayload.encryption.version !== 1 ||
          replyPayload.encryption.algorithm !== 'AES-GCM'
        ) {
          throw new Error(
            `Unsupported encryption format for reply target of DM ${msg.id}`
          );
        }

        const replyPlaintext =
          await decryptIncomingMessage(
            replyPayload,
            peerId
          );

        if (typeof replyPlaintext !== 'string') {
          throw new Error(
            `Invalid plaintext returned for reply target of DM ${msg.id}`
          );
        }

        // Defense in depth.
        if (isEncryptedDmContent(replyPlaintext)) {
          throw new Error(
            `Crypto layer returned encrypted reply data for DM ${msg.id}`
          );
        }

        decryptedReplyTo.content = replyPlaintext;
      }
    }
  }

  return {
    ...msg,
    content: decryptedContent,
    reply_to: decryptedReplyTo,
  };
}

async function decryptDmMessages(messages) {
  return Promise.all(
    messages.map((message) =>
      decryptDmMessage(message)
    )
  );
}

// Shared by the composer's buildTextBody (new message) and
// buildEditBody (in-place edit) — both need the exact same
// current-user/active-peer validation and produce the exact same
// encrypted-payload shape for the `content` field, so there's one
// encryption path for outgoing DM text instead of two.
async function encryptForActivePeer(content) {
  const currentUser = getCurrentUser();
  if (
    !currentUser ||
    !Number.isInteger(Number(currentUser.id)) ||
    Number(currentUser.id) <= 0
  ) {
    throw new Error('Current user is not available');
  }
  if (
    !dmActivePeer ||
    !Number.isInteger(Number(dmActivePeer.id)) ||
    Number(dmActivePeer.id) <= 0
  ) {
    throw new Error('Invalid DM recipient');
  }

  const senderId = Number(currentUser.id);
  const recipientId = Number(dmActivePeer.id);
  const encrypted = await encryptOutgoingMessage(content, senderId, recipientId);

  return JSON.stringify(encrypted);
}

async function decryptConversationPreview(
  lastMessage,
  peerUserId
) {
  if (!lastMessage) {
    return '';
  }

  const payload = parseDmPayload(lastMessage);

  // Legacy/plaintext preview.
  if (!payload) {
    return String(lastMessage);
  }

  // Encrypted data must never fall through to the UI.
  if (
    payload.encryption.version !== 1 ||
    payload.encryption.algorithm !== 'AES-GCM'
  ) {
    console.error(
      'Unsupported encryption format in conversation preview'
    );

    return 'Unable to decrypt';
  }

  const peerId = Number(peerUserId);

  if (
    !Number.isInteger(peerId) ||
    peerId <= 0
  ) {
    console.error(
      'Invalid peer ID for conversation preview:',
      peerUserId
    );

    return 'Unable to decrypt';
  }

  try {
    const plaintext = await decryptIncomingMessage(
      payload,
      peerId
    );

    if (typeof plaintext !== 'string') {
      throw new Error(
        'Invalid plaintext returned for conversation preview'
      );
    }

    if (isEncryptedDmContent(plaintext)) {
      throw new Error(
        'Encrypted data returned instead of plaintext preview'
      );
    }

    return plaintext;
  } catch (error) {
    console.error(
      `Failed to decrypt conversation preview for ${peerId}:`,
      error
    );

    return 'Unable to decrypt';
  }
}

// ---------- Presence ----------
onPresenceChange((changedUserId) => {
  if (!dmActivePeer) return;
  if (changedUserId !== null && changedUserId !== dmActivePeer.id) return;

  const statusEl = document.getElementById('dm-thread-status');
  if (!statusEl) return;
  statusEl.textContent = getPresenceStatusText(dmActivePeer.id);
  statusEl.classList.toggle('online', isUserOnline(dmActivePeer.id));
});

// Same live-sync approach for the "New message" picker's status lines
// (this just keeps the "Online"/"Last seen…" text next to each row's
// avatar in sync too, without re-rendering the whole list).
onPresenceChange((changedUserId) => {
  const selector =
    changedUserId === null
      ? '.dm-picker-status[data-user-id]'
      : `.dm-picker-status[data-user-id="${changedUserId}"]`;

  document.querySelectorAll(selector).forEach((el) => {
    el.textContent = getPresenceStatusText(el.dataset.userId);
    el.classList.toggle('online', isUserOnline(el.dataset.userId));
  });
});

// Background fetch of a peer's presence for whichever surface (DM
// thread header, profile card) just rendered from local state alone.
// Local state (the presence.js Set/Map) only knows what live socket
// events have said since this session started, so a peer who was
// already offline before we connected has no last-seen time yet
// without this — see /api/me/:userId in me.controller.js, the same
// endpoint the profile card already uses.
async function refreshPeerPresence(peerId) {
  try {
    const profile = await api(`/api/me/${peerId}`);
    if (profile.online) {
      setUserOnline(peerId);
    } else {
      setLastSeenAt(peerId, profile.last_seen_at || null);
    }
    refreshPresenceDisplay(peerId);
  } catch (e) {
    // Best-effort only — the header/card already shows whatever local
    // state had, so a failed refresh just means it stays as-is.
  }
}

// ---------- Typing indicator ----------
function renderDmTyping(usernames) {
  const el = document.getElementById('dm-typing-indicator');
  if (!el) return;
  if (usernames.length === 0) {
    el.textContent = '';
    el.classList.remove('active');
    return;
  }
  el.textContent = `${usernames[0]} is typing…`;
  el.classList.add('active');
}

const dmTypingIndicator = createTypingIndicator(renderDmTyping);
const dmTypingEmitter = createTypingEmitter(
  getSocket,
  'dm:typing',
  'dm:stop-typing',
  () => (dmActivePeer ? { recipient_id: dmActivePeer.id } : null)
);

export function showDmTyping(senderId, username) {
  if (!dmActivePeer || senderId !== dmActivePeer.id) return;
  dmTypingIndicator.set(senderId, username);
}

export function hideDmTyping(senderId) {
  dmTypingIndicator.clear(senderId);
}

export function clearAllDmTyping() {
  dmTypingIndicator.clearAll();
}

export function destroyDmComposer() {
  if (dmComposer) {
    dmComposer.destroy();
    dmComposer = null;
  }
}

// ---------- Render ----------
// Tab-switch entry point. With no target conversation and a list we
// already have, paint it locally and refresh in the background; anything
// else (first visit, "message this person" with a target) is a normal render.
export async function showDm(params) {
  const hasTarget = params !== undefined && params !== null;
  return renderDm(params, { fromCache: dmConvsLoaded && !hasTarget });
}

export async function renderDm(openPeerId, opts) {
  const fromCache = !!(opts && opts.fromCache);
  const isCurrent = claimRender('messages');
  const main = document.getElementById('content-area');

  bindDmMobileSwipeBack(main);

  saveDmScrollState();
  dmActivePeer = null;
  dmEntry = null;

  cleanupImageUrls(document.getElementById('dm-messages'), 'dm');

  main.innerHTML = `
    <div class="dm-layout">
      <div class="dm-sidebar">
        <div class="conv-header">
          <div class="conv-header-row">
            <span class="conv-header-label">Conversations</span>
          </div>
          <div class="conv-search-wrap">
            <span class="conv-search-icon">${ICONS.search}</span>
            <input type="text" class="conv-search-input" id="dm-conv-search" placeholder="Search conversations…" autocomplete="off">
          </div>
        </div>
        <div id="dm-conv-list" class="dm-conv-list">${fromCache ? '' : loadingState()}</div>
        ${newChatFabHtml()}
      </div>
      <div class="dm-thread" id="dm-thread">
        ${emptyState(ICONS.mail, 'Select a conversation', 'Or start a new one with a friend.')}
      </div>
    </div>
  `;

  bindDmThreadBackground();

  bindNewChatFab(main, {
    onMessage: () => window.openNewDmPicker(),
    onGroup: async () => {
      const { navigate } = await import('../core/router.js');
      await navigate('groups');
      window.openCreateGroupDialog?.();
    },
  });

  const list = document.getElementById('dm-conv-list');
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.dm-conv');
    if (!item) return;
    const peerId = Number(item.dataset.peer);
    const conv = dmConvMap.get(peerId);
    openDmConversation(peerId, conv?.username || `User ${peerId}`);
  });

  const searchInput = document.getElementById('dm-conv-search');
  searchInput.addEventListener('input', () => {
    void renderConvListRows(Array.from(dmConvMap.values()), searchInput.value);
  });

  if (fromCache) {
    paintConvRows(dmPreparedConvs, '');
    void loadDmConversations();
    void refreshUnreadBadge();
    return;
  }

  const convs = await loadDmConversations();

  // The user may have left Messages while the list was loading; opening a
  // conversation now would target a thread pane that no longer exists.
  if (!isCurrent()) return;

  if (openPeerId !== undefined && openPeerId !== null) {
    const isObjectParam = typeof openPeerId === 'object';
    const peerId = Number(isObjectParam ? openPeerId.id : openPeerId);
    const knownUsername = isObjectParam ? openPeerId.username : null;
    const conv = convs.find((c) => c.peer_id == peerId);
    const username = conv ? conv.username : knownUsername || `User ${peerId}`;
    openDmConversation(peerId, username);
  }
}

// ---------- Conversation list ----------
async function renderConvListRows(convs, filter = '') {
  const list = document.getElementById('dm-conv-list');
  if (!list) return;

  const preparedConvs = await Promise.all(
    convs.map(async (c) => ({
      ...c,
      decrypted_last_message: await decryptConversationPreview(
        c.last_message,
        c.peer_id
      ),
    }))
  );

  dmPreparedConvs = preparedConvs;
  dmConvsLoaded = true;

  paintConvRows(preparedConvs, filter);
}

// Synchronous: turns already-prepared conversations into rows.
function paintConvRows(preparedConvs, filter = '') {
  const list = document.getElementById('dm-conv-list');
  if (!list) return;

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? preparedConvs.filter(
        (c) =>
          String(c.username || '').toLowerCase().includes(q) ||
          String(c.decrypted_last_message || '').toLowerCase().includes(q)
      )
    : preparedConvs;

  let html;

  if (filtered.length === 0) {
    html = q
      ? `<div class="text-muted" style="font-size:12.5px;padding:16px 10px;text-align:center;">No conversations found</div>`
      : `<div class="text-muted" style="font-size:12.5px;padding:10px 4px;">No conversations yet. Start one above.</div>`;
  } else {
    html = filtered
      .map(
        (c) => `
        <div class="dm-conv ${
          dmActivePeer && dmActivePeer.id == c.peer_id ? 'active' : ''
        }" data-peer="${c.peer_id}">
          ${avatarHtml(c.peer_id, c.username, 'conv-avatar', true)}
          <div class="conv-info">
            <div class="dm-conv-name">${escapeHtml(c.username)}</div>
            <div class="dm-conv-preview">${escapeHtml(
              c.decrypted_last_message || 'No messages yet'
            )}</div>
          </div>
          <div class="conv-meta">
            ${
              c.last_timestamp
                ? `<span class="conv-time">${formatDate(c.last_timestamp)}</span>`
                : ''
            }
            ${
              c.unread_count > 0
                ? `<span class="dm-unread-badge">${
                    c.unread_count > 99 ? '99+' : c.unread_count
                  }</span>`
                : ''
            }
          </div>
        </div>
      `
      )
      .join('');
  }

  // A background refresh that produced identical rows must not touch the
  // DOM (no flicker, no lost hover/scroll state).
  if (list._wireHtml === html) return;
  list._wireHtml = html;
  list.innerHTML = html;
}

export async function loadDmConversations() {
  const list = document.getElementById('dm-conv-list');
  try {
    const convs = await api('/api/dm/conversations');

    dmConvMap.clear();
    for (const c of convs) {
      dmConvMap.set(c.peer_id, c);
    }

    const searchInput = document.getElementById('dm-conv-search');
    await renderConvListRows(convs, searchInput ? searchInput.value : '');

    return convs;
  } catch (e) {
    if (list && !dmConvsLoaded) {
      list._wireHtml = null;
      list.innerHTML = emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message));
    }
    return [];
  }
}

// ---------- Unread badge ----------
export async function refreshUnreadBadge() {
  try {
    const { count } = await api('/api/dm/unread-count');
    // Sidebar + phone bottom bar each render a badge (see navBadgeHtml
    // in ui/mobile-shell.js) — update every one of them.
    document.querySelectorAll('[data-badge="dm"]').forEach((badge) => {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    });
  } catch {
    /* ignore */
  }
}

// ---------- New DM picker ----------
// Full, unfiltered set of selectable people for the picker session
// currently on screen — fetched once per open, then filtered
// client-side as the user types (the app already has this whole list
// in hand via /api/share/users, so there's no need for a server-side
// search round-trip for what is, in practice, a short contact list).
let dmPickerUsers = null;

window.openNewDmPicker = async function () {
  pushOverlay('dm-new-picker', window.closeNewDmPicker);

  document.querySelector('.dm-layout')?.classList.add('showing-thread');
  playDmThreadEnter();
  document.querySelectorAll('.dm-conv').forEach((el) => el.classList.remove('active'));

  const thread = document.getElementById('dm-thread');
  thread.innerHTML = `
    <div class="dm-thread-header">
      <button class="icon-btn dm-back-btn" title="Back" onclick="window.closeNewDmPicker()">${ICONS.arrowLeft}</button>
      <div class="card-title" style="margin:0;">${ICONS.plus} New message</div>
      <button class="icon-btn dm-picker-close" title="Close" onclick="window.closeNewDmPicker()">${ICONS.close}</button>
    </div>
    <div class="dm-picker-body">
      <div class="conv-search-wrap dm-picker-search-wrap">
        <span class="conv-search-icon">${ICONS.search}</span>
        <input
          type="text"
          class="conv-search-input dm-picker-search-input"
          id="dm-picker-search"
          placeholder="Search people…"
          autocomplete="off"
          aria-label="Search people">
        <button type="button" class="icon-btn dm-picker-clear hidden" id="dm-picker-clear" title="Clear search">${ICONS.close}</button>
      </div>
      <div class="dm-picker-list" id="dm-picker-list" role="listbox" aria-label="People"></div>
    </div>
  `;

  const list = document.getElementById('dm-picker-list');
  list.innerHTML = loadingState();

  const searchInput = document.getElementById('dm-picker-search');
  const clearBtn = document.getElementById('dm-picker-clear');

  searchInput.addEventListener('input', () => {
    clearBtn.classList.toggle('hidden', searchInput.value.length === 0);
    renderDmPickerRows(searchInput.value);
  });
  searchInput.addEventListener('keydown', handleDmPickerSearchKeydown);

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.classList.add('hidden');
    renderDmPickerRows('');
    searchInput.focus();
  });

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.dm-picker-row');
    if (row) startDmFromPickerRow(row);
  });
  list.addEventListener('keydown', handleDmPickerListKeydown);

  // Focusing immediately lets typing start the search with no extra
  // click, same as the conversation search box above it.
  requestAnimationFrame(() => searchInput.focus());

  try {
    dmPickerUsers = await api('/api/share/users');
  } catch (e) {
    dmPickerUsers = null;
    list.innerHTML = emptyState(ICONS.empty, 'Couldn’t load people', escapeHtml(e.message));
    return;
  }

  if (dmPickerUsers.length === 0) {
    list.innerHTML = emptyState(
      ICONS.users,
      'No one to message yet',
      'Once other people join, you’ll find them here.'
    );
    return;
  }

  renderDmPickerRows('');
};

function renderDmPickerRows(filter = '') {
  const list = document.getElementById('dm-picker-list');
  if (!list || !dmPickerUsers) return;

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? dmPickerUsers.filter((u) => String(u.username || '').toLowerCase().includes(q))
    : dmPickerUsers;

  if (filtered.length === 0) {
    list.innerHTML = q
      ? emptyState(ICONS.search, 'No matches', `No one found for “${escapeHtml(filter.trim())}”`)
      : emptyState(
          ICONS.users,
          'No one to message yet',
          'Once other people join, you’ll find them here.'
        );
    return;
  }

  list.innerHTML = filtered
    .map((u) => {
      const online = isUserOnline(u.id);
      return `
        <div
          class="dm-picker-row"
          role="option"
          tabindex="0"
          data-user-id="${u.id}"
          data-username="${escapeAttr(u.username)}"
          aria-selected="false">
          ${avatarHtml(u.id, u.username, 'conv-avatar dm-picker-avatar')}
          <div class="dm-picker-info">
            <div class="dm-picker-name">${escapeHtml(u.username)}</div>
            <div class="dm-picker-status${online ? ' online' : ''}" data-user-id="${u.id}">${
              getPresenceStatusText(u.id)
            }</div>
          </div>
        </div>
      `;
    })
    .join('');
}

function startDmFromPickerRow(row) {
  const id = Number(row.dataset.userId);
  const username = row.dataset.username;
  if (!Number.isInteger(id) || id <= 0) return;

  // Selecting a person closes the picker (it's about to be replaced
  // by the conversation thread) — remove its overlay entry directly
  // rather than via window.closeNewDmPicker(), which would instead
  // reopen whatever conversation was active before the picker opened.
  closeOverlay('dm-new-picker');

  openDmConversation(id, username);
}

function handleDmPickerSearchKeydown(e) {
  const list = document.getElementById('dm-picker-list');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    list?.querySelector('.dm-picker-row')?.focus();
  } else if (e.key === 'Enter') {
    const rows = list ? list.querySelectorAll('.dm-picker-row') : [];
    if (rows.length === 1) {
      e.preventDefault();
      startDmFromPickerRow(rows[0]);
    }
  } else if (e.key === 'Escape') {
    window.closeNewDmPicker();
  }
}

function handleDmPickerListKeydown(e) {
  const row = e.target.closest('.dm-picker-row');
  if (!row) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    (row.nextElementSibling || row).focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (row.previousElementSibling) row.previousElementSibling.focus();
    else document.getElementById('dm-picker-search')?.focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    startDmFromPickerRow(row);
  } else if (e.key === 'Escape') {
    window.closeNewDmPicker();
  }
}

// ---------- Close new-message picker ----------
// Returns to whichever conversation was open before "New message" was
// clicked, or to the empty placeholder if none was.
window.closeNewDmPicker = function () {
  closeOverlay('dm-new-picker');

  document.querySelector('.dm-layout')?.classList.remove('showing-thread');
  dmPickerUsers = null;

  if (dmActivePeer) {
    // Re-showing the conversation the picker was opened from, not a
    // new navigation state — it's already represented in history.
    openDmConversation(dmActivePeer.id, dmActivePeer.username, {
      fromNav: true,
    });
    return;
  }

  const thread = document.getElementById('dm-thread');
  if (thread) {
    thread.innerHTML = emptyState(
      ICONS.mail,
      'Select a conversation',
      'Or start a new one with a friend.'
    );
  }
};

// ---------- Mobile DM thread background ----------
// On phones .dm-thread is an opaque layer that paints its own copy of
// the site background (responsive.css: .dm-thread::before, fed by the
// --ambient-bg variable theme.js publishes). To look exactly like the
// real background, that copy must be the same size as the fixed
// #ambient-underlay and sit at the same screen position — otherwise its
// gradients would be laid out against the thread's own smaller box and
// visibly break against the topbar/bottom bar. So: measure where the
// (never transformed) .dm-layout sits relative to the underlay and
// expose that as CSS variables. Layout only; nothing here touches
// messages.
let dmBgObserver = null;
let dmBgWindowBound = false;

function syncDmThreadBackground() {
  const layout = document.querySelector('.dm-layout');
  const underlay = document.getElementById('ambient-underlay');
  if (!layout || !underlay) return;

  const l = layout.getBoundingClientRect();
  const u = underlay.getBoundingClientRect();

  layout.style.setProperty('--dm-bg-x', `${l.left - u.left}px`);
  layout.style.setProperty('--dm-bg-y', `${l.top - u.top}px`);
  layout.style.setProperty('--dm-bg-w', `${u.width}px`);
  layout.style.setProperty('--dm-bg-h', `${u.height}px`);
}

function bindDmThreadBackground() {
  const layout = document.querySelector('.dm-layout');
  if (!layout) return;

  syncDmThreadBackground();
  window.dispatchEvent(new Event('wire:dm-layout'));

  // Keyboard open/close (bottom bar hides), rotation, safe-area changes…
  // all resize the layout box.
  if (dmBgObserver) dmBgObserver.disconnect();
  if (typeof ResizeObserver === 'function') {
    dmBgObserver = new ResizeObserver(syncDmThreadBackground);
    dmBgObserver.observe(layout);
  }

  if (!dmBgWindowBound) {
    dmBgWindowBound = true;
    window.addEventListener('resize', syncDmThreadBackground);
    window.visualViewport?.addEventListener('resize', syncDmThreadBackground);
  }
}

// ---------- DM open / back-button motion ----------
// The conversation layer (never the messages) gets its own short sideways
// entrance — see motion-thread-in in core/motion.css; deliberately not the
// tab transition — through .dm-layout--opening. Only animation, no permanent
// transform. Plays nothing when the global Animations setting is off (and
// is 0ms under reduced motion).
let dmEnterTimer = 0;

function playDmThreadEnter() {
  if (!document.documentElement.hasAttribute('data-animations')) return;

  const layout = document.querySelector('.dm-layout');
  if (!layout) return;

  clearTimeout(dmEnterTimer);
  layout.classList.remove('dm-layout--opening');
  void layout.offsetWidth; // restart the animation on 2nd+ opens
  layout.classList.add('dm-layout--opening');

  // Not left on: otherwise a later display:none -> flex of the thread
  // (phone) would replay it without the list being held hidden.
  dmEnterTimer = setTimeout(() => {
    layout.classList.remove('dm-layout--opening');
  }, 400);
}

function motionMs(name) {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name);
  const ms = Number.parseFloat(raw);
  return Number.isFinite(ms) ? ms : 0;
}

// Back button on the phone: slide the thread away exactly like a committed
// swipe-back (inline transform over the untouched list underneath), then run
// the unchanged closeDmThreadMobile(). With animations off, or reduced
// motion, it is just closeDmThreadMobile() immediately.
window.backFromDmThread = function () {
  const thread = document.getElementById('dm-thread');
  const ms = motionMs('--motion-base');

  if (!thread || !ms || thread.dataset.dmClosing === '1') {
    window.closeDmThreadMobile();
    return;
  }

  thread.dataset.dmClosing = '1';
  thread.style.transition = `transform ${ms}ms var(--motion-ease)`;
  thread.style.transform = 'translate3d(100%, 0, 0)';

  window.setTimeout(() => {
    delete thread.dataset.dmClosing;
    window.closeDmThreadMobile();
  }, ms);
};

// ---------- Mobile DM swipe-back ----------
// Shared with the swipe-to-reply gesture below so the two can never
// disagree about where swipe-back owns the touch.
const DM_SWIPE_BACK_EDGE_PX = 230;
const DM_MOBILE_BREAKPOINT = 900;

function bindDmMobileSwipeBack(root) {
  if (!root || root.dataset.dmSwipeBackBound === '1') return;
  root.dataset.dmSwipeBackBound = '1';

  const EDGE_START_PX = DM_SWIPE_BACK_EDGE_PX;
  const ACTIVATION_DISTANCE_PX = 6;
  const COMMIT_DISTANCE_PX = 85;
  const MOBILE_BREAKPOINT = DM_MOBILE_BREAKPOINT;
  const ANIMATION_MS = 180;

  let pointerId = null;
  let startX = 0;
  let startY = 0;

  let tracking = false;
  let active = false;
  let committed = false;
  let thread = null;

  function reset() {
    pointerId = null;
    startX = 0;
    startY = 0;
    tracking = false;
    active = false;
    committed = false;
    thread = null;
  }

  function clearVisualState(animate = true) {
    if (!thread) return;

    const currentThread = thread;

    currentThread.style.transition = animate
      ? `transform ${ANIMATION_MS}ms ease`
      : 'none';

    currentThread.style.transform = '';

    if (animate) {
      window.setTimeout(() => {
        currentThread.style.transition = '';
      }, ANIMATION_MS);
    }
  }

  function isInteractiveTarget(target) {
    return !!target?.closest(
      'input, textarea, button, select, a, [contenteditable="true"], [role="button"]'
    );
  }

  function cancel(pointerEvent) {
    if (
      pointerEvent &&
      root.hasPointerCapture?.(pointerEvent.pointerId)
    ) {
      try {
        root.releasePointerCapture(pointerEvent.pointerId);
      } catch {}
    }

    clearVisualState(true);
    reset();
  }

  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (window.innerWidth > MOBILE_BREAKPOINT) return;
    if (!dmActivePeer) return;
    if (e.isPrimary === false) return;

    // Only start the gesture from the left edge.
    if (e.clientX > EDGE_START_PX) return;

    // Don't steal touches from buttons, inputs, etc.
    if (isInteractiveTarget(e.target)) return;

    thread = e.target.closest('.dm-thread');

    // The New Message picker can exist while dmActivePeer still
    // references the previous conversation. Only allow the gesture
    // when an actual DM thread is present.
    if (
      !thread ||
      !root.contains(thread) ||
      !thread.querySelector('#dm-messages')
    ) {
      thread = null;
      return;
    }

    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;

    tracking = true;
    active = false;
    committed = false;
  });

  root.addEventListener(
    'pointermove',
    (e) => {
      if (!tracking || e.pointerId !== pointerId) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Before activation, let clearly vertical gestures remain
      // normal message scrolling.
      if (!active) {
        if (
          Math.abs(dy) > 8 &&
          Math.abs(dy) > Math.abs(dx)
        ) {
          cancel(e);
          return;
        }

        // Only left-to-right.
        if (dx <= 0) return;

        if (dx < ACTIVATION_DISTANCE_PX) return;

        active = true;

        try {
          root.setPointerCapture(e.pointerId);
        } catch {}

        thread.style.transition = 'none';

        e.preventDefault();
      }

      if (!active || committed) return;

      // Once the swipe is active, follow the finger directly.
      // There is intentionally NO maximum distance.
      if (dx <= 0) return;

      thread.style.transform =
        `translate3d(${dx}px, 0, 0)`;

      e.preventDefault();
    },
    { passive: false }
  );

  root.addEventListener('pointerup', (e) => {
    if (!tracking || e.pointerId !== pointerId) return;

    const dx = e.clientX - startX;

    if (
      active &&
      dx >= COMMIT_DISTANCE_PX &&
      !committed &&
      dmActivePeer
    ) {
      committed = true;

      const currentThread = thread;

      currentThread.style.transition =
        `transform ${ANIMATION_MS}ms ease`;

      // Finish the animation across the entire remaining width.
      currentThread.style.transform =
        'translate3d(100%, 0, 0)';

      window.setTimeout(() => {
        if (dmActivePeer) {
          window.closeDmThreadMobile();
        }
      }, ANIMATION_MS);
    } else {
      clearVisualState(true);
    }

    try {
      if (root.hasPointerCapture?.(e.pointerId)) {
        root.releasePointerCapture(e.pointerId);
      }
    } catch {}

    reset();
  });

  // Do NOT treat pointercancel as a normal swipe failure.
  // touch-action below prevents the browser from stealing the
  // horizontal gesture in the first place.
  root.addEventListener('pointercancel', (e) => {
    if (!tracking || e.pointerId !== pointerId) return;

    clearVisualState(true);
    reset();
  });
}

// ---------- Open conversation ----------
// `opts.fromNav` is set by navigation.js when it calls this back as a
// DM history entry's restore() — i.e. Back is switching to a
// conversation that's already represented in the navigation stack, so
// this must not push another entry for it (that would duplicate the
// entry Back is in the middle of revealing).
window.openDmConversation = async function (peerId, username, opts = {}) {
  const { fromNav = false } = opts;

  peerId = Number(peerId);
  if (!Number.isInteger(peerId) || peerId <= 0) {
    showToast('Invalid DM recipient', 'error');
    return;
  }

  if (
    dmActivePeer &&
    dmActivePeer.id === peerId &&
    document.getElementById('dm-messages')
  ) {
    return;
  }

  dmTypingEmitter.stop();
  dmTypingIndicator.clearAll();
  saveDmScrollState();
  settleUnread(dmEntry);

  dmActivePeer = { id: peerId, username };
  dmEntry = getOrCreateDmCacheEntry(peerId, username);

  // Record this conversation in navigation history so Android Back
  // steps through DM Alice -> DM Bob -> ... one conversation at a
  // time, same as any other navigation context. Skipped when this
  // call is itself a restore() coming from navigation.js (fromNav),
  // and when the conversation now on top of the stack is already
  // this same peer (reselecting the active conversation, e.g. from
  // the "New message" picker, isn't a new navigation state).
  if (!fromNav) {
    const topEntry = peekNavEntry();
    const alreadyTop =
      topEntry &&
      topEntry.type === 'dm' &&
      Number(topEntry.params?.id) === peerId;

    if (!alreadyTop) {
      pushNavEntry({
        type: 'dm',
        key: 'messages',
        params: { id: peerId, username },
        restore: (params) =>
          window.openDmConversation(params.id, params.username, {
            fromNav: true,
          }),
        deactivate: () => window.closeDmThreadMobile(),
      });
    }
  }

  document.querySelector('.dm-layout')?.classList.add('showing-thread');
  cleanupImageUrls(document.getElementById('dm-messages'), 'dm');

  const list = document.getElementById('dm-conv-list');
  if (list) {
    list.querySelectorAll('.dm-conv').forEach((el) => el.classList.remove('active'));
    const activeEl = list.querySelector(`.dm-conv[data-peer="${peerId}"]`);
    if (activeEl) activeEl.classList.add('active');
  }

  const thread = document.getElementById('dm-thread');
      // Defensive reset in case the thread was previously closed
    // through a swipe animation or another animated transition.
    thread.style.transition = 'none';
    thread.style.transform = '';

playDmThreadEnter();

thread.innerHTML = `
    <div class="chat-top-bar chat-header-glass">
      <button class="icon-btn dm-back-btn" title="Back" onclick="window.backFromDmThread()">${ICONS.arrowLeft}</button>
      <div class="dm-peer-profile" title="View ${escapeAttr(username)}'s profile" onclick="window.openProfileCard(${peerId})">
        ${avatarHtml(peerId, username, 'chat-top-avatar', false)}
        <div class="dm-peer-meta">
          <div class="chat-top-name">${escapeHtml(username)}</div>
          <div class="chat-top-status${
            isUserOnline(peerId) ? ' online' : ''
          }" id="dm-thread-status">${
            getPresenceStatusText(peerId)
          }</div>
        </div>
      </div>
    </div>
    <div class="chat-messages-wrap">
      <div class="chat-messages" id="dm-messages">${loadingState()}</div>
      <button type="button" class="jump-to-latest-btn" id="dm-jump-latest" title="Jump to latest" aria-label="Jump to latest messages" onclick="window.dmJumpToLatest()">
        ${ICONS.arrowDown}
        <span class="unread-dot" aria-hidden="true"></span>
      </button>
    </div>
    <div class="typing-indicator" id="dm-typing-indicator"></div>
    <div class="composer-wrapper">
      <div class="reply-preview-bar" id="dm-reply-preview"></div>
      <div class="reply-preview-bar" id="dm-edit-preview"></div>
      <div class="attach-staging" id="dm-attach-staging"></div>
      <div class="composer-recording-bar" id="dm-recording-bar">
        <button type="button" class="composer-recording-cancel" id="dm-recording-cancel" aria-label="Cancel recording">Cancel</button>
        <div class="composer-recording-indicator">
          <span class="composer-recording-dot" aria-hidden="true"></span>
          <span id="dm-recording-time">0:00</span>
        </div>
        <button type="button" class="composer-recording-stop" id="dm-recording-stop" aria-label="Stop recording">${ICONS.stop}</button>
      </div>
      <div class="chat-input-area" id="dm-input-area">
        <input type="file" id="dm-file-input" class="hidden" multiple>
        <button class="btn btn-ghost btn-icon" title="Attach" onclick="document.getElementById('dm-file-input').click()">${ICONS.paperclip}</button>
        <button class="btn btn-ghost btn-icon emoji-trigger" title="Emoji" onclick="window.openDmEmojiPicker(this)">${ICONS.emoji}</button>
        <textarea id="dm-input" rows="1" placeholder="Message ${escapeHtml(username)}…"></textarea>
        <button class="composer-mic-btn" id="dm-mic-btn" aria-label="Record a voice message">${ICONS.mic}</button>
        <button onclick="window.sendDm()" class="btn-send" title="Send message (Enter) — Shift+Enter for a new line">${ICONS.send}</button>
      </div>
    </div>
  `;

  // Fire-and-forget: fills in "Last seen …" for a peer who was
  // already offline before this session's socket connected (nothing
  // live has told us their last-seen time yet). Header/dot already
  // rendered correctly from local state above either way.
  refreshPeerPresence(peerId);

  if (dmComposer) dmComposer.destroy();

  dmComposer = createComposer({
    inputId: 'dm-input',
    fileInputId: 'dm-file-input',
    stagingId: 'dm-attach-staging',
    replyPreviewId: 'dm-reply-preview',
    sendTextUrl: '/api/dm/messages',
    uploadUrl: '/api/dm/upload',
    buildTextBody: async (content) => {
      const recipientId = Number(dmActivePeer.id);
      return {
        recipient_id: recipientId,
        content: await encryptForActivePeer(content),
      };
    },
    buildFormExtra: (form) => form.append('recipient_id', dmActivePeer.id),
    onMessage: (message) => {
      addDmMessage(message);
      // The composer only calls onMessage after the send succeeded
      // (text, file and voice paths alike), so a failed send never
      // reaches this line.
      messageSoundManager.playSent(message?.id);
    },
    typingEmitter: dmTypingEmitter,
    canSend: () => !!dmActivePeer,
    inputAreaId: 'dm-input-area',
    micButtonId: 'dm-mic-btn',
    recordingBarId: 'dm-recording-bar',
    recordingTimeId: 'dm-recording-time',
    recordingCancelId: 'dm-recording-cancel',
    recordingStopId: 'dm-recording-stop',
    // ---------- Edit mode ----------
    editPreviewId: 'dm-edit-preview',
    buildEditBody: async (content) => ({
      content: await encryptForActivePeer(content),
    }),
    editUrlFor: (id) => `/api/dm/messages/${id}`,
    onEdit: (message) => {
      void updateDmMessage(message);
    },
    // ArrowUp in an empty input: edit my most recent editable message.
    onEditLast: () => {
      const currentUser = getCurrentUser();
      const messages = dmEntry?.messages;
      if (!currentUser || !messages) return;

      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (
          Number(m.sender_id) === Number(currentUser.id) &&
          m.content &&
          !m.has_attachment
        ) {
          window.editDmMessage(m.id);
          return;
        }
      }
    },
  });

  wirePasteImage('dm-input', (file) => dmComposer.addFiles([file]));
  wireTypingInput('dm-input', dmTypingEmitter);

  const container = document.getElementById('dm-messages');

  // Touch swipe-to-reply on this fresh #dm-messages element (its
  // listeners go away with it the next time the thread is rebuilt). On
  // the phone layout a rightward swipe that starts in the left edge
  // strip belongs to swipe-back, so it is not started here.
  bindDmMessageActions(container);

  bindSwipeToReply(container, {
    onReply: (id) => window.replyToDmMessage(id),
    shouldIgnoreStart: (e, dir) =>
      dir > 0 &&
      window.innerWidth <= DM_MOBILE_BREAKPOINT &&
      e.clientX <= DM_SWIPE_BACK_EDGE_PX,
  });

  container.addEventListener(
    'scroll',
    () => {
      if (dmEntry) dmEntry.atBottom = isNearBottom(container);
      refreshJumpToLatestButton();
    },
    { passive: true }
  );

  attachLoadMoreObserver(container);

  if (dmEntry.initialized) {
    renderDmMessagesFromCache();
    void syncDmMessagesSince();
  } else {
    await loadRecentDm();
  }

  void loadDmConversations();
  void refreshUnreadBadge();
};

// ---------- Close conversation ----------
window.closeDmThreadMobile = function () {
  saveDmScrollState();
  settleUnread(dmEntry);

  const thread = document.getElementById('dm-thread');

  // A swipe-back leaves the thread translated to 100%.
  // Reset the inline transform before this same DOM node is
  // reused for another conversation.
  if (thread) {
    thread.style.transition = 'none';
    thread.style.transform = '';
  }

  document.querySelector('.dm-layout')?.classList.remove('showing-thread');

  dmTypingEmitter.stop();
  dmTypingIndicator.clearAll();
  dmActivePeer = null;
  dmEntry = null;

  document
    .querySelectorAll('.dm-conv')
    .forEach((el) => el.classList.remove('active'));
};

// ---------- Render cache ----------
function renderDmMessagesFromCache() {
  const container = document.getElementById('dm-messages');
  if (!container || !dmEntry) return;

  if (dmEntry.messages.length === 0) {
    container.innerHTML = emptyState(
      ICONS.mail,
      'No messages yet',
      `Say hello to ${escapeHtml(dmActivePeer.username)} 👋`
    );
    return;
  }

  const currentUser = getCurrentUser();
  const frag = document.createDocumentFragment();

  if (dmEntry.hasMore) {
    frag.appendChild(buildLoadMoreEl(loadOlderDm));
  }

  const layout = createLayoutBuilder(frag, {
    boundaryId: dmEntry.unreadFromId,
    myId: currentUserId()
  });
  for (const msg of dmEntry.messages) {
    layout.add(msg, buildDmMessageEl(msg, currentUser));
  }
  if (layout.unreadInserted) dmEntry.unreadShown = true;

  container.innerHTML = '';
  container.appendChild(frag);

  container.scrollTop = dmEntry.atBottom ? container.scrollHeight : dmEntry.scrollTop;
  observeLoadMoreRowIfPresent(container);
  refreshJumpToLatestButton();
}

// ---------- Sync cached conversation ----------
// ---------- Live read receipts for an already-open conversation ----------
//
// Root cause this exists to fix: marking a peer's messages read (and
// telling them via a seen receipt) only ever happened in
// getRecentMessagesHandler/getMessagesSinceHandler on the server —
// i.e. only when a REST call fetches messages, which on the client
// only happens from loadRecentDm()/syncDmMessagesSince() when a
// conversation is opened or reopened. A message pushed live over the
// socket while that same conversation was already open landed in
// addDmMessage() above, which only ever touched the local cache/DOM —
// it never told the server anything, so read_at/seen_at (and the
// unread counts derived from them) stayed stale until the thread was
// closed and reopened. This calls the exact same server path
// (markRead() + the conditional dm-messages-seen emit — see
// controllers/dm.controller.js's getMessagesSinceHandler) for that
// live case, instead of waiting for the next reopen.
//
// One in-flight request per peer, not one per message: the server's
// markRead() marks every currently-unread message from that peer in
// one go, not just whichever one triggered the call, so a single
// request already covers an entire burst — this just avoids firing
// five near-simultaneous, redundant requests for a 5-message burst.
// No timer involved: a call that arrives mid-flight is simply
// remembered and re-run once, immediately after the current one
// settles, which still covers anything that arrived in between.
const liveReadMark = {
  peerId: null,
  inFlight: false,
  pending: false
};

async function markActiveConversationReadLive(peerId) {
  if (liveReadMark.peerId !== peerId) {
    // Switched conversations mid-flight — a pending re-run for the
    // previous peer is no longer relevant.
    liveReadMark.peerId = peerId;
    liveReadMark.pending = false;
  }

  if (liveReadMark.inFlight) {
    liveReadMark.pending = true;
    return;
  }

  liveReadMark.inFlight = true;

  try {
    // `since` = right now always yields zero rows here — the message
    // that triggered this call already arrived (and was rendered) via
    // the socket push, so this call's only effect is the server-side
    // read-marking side effect, not a resync/refetch of the thread.
    // Privacy (send_read_receipts) is enforced entirely server-side
    // in markRead() — nothing here needs to know or check it.
    await api(
      `/api/dm/messages/${peerId}/since?since=${encodeURIComponent(new Date().toISOString())}&limit=1`
    );

    // The sidebar/badge were already refreshed once, with the
    // pre-mark-read (stale) count, by handleDirectMessage right when
    // the message arrived (see core/socket.js) — refresh them again
    // now that the server-side unread count has actually changed.
    void loadDmConversations();
    void refreshUnreadBadge();
  } catch (e) {
    console.error('Failed to mark live DM messages as read:', e);
  } finally {
    liveReadMark.inFlight = false;

    if (liveReadMark.pending) {
      liveReadMark.pending = false;
      // liveReadMark.peerId, not the closure's `peerId` — if the
      // active conversation changed while this call was in flight,
      // the pending re-run must follow it, not re-target the peer
      // this particular call started out for.
      void markActiveConversationReadLive(liveReadMark.peerId);
    }
  }
}

async function syncDmMessagesSince() {
  if (!dmActivePeer || !dmEntry || dmEntry.messages.length === 0) return;

  const peerId = dmActivePeer.id;
  const since = dmEntry.messages[dmEntry.messages.length - 1].timestamp;

  try {
    const messages = await api(
      `/api/dm/messages/${peerId}/since?since=${encodeURIComponent(since)}&limit=100`
    );

    if (!dmActivePeer || dmActivePeer.id !== peerId) return;
    if (messages.length === 0) return;

    const decryptedMessages = await decryptDmMessages(messages);
    if (!dmActivePeer || dmActivePeer.id !== peerId) return;

    const container = document.getElementById('dm-messages');
    const wasAtBottom = container ? isNearBottom(container) : dmEntry.atBottom;
    const currentUser = getCurrentUser();
    const frag = document.createDocumentFragment();

    const fresh = decryptedMessages.filter((m) => !dmEntry.ids.has(m.id));
    if (fresh.length === 0) return;

    if (dmEntry.unreadFromId == null) {
      dmEntry.unreadFromId = findFirstUnreadId(fresh, currentUserId());
    }

    const prevMsg = dmEntry.messages[dmEntry.messages.length - 1] || null;
    const lastEl = container ? container.lastElementChild : null;
    const layout = createLayoutBuilder(frag, {
      prevMsg,
      prevEl:
        lastEl && prevMsg && lastEl.dataset?.msgId === String(prevMsg.id)
          ? lastEl
          : null,
      boundaryId: dmEntry.unreadFromId,
      myId: currentUserId()
    });

    for (const msg of fresh) {
      dmEntry.ids.add(msg.id);
      dmEntry.byId.set(msg.id, msg);
      dmEntry.messages.push(msg);
      if (container) layout.add(msg, buildDmMessageEl(msg, currentUser));
    }
    if (layout.unreadInserted) dmEntry.unreadShown = true;

    if (container && frag.childNodes.length > 0) {
      container.appendChild(frag);
      if (wasAtBottom) {
        container.scrollTop = container.scrollHeight;
        dmEntry.atBottom = true;
      }
    }
  } catch (e) {
    console.error('Failed to sync DM messages:', e);
  }
}

// ---------- Load recent messages ----------
async function loadRecentDm() {
  if (!dmActivePeer || !dmEntry) return;

  const entry = dmEntry;
  const container = document.getElementById('dm-messages');
  if (!container) return;

  try {
    const messages = await api(
      `/api/dm/messages/${dmActivePeer.id}/recent?limit=50`
    );

    if (dmEntry !== entry) return;

    const decryptedMessages = await decryptDmMessages(messages);
    if (dmEntry !== entry || !container.isConnected) return;

    cleanupImageUrls(container, 'dm');
    container.innerHTML = '';
    entry.initialized = true;

    if (decryptedMessages.length === 0) {
      container.innerHTML = emptyState(
        ICONS.mail,
        'No messages yet',
        `Say hello to ${escapeHtml(dmActivePeer.username)} 👋`
      );
      entry.hasMore = false;
      entry.atBottom = true;
      return;
    }

    entry.oldest = decryptedMessages[0].timestamp;
    entry.hasMore = decryptedMessages.length >= 50;

    const frag = document.createDocumentFragment();
    if (entry.hasMore) {
      frag.appendChild(buildLoadMoreEl(loadOlderDm));
    }

    const currentUser = getCurrentUser();
    const unreadId = findFirstUnreadId(decryptedMessages, currentUserId());
    if (unreadId != null) entry.unreadFromId = unreadId;

    const layout = createLayoutBuilder(frag, {
      boundaryId: entry.unreadFromId,
      myId: currentUserId()
    });
    for (const msg of decryptedMessages) {
      entry.ids.add(msg.id);
      entry.byId.set(msg.id, msg);
      entry.messages.push(msg);
      layout.add(msg, buildDmMessageEl(msg, currentUser));
    }
    if (layout.unreadInserted) entry.unreadShown = true;

    container.appendChild(frag);
    container.scrollTop = container.scrollHeight;
    entry.atBottom = true;
    observeLoadMoreRowIfPresent(container);
    refreshJumpToLatestButton();
  } catch (e) {
    if (dmEntry !== entry || !container.isConnected) return;
    container.innerHTML = emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message));
  }
}

// ---------- Load older messages ----------
async function loadOlderDm() {
  if (!canLoadMoreDm()) return;

  const entry = dmEntry;
  const peerId = dmActivePeer.id;
  const container = document.getElementById('dm-messages');
  // The thread isn't mounted (e.g. Settings is open): nothing to prepend to.
  if (!container) return;
  const btnRow = document.getElementById('chat-load-more-row');
  if (btnRow) btnRow.querySelector('.load-more-btn').textContent = 'Loading…';

  entry.loadingOlder = true;

  try {
    const messages = await api(
      `/api/dm/messages/${peerId}/before?before=${encodeURIComponent(
        entry.oldest
      )}&limit=50`
    );

    entry.loadingOlder = false;
    if (dmEntry !== entry) return;
    if (btnRow) btnRow.remove();

    if (messages.length === 0) {
      entry.hasMore = false;
      observeLoadMoreRowIfPresent(container);
      return;
    }

    const decryptedMessages = await decryptDmMessages(messages);
    if (dmEntry !== entry) return;
    // Thread was torn down/rebuilt while we were fetching: drop this page,
    // it will be fetched again from the fresh thread.
    if (!container.isConnected) return;

    entry.oldest = decryptedMessages[0].timestamp;
    entry.hasMore = decryptedMessages.length >= 50;

    const oldTop = container.scrollTop;
    const prevHeight = container.scrollHeight;

    const frag = document.createDocumentFragment();
    if (entry.hasMore) {
      frag.appendChild(buildLoadMoreEl(loadOlderDm));
    }

    const currentUser = getCurrentUser();
    const newMessages = [];
    const layout = createLayoutBuilder(frag, {
      boundaryId: entry.unreadFromId,
      myId: currentUserId()
    });
    let lastNewEl = null;
    for (const msg of decryptedMessages) {
      if (!entry.ids.has(msg.id)) {
        entry.ids.add(msg.id);
        entry.byId.set(msg.id, msg);
        newMessages.push(msg);
        lastNewEl = buildDmMessageEl(msg, currentUser);
        layout.add(msg, lastNewEl);
      }
    }
    if (layout.unreadInserted) entry.unreadShown = true;

    const firstOldMsg = entry.messages[0] || null;
    const firstOldEl = firstOldMsg
      ? container.querySelector(':scope > .chat-msg')
      : null;

    entry.messages.unshift(...newMessages);
    container.insertBefore(frag, container.firstChild);

    // The page above joins the old top of the list: its date separator
    // (it used to be first) and its group may need to change.
    if (firstOldEl && lastNewEl) {
      repairSeam({
        prevMsg: newMessages[newMessages.length - 1],
        prevEl: lastNewEl,
        nextMsg: firstOldMsg,
        nextEl: firstOldEl,
        boundaryId: entry.unreadFromId,
        myId: currentUserId(),
        // The older page can move where the group at the seam starts,
        // which changes how far its outgoing window reaches below.
        msgOf: dmMsgOfRow
      });
    }
    container.scrollTop = oldTop + (container.scrollHeight - prevHeight);
    observeLoadMoreRowIfPresent(container);
  } catch (e) {
    entry.loadingOlder = false;
    if (dmEntry !== entry) return;
    if (btnRow) btnRow.querySelector('.load-more-btn').textContent = 'Load older messages';
    // Stop auto-triggering on this row after a failure — it's still
    // sitting at the top of the viewport (that's what triggered this
    // call), so the observer would otherwise refire immediately in a
    // retry loop. The visible button is the fallback: a manual click
    // calls loadOlderDm() directly, bypassing the observer entirely.
    dmLoadMoreObserver?.disconnect();
    showToast(e.message, 'error');
  }
}

// ---------- UI Components ----------
function buildLoadMoreEl(onClick) {
  const row = document.createElement('div');
  row.className = 'load-more-row';
  row.id = 'chat-load-more-row';
  const btn = document.createElement('button');
  btn.className = 'load-more-btn';
  btn.textContent = 'Load older messages';
  btn.onclick = onClick;
  row.appendChild(btn);
  return row;
}

// Read-receipt ticks — own messages only. Single check = sent
// (the message exists), double check = seen_at is set (the recipient
// actually read it while they had "Send Read Receipts" enabled — see
// services/dm.service.js's markRead). There is deliberately no
// separate "delivered" state: this architecture has no reliable ack
// that a specific device received the socket emit, and a live
// message-list overhaul is not the place to invent one, so showing
// only sent/seen avoids faking a delivery status we can't verify.
function dmTicksHtml(msg, own, variant = '') {
  if (!own) return '';
  const seen = !!msg.seen_at;
  const cls = ['dm-ticks', variant, seen ? 'seen' : ''].filter(Boolean).join(' ');
  return `<span class="${cls}" title="${seen ? 'Read' : 'Sent'}" aria-label="${seen ? 'Read' : 'Sent'}">${seen ? ICONS.checkDouble : ICONS.check}</span>`;
}

// Side status for grouped (compacted) messages: the small "Edited"
// text and, for own messages, the read-receipt ticks, kept together in
// one container so "Edited" always sits right beside the seen icon.
// "Edited" is shown to BOTH sides of the conversation (the recipient
// needs to know a message was changed too); the ticks are own-only.
function dmEditedSideHtml(msg) {
  if (!msg.edited_at) return '';
  return `<span class="chat-edited-flag chat-edited-flag-side">Edited</span>`;
}

function dmSideStatusHtml(msg, own) {
  return `<span class="dm-side-status" aria-hidden="true">${dmEditedSideHtml(msg)}${dmTicksHtml(msg, own, 'dm-ticks-side')}</span>`;
}

function buildDmMessageEl(msg, currentUser) {
  const own =
    currentUser && Number(msg.sender_id) === Number(currentUser.id);
  const canDelete = own || (currentUser && currentUser.is_admin);

  const div = document.createElement('div');
  div.className = `chat-msg${own ? ' own' : ''}`;
  div.dataset.msgId = msg.id;
  setMessageAccent(div);

  const messageText =
    msg.content == null ? '' : String(msg.content);

  // Edit is only ever offered for the sender's own plain-text
  // messages — never for something received, and never for an
  // attachment (see dm.controller.js's editMessage for the matching
  // server-side check; this is UI affordance only, not the real
  // enforcement).
  const canEdit =
    own && !!messageText && !msg.has_attachment;

  div.innerHTML = `
    ${avatarHtml(msg.sender_id, msg.sender_username, 'chat-avatar')}
    <div class="chat-msg-content">
      <div class="chat-meta">
        <span class="chat-sender">${escapeHtml(msg.sender_username)}</span>
        <time class="chat-time" datetime="${escapeAttr(msg.timestamp)}" title="${escapeAttr(formatFullDateTime(msg.timestamp))}">${formatTime(msg.timestamp)}</time>
        ${
          msg.edited_at
            ? `<span class="chat-edited-flag">Edited</span>`
            : ''
        }
        ${dmTicksHtml(msg, own)}
      </div>
      ${buildReplyQuoteHtml(msg, 'dm')}
      ${
        messageText
          ? `<div class="chat-bubble" dir="auto">${linkifyHtml(messageText)}</div>`
          : ''
      }
      ${msg.has_attachment ? renderAttachment(msg, 'dm') : ''}
      <div class="chat-msg-actions" role="toolbar" aria-label="Message actions">
        <div class="chat-msg-actions-bar">
        <button type="button" class="chat-msg-reply" title="Reply" aria-label="Reply" onclick="window.replyToDmMessage(${msg.id})">${ICONS.reply}</button>
        ${
          canEdit
            ? `<button type="button" class="chat-msg-edit" title="Edit message" aria-label="Edit message" onclick="window.editDmMessage(${msg.id})">${ICONS.edit}</button>`
            : ''
        }
        ${reactButtonHtml(msg, 'dm')}
        ${
          messageText
            ? `<button type="button" class="chat-msg-copy" title="Copy message text" aria-label="Copy message text">${ICONS.copy}</button>`
            : ''
        }
        ${imageDownloadButtonHtml(msg, 'dm')}
        ${
          canDelete
            ? `<button type="button" class="chat-msg-delete" title="Delete message" aria-label="Delete message" onclick="window.deleteDmMessage(${msg.id})">${ICONS.trash}</button>`
            : ''
        }
        </div>
      </div>
      ${renderReactionsRow(msg, 'dm')}
    </div>
    <time class="chat-time chat-time-side" datetime="${escapeAttr(msg.timestamp)}" title="${escapeAttr(formatFullDateTime(msg.timestamp))}" aria-hidden="true">${formatTime(msg.timestamp)}</time>
    ${dmSideStatusHtml(msg, own)}
  `;

  if (
    msg.has_attachment &&
    msg.attachment_mime &&
    msg.attachment_mime.startsWith('image/')
  ) {
    queueMicrotask(() => loadChatImage(msg.id, 'dm'));
  }

  mountAttachmentMedia(msg, div, 'dm');
  return div;
}

// ---------- Message actions (copy, tap-to-reveal, double-tap react, right-click menu) ----------
// One delegated click listener per #dm-messages element (the element is
// rebuilt for every conversation, so nothing accumulates). No
// per-message handlers.

async function copyDmMessageText(btn) {
  const row = btn.closest('.chat-msg');
  const msg = row ? dmEntry?.byId.get(Number(row.dataset.msgId)) : null;
  // The decrypted plain text as sent — never the rendered HTML, ids,
  // names or timestamps.
  const text = msg && msg.content != null ? String(msg.content) : '';
  if (!text) {
    showToast('Nothing to copy', 'info');
    return;
  }

  // copyText() (files/links.js) only has a non-Clipboard-API fallback
  // when given an input to select; a throwaway one keeps this working
  // where navigator.clipboard is unavailable.
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText =
    'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(field);
  let result;
  try {
    result = await copyText(text, field);
  } finally {
    field.remove();
  }

  if (result === 'copied') {
    showToast('Message copied', 'success');
    btn.innerHTML = ICONS.check;
    setTimeout(() => {
      if (btn.isConnected) btn.innerHTML = ICONS.copy;
    }, 1200);
  } else {
    showToast('Couldn\u2019t copy automatically', 'error');
  }
}

// Double-tap = two touch clicks on the same message this close in
// time and space. Built on `click` (not touchstart/touchend or
// dblclick): the browser emits exactly one click per tap, so a tap can
// never be counted twice, a swipe/scroll produces no click at all (and
// swipe-reply swallows the click after its own gesture), and the
// picker opens from inside a click — which the picker's own
// outside-click listener (registered a tick later) cannot see.
// .chat-msg is touch-action:pan-y, so there is no double-tap-zoom and
// no click delay: the first tap acts immediately.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 30;

function bindDmMessageActions(container) {
  // Desktop: right-click opens the same action bar (tap-reveal.js);
  // touch keeps the tap toggle below.
  bindContextMenu(container);

  let openRow = null;
  let armTimer = 0;
  let lastTap = null; // { row, t, x, y }

  // A row's extras open on the first tap but only become tappable once
  // the double-tap window has passed (.is-actions-armed): a floating
  // toolbar that opens over the message's edge would otherwise catch
  // the second tap of a double-tap (the browser snaps taps to nearby
  // buttons) and fire Reply/Delete instead of opening the reactions.
  const setRowActions = (row, on) => {
    clearTimeout(armTimer);
    row.classList.toggle('is-actions-open', on);
    row.classList.remove('is-actions-armed');

    // Same tap that opens the action bar also reveals a grouped row's
    // timestamp/seen indicator (CSS in features/messages.css, scoped to
    // touch via hover:none) — unless the user turned that off in
    // Settings > Appearance > "Show timestamp and seen on message
    // touch" (mobile-only; see getDmTapTimestampEnabled()/theme.js).
    row.classList.toggle(
      'is-timestamp-open',
      on && getDmTapTimestampEnabled()
    );

    if (on) {
      // Opposite side of the sender, kept inside the visible list.
      placeActionBar(row, container);
      armTimer = setTimeout(() => {
        if (row.classList.contains('is-actions-open')) {
          row.classList.add('is-actions-armed');
        }
      }, DOUBLE_TAP_MS + 20);
    }
    openRow = on ? row : null;
  };

  container.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.chat-msg-copy');
    if (copyBtn && container.contains(copyBtn)) {
      e.preventDefault();
      void copyDmMessageText(copyBtn);
      return;
    }

    if (!isTouchClick(e)) return;

    // Taps on links, buttons, media, attachments, the reply quote or
    // reaction pills belong to those controls and never count.
    if (e.target.closest(TAP_IGNORE_SELECTOR)) {
      lastTap = null;
      return;
    }
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) {
      lastTap = null;
      return;
    }

    const row = e.target.closest('.chat-msg');
    if (openRow && openRow !== row) setRowActions(openRow, false);
    if (!row || !container.contains(row)) {
      lastTap = null;
      return;
    }

    // Double-tap on the bubble (or, for a message without one, its
    // content area) opens the SAME reaction picker the React button
    // opens, via window.openReactionPicker.
    const msgId = Number(row.dataset.msgId);
    const target =
      e.target.closest('.chat-bubble') ||
      (row.querySelector('.chat-bubble')
        ? null
        : e.target.closest('.chat-msg-content'));

    if (
      target &&
      lastTap &&
      lastTap.row === row &&
      e.timeStamp - lastTap.t <= DOUBLE_TAP_MS &&
      Math.abs(e.clientX - lastTap.x) <= DOUBLE_TAP_SLOP_PX &&
      Math.abs(e.clientY - lastTap.y) <= DOUBLE_TAP_SLOP_PX
    ) {
      lastTap = null; // a third rapid tap starts a new gesture
      setRowActions(row, false);
      if (dmEntry?.byId.has(msgId) && !isEmojiPickerOpen()) {
        window.openReactionPicker('dm', msgId, target);
      }
      return;
    }

    lastTap = target
      ? { row, t: e.timeStamp, x: e.clientX, y: e.clientY }
      : null;

    // Single tap (acts immediately, no waiting for a possible second
    // tap): nothing is permanently drawn on the bubbles, so it toggles
    // the row's extra actions (React/Copy, and a grouped row's toolbar,
    // which would otherwise sit on top of the message above).
    setRowActions(row, !row.classList.contains('is-actions-open'));
  });
}

// ---------- Incoming / outgoing messages ----------
export async function addDmMessage(msg) {
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  const peerId =
    Number(msg.sender_id) === Number(currentUser.id)
      ? Number(msg.recipient_id)
      : Number(msg.sender_id);

  if (!Number.isInteger(peerId) || peerId <= 0) {
    console.error('Invalid DM peer ID:', msg);
    return;
  }

  const entry = getOrCreateDmCacheEntry(
    peerId,
    dmActivePeer?.id === peerId ? dmActivePeer.username : undefined
  );

  if (entry.ids.has(msg.id)) return;

  let decrypted;
  try {
    decrypted = await decryptDmMessage(msg);
  } catch (e) {
    console.error(`Failed to process DM ${msg.id}:`, e);

    /*
     * IMPORTANT:
     * Failed encrypted messages are NOT inserted into the normal
     * message cache and are NOT passed to buildDmMessageEl().
     *
     * This prevents ciphertext from ever reaching .chat-bubble.
     */
    const isActiveConversation =
      dmActivePeer && Number(dmActivePeer.id) === peerId;

    if (isActiveConversation) {
      const container = document.getElementById('dm-messages');

      if (container) {
        const errorEl = document.createElement('div');
        errorEl.className = 'chat-msg';
        errorEl.dataset.msgId = msg.id;

        errorEl.innerHTML = `
          <div class="chat-msg-content">
            <div class="chat-bubble">Unable to decrypt</div>
          </div>
        `;

        const emptyEl = container.querySelector('.empty-state');
        if (emptyEl) container.innerHTML = '';

        container.appendChild(errorEl);
      }
    }

    return;
  }

  entry.ids.add(msg.id);
  entry.byId.set(msg.id, decrypted);
  entry.messages.push(decrypted);

  const isActiveConversation =
    dmActivePeer && Number(dmActivePeer.id) === peerId;

  // Decision + platform dispatch for a system notification lives
  // entirely in notification-manager.js. It already knows how to
  // ignore the current user's own messages, so it's safe to call
  // unconditionally here rather than threading a "was this from
  // the socket" flag through — the composer's own optimistic-add
  // path lands here too, and is simply a no-op for that module.
  maybeNotifyDM(decrypted, isActiveConversation);

  // In-app "message received" sound. addDmMessage() is only reached
  // for live messages (the Socket.IO 'new-dm-message' event and the
  // composer's own send) — initial load, history sync and pagination
  // fill the cache directly and never come through here. Reaching this
  // point also means the message passed the entry.ids dedupe above and
  // decrypted successfully; the manager additionally dedupes by id to
  // cover two concurrent calls racing past that check.
  if (Number(decrypted.sender_id) !== Number(currentUser.id)) {
    messageSoundManager.playReceived(decrypted.id);
  }

  if (!isActiveConversation) {
    // Arrived while this thread is closed: remember where the unread
    // run starts so the marker is drawn when the thread is opened.
    if (
      entry.unreadFromId == null &&
      Number(decrypted.sender_id) !== Number(currentUser.id)
    ) {
      entry.unreadFromId = decrypted.id;
    }
    return;
  }

  // This message just arrived while its conversation is the one the
  // user is actively viewing — the recipient has, in effect, already
  // read it. Tell the server now rather than waiting for the thread
  // to be closed and reopened (openDmConversation()'s call to
  // syncDmMessagesSince() below is the only other place that does
  // this, which is exactly why it previously only ever caught up on
  // reopen). Skipped for our own outgoing messages, which don't need
  // marking read against our own inbox.
  if (Number(decrypted.sender_id) !== Number(currentUser.id)) {
    void markActiveConversationReadLive(peerId);
  }

  const container = document.getElementById('dm-messages');
  if (!container) return;

  if (container.querySelector(`.chat-msg[data-msg-id="${msg.id}"]`)) return;

  const el = buildDmMessageEl(decrypted, currentUser);
  // New-message entrance — only for a message arriving/sent live
  // here, never the initial history load, so scrollback never
  // animates in all at once.
  el.classList.add('msg-enter');
  const emptyEl = container.querySelector('.empty-state');
  if (emptyEl) container.innerHTML = '';

  // `entry.messages` already ends with this message; the one before it
  // is what it may group with / get a date separator against.
  const prevMsg =
    entry.messages.length > 1
      ? entry.messages[entry.messages.length - 2]
      : null;
  const lastEl = container.lastElementChild;
  createLayoutBuilder(container, {
    prevMsg,
    prevEl:
      lastEl && prevMsg && lastEl.dataset?.msgId === String(prevMsg.id)
        ? lastEl
        : null,
    boundaryId: null,
    myId: currentUserId()
  }).add(decrypted, el);

  const isOwnMessage = Number(msg.sender_id) === Number(currentUser.id);
  const wasAtBottom = dmEntry ? dmEntry.atBottom : true;

  if (wasAtBottom || isOwnMessage) {
    container.scrollTop = container.scrollHeight;
    if (dmEntry) dmEntry.atBottom = true;
    refreshJumpToLatestButton();
  } else {
    // User is reading scrollback — leave their position alone (don't
    // forcibly scroll them down) but flag the jump-to-latest button so
    // they know something new arrived below.
    document.getElementById('dm-jump-latest')?.classList.add('has-new');
  }
}

// ---------- Read receipts ----------
// Received via the 'dm-messages-seen' socket event (core/socket.js) —
// only ever describes messages *we* sent to `reader_id`, so there is
// no sender/recipient ambiguity to resolve here.
export function markDmMessagesSeen({ reader_id, message_ids, seen_at }) {
  const peerId = Number(reader_id);
  const entry = dmCache.get(peerId);
  if (!entry) return;

  let changedIds = [];
  for (const id of message_ids) {
    const msg = entry.byId.get(Number(id));
    if (msg && !msg.seen_at) {
      msg.seen_at = seen_at || new Date().toISOString();
      changedIds.push(msg.id);
    }
  }
  if (changedIds.length === 0) return;

  const isActiveConversation = dmActivePeer && Number(dmActivePeer.id) === peerId;
  if (!isActiveConversation) return;

  const container = document.getElementById('dm-messages');
  if (!container) return;

  for (const id of changedIds) {
    const row = container.querySelector(`.chat-msg[data-msg-id="${id}"]`);
    if (!row) continue;
    row.querySelectorAll('.dm-ticks').forEach((ticksEl) => {
      ticksEl.classList.add('seen');
      ticksEl.innerHTML = ICONS.checkDouble;
      ticksEl.title = 'Read';
      ticksEl.setAttribute('aria-label', 'Read');
    });
  }
}

// ---------- Edit message ----------
// Received both from the composer's own successful PATCH (onEdit
// config above) and from the 'dm-message-edited' socket event (see
// core/socket.js) — same server row shape either way, so one
// function handles both: decrypt the new content, patch the cache
// entry in place (never remove-and-reinsert — this is the same
// message, not a new one) and, if its conversation is open, update
// the existing DOM row's bubble text and "edited" flag without
// moving or re-animating the row.
export async function updateDmMessage(msg) {
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  const peerId =
    Number(msg.sender_id) === Number(currentUser.id)
      ? Number(msg.recipient_id)
      : Number(msg.sender_id);

  if (!Number.isInteger(peerId) || peerId <= 0) {
    console.error('Invalid DM peer ID:', msg);
    return;
  }

  const entry = dmCache.get(peerId);
  // Nothing to update if we never had this conversation/message
  // cached — can legitimately happen for a stale/out-of-order event.
  if (!entry || !entry.byId.has(msg.id)) return;

  let decrypted;
  try {
    decrypted = await decryptDmMessage(msg);
  } catch (e) {
    console.error(`Failed to process edited DM ${msg.id}:`, e);
    return;
  }

  entry.byId.set(msg.id, decrypted);
  const idx = entry.messages.findIndex((m) => m.id === msg.id);
  if (idx !== -1) entry.messages[idx] = decrypted;

  const isActiveConversation = dmActivePeer && Number(dmActivePeer.id) === peerId;
  if (!isActiveConversation) return;

  const container = document.getElementById('dm-messages');
  if (!container) return;

  const row = container.querySelector(`.chat-msg[data-msg-id="${msg.id}"]`);
  if (!row) return;

  const bubble = row.querySelector('.chat-bubble');
  const text = decrypted.content == null ? '' : String(decrypted.content);
  if (bubble) {
    bubble.innerHTML = linkifyHtml(text);
  }

  const meta = row.querySelector('.chat-meta');
  if (meta && decrypted.edited_at && !meta.querySelector('.chat-edited-flag')) {
    const flag = document.createElement('span');
    flag.className = 'chat-edited-flag';
    flag.textContent = 'Edited';
    const timeEl = meta.querySelector('.chat-time');
    if (timeEl) {
      timeEl.insertAdjacentElement('afterend', flag);
    } else {
      meta.appendChild(flag);
    }
  }

  // Side metadata (hover/tap column) for grouped messages: put
  // "Edited" inside the side status container, right before the read
  // ticks, for whoever is looking (sender and recipient). This does
  // not depend on the row being grouped at this moment — the CSS only
  // reveals the container for grouped rows, so it is harmless otherwise.
  if (decrypted.edited_at && !row.querySelector('.chat-edited-flag-side')) {
    let status = row.querySelector(':scope > .dm-side-status');
    if (!status) {
      status = document.createElement('span');
      status.className = 'dm-side-status';
      status.setAttribute('aria-hidden', 'true');
      row.appendChild(status);
    }
    const sideFlag = document.createElement('span');
    sideFlag.className = 'chat-edited-flag chat-edited-flag-side';
    sideFlag.textContent = 'Edited';
    status.insertBefore(sideFlag, status.firstChild);
  }
}

// ---------- Delete message ----------
export function removeDmMessage(id) {
  for (const entry of dmCache.values()) {
    if (entry.ids.delete(id)) {
      entry.byId.delete(id);
      const idx = entry.messages.findIndex((m) => m.id === id);
      if (idx !== -1) entry.messages.splice(idx, 1);

      // The boundary message itself was deleted: it moves to the next
      // message from the peer (everything after it is unread too), or
      // disappears if there is none.
      if (entry.unreadFromId === id) {
        const me = currentUserId();
        const next =
          idx === -1
            ? null
            : entry.messages
                .slice(idx)
                .find((m) => Number(m.sender_id) !== me);
        entry.unreadFromId = next ? next.id : null;
      }
    }
  }

  revokeAttachmentImage(id, 'dm');

  const container = document.getElementById('dm-messages');
  if (!container) return;

  const el = container.querySelector(`.chat-msg[data-msg-id="${id}"]`);
  if (!el) return;

  cleanupImageUrls(el, 'dm');

  // Rows around the one being removed, found before it leaves the DOM.
  const siblingRow = (start, dir) => {
    let n = start[dir];
    while (n && !n.classList.contains('chat-msg')) n = n[dir];
    return n;
  };
  const prevEl = siblingRow(el, 'previousElementSibling');
  const nextEl = siblingRow(el, 'nextElementSibling');

  animateRemoval(el, () => {
    if (dmEntry && (prevEl || nextEl)) {
      const lookup = dmMsgOfRow;
      const nextMsg = lookup(nextEl);
      if (nextEl && nextMsg) {
        repairSeam({
          prevMsg: lookup(prevEl),
          prevEl,
          nextMsg,
          nextEl,
          boundaryId: dmEntry.unreadFromId,
          myId: currentUserId(),
          msgOf: dmMsgOfRow
        });
      } else if (prevEl) {
        repairSeam({ prevEl, nextEl: null });
      }
    }
    if (!container.querySelector('.chat-msg')) {
      container.innerHTML = emptyState(
        ICONS.mail,
        'No messages yet',
        dmActivePeer ? `Say hello to ${escapeHtml(dmActivePeer.username)} 👋` : ''
      );
    }
  });
}

// ---------- Emoji ----------
window.openDmEmojiPicker = function (triggerEl) {
  const input = document.getElementById('dm-input');
  if (!input) return;
  openEmojiPicker({
    anchorEl: triggerEl,
    onSelect: (char) => insertAtCursor(input, char),
  });
};

// ---------- Reply ----------
window.replyToDmMessage = function (id) {
  const msg = dmEntry?.byId.get(id);
  if (!msg || !dmComposer) return;
  dmComposer.setReplyTo(buildReplyPreview(msg));
};

// ---------- Edit ----------
window.editDmMessage = function (id) {
  const currentUser = getCurrentUser();
  const msg = dmEntry?.byId.get(id);
  if (!msg || !dmComposer || !currentUser) return;

  // Defense in depth — buildDmMessageEl already only renders this
  // button for own, non-attachment, non-empty messages, but the
  // handler doesn't trust the DOM/onclick argument alone.
  if (Number(msg.sender_id) !== Number(currentUser.id)) return;
  if (msg.has_attachment) return;
  if (!msg.content) return;

  dmComposer.setEditMessage(msg);
};

// ---------- Delete ----------
window.deleteDmMessage = async function (id) {
  if (!(await showConfirm('Delete this message? This cannot be undone.', { title: 'Delete message' }))) {
    return;
  }
  try {
    await api(`/api/dm/messages/${id}`, { method: 'DELETE' });
    removeDmMessage(id);
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ---------- Send message ----------
window.sendDm = function () {
  if (dmComposer) dmComposer.send();
};

// ---------- Drag and drop ----------
export function uploadDmFiles(fileList) {
  if (!dmActivePeer || !dmComposer) {
    showToast('Open a conversation first', 'error');
    return;
  }
  dmComposer.addFiles(fileList);
}

// ---------- Paste image ----------
function wirePasteImage(inputId, addFn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        const ext = (item.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const file = new File([blob], `pasted-${Date.now()}.${ext}`, {
          type: item.type,
        });
        addFn(file);
        return;
      }
    }
  });
}
