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
import { escapeHtml, escapeHtmlAttr, showToast } from '../core/utils.js';
import { getCurrentUser } from '../core/auth.js';
import { openEmojiPicker } from '../ui/emoji-picker.js';
import { ICONS } from '../icons.js';

const MESSAGES_CONTAINER_ID = {
  dm: 'dm-messages',
  group: 'group-messages',
};

// Unlike 'chat' and 'dm', the group reaction endpoint needs a
// dynamic groupId path segment (/api/groups/:groupId/messages/...) --
// there's no fixed URL for "the group" the way there is for "the
// chat room" or "my DMs". group.js registers a getter here once,
// rather than this module importing group.js directly (which would
// create a dependency in the wrong direction).
let activeGroupIdGetter = () => null;

export function setActiveGroupIdGetter(fn) {
  activeGroupIdGetter = fn;
}

export function reactionEndpoint(scope, messageId) {
  if (scope === 'dm') return `/api/dm/messages/${messageId}/reactions`;

  if (scope === 'group') {
    const groupId = activeGroupIdGetter();
    if (groupId == null) {
      throw new Error('No active group to react in');
    }
    return `/api/groups/${groupId}/messages/${messageId}/reactions`;
  }

  throw new Error(`Unknown reaction scope: ${scope}`);
}

/**
 * The "React" button of a message's action bar (the .chat-meta row).
 * It is the only entry point for adding a reaction from a message;
 * it opens the same shared picker as always through
 * window.openReactionPicker, anchored to itself. Called from
 * buildChatMessageEl()/buildDmMessageEl().
 */
export function reactButtonHtml(msg, scope) {
  return `<button type="button" class="chat-msg-react" title="React" aria-label="Add reaction"
    data-action="open-reaction-picker" data-scope="${escapeHtmlAttr(scope)}" data-msg-id="${msg.id}">${ICONS.emoji}</button>`;
}

/**
 * HTML for the row below a message bubble: the existing reaction pills
 * (grouped by emoji, with a count and "own reaction" highlight).
 * Empty string when the message has no reactions, so an unreacted
 * message carries no extra row. Called from
 * buildChatMessageEl()/buildDmMessageEl() when a message is first
 * rendered.
 */
export function renderReactionsRow(msg, scope) {
  const currentUserId = getCurrentUser()?.id;
  const reactions = msg.reactions || [];

  // group.emoji is server data with no character-set validation -- the
  // API only enforces a 32-char length limit (chat/dm/groups controllers),
  // so any authenticated user can submit an arbitrary string as a
  // "reaction" via a direct API call, bypassing the emoji picker. It MUST
  // be escaped like any other untrusted value before going into
  // innerHTML, both as visible text and inside the data-emoji attribute.
  // Previously it was interpolated raw into an inline onclick="" string,
  // a stored-XSS hole that ran in every participant's chat/DM view.
  const pillsHtml = reactions.map(group => {
    const isOwn = currentUserId && group.user_ids.includes(currentUserId);
    const title = escapeHtmlAttr(group.usernames.join(', '));
    const emoji = escapeHtml(group.emoji);
    const emojiAttr = escapeHtmlAttr(group.emoji);
    return `
      <button type="button" class="reaction-pill${isOwn ? ' own' : ''}"
        title="${title}"
        data-action="toggle-reaction" data-scope="${escapeHtmlAttr(scope)}" data-msg-id="${Number(msg.id)}" data-emoji="${emojiAttr}">
        <span class="reaction-emoji">${emoji}</span><span class="reaction-count">${Number(group.count) || 0}</span>
      </button>
    `;
  }).join('');

  // chat/dm keep X's design: the React button lives in the message's
  // action bar (reactButtonHtml), so a message without reactions has no
  // row. The group thread (chat/thread.js) has no such button, so for
  // scope 'group' the row always carries its own add-reaction button.
  const isGroup = scope === 'group';
  if (!reactions.length && !isGroup) return '';

  const addBtn = isGroup
    ? `<button type="button" class="reaction-add-btn" title="Add reaction"
        data-action="open-reaction-picker" data-scope="${escapeHtmlAttr(scope)}" data-msg-id="${Number(msg.id)}">
        ${ICONS.emoji}
      </button>`
    : '';

  return `
    <div class="reactions-row" data-msg-id="${Number(msg.id)}">
      ${pillsHtml}
      ${addBtn}
    </div>
  `;
}

// Delegated click handling for renderReactionsRow()'s output (chat.js,
// dm.js, group.js). Bound once here instead of inline onclick="" attributes:
// the app's CSP has no 'unsafe-inline' in script-src (which would silently
// drop them), and reading the emoji back out of a data-* attribute avoids
// re-parsing untrusted data as script text.
if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="toggle-reaction"], [data-action="open-reaction-picker"]');
  if (!btn) return;

  const { action, scope, msgId, emoji } = btn.dataset;
  if (action === 'toggle-reaction') {
    window.toggleMessageReaction(scope, Number(msgId), emoji);
  } else if (action === 'open-reaction-picker') {
    window.openReactionPicker(scope, Number(msgId), btn);
  }
});

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

  const msgEl = container.querySelector(`.chat-msg[data-msg-id="${Number(messageId)}"]`);
  if (!msgEl) return; // message not currently rendered (e.g. a different conversation is open) — nothing to update

  const existingRow = msgEl.querySelector('.reactions-row');
  const html = renderReactionsRow({ id: messageId, reactions }, scope);

  if (existingRow) {
    existingRow.outerHTML = html;
  } else {
    // A message without reactions has no .reactions-row yet — append
    // one (CSS orders it after the bubble/attachment).
    msgEl.querySelector('.chat-msg-content')?.insertAdjacentHTML('beforeend', html);
  }
}

window.toggleMessageReaction = async function(scope, messageId, emoji) {
  let endpoint;
  try {
    endpoint = reactionEndpoint(scope, messageId);
  } catch (e) {
    showToast(e.message, 'error');
    return;
  }

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
