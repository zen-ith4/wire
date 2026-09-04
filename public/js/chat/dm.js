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
  insertAtCursor
} from '../core/utils.js';
import { renderAttachment, loadChatImage, mountAttachmentMedia, cleanupImageUrls, imageDownloadButtonHtml } from '../media/attachments.js';
import { avatarHtml } from '../ui/avatar.js';
import { getCurrentUser } from '../core/auth.js';
import { showConfirm } from '../ui/confirm.js';
import { openEmojiPicker } from '../ui/emoji-picker.js';
import { renderReactionsRow } from './reactions.js';
import { buildReplyQuoteHtml, buildReplyPreview } from './reply.js';
import { createTypingEmitter, createTypingIndicator, wireTypingInput } from './typing.js';
import { getSocket } from '../core/socket.js';
import { isUserOnline, onPresenceChange } from './presence.js';
import { createComposer } from './composer.js';
import { setMessageAccent } from './message-accent.js';

// State
let dmActivePeer = null;
let dmOldest = null;
let dmHasMore = true;
const renderedDmIds = new Set();
// Same purpose as chat.js's chatMsgById — lets the Reply button look
// up the message it's attached to from just an id.
const dmMsgById = new Map();
let dmComposer = null;

// Cache for conversation data (used for delegated clicks)
let dmConvMap = new Map();

// Helper
function canLoadMoreDm() {
  return dmActivePeer && dmOldest && dmHasMore;
}

// Exposes the currently-open conversation peer to socket.js, which
// needs it to decide whether an incoming/deleted message belongs to
// the thread that's currently on screen. (Previously socket.js read
// `window.dmActivePeer`, which was never set anywhere — this module
// only ever kept `dmActivePeer` as a private variable — so real-time
// delivery for an already-open thread silently never worked.)
export function getDmActivePeer() {
  return dmActivePeer;
}

// Keeps the open thread's "Online"/"Offline" header line live.
// Registered once for the module's lifetime — same reasoning as the
// single shared subscription in avatar.js/profile-card.js: this app
// re-renders the thread header on every conversation switch, so a
// subscription made *inside* openDmConversation would leak one
// listener per switch instead of ever being cleaned up.
onPresenceChange((changedUserId) => {
  if (!dmActivePeer) return;
  if (changedUserId !== null && changedUserId !== dmActivePeer.id) return;

  const statusEl = document.getElementById('dm-thread-status');
  if (!statusEl) return;
  const online = isUserOnline(dmActivePeer.id);
  statusEl.textContent = online ? 'Online' : 'Offline';
  statusEl.classList.toggle('online', online);
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
  el.textContent = `${usernames[0]} is typing…`; // textContent — no escaping needed
  el.classList.add('active');
}

const dmTypingIndicator = createTypingIndicator(renderDmTyping);

// Unlike chat's fixed payload, the DM payload depends on which
// conversation is open right now — read via a function so it's
// always current at emit time, and returns null (meaning "don't
// emit") when no conversation is open at all.
const dmTypingEmitter = createTypingEmitter(
  getSocket,
  'dm:typing',
  'dm:stop-typing',
  () => (dmActivePeer ? { recipient_id: dmActivePeer.id } : null)
);

// Called from socket.js when a 'dm:typing' / 'dm:stop-typing' event arrives.
export function showDmTyping(senderId, username) {
  // Only relevant if it's from the conversation currently open —
  // mirrors how handleDirectMessage already filters by activePeer.
  if (!dmActivePeer || senderId !== dmActivePeer.id) return;
  dmTypingIndicator.set(senderId, username);
}
export function hideDmTyping(senderId) {
  dmTypingIndicator.clear(senderId);
}
export function clearAllDmTyping() {
  dmTypingIndicator.clearAll();
}

/** Same reasoning as chat.js's destroyChatComposer() — see there. */
export function destroyDmComposer() {
  if (dmComposer) dmComposer.destroy();
}

// ---------- Render ----------
export async function renderDm(openPeerId) {
  const main = document.getElementById('content-area');
  // Revoke any blob URLs (loaded image attachments) owned by
  // whichever conversation thread is currently rendered — the
  // innerHTML replacement below detaches #dm-messages along with
  // everything the user had open, but detaching an element never
  // revokes the blob URLs it references, so without this every
  // visit to Messages would leak the previously-open thread's
  // loaded images.
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

  // یک بار event delegation برای لیست گفتگوها
  const list = document.getElementById('dm-conv-list');
  list.addEventListener('click', e => {
    const item = e.target.closest('.dm-conv');
    if (!item) return;
    const peerId = Number(item.dataset.peer);
    const conv = dmConvMap.get(peerId);
    openDmConversation(peerId, conv?.username || `User ${peerId}`);
  });

  // Client-side filter over the conversation list that's already
  // loaded — matches the reference's search behavior without firing
  // a new API request per keystroke.
  const searchInput = document.getElementById('dm-conv-search');
  searchInput.addEventListener('input', () => {
    renderConvListRows(Array.from(dmConvMap.values()), searchInput.value);
  });

  const convs = await loadDmConversations();
  if (openPeerId !== undefined && openPeerId !== null) {
    // Callers may pass either a bare id (e.g. a hash-based
    // navigation with no extra context) or { id, username } when the
    // real display name is already known (e.g. the profile card's
    // "Send Message" button) — the latter avoids ever falling back
    // to a placeholder name for a conversation that doesn't exist yet.
    const isObjectParam = typeof openPeerId === 'object';
    const peerId = Number(isObjectParam ? openPeerId.id : openPeerId);
    const knownUsername = isObjectParam ? openPeerId.username : null;

    const conv = convs.find(c => c.peer_id == peerId);
    const username = conv ? conv.username : (knownUsername || `User ${peerId}`);
    openDmConversation(peerId, username);
  }
}

// ---------- Conversation list ----------
function renderConvListRows(convs, filter = '') {
  const list = document.getElementById('dm-conv-list');
  if (!list) return;

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? convs.filter(c => c.username.toLowerCase().includes(q) || (c.last_message || '').toLowerCase().includes(q))
    : convs;

  if (filtered.length === 0) {
    list.innerHTML = q
      ? `<div class="text-muted" style="font-size:12.5px;padding:16px 10px;text-align:center;">No conversations found</div>`
      : `<div class="text-muted" style="font-size:12.5px;padding:10px 4px;">No conversations yet. Start one above.</div>`;
    return;
  }

  list.innerHTML = filtered.map(c => `
    <div class="dm-conv ${dmActivePeer && dmActivePeer.id == c.peer_id ? 'active' : ''}" data-peer="${c.peer_id}">
      ${avatarHtml(c.peer_id, c.username, 'conv-avatar', true)}
      <div class="conv-info">
        <div class="dm-conv-name">${escapeHtml(c.username)}</div>
        <div class="dm-conv-preview">${escapeHtml(c.last_message || 'No messages yet')}</div>
      </div>
      <div class="conv-meta">
        ${c.last_timestamp ? `<span class="conv-time">${formatDate(c.last_timestamp)}</span>` : ''}
        ${c.unread_count > 0 ? `<span class="dm-unread-badge">${c.unread_count > 99 ? '99+' : c.unread_count}</span>` : ''}
      </div>
    </div>
  `).join('');
}

export async function loadDmConversations() {
  const list = document.getElementById('dm-conv-list');
  try {
    const convs = await api('/api/dm/conversations');

    // بروزرسانی map برای کلیک‌های آینده
    dmConvMap.clear();
    for (const c of convs) {
      dmConvMap.set(c.peer_id, c);
    }

    const searchInput = document.getElementById('dm-conv-search');
    renderConvListRows(convs, searchInput ? searchInput.value : '');

    return convs;
  } catch (e) {
    if (list) list.innerHTML = emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message));
    return [];
  }
}

// ---------- Unread badge ----------
export async function refreshUnreadBadge() {
  try {
    const { count } = await api('/api/dm/unread-count');
    const badge = document.getElementById('dm-nav-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch { /* ignore */ }
}

// ---------- New DM picker ----------
window.openNewDmPicker = async function() {
  try {
    const users = await api('/api/share/users');
    if (users.length === 0) {
      showToast('No other users to message yet', 'info');
      return;
    }
    document.querySelector('.dm-layout')?.classList.add('showing-thread');
    const thread = document.getElementById('dm-thread');
    thread.innerHTML = `
      <div class="dm-thread-header">
        <button class="icon-btn dm-back-btn" title="Back" onclick="window.closeDmThreadMobile()">${ICONS.arrowLeft}</button>
        <div class="card-title" style="margin:0;">${ICONS.plus} New message</div>
      </div>
      <div class="toolbar">
        <select id="dm-new-user">
          ${users.map(u => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" onclick="window.startDmFromPicker()">Start chat</button>
      </div>
    `;
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.startDmFromPicker = function() {
  const sel = document.getElementById('dm-new-user');
  // sel.value is always a string; openDmConversation stores it as
  // dmActivePeer.id and socket.js compares it against message.sender_id
  // /recipient_id (numbers from the DB) with ===. Without this
  // conversion, live socket messages for a conversation started from
  // this picker never matched isRelevant and wouldn't appear until
  // the thread was closed and reopened.
  const id = Number(sel.value);
  const username = sel.options[sel.selectedIndex].textContent;
  openDmConversation(id, username);
};

// ---------- Open / close conversation ----------
window.openDmConversation = async function(peerId, username) {
  // Stop any in-flight "I'm typing" announcement to whichever peer
  // was previously open — must happen before dmActivePeer changes,
  // since the emitter's payload is derived from it.
  dmTypingEmitter.stop();
  dmTypingIndicator.clearAll();

  dmActivePeer = { id: peerId, username };
  dmOldest = null;
  dmHasMore = true;
  renderedDmIds.clear();
  dmMsgById.clear();

  document.querySelector('.dm-layout')?.classList.add('showing-thread');

  // Revoke blob URLs from whichever conversation was open before
  // this one — same leak/fix as renderDm() above, but for switching
  // between two conversations without leaving the Messages view
  // (the thread's innerHTML gets replaced below, which is the
  // common case: this runs every time the user picks a different
  // conversation from the sidebar).
  cleanupImageUrls(document.getElementById('dm-messages'), 'dm');

  // فعال/غیرفعال کردن آیتم‌ها در sidebar
  const list = document.getElementById('dm-conv-list');
  if (list) {
    list.querySelectorAll('.dm-conv').forEach(el => el.classList.remove('active'));
    const activeEl = list.querySelector(`.dm-conv[data-peer="${peerId}"]`);
    if (activeEl) activeEl.classList.add('active');
  }

  const thread = document.getElementById('dm-thread');
  thread.innerHTML = `
    <div class="chat-top-bar chat-header-glass">
      <button class="icon-btn dm-back-btn" title="Back" onclick="window.closeDmThreadMobile()">${ICONS.arrowLeft}</button>
      <div class="dm-peer-profile" title="View ${escapeAttr(username)}'s profile" onclick="window.openProfileCard(${Number(peerId)})">
        ${avatarHtml(peerId, username, 'chat-top-avatar', false)}
        <div class="dm-peer-meta">
          <div class="chat-top-name">${escapeHtml(username)}</div>
          <div class="chat-top-status${isUserOnline(peerId) ? ' online' : ''}" id="dm-thread-status">${isUserOnline(peerId) ? 'Online' : 'Offline'}</div>
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

  // Same reasoning as chat.js's renderChat() — release any
  // in-progress recording before this render's innerHTML replace
  // throws away the DOM the previous composer instance was wired to.
  if (dmComposer) dmComposer.destroy();

  dmComposer = createComposer({
    inputId: 'dm-input',
    fileInputId: 'dm-file-input',
    stagingId: 'dm-attach-staging',
    replyPreviewId: 'dm-reply-preview',
    sendTextUrl: '/api/dm/messages',
    uploadUrl: '/api/dm/upload',
    buildTextBody: (content) => ({ recipient_id: dmActivePeer.id, content }),
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
  await loadRecentDm();

  // تازه‌سازی sidebar (مثلاً unread)
  void loadDmConversations();
  void refreshUnreadBadge();
};

window.closeDmThreadMobile = function() {
  document.querySelector('.dm-layout')?.classList.remove('showing-thread');
  dmTypingEmitter.stop();
  dmTypingIndicator.clearAll();
  dmActivePeer = null;
  // حذف active از همه
  document.querySelectorAll('.dm-conv').forEach(el => el.classList.remove('active'));
};

// ---------- Load messages ----------
async function loadRecentDm() {
  if (!dmActivePeer) return;
  const container = document.getElementById('dm-messages');
  try {
    const messages = await api(`/api/dm/messages/${dmActivePeer.id}/recent?limit=50`);
    renderedDmIds.clear();
    dmMsgById.clear();
    // Same reasoning as renderDm()/openDmConversation() — this
    // innerHTML clear discards the loading-state markup here, but
    // is also reached any time this function re-runs for a thread
    // that already has rendered (and loaded) messages in it.
    cleanupImageUrls(container, 'dm');
    container.innerHTML = '';

    if (messages.length === 0) {
      container.innerHTML = emptyState(ICONS.mail, 'No messages yet', `Say hello to ${escapeHtml(dmActivePeer.username)} 👋`);
      dmHasMore = false;
      return;
    }

    dmOldest = messages[0].timestamp;
    dmHasMore = messages.length >= 50;

    const frag = document.createDocumentFragment();
    if (dmHasMore) {
      frag.appendChild(buildLoadMoreEl(loadOlderDm));
    }

    const currentUser = getCurrentUser();
    for (const msg of messages) {
      renderedDmIds.add(msg.id);
      dmMsgById.set(msg.id, msg);
      frag.appendChild(buildDmMessageEl(msg, currentUser));
    }

    container.appendChild(frag);
    container.scrollTop = container.scrollHeight;
  } catch (e) {
    container.innerHTML = emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message));
  }
}

async function loadOlderDm() {
  if (!canLoadMoreDm()) return;
  const container = document.getElementById('dm-messages');
  const btnRow = document.getElementById('chat-load-more-row');
  if (btnRow) btnRow.querySelector('.load-more-btn').textContent = 'Loading…';

  try {
    const messages = await api(`/api/dm/messages/${dmActivePeer.id}/before?before=${encodeURIComponent(dmOldest)}&limit=50`);
    if (btnRow) btnRow.remove();

    if (messages.length === 0) {
      dmHasMore = false;
      return;
    }

    dmOldest = messages[0].timestamp;
    dmHasMore = messages.length >= 50;

    const oldTop = container.scrollTop;
    const prevHeight = container.scrollHeight;

    const frag = document.createDocumentFragment();
    if (dmHasMore) {
      frag.appendChild(buildLoadMoreEl(loadOlderDm));
    }

    const currentUser = getCurrentUser();
    for (const msg of messages) {
      if (!renderedDmIds.has(msg.id)) {
        renderedDmIds.add(msg.id);
        dmMsgById.set(msg.id, msg);
        frag.appendChild(buildDmMessageEl(msg, currentUser));
      }
    }

    container.insertBefore(frag, container.firstChild);
    container.scrollTop = oldTop + (container.scrollHeight - prevHeight);
  } catch (e) {
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
  const own = currentUser && msg.sender_id === currentUser.id;
  const canDelete = own || (currentUser && currentUser.is_admin);
  const div = document.createElement('div');
  div.className = 'chat-msg' + (own ? ' own' : '');
  div.dataset.msgId = msg.id;
  // Every bubble uses the current viewer's own accent color,
  // regardless of who sent the message (see message-accent.js).
  setMessageAccent(div);
  div.innerHTML = `
    ${avatarHtml(msg.sender_id, msg.sender_username, 'chat-avatar')}
    <div class="chat-msg-content">
      <div class="chat-meta">
        <span class="chat-sender">${escapeHtml(msg.sender_username)}</span>
        <span class="chat-time">${formatDate(msg.timestamp)}</span>
        <button type="button" class="chat-msg-reply" title="Reply" onclick="window.replyToDmMessage(${msg.id})">${ICONS.reply}</button>
        ${imageDownloadButtonHtml(msg, 'dm')}
        ${canDelete ? `<button type="button" class="chat-msg-delete" title="Delete message" onclick="window.deleteDmMessage(${msg.id})">${ICONS.trash}</button>` : ''}
      </div>
      ${buildReplyQuoteHtml(msg, 'dm')}
      ${msg.content ? `<div class="chat-bubble">${linkifyHtml(msg.content)}</div>` : ''}
      ${msg.has_attachment ? renderAttachment(msg, 'dm') : ''}
      ${renderReactionsRow(msg, 'dm')}
    </div>
  `;
  if (msg.has_attachment && msg.attachment_mime && msg.attachment_mime.startsWith('image/')) {
    queueMicrotask(() => loadChatImage(msg.id, 'dm'));
  }
  // Initialize the audio/video player (if any) directly on this
  // element. No document-wide query and no timing dependency.
  mountAttachmentMedia(msg, div, 'dm');
  return div;
}

export function addDmMessage(msg) {
  if (renderedDmIds.has(msg.id)) return;
  renderedDmIds.add(msg.id);
  dmMsgById.set(msg.id, msg);
  const container = document.getElementById('dm-messages');
  if (!container) return;

  const currentUser = getCurrentUser();
  const el = buildDmMessageEl(msg, currentUser);
  const emptyEl = container.querySelector('.empty-state');
  if (emptyEl) container.innerHTML = '';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

// Idempotent: safe to call whether or not the message is currently
// rendered (e.g. the thread might not be open, or it may have
// already been removed by an earlier call — the delete button and
// the 'dm-message-deleted' socket event both call this).
export function removeDmMessage(id) {
  renderedDmIds.delete(id);
  dmMsgById.delete(id);
  const container = document.getElementById('dm-messages');
  if (!container) return;
  const el = container.querySelector(`.chat-msg[data-msg-id="${id}"]`);
  if (!el) return;
  // Revoke this message's own loaded-image blob URL (if any) before
  // dropping the element — same leak as the spots above, just for a
  // single deleted message instead of a whole thread.
  cleanupImageUrls(el, 'dm');
  el.remove();
  if (!container.querySelector('.chat-msg')) {
    container.innerHTML = emptyState(ICONS.mail, 'No messages yet', dmActivePeer ? `Say hello to ${escapeHtml(dmActivePeer.username)} 👋` : '');
  }
}

window.openDmEmojiPicker = function(triggerEl) {
  const input = document.getElementById('dm-input');
  if (!input) return;
  openEmojiPicker({
    anchorEl: triggerEl,
    onSelect: (char) => insertAtCursor(input, char),
  });
};

window.replyToDmMessage = function(id) {
  const msg = dmMsgById.get(id);
  if (!msg || !dmComposer) return;
  dmComposer.setReplyTo(buildReplyPreview(msg));
};

window.deleteDmMessage = async function(id) {
  if (!await showConfirm('Delete this message? This cannot be undone.', { title: 'Delete message' })) return;
  try {
    await api(`/api/dm/messages/${id}`, { method: 'DELETE' });
    removeDmMessage(id);
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ---------- Send message ----------
window.sendDm = function() {
  if (dmComposer) dmComposer.send();
};

// Drag-and-drop entry point (see dragdrop.js). Requires an open
// conversation — dragdrop.js already checks getDmActivePeer() before
// calling this, but the guard is repeated here since this is exported
// and could be called directly. Stages the dropped files above the
// input (same as picking/pasting) rather than uploading immediately.
export function uploadDmFiles(fileList) {
  if (!dmActivePeer || !dmComposer) {
    showToast('Open a conversation first', 'error');
    return;
  }
  dmComposer.addFiles(fileList);
}

// ---------- Paste image helper (duplicated from chat.js – ideally move to utils) ----------
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
        const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: item.type });
        addFn(file);
        return;
      }
    }
  });
}