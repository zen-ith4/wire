import { api } from '../core/api.js';
import { ICONS } from '../icons.js';
import {
  showToast,
  emptyState,
  loadingState,
  escapeHtml,
  linkifyHtml,
  formatDate,
  insertAtCursor,
  animateRemoval
} from '../core/utils.js';
import { renderAttachment, loadChatImage, mountAttachmentMedia, cleanupImageUrls, revokeAttachmentImage, imageDownloadButtonHtml } from '../media/attachments.js';
import { avatarHtml } from '../ui/avatar.js';
import { getCurrentUser } from '../core/auth.js';
import { showConfirm } from '../ui/confirm.js';
import { openEmojiPicker } from '../ui/emoji-picker.js';
import { renderReactionsRow, updateMessageReactions, onReactionsUpdated } from './reactions.js';
import { buildReplyQuoteHtml, buildReplyPreview } from './reply.js';
import { createTypingEmitter, createTypingIndicator, wireTypingInput } from './typing.js';
import { getSocket } from '../core/socket.js';
import { createComposer } from './composer.js';
import { setMessageAccent } from './message-accent.js';

let chatRenderGeneration = 0;
let chatOldest = null;
let chatHasMore = true;
const renderedChatIds = new Set();
// Keeps the last-rendered message object for each currently-visible
// chat message id, so the Reply button (which only has an id, via
// its inline onclick) can look up what it's actually replying to
// without a round trip.
const chatMsgById = new Map();
let chatComposer = null;

// ---------- In-memory message cache ----------
// The ordered (oldest -> newest) messages the Chat view has loaded.
// It is the single source of truth for what the view shows: a tab
// switch repaints from it locally and then reconciles with the server
// in the background (see showChat / reconcileChat). It keeps growing
// from live socket events while another tab is open, so coming back
// never has to wait for the network. Memory only; cleared on logout.
let chatMessages = [];
let chatLoaded = false;

window.addEventListener('wire:logout', () => {
  chatMessages = [];
  chatLoaded = false;
  chatOldest = null;
  chatHasMore = true;
  renderedChatIds.clear();
  chatMsgById.clear();
});

// Keep cached message objects in step with reaction changes (local
// toggles and socket updates both flow through updateMessageReactions),
// so a repaint from the cache never shows stale reactions.
onReactionsUpdated((scope, messageId, reactions) => {
  if (scope !== 'chat') return;
  const cached = chatMsgById.get(messageId);
  if (cached) cached.reactions = reactions;
});

// ---------- Typing indicator ----------
function renderChatTyping(usernames) {
  const el = document.getElementById('chat-typing-indicator');
  if (!el) return;
  if (usernames.length === 0) {
    el.textContent = '';
    el.classList.remove('active');
    return;
  }
  let text;
  if (usernames.length === 1) {
    text = `${usernames[0]} is typing…`;
  } else if (usernames.length === 2) {
    text = `${usernames[0]} and ${usernames[1]} are typing…`;
  } else {
    text = `${usernames.length} people are typing…`;
  }
  el.textContent = text; // textContent, not innerHTML — usernames need no escaping this way
  el.classList.add('active');
}

const chatTypingIndicator = createTypingIndicator(renderChatTyping);
const chatTypingEmitter = createTypingEmitter(getSocket, 'chat:typing', 'chat:stop-typing', () => ({}));

// Called from socket.js when a 'chat:typing' / 'chat:stop-typing' event arrives.
export function showChatTyping(userId, username) {
  chatTypingIndicator.set(userId, username);
}
export function hideChatTyping(userId) {
  chatTypingIndicator.clear(userId);
}
export function clearAllChatTyping() {
  chatTypingIndicator.clearAll();
}

/**
 * Releases any in-progress voice recording's mic/timer resources.
 * Called by the router before navigating away from the Chat view to
 * anything else (Files, Settings, ...) — renderChat() itself already
 * handles the case of navigating back to Chat (or refreshing DM →
 * Chat → DM), since it destroys the previous composer at the top of
 * its own render. This covers the remaining case: leaving Chat for a
 * view that never calls renderChat() again, which would otherwise
 * leave that composer (and its open mic stream, if one was active)
 * unreachable but still alive.
 */
export function destroyChatComposer() {
  if (chatComposer) chatComposer.destroy();
}

// Tab-switch entry point: first visit loads from the network exactly
// as before; afterwards the view is painted from the cache immediately.
export async function showChat() {
  return renderChat({ fromCache: chatLoaded });
}

export async function renderChat(opts) {
  const fromCache = !!(opts && opts.fromCache);
  const main = document.getElementById('content-area');
  const generation = ++chatRenderGeneration;
  // Revoke any blob URLs (loaded image attachments) owned by the
  // message list we're about to throw away — innerHTML replacement
  // below detaches those elements from the document, but detaching
  // an element never revokes the blob URLs it happens to reference,
  // so without this every render (i.e. every visit to this view)
  // would leak the previous batch of loaded images' memory.
  cleanupImageUrls(document.getElementById('chat-messages'), 'chat');
  main.innerHTML = `
    <div class="chat-panel">
      <div class="chat-top-bar">
        <div class="chat-top-avatar" style="display:flex;align-items:center;justify-content:center;">${ICONS.chat}</div>
        <div>
          <div class="chat-top-name">Group Chat</div>
          <div class="chat-top-status">Everyone in this workspace</div>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages">${fromCache ? '' : loadingState()}</div>
      <div class="typing-indicator" id="chat-typing-indicator"></div>
      <div class="composer-wrapper">
        <div class="reply-preview-bar" id="chat-reply-preview"></div>
        <div class="attach-staging" id="chat-attach-staging"></div>
        <div class="composer-recording-bar" id="chat-recording-bar">
          <button type="button" class="composer-recording-cancel" id="chat-recording-cancel" aria-label="Cancel recording">Cancel</button>
          <div class="composer-recording-indicator">
            <span class="composer-recording-dot" aria-hidden="true"></span>
            <span id="chat-recording-time">0:00</span>
          </div>
          <button type="button" class="composer-recording-stop" id="chat-recording-stop" aria-label="Stop recording">${ICONS.stop}</button>
        </div>
        <div class="chat-input-area" id="chat-input-area">
          <input type="file" id="chat-file-input" class="hidden" multiple>
          <button class="btn btn-ghost btn-icon" title="Attach a file" onclick="document.getElementById('chat-file-input').click()">${ICONS.paperclip}</button>
          <button class="btn btn-ghost btn-icon emoji-trigger" title="Emoji" onclick="window.openChatEmojiPicker(this)">${ICONS.emoji}</button>
          <textarea id="chat-input" rows="1" placeholder="Type a message…"></textarea>
          <button class="composer-mic-btn" id="chat-mic-btn" aria-label="Record a voice message">${ICONS.mic}</button>
          <button onclick="window.sendChat()" class="btn-send" title="Send message (Enter) — Shift+Enter for a new line">${ICONS.send}</button>
        </div>
      </div>
    </div>
  `;
  if (!fromCache) {
    chatOldest = null;
    chatHasMore = true;
    renderedChatIds.clear();
    chatMsgById.clear();
  }
  chatTypingIndicator.clearAll();

  // Release any mic/timer resources an in-progress recording on the
  // previous composer instance was holding — this render is about to
  // throw away its DOM (including the mic/recording-bar buttons it
  // was wired to), and nothing else would stop that stream otherwise.
  if (chatComposer) chatComposer.destroy();

  chatComposer = createComposer({
    inputId: 'chat-input',
    fileInputId: 'chat-file-input',
    stagingId: 'chat-attach-staging',
    replyPreviewId: 'chat-reply-preview',
    sendTextUrl: '/api/chat/messages',
    uploadUrl: '/api/chat/upload',
    buildTextBody: (content) => ({ content }),
    onMessage: (message) => addChatMessage(message),
    typingEmitter: chatTypingEmitter,
    inputAreaId: 'chat-input-area',
    micButtonId: 'chat-mic-btn',
    recordingBarId: 'chat-recording-bar',
    recordingTimeId: 'chat-recording-time',
    recordingCancelId: 'chat-recording-cancel',
    recordingStopId: 'chat-recording-stop',
  });
  wirePasteImage('chat-input', (file) => chatComposer.addFiles([file]));
  wireTypingInput('chat-input', chatTypingEmitter);

  if (fromCache) {
    paintChatFromCache();
    void reconcileChat(generation);
    return;
  }

  await loadRecentChat(generation);
}

// Rebuilds the message list from chatMessages (no network).
function paintChatFromCache() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  cleanupImageUrls(container, 'chat');
  container.innerHTML = '';
  renderedChatIds.clear();
  chatMsgById.clear();

  if (chatMessages.length === 0) {
    container.innerHTML = emptyState(ICONS.chat, 'No messages yet', 'Say hello 👋');
    chatHasMore = false;
    return;
  }

  if (chatHasMore) {
    container.appendChild(buildLoadMoreEl(loadOlderChat));
  }
  for (const msg of chatMessages) {
    renderedChatIds.add(msg.id);
    chatMsgById.set(msg.id, msg);
    container.appendChild(buildChatMessageEl(msg));
  }
  container.scrollTop = container.scrollHeight;
}

// Background revalidation after a paint from the cache. Applies only
// the differences (deleted messages, changed reactions, new messages)
// so the list does not flicker or lose its scroll position.
async function reconcileChat(generation) {
  try {
    const fresh = await api('/api/chat/messages/recent?limit=50');
    // Stale: the user left, or a newer render replaced this one.
    if (generation !== chatRenderGeneration) return;
    if (!document.getElementById('chat-messages')) return;

    if (fresh.length === 0) {
      if (chatMessages.length > 0) {
        chatMessages = [];
        paintChatFromCache();
      }
      return;
    }

    const firstIdx = chatMessages.findIndex((m) => m.id === fresh[0].id);
    if (firstIdx === -1) {
      // Cache and server no longer overlap (long absence): start over
      // from the server's window.
      chatMessages = fresh;
      chatOldest = fresh[0].timestamp;
      chatHasMore = fresh.length >= 50;
      paintChatFromCache();
      return;
    }

    const freshIds = new Set(fresh.map((m) => m.id));
    let lastKnownIdx = -1;
    chatMessages.forEach((m, i) => {
      if (freshIds.has(m.id)) lastKnownIdx = i;
    });

    // A message missing from the *middle* of what we hold (missed while
    // the socket was not delivering, with later ones arriving after it)
    // cannot be appended in order: replace that window with the server's.
    let lastCachedFreshPos = -1;
    fresh.forEach((m, i) => {
      if (chatMsgById.has(m.id)) lastCachedFreshPos = i;
    });
    const hasGap = fresh.some(
      (m, i) => i < lastCachedFreshPos && !chatMsgById.has(m.id)
    );
    if (hasGap) {
      chatMessages = chatMessages
        .slice(0, firstIdx)
        .concat(fresh, chatMessages.slice(lastKnownIdx + 1));
      paintChatFromCache();
      return;
    }

    // Deleted while we were away: cached, inside the server's window, gone.
    // (Messages after the last one the server knew about arrived live in
    // the meantime and must be kept.)
    chatMessages
      .slice(firstIdx, lastKnownIdx + 1)
      .filter((m) => !freshIds.has(m.id))
      .forEach((m) => removeChatMessage(m.id));

    for (const msg of fresh) {
      const cached = chatMsgById.get(msg.id);
      if (!cached) {
        addChatMessage(msg); // arrived while the socket was not delivering
      } else if (
        JSON.stringify(cached.reactions || []) !== JSON.stringify(msg.reactions || [])
      ) {
        cached.reactions = msg.reactions;
        updateMessageReactions('chat', msg.id, msg.reactions || []);
      }
    }
  } catch (e) {
    if (generation !== chatRenderGeneration) return;
    console.warn('[Chat] Background refresh failed:', e);
  }
}

async function loadRecentChat(generation) {
  const container = document.getElementById('chat-messages');
  try {
    const messages = await api('/api/chat/messages/recent?limit=50');
    // Stale render: abort if a newer render has replaced this one
    if (generation !== chatRenderGeneration) return;

    chatMessages = messages;
    chatLoaded = true;
    if (messages.length > 0) {
      chatOldest = messages[0].timestamp;
      chatHasMore = messages.length >= 50;
    }
    // Same reasoning as renderChat() above — the painter clears the
    // loading-state markup and revokes/aborts the previous batch's
    // image loads before rebuilding the list.
    paintChatFromCache();
  } catch (e) {
    // Stale render: abort if a newer render has replaced this one
    if (generation !== chatRenderGeneration) return;
    container.innerHTML = emptyState(ICONS.empty, 'Failed to load chat', escapeHtml(e.message));
  }
}

async function loadOlderChat() {
  if (!chatHasMore || !chatOldest) return;
  const container = document.getElementById('chat-messages');
  const btnRow = document.getElementById('chat-load-more-row');
  if (btnRow) btnRow.querySelector('.load-more-btn').textContent = 'Loading…';
  try {
    const messages = await api(`/api/chat/messages/before?before=${encodeURIComponent(chatOldest)}&limit=50`);
    // Stale render: abort if the load-more-row was removed by a newer render
    const btnRow2 = document.getElementById('chat-load-more-row');
    if (!btnRow2) return;
    if (btnRow) btnRow.remove();
    if (messages.length === 0) {
      chatHasMore = false;
      return;
    }
    chatOldest = messages[0].timestamp;
    chatHasMore = messages.length >= 50;
    const oldTop = container.scrollTop;
    const prevHeight = container.scrollHeight;
    const frag = document.createDocumentFragment();
    if (chatHasMore) {
      frag.appendChild(buildLoadMoreEl(loadOlderChat));
    }
    const older = [];
    messages.forEach(msg => {
      if (!renderedChatIds.has(msg.id)) {
        renderedChatIds.add(msg.id);
        chatMsgById.set(msg.id, msg);
        older.push(msg);
        frag.appendChild(buildChatMessageEl(msg));
      }
    });
    chatMessages = older.concat(chatMessages);
    container.insertBefore(frag, container.firstChild);
    container.scrollTop = oldTop + (container.scrollHeight - prevHeight);
  } catch (e) {
    if (btnRow) btnRow.querySelector('.load-more-btn').textContent = 'Load older messages';
    showToast(e.message, 'error');
  }
}

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

function buildChatMessageEl(msg) {
  const currentUser = getCurrentUser();
  const own = currentUser && msg.user_id === currentUser.id;
  const canDelete = own || (currentUser && currentUser.is_admin);
  const div = document.createElement('div');
  div.className = 'chat-msg' + (own ? ' own' : '');
  div.dataset.msgId = msg.id;
  // Every bubble uses the current viewer's own accent color,
  // regardless of who sent the message (see message-accent.js).
  setMessageAccent(div);
  div.innerHTML = `
    ${avatarHtml(msg.user_id, msg.username, 'chat-avatar')}
    <div class="chat-msg-content">
      <div class="chat-meta">
        <span class="chat-sender">${escapeHtml(msg.username)}</span>
        <span class="chat-time">${formatDate(msg.timestamp)}</span>
        <button type="button" class="chat-msg-reply" title="Reply" onclick="window.replyToChatMessage(${msg.id})">${ICONS.reply}</button>
        ${imageDownloadButtonHtml(msg, 'chat')}
        ${canDelete ? `<button type="button" class="chat-msg-delete" title="Delete message" onclick="window.deleteChatMessage(${msg.id})">${ICONS.trash}</button>` : ''}
      </div>
      ${buildReplyQuoteHtml(msg, 'chat')}
      ${msg.content ? `<div class="chat-bubble">${linkifyHtml(msg.content)}</div>` : ''}
      ${msg.has_attachment ? renderAttachment(msg, 'chat') : ''}
      ${renderReactionsRow(msg, 'chat')}
    </div>
  `;
  if (msg.has_attachment && msg.attachment_mime && msg.attachment_mime.startsWith('image/')) {
    queueMicrotask(() => loadChatImage(msg.id, 'chat'));
  }
  // Initialize the audio/video player (if any) directly on this
  // element. No document-wide query and no timing dependency: `div`
  // doesn't even need to be attached to the document yet.
  mountAttachmentMedia(msg, div, 'chat');
  return div;
}

export function addChatMessage(msg) {
  if (renderedChatIds.has(msg.id)) return;
  renderedChatIds.add(msg.id);
  chatMsgById.set(msg.id, msg);
  // Keep the cache current even while another tab is open, so the next
  // visit needs no refetch to show this message.
  if (chatLoaded) chatMessages.push(msg);
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const el = buildChatMessageEl(msg);
  // New-message entrance (see .chat-msg.msg-enter in messages.css) —
  // only for messages arriving/sent live, never the initial history
  // load in loadRecentChat()/loadOlderChat(), so scrollback never
  // animates in all at once.
  el.classList.add('msg-enter');
  const emptyEl = container.querySelector('.empty-state');
  if (emptyEl) container.innerHTML = '';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

// Idempotent: safe to call whether or not the message is currently
// rendered — the delete button and the 'chat-message-deleted' socket
// event (which fires for the deleter too, since everyone is in the
// 'chat' room) both call this.
export function removeChatMessage(id) {
  renderedChatIds.delete(id);
  chatMsgById.delete(id);
  chatMessages = chatMessages.filter((m) => m.id !== id);
  const container = document.getElementById('chat-messages');
  if (!container) {
    revokeAttachmentImage(id, 'chat'); // message is gone for good; free its cached image
    return;
  }
  const el = container.querySelector(`.chat-msg[data-msg-id="${id}"]`);
  if (!el) return;
  // Cancel any in-flight fetch for this element, and free its cached
  // image (if any) for good — unlike the navigation-teardown calls
  // to cleanupImageUrls() elsewhere in this file, this message is
  // actually gone, so there's no future "switch back" to keep it
  // cached for.
  cleanupImageUrls(el, 'chat');
  revokeAttachmentImage(id, 'chat');
  animateRemoval(el, () => {
    if (!container.querySelector('.chat-msg')) {
      container.innerHTML = emptyState(ICONS.chat, 'No messages yet', 'Say hello 👋');
    }
  });
}

window.openChatEmojiPicker = function(triggerEl) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  openEmojiPicker({
    anchorEl: triggerEl,
    onSelect: (char) => insertAtCursor(input, char),
  });
};

window.replyToChatMessage = function(id) {
  const msg = chatMsgById.get(id);
  if (!msg || !chatComposer) return;
  chatComposer.setReplyTo(buildReplyPreview(msg));
};

window.deleteChatMessage = async function(id) {
  if (!await showConfirm('Delete this message? This cannot be undone.', { title: 'Delete message' })) return;
  try {
    await api(`/api/chat/messages/${id}`, { method: 'DELETE' });
    removeChatMessage(id);
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.sendChat = function() {
  if (chatComposer) chatComposer.send();
};

// Drag-and-drop entry point (see dragdrop.js). Stages the dropped
// files above the input (same as picking/pasting) rather than
// uploading them immediately — the user reviews/captions/removes
// before anything is actually sent.
export function uploadChatFiles(fileList) {
  if (chatComposer) chatComposer.addFiles(fileList);
}

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