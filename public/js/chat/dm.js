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
import { renderReactionsRow } from './reactions.js';
import {
  buildReplyQuoteHtml,
  buildReplyPreview
} from './reply.js';
import {
  createTypingEmitter,
  createTypingIndicator,
  wireTypingInput
} from './typing.js';
import { getSocket } from '../core/socket.js';
import {
  isUserOnline,
  onPresenceChange
} from './presence.js';
import { createComposer } from './composer.js';
import { setMessageAccent } from './message-accent.js';
import {
  encryptOutgoingMessage,
  decryptIncomingMessage
} from '../crypto/messages/message-crypto.js';

// ---------- Per-conversation message cache ----------
const dmCache = new Map();
let dmActivePeer = null;
let dmEntry = null;
let dmComposer = null;
const dmConvMap = new Map();

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
      atBottom: true
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
  const online = isUserOnline(dmActivePeer.id);
  statusEl.textContent = online ? 'Online' : 'Offline';
  statusEl.classList.toggle('online', online);
});

// Same live-sync approach for the "New message" picker's status lines
// (the .presence-dot on each row's avatar already updates itself via
// avatar.js's own listener — this just keeps the "Online"/"Offline"
// text next to it in sync too, without re-rendering the whole list).
onPresenceChange((changedUserId) => {
  const selector =
    changedUserId === null
      ? '.dm-picker-status[data-user-id]'
      : `.dm-picker-status[data-user-id="${changedUserId}"]`;

  document.querySelectorAll(selector).forEach((el) => {
    const online = isUserOnline(el.dataset.userId);
    el.textContent = online ? 'Online' : 'Offline';
    el.classList.toggle('online', online);
  });
});

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
export async function renderDm(openPeerId) {
  const isCurrent = claimRender('messages');
  const main = document.getElementById('content-area');

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
            <button class="btn-new-message" onclick="window.openNewDmPicker()">${ICONS.plus} New message</button>
          </div>
          <div class="conv-search-wrap">
            <span class="conv-search-icon">${ICONS.search}</span>
            <input type="text" class="conv-search-input" id="dm-conv-search" placeholder="Search conversations…" autocomplete="off">
          </div>
        </div>
        <div id="dm-conv-list" class="dm-conv-list">${loadingState()}</div>
      </div>
      <div class="dm-thread" id="dm-thread">
        ${emptyState(ICONS.mail, 'Select a conversation', 'Or start a new one with a friend.')}
      </div>
    </div>
  `;

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

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? preparedConvs.filter(
        (c) =>
          String(c.username || '').toLowerCase().includes(q) ||
          String(c.decrypted_last_message || '').toLowerCase().includes(q)
      )
    : preparedConvs;

  if (filtered.length === 0) {
    list.innerHTML = q
      ? `<div class="text-muted" style="font-size:12.5px;padding:16px 10px;text-align:center;">No conversations found</div>`
      : `<div class="text-muted" style="font-size:12.5px;padding:10px 4px;">No conversations yet. Start one above.</div>`;
    return;
  }

  list.innerHTML = filtered
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
    if (list) {
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
  document.querySelector('.dm-layout')?.classList.add('showing-thread');
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
          ${avatarHtml(u.id, u.username, 'conv-avatar dm-picker-avatar', true)}
          <div class="dm-picker-info">
            <div class="dm-picker-name">${escapeHtml(u.username)}</div>
            <div class="dm-picker-status${online ? ' online' : ''}" data-user-id="${u.id}">${
              online ? 'Online' : 'Offline'
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
  document.querySelector('.dm-layout')?.classList.remove('showing-thread');
  dmPickerUsers = null;

  if (dmActivePeer) {
    openDmConversation(dmActivePeer.id, dmActivePeer.username);
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

// ---------- Open conversation ----------
window.openDmConversation = async function (peerId, username) {
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

  dmActivePeer = { id: peerId, username };
  dmEntry = getOrCreateDmCacheEntry(peerId, username);

  document.querySelector('.dm-layout')?.classList.add('showing-thread');
  cleanupImageUrls(document.getElementById('dm-messages'), 'dm');

  const list = document.getElementById('dm-conv-list');
  if (list) {
    list.querySelectorAll('.dm-conv').forEach((el) => el.classList.remove('active'));
    const activeEl = list.querySelector(`.dm-conv[data-peer="${peerId}"]`);
    if (activeEl) activeEl.classList.add('active');
  }

  const thread = document.getElementById('dm-thread');
  thread.innerHTML = `
    <div class="chat-top-bar chat-header-glass">
      <button class="icon-btn dm-back-btn" title="Back" onclick="window.closeDmThreadMobile()">${ICONS.arrowLeft}</button>
      <div class="dm-peer-profile" title="View ${escapeAttr(username)}'s profile" onclick="window.openProfileCard(${peerId})">
        ${avatarHtml(peerId, username, 'chat-top-avatar', false)}
        <div class="dm-peer-meta">
          <div class="chat-top-name">${escapeHtml(username)}</div>
          <div class="chat-top-status${
            isUserOnline(peerId) ? ' online' : ''
          }" id="dm-thread-status">${
            isUserOnline(peerId) ? 'Online' : 'Offline'
          }</div>
        </div>
      </div>
    </div>
    <div class="chat-messages" id="dm-messages">${loadingState()}</div>
    <div class="typing-indicator" id="dm-typing-indicator"></div>
    <div class="composer-wrapper">
      <div class="reply-preview-bar" id="dm-reply-preview"></div>
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

  if (dmComposer) dmComposer.destroy();

  dmComposer = createComposer({
    inputId: 'dm-input',
    fileInputId: 'dm-file-input',
    stagingId: 'dm-attach-staging',
    replyPreviewId: 'dm-reply-preview',
    sendTextUrl: '/api/dm/messages',
    uploadUrl: '/api/dm/upload',
    buildTextBody: async (content) => {
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

      return {
        recipient_id: recipientId,
        content: JSON.stringify(encrypted),
      };
    },
    buildFormExtra: (form) => form.append('recipient_id', dmActivePeer.id),
    onMessage: (message) => addDmMessage(message),
    typingEmitter: dmTypingEmitter,
    canSend: () => !!dmActivePeer,
    inputAreaId: 'dm-input-area',
    micButtonId: 'dm-mic-btn',
    recordingBarId: 'dm-recording-bar',
    recordingTimeId: 'dm-recording-time',
    recordingCancelId: 'dm-recording-cancel',
    recordingStopId: 'dm-recording-stop',
  });

  wirePasteImage('dm-input', (file) => dmComposer.addFiles([file]));
  wireTypingInput('dm-input', dmTypingEmitter);

  const container = document.getElementById('dm-messages');
  container.addEventListener(
    'scroll',
    () => {
      if (dmEntry) dmEntry.atBottom = isNearBottom(container);
    },
    { passive: true }
  );

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
  document.querySelector('.dm-layout')?.classList.remove('showing-thread');
  dmTypingEmitter.stop();
  dmTypingIndicator.clearAll();
  dmActivePeer = null;
  dmEntry = null;
  document.querySelectorAll('.dm-conv').forEach((el) => el.classList.remove('active'));
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

  for (const msg of dmEntry.messages) {
    frag.appendChild(buildDmMessageEl(msg, currentUser));
  }

  container.innerHTML = '';
  container.appendChild(frag);

  container.scrollTop = dmEntry.atBottom ? container.scrollHeight : dmEntry.scrollTop;
}

// ---------- Sync cached conversation ----------
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

    for (const msg of decryptedMessages) {
      if (dmEntry.ids.has(msg.id)) continue;
      dmEntry.ids.add(msg.id);
      dmEntry.byId.set(msg.id, msg);
      dmEntry.messages.push(msg);
      if (container) frag.appendChild(buildDmMessageEl(msg, currentUser));
    }

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

  try {
    const messages = await api(
      `/api/dm/messages/${dmActivePeer.id}/recent?limit=50`
    );

    if (dmEntry !== entry) return;

    const decryptedMessages = await decryptDmMessages(messages);
    if (dmEntry !== entry) return;

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
    for (const msg of decryptedMessages) {
      entry.ids.add(msg.id);
      entry.byId.set(msg.id, msg);
      entry.messages.push(msg);
      frag.appendChild(buildDmMessageEl(msg, currentUser));
    }

    container.appendChild(frag);
    container.scrollTop = container.scrollHeight;
    entry.atBottom = true;
  } catch (e) {
    if (dmEntry !== entry) return;
    container.innerHTML = emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message));
  }
}

// ---------- Load older messages ----------
async function loadOlderDm() {
  if (!canLoadMoreDm()) return;

  const entry = dmEntry;
  const peerId = dmActivePeer.id;
  const container = document.getElementById('dm-messages');
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
      return;
    }

    const decryptedMessages = await decryptDmMessages(messages);
    if (dmEntry !== entry) return;

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
    for (const msg of decryptedMessages) {
      if (!entry.ids.has(msg.id)) {
        entry.ids.add(msg.id);
        entry.byId.set(msg.id, msg);
        newMessages.push(msg);
        frag.appendChild(buildDmMessageEl(msg, currentUser));
      }
    }

    entry.messages.unshift(...newMessages);
    container.insertBefore(frag, container.firstChild);
    container.scrollTop = oldTop + (container.scrollHeight - prevHeight);
  } catch (e) {
    entry.loadingOlder = false;
    if (dmEntry !== entry) return;
    if (btnRow) btnRow.querySelector('.load-more-btn').textContent = 'Load older messages';
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

  div.innerHTML = `
    ${avatarHtml(msg.sender_id, msg.sender_username, 'chat-avatar')}
    <div class="chat-msg-content">
      <div class="chat-meta">
        <span class="chat-sender">${escapeHtml(msg.sender_username)}</span>
        <span class="chat-time">${formatDate(msg.timestamp)}</span>
        <button type="button" class="chat-msg-reply" title="Reply" onclick="window.replyToDmMessage(${msg.id})">${ICONS.reply}</button>
        ${imageDownloadButtonHtml(msg, 'dm')}
        ${
          canDelete
            ? `<button type="button" class="chat-msg-delete" title="Delete message" onclick="window.deleteDmMessage(${msg.id})">${ICONS.trash}</button>`
            : ''
        }
      </div>
      ${buildReplyQuoteHtml(msg, 'dm')}
      ${
        messageText
          ? `<div class="chat-bubble">${linkifyHtml(messageText)}</div>`
          : ''
      }
      ${msg.has_attachment ? renderAttachment(msg, 'dm') : ''}
      ${renderReactionsRow(msg, 'dm')}
    </div>
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

  if (!isActiveConversation) return;

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

  container.appendChild(el);

  const isOwnMessage = Number(msg.sender_id) === Number(currentUser.id);
  const wasAtBottom = dmEntry ? dmEntry.atBottom : true;

  if (wasAtBottom || isOwnMessage) {
    container.scrollTop = container.scrollHeight;
    if (dmEntry) dmEntry.atBottom = true;
  }
}

// ---------- Delete message ----------
export function removeDmMessage(id) {
  for (const entry of dmCache.values()) {
    if (entry.ids.delete(id)) {
      entry.byId.delete(id);
      const idx = entry.messages.findIndex((m) => m.id === id);
      if (idx !== -1) entry.messages.splice(idx, 1);
    }
  }

  revokeAttachmentImage(id, 'dm');

  const container = document.getElementById('dm-messages');
  if (!container) return;

  const el = container.querySelector(`.chat-msg[data-msg-id="${id}"]`);
  if (!el) return;

  cleanupImageUrls(el, 'dm');
  animateRemoval(el, () => {
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