// ============================================================
// Message replies
// ------------------------------------------------------------
// Shared between group Chat and DMs (same reasoning as
// reactions.js/typing.js/presence.js): rendering a reply quote and
// scrolling to the original message are identical for both message
// types — only the container id and the message's field names
// (username vs sender_username) differ — so this lives here once
// instead of being duplicated in chat.js and dm.js.
// ============================================================

import { escapeHtml, escapeHtmlAttr, showToast } from '../core/utils.js';

const MESSAGES_CONTAINER_ID = {
  chat: 'chat-messages',
  dm: 'dm-messages',
  group: 'group-messages',
};

function attachmentLabel(msg) {
  const mime = msg.attachment_mime || '';
  if (msg.is_voice_message) return 'Voice message';
  if (mime.startsWith('image/')) return 'Photo';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  return msg.attachment_name || 'Attachment';
}

/**
 * HTML for the quoted "replying to ..." block rendered inside a
 * message bubble, right above its own content, when that message is
 * itself a reply (msg.reply_to_id is set). Returns '' for normal
 * messages so callers can inline it unconditionally.
 *
 * The backend distinguishes "not a reply" (reply_to_id: null) from
 * "was a reply, but the original was deleted" (reply_to_id set,
 * reply_to: null — see chat.service.js/dm.service.js) — the latter
 * still renders a placeholder rather than silently dropping the fact
 * that this message was a reply.
 */
export function buildReplyQuoteHtml(msg, scope) {
  if (msg.reply_to_id == null) return '';

  if (!msg.reply_to) {
    return `
      <div class="reply-quote reply-quote-deleted">
        <div class="reply-quote-bar"></div>
        <div class="reply-quote-body">
          <div class="reply-quote-text">Original message deleted</div>
        </div>
      </div>
    `;
  }

  const r = msg.reply_to;
  // attachmentLabel() can return the uploader-controlled filename
  // (msg.attachment_name), and the server only path.basename()s it -- a
  // name like `<img src=x onerror=...>.pdf` is a legal filename -- so
  // BOTH branches must be escaped before going into innerHTML.
  const text = escapeHtml(
    r.content
      ? r.content
      : (r.has_attachment ? attachmentLabel(r) : '')
  );

  return `
    <div class="reply-quote" data-action="scroll-to-replied" data-scope="${escapeHtmlAttr(scope)}" data-msg-id="${Number(r.id)}">
      <div class="reply-quote-bar"></div>
      <div class="reply-quote-body">
        <div class="reply-quote-name">${escapeHtml(r.username)}</div>
        <div class="reply-quote-text">${text}</div>
      </div>
    </div>
  `;
}

// Delegated click handling for the reply-quote block above (used by
// chat.js, dm.js and group/thread.js). Bound once, here, instead of
// an inline onclick="" attribute, because the app's CSP has no
// 'unsafe-inline' in script-src, which silently drops inline
// event-handler attributes.
if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
  const el = e.target.closest('.reply-quote[data-action="scroll-to-replied"]');
  if (!el) return;
  window.scrollToRepliedMessage(el.dataset.scope, Number(el.dataset.msgId));
});

/**
 * Normalizes a rendered chat/DM message into the shape the
 * composer's reply-preview bar needs (see composer.js setReplyTo),
 * hiding the chat-vs-DM field-name differences (username vs
 * sender_username) from chat.js/dm.js.
 */
export function buildReplyPreview(msg) {
  return {
    id: msg.id,
    username: msg.username || msg.sender_username || '',
    content: msg.content || '',
    hasAttachment: !!msg.has_attachment,
    attachmentName: msg.attachment_name || null,
    attachmentMime: msg.attachment_mime || null,
    isVoiceMessage: !!msg.is_voice_message,
  };
}

/**
 * Click handler for a reply-quote block: finds the original message
 * in the currently-rendered list, scrolls to it, and briefly pulses
 * it. If the original message isn't currently loaded (e.g. it's
 * outside the loaded pagination window), this degrades gracefully —
 * no crash, just a toast pointing at "load older messages", which is
 * already how both chat.js and dm.js load more history.
 */
window.scrollToRepliedMessage = function (scope, id) {
  const containerId = MESSAGES_CONTAINER_ID[scope];
  const container = document.getElementById(containerId);
  if (!container) return;

  const el = container.querySelector(`.chat-msg[data-msg-id="${Number(id)}"]`);
  if (!el) {
    showToast("That message isn't loaded — try loading older messages.", 'info');
    return;
  }

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('reply-highlight');
  setTimeout(() => el.classList.remove('reply-highlight'), 1600);
};
