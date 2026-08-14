import { api } from './api.js';
import { ICONS } from './icons.js';
import {
  showToast,
  emptyState,
  loadingState,
  escapeHtml,
  formatDate,
  insertAtCursor
} from './utils.js';
import {
  progressBarHtml,
  showUploadProgress,
  updateUploadProgress,
  hideUploadProgress,
  xhrUpload
} from './upload.js';
import { renderAttachment, loadChatImage, mountAttachmentMedia } from './attachments.js';
import { avatarHtml } from './avatar.js';
import { getCurrentUser } from './auth.js';
import { showConfirm } from './confirm.js';
import { openEmojiPicker } from './emoji-picker.js';
import { renderReactionsRow } from './reactions.js';
import { createTypingEmitter, createTypingIndicator, wireTypingInput } from './typing.js';
import { getSocket } from './socket.js';

let chatRenderGeneration = 0;
let chatOldest = null;
let chatHasMore = true;
const renderedChatIds = new Set();

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

export async function renderChat() {
  const main = document.getElementById('content-area');
  const generation = ++chatRenderGeneration;
  main.innerHTML = `
    <div class="chat-panel">
      <div class="chat-top-bar">
        <div class="chat-top-avatar" style="display:flex;align-items:center;justify-content:center;">${ICONS.chat}</div>
        <div>
          <div class="chat-top-name">Group Chat</div>
          <div class="chat-top-status">Everyone in this workspace</div>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages">${loadingState()}</div>
      ${progressBarHtml('chat-upload-progress')}
      <div class="typing-indicator" id="chat-typing-indicator"></div>
      <div class="chat-input-area">
        <input type="file" id="chat-file-input" class="hidden" onchange="window.sendChatFile()">
        <button class="btn btn-ghost btn-icon" title="Attach a file" onclick="document.getElementById('chat-file-input').click()">${ICONS.paperclip}</button>
        <button class="btn btn-ghost btn-icon emoji-trigger" title="Emoji" onclick="window.openChatEmojiPicker(this)">${ICONS.emoji}</button>
        <input type="text" id="chat-input" placeholder="Type a message…" onkeypress="if(event.key==='Enter') window.sendChat()">
        <button onclick="window.sendChat()" class="btn-send" title="Send message">${ICONS.send}</button>
      </div>
    </div>
  `;
  chatOldest = null;
  chatHasMore = true;
  renderedChatIds.clear();
  chatTypingIndicator.clearAll();
  wirePasteImage('chat-input', window.sendChatFile);
  wireTypingInput('chat-input', chatTypingEmitter);
  await loadRecentChat(generation);
}

async function loadRecentChat(generation) {
  const container = document.getElementById('chat-messages');
  try {
    const messages = await api('/api/chat/messages/recent?limit=50');
    // Stale render: abort if a newer render has replaced this one
    if (generation !== chatRenderGeneration) return;

    renderedChatIds.clear();
    container.innerHTML = '';
    if (messages.length === 0) {
      container.innerHTML = emptyState(ICONS.chat, 'No messages yet', 'Say hello 👋');
      chatHasMore = false;
      return;
    }
    chatOldest = messages[0].timestamp;
    chatHasMore = messages.length >= 50;
    if (chatHasMore) {
      container.appendChild(buildLoadMoreEl(loadOlderChat));
    }
    messages.forEach(msg => {
      renderedChatIds.add(msg.id);
      container.appendChild(buildChatMessageEl(msg));
    });
    container.scrollTop = container.scrollHeight;
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
    messages.forEach(msg => {
      if (!renderedChatIds.has(msg.id)) {
        renderedChatIds.add(msg.id);
        frag.appendChild(buildChatMessageEl(msg));
      }
    });
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
  div.innerHTML = `
    ${avatarHtml(msg.user_id, msg.username, 'chat-avatar')}
    <div class="chat-msg-content">
      <div class="chat-meta">
        <span class="chat-sender">${escapeHtml(msg.username)}</span>
        <span class="chat-time">${formatDate(msg.timestamp)}</span>
        ${canDelete ? `<button type="button" class="chat-msg-delete" title="Delete message" onclick="window.deleteChatMessage(${msg.id})">${ICONS.trash}</button>` : ''}
      </div>
      ${msg.content ? `<div class="chat-bubble">${escapeHtml(msg.content)}</div>` : ''}
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
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const el = buildChatMessageEl(msg);
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
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const el = container.querySelector(`.chat-msg[data-msg-id="${id}"]`);
  if (!el) return;
  el.remove();
  if (!container.querySelector('.chat-msg')) {
    container.innerHTML = emptyState(ICONS.chat, 'No messages yet', 'Say hello 👋');
  }
}

window.openChatEmojiPicker = function(triggerEl) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  openEmojiPicker({
    anchorEl: triggerEl,
    onSelect: (char) => insertAtCursor(input, char),
  });
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

window.sendChat = async function() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!content) return;
  chatTypingEmitter.stop();
  try {
    const message = await api('/api/chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    input.value = '';
    addChatMessage(message);
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// Core single-file upload, shared by the file-picker/paste flow
// (window.sendChatFile) and the drag-and-drop flow (uploadChatFiles).
async function uploadOneChatFile(file, caption, progressLabel) {
  const form = new FormData();
  form.append('file', file, file.name);
  if (caption) form.append('content', caption);
  showUploadProgress('chat-upload-progress', progressLabel || file.name);
  try {
    const message = await xhrUpload('/api/chat/upload', form, (pct) => updateUploadProgress('chat-upload-progress', pct));
    addChatMessage(message);
    return true;
  } catch (e) {
    showToast(`${file.name}: ${e.message}`, 'error');
    return false;
  } finally {
    hideUploadProgress('chat-upload-progress');
  }
}

window.sendChatFile = async function(pastedFile) {
  const input = document.getElementById('chat-file-input');
  const file = pastedFile || input.files[0];
  if (!file) return;
  const captionInput = document.getElementById('chat-input');
  const caption = captionInput ? captionInput.value.trim() : '';
  chatTypingEmitter.stop();
  const ok = await uploadOneChatFile(file, caption);
  if (ok) {
    if (!pastedFile) input.value = '';
    if (captionInput) captionInput.value = '';   // پاک کردن کپشن بعد از آپلود موفق
  }
};

// Drag-and-drop entry point (see dragdrop.js). Unlike the file-picker
// flow, drops can carry multiple files at once — each becomes its own
// message, uploaded sequentially through the same endpoint/progress
// bar so "(2/5)" style progress stays meaningful with one shared bar.
export async function uploadChatFiles(fileList) {
  const files = Array.from(fileList);
  for (let i = 0; i < files.length; i++) {
    const label = files.length > 1 ? `${files[i].name} (${i + 1}/${files.length})` : files[i].name;
    await uploadOneChatFile(files[i], '', label);
  }
}

function wirePasteImage(inputId, sendFn) {
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
        sendFn(file);
        return;
      }
    }
  });
}