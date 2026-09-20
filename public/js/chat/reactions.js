// ============================================================
// Message reactions
// ------------------------------------------------------------
// Shared between group Chat and DMs (both message types are
// visually and behaviorally identical for reactions — only the API
// endpoint differs, which is why every function here takes a
// `scope` ('chat' | 'dm') parameter instead of being duplicated in
// chat.js and dm.js).
// ============================================================

import { api } from '../core/api.js';
import { escapeHtml, showToast } from '../core/utils.js';
import { getCurrentUser } from '../core/auth.js';
import { openEmojiPicker } from '../ui/emoji-picker.js';
import { ICONS } from '../icons.js';

const MESSAGES_CONTAINER_ID = {
  chat: 'chat-messages',
  dm: 'dm-messages',
};

/**
 * HTML for the row below a message bubble: existing reaction pills
 * (grouped by emoji, with a count and "own reaction" highlight) plus
 * a hover-revealed "add reaction" button. Called from
 * buildChatMessageEl()/buildDmMessageEl() when a message is first
 * rendered.
 */
export function renderReactionsRow(msg, scope) {
  const currentUserId = getCurrentUser()?.id;
  const reactions = msg.reactions || [];

  const pillsHtml = reactions.map(group => {
    const isOwn = currentUserId && group.user_ids.includes(currentUserId);
    const title = escapeHtml(group.usernames.join(', '));
    return `
      <button type="button" class="reaction-pill${isOwn ? ' own' : ''}"
        title="${title}"
        onclick="window.toggleMessageReaction('${scope}', ${msg.id}, '${group.emoji}')">
        <span class="reaction-emoji">${group.emoji}</span><span class="reaction-count">${group.count}</span>
      </button>
    `;
  }).join('');

  return `
    <div class="reactions-row" data-msg-id="${msg.id}">
      ${pillsHtml}
      <button type="button" class="reaction-add-btn" title="Add reaction"
        onclick="window.openReactionPicker('${scope}', ${msg.id}, this)">
        ${ICONS.emoji}
      </button>
    </div>
  `;
}

/**
 * Re-renders just the reactions row for one message, without
 * touching the rest of the message bubble. Used both by the local
 * "I just clicked a reaction" optimistic update and by the
 * 'chat-reaction-update'/'dm-reaction-update' socket handlers (see
 * socket.js) — the same function serves both, so there's no separate
 * "local" vs "remote" rendering path to keep in sync.
 */
// Views that keep their own message cache (chat.js, dm.js) subscribe here
// so cached messages follow every reaction change, wherever it came from.
const reactionListeners = new Set();
export function onReactionsUpdated(fn) {
  reactionListeners.add(fn);
}

export function updateMessageReactions(scope, messageId, reactions) {
  reactionListeners.forEach((fn) => fn(scope, messageId, reactions));

  const containerId = MESSAGES_CONTAINER_ID[scope];
  const container = document.getElementById(containerId);
  if (!container) return;

  const msgEl = container.querySelector(`.chat-msg[data-msg-id="${messageId}"]`);
  if (!msgEl) return; // message not currently rendered (e.g. a different conversation is open) — nothing to update

  const existingRow = msgEl.querySelector('.reactions-row');
  const html = renderReactionsRow({ id: messageId, reactions }, scope);

  if (existingRow) {
    existingRow.outerHTML = html;
  } else {
    // Older messages rendered before this feature existed in this
    // session wouldn't have a .reactions-row yet — append one.
    msgEl.querySelector('div:last-child')?.insertAdjacentHTML('beforeend', html);
  }
}

window.toggleMessageReaction = async function(scope, messageId, emoji) {
  const endpoint = scope === 'dm'
    ? `/api/dm/messages/${messageId}/reactions`
    : `/api/chat/messages/${messageId}/reactions`;

  try {
    const result = await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    });
    // Optimistic-ish: update immediately from this response rather
    // than waiting for the socket echo, which is what makes your own
    // click feel instant; the socket event for this same change will
    // arrive shortly after and just re-apply the identical data.
    updateMessageReactions(scope, messageId, result.reactions);
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.openReactionPicker = function(scope, messageId, triggerEl) {
  openEmojiPicker({
    anchorEl: triggerEl,
    onSelect: (char) => window.toggleMessageReaction(scope, messageId, char),
  });
};
