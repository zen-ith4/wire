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
import { renderAttachment, loadChatImage, mountAttachmentMedia, cleanupImageUrls, revokeAttachmentImage, imageDownloadButtonHtml } from '../media/attachments.js';
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

// ---------- Per-conversation message cache ----------
//
// Keyed by peer id. Each entry holds everything needed to redraw a
// conversation's message list *instantly* the next time the user
// switches back to it — no network round trip required. Messages
// are rebuilt as DOM elements from this cached data on every switch
// (cheap: a few dozen/hundred nodes), rather than trying to keep
// several threads' DOM subtrees alive simultaneously, which would
// substantially complicate image-blob lifecycle management for very
// little additional benefit. Already-loaded images specifically
// still avoid being re-fetched across a switch — see
// media/attachments.js's own persistent image-blob cache.
//
// entry shape:
//   {
//     username,
//     messages: [],        // ordered oldest -> newest; the source of truth
//     ids: Set(),          // mirrors messages, for O(1) dedupe checks
//     byId: Map(),         // id -> message, for reply-button lookups
//     oldest: string|null, // cursor for the next "before" page
//     hasMore: boolean,
//     initialized: boolean, // recent messages fetched at least once
//     loadingOlder: boolean,
//     scrollTop: number,   // saved on switch-away / periodically while scrolling
//     atBottom: boolean,   // was the user at (near) the bottom last we checked
//   }
const dmCache = new Map();

let dmActivePeer = null;
// The cache entry for whichever conversation is currently open — all
// per-conversation reads/writes below go through this, rather than
// duplicating the same state in separate module-level variables.
let dmEntry = null;
let dmComposer = null;

// Cache for conversation data (used for delegated clicks)
let dmConvMap = new Map();

// Helper
function canLoadMoreDm() {
  return !!(dmActivePeer && dmEntry && dmEntry.oldest && dmEntry.hasMore && !dmEntry.loadingOlder);
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
    };
    dmCache.set(peerId, entry);
  } else if (username) {
    // Keep the display name fresh — e.g. resolved from a placeholder
    // "User 42" the first time this peer was opened, to the real
    // username once the conversation list has loaded.
    entry.username = username;
  }
  return entry;
}

// How close to the bottom still counts as "at the bottom" for the
// purposes of auto-scrolling on a new message — a small tolerance so
// a few pixels of rounding/scrollbar slop don't wrongly register as
// "the user scrolled up to read history".
const DM_NEAR_BOTTOM_PX = 80;

function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= DM_NEAR_BOTTOM_PX;
}

// Persists the currently-open conversation's scroll position (and
// whether it was pinned to the bottom) into its cache entry. Must be
// called right before that conversation's DOM is torn down —
// openDmConversation() does this when switching to a different peer,
// and closeDmThreadMobile() does it when backing out of the thread
// entirely.
function saveDmScrollState() {
  if (!dmEntry) return;
  const container = document.getElementById('dm-messages');
  if (!container) return;
  dmEntry.scrollTop = container.scrollTop;
  dmEntry.atBottom = isNearBottom(container);
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

  // Save wherever the user was scrolled to in case they're coming
  // right back (e.g. Messages → Files → Messages) — dmCache itself
  // (the actual message data) is module-level and untouched by this
  // navigation, only the DOM below gets rebuilt.
  saveDmScrollState();
  dmActivePeer = null;
  dmEntry = null;

  // Cancel any in-flight image fetches for whichever conversation
  // thread is currently rendered — the innerHTML replacement below
  // detaches #dm-messages along with everything the user had open.
  // Already-loaded images are NOT revoked: they stay in the
  // persistent cache (media/attachments.js) so reopening the same
  // conversation, even after leaving Messages entirely, still skips
  // re-fetching them.
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
  // Re-clicking the conversation that's already open shouldn't tear
  // down and rebuild anything — same UX as Discord/etc, and avoids
  // an unnecessary reset of scroll position and in-flight composer
  // state (staged attachments, reply-to, draft text) for no reason.
  // Guarded on #dm-messages actually being on screen too: the thread
  // pane can show something else for this same peer id (e.g. the
  // "New message" picker was reopened and the same user picked
  // again), in which case it still needs a real rebuild.
  if (dmActivePeer && dmActivePeer.id === peerId && document.getElementById('dm-messages')) return;

  // Stop any in-flight "I'm typing" announcement to whichever peer
  // was previously open — must happen before dmActivePeer changes,
  // since the emitter's payload is derived from it.
  dmTypingEmitter.stop();
  dmTypingIndicator.clearAll();

  // Save the outgoing conversation's scroll position/state into its
  // cache entry *before* we touch dmActivePeer/dmEntry or throw away
  // its DOM below — this is what lets returning to it later restore
  // exactly where the user left off.
  saveDmScrollState();

  dmActivePeer = { id: peerId, username };
  dmEntry = getOrCreateDmCacheEntry(peerId, username);

  document.querySelector('.dm-layout')?.classList.add('showing-thread');

  // Cancel any in-flight image fetches from whichever conversation
  // was open before this one (the thread's innerHTML gets replaced
  // below) — already-loaded images are NOT revoked here, they stay
  // in the persistent cache (see media/attachments.js) so switching
  // back to this same conversation later can reuse them instantly.
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

  const container = document.getElementById('dm-messages');
  container.addEventListener('scroll', () => {
    // Keep the cache entry's scroll bookkeeping fresh continuously
    // (not just at switch-away time) so anything that reads it in
    // between — e.g. a live message arriving while the user is mid-
    // scroll — sees an up-to-date "was near the bottom" reading.
    if (dmEntry) dmEntry.atBottom = isNearBottom(container);
  }, { passive: true });

  if (dmEntry.initialized) {
    // Already have this conversation cached from earlier in the
    // session: paint instantly from local data, no network request,
    // then reconcile with the server in the background in case
    // anything arrived while this thread wasn't open (the socket
    // only pushes new messages to whichever conversation is
    // currently active — see socket.js's handleDirectMessage).
    renderDmMessagesFromCache();
    void syncDmMessagesSince();
  } else {
    await loadRecentDm();
  }

  // تازه‌سازی sidebar (مثلاً unread)
  void loadDmConversations();
  void refreshUnreadBadge();
};

window.closeDmThreadMobile = function() {
  saveDmScrollState();
  document.querySelector('.dm-layout')?.classList.remove('showing-thread');
  dmTypingEmitter.stop();
  dmTypingIndicator.clearAll();
  dmActivePeer = null;
  dmEntry = null;
  // حذف active از همه
  document.querySelectorAll('.dm-conv').forEach(el => el.classList.remove('active'));
};

// Rebuilds the message list DOM from the currently-active cache
// entry's data, then restores exactly where the user left off (or
// pins to the bottom for a conversation that's never been scrolled
// away from). This is the "instant" path — no network request.
function renderDmMessagesFromCache() {
  const container = document.getElementById('dm-messages');
  if (!container || !dmEntry) return;

  if (dmEntry.messages.length === 0) {
    container.innerHTML = emptyState(ICONS.mail, 'No messages yet', `Say hello to ${escapeHtml(dmActivePeer.username)} 👋`);
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

  // Restore the saved scroll position synchronously. Image loads
  // that resolve afterwards are already accounted for: they render
  // into placeholders that were sized up front from the attachment's
  // real (or fallback) aspect ratio, so they don't change the
  // container's scrollHeight once they arrive — see
  // media/attachments.js.
  container.scrollTop = dmEntry.atBottom ? container.scrollHeight : dmEntry.scrollTop;
}

// Fetches anything that arrived in this conversation since the last
// cached message, and appends it — used when switching back into an
// already-cached conversation, to reconcile the local snapshot with
// the server without redownloading the whole thing.
async function syncDmMessagesSince() {
  if (!dmActivePeer || !dmEntry || dmEntry.messages.length === 0) return;
  const peerId = dmActivePeer.id;
  const since = dmEntry.messages[dmEntry.messages.length - 1].timestamp;
  try {
    const messages = await api(`/api/dm/messages/${peerId}/since?since=${encodeURIComponent(since)}&limit=100`);
    // The user may have switched to a different conversation (or
    // this one may have been closed) while this request was in
    // flight — only apply the result if it's still relevant.
    if (!dmActivePeer || dmActivePeer.id !== peerId) return;
    if (messages.length === 0) return;

    const container = document.getElementById('dm-messages');
    const wasAtBottom = container ? isNearBottom(container) : dmEntry.atBottom;
    const currentUser = getCurrentUser();
    const frag = document.createDocumentFragment();
    for (const msg of messages) {
      if (dmEntry.ids.has(msg.id)) continue;
      dmEntry.ids.add(msg.id);
      dmEntry.byId.set(msg.id, msg);
      dmEntry.messages.push(msg);
      if (container) frag.appendChild(buildDmMessageEl(msg, currentUser));
    }
    if (container && frag.childNodes.length > 0) {
      container.appendChild(frag);
      // Only auto-scroll if the user was already at the bottom —
      // catching up on messages sent elsewhere shouldn't yank the
      // view away from history the user is actively reading.
      if (wasAtBottom) {
        container.scrollTop = container.scrollHeight;
        dmEntry.atBottom = true;
      }
    }
  } catch {
    // Best-effort background sync — a failure here just means the
    // cached view might be very slightly behind until the next
    // real-time message or reopen; not worth surfacing as an error.
  }
}

// ---------- Load messages ----------
// Only ever called the first time a conversation is opened in this
// session (see openDmConversation) — subsequent visits are served
// from dmEntry via renderDmMessagesFromCache()/syncDmMessagesSince()
// instead of hitting this endpoint again.
async function loadRecentDm() {
  if (!dmActivePeer || !dmEntry) return;
  const entry = dmEntry;
  const container = document.getElementById('dm-messages');
  try {
    const messages = await api(`/api/dm/messages/${dmActivePeer.id}/recent?limit=50`);
    // Stale response: the user switched to a different conversation
    // (or back out of Messages entirely) before this resolved.
    if (dmEntry !== entry) return;

    cleanupImageUrls(container, 'dm');
    container.innerHTML = '';

    entry.initialized = true;

    if (messages.length === 0) {
      container.innerHTML = emptyState(ICONS.mail, 'No messages yet', `Say hello to ${escapeHtml(dmActivePeer.username)} 👋`);
      entry.hasMore = false;
      entry.atBottom = true;
      return;
    }

    entry.oldest = messages[0].timestamp;
    entry.hasMore = messages.length >= 50;

    const frag = document.createDocumentFragment();
    if (entry.hasMore) {
      frag.appendChild(buildLoadMoreEl(loadOlderDm));
    }

    const currentUser = getCurrentUser();
    for (const msg of messages) {
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

async function loadOlderDm() {
  if (!canLoadMoreDm()) return;
  const entry = dmEntry;
  const peerId = dmActivePeer.id;
  const container = document.getElementById('dm-messages');
  const btnRow = document.getElementById('chat-load-more-row');
  if (btnRow) btnRow.querySelector('.load-more-btn').textContent = 'Loading…';
  entry.loadingOlder = true;

  try {
    const messages = await api(`/api/dm/messages/${peerId}/before?before=${encodeURIComponent(entry.oldest)}&limit=50`);
    entry.loadingOlder = false;
    // Stale response: switched away from this conversation while
    // the request was in flight.
    if (dmEntry !== entry) return;
    if (btnRow) btnRow.remove();

    if (messages.length === 0) {
      entry.hasMore = false;
      return;
    }

    entry.oldest = messages[0].timestamp;
    entry.hasMore = messages.length >= 50;

    // Scroll-position preservation: capture the pre-insert height so
    // we can compensate by exactly how much the container grew,
    // keeping whatever the user was already looking at pinned in
    // place instead of jumping.
    const oldTop = container.scrollTop;
    const prevHeight = container.scrollHeight;

    const frag = document.createDocumentFragment();
    if (entry.hasMore) {
      frag.appendChild(buildLoadMoreEl(loadOlderDm));
    }

    const currentUser = getCurrentUser();
    const newMessages = [];
    for (const msg of messages) {
      if (!entry.ids.has(msg.id)) {
        entry.ids.add(msg.id);
        entry.byId.set(msg.id, msg);
        newMessages.push(msg);
        frag.appendChild(buildDmMessageEl(msg, currentUser));
      }
    }
    // Older messages are prepended to the ordered array too, so the
    // cache stays consistent with what's on screen.
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

// Called from socket.js for every incoming DM, regardless of which
// conversation (if any) is currently open — unlike the old
// isRelevant-gated call, this always updates that peer's cache entry
// (when one exists) so a conversation the user isn't currently
// looking at doesn't "lose" a message and need a full refetch the
// next time it's opened. DOM updates still only happen for the
// conversation that's actually on screen right now.
export function addDmMessage(msg) {
  const currentUser = getCurrentUser();
  if (!currentUser) return;
  const peerId = msg.sender_id === currentUser.id ? msg.recipient_id : msg.sender_id;

  const entry = dmCache.get(peerId);
  const alreadyKnown = !!(entry && entry.ids.has(msg.id));
  if (entry && !alreadyKnown) {
    entry.ids.add(msg.id);
    entry.byId.set(msg.id, msg);
    entry.messages.push(msg);
  }

  const isActiveConversation = dmActivePeer && dmActivePeer.id === peerId;
  if (!isActiveConversation) return;

  const container = document.getElementById('dm-messages');
  if (!container) return;
  if (container.querySelector(`.chat-msg[data-msg-id="${msg.id}"]`)) return;

  const el = buildDmMessageEl(msg, currentUser);
  const emptyEl = container.querySelector('.empty-state');
  if (emptyEl) container.innerHTML = '';
  container.appendChild(el);

  // Only auto-scroll if the user was already at (or near) the
  // bottom, or this is their own outgoing message — someone reading
  // older history shouldn't be yanked down by an arrival elsewhere.
  const isOwnMessage = msg.sender_id === currentUser.id;
  const wasAtBottom = dmEntry ? dmEntry.atBottom : true;
  if (wasAtBottom || isOwnMessage) {
    container.scrollTop = container.scrollHeight;
    if (dmEntry) dmEntry.atBottom = true;
  }
}

// Idempotent: safe to call whether or not the message is currently
// rendered, or even whether its conversation is currently open at
// all (e.g. the delete happened while some other thread — or none —
// was on screen). Searches every cached conversation rather than
// just the active one, since a deletion can arrive for any of them.
export function removeDmMessage(id) {
  for (const entry of dmCache.values()) {
    if (entry.ids.delete(id)) {
      entry.byId.delete(id);
      const idx = entry.messages.findIndex(m => m.id === id);
      if (idx !== -1) entry.messages.splice(idx, 1);
    }
  }

  // Gone for good — unlike ordinary navigation, actually free the
  // cached image (if any) instead of keeping it around for a
  // "switch back" that will never need it again.
  revokeAttachmentImage(id, 'dm');

  const container = document.getElementById('dm-messages');
  if (!container) return;
  const el = container.querySelector(`.chat-msg[data-msg-id="${id}"]`);
  if (!el) return;
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
  const msg = dmEntry?.byId.get(id);
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