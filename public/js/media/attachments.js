import { fetchBlob } from '../core/api.js';
import { ICONS } from '../icons.js';
import {
  showToast,
  escapeAttr,
  escapeHtml,
  formatBytes
} from '../core/utils.js';

import { isAudio, renderAudio } from './audio-player.js';
import { isVideo, renderVideo } from './video-player.js';
import { isVoiceMessage, renderVoiceMessage } from './voice-message.js';

// Track pending loads: key = `${prefix}-${id}`, value = { promise, controller }
const pendingLoads = new Map();

// Detect which media player (if any) a message's attachment needs.
// Shared by renderAttachment() (to know what placeholder to emit)
// and mountAttachmentMedia() (to know which player to initialize).
function attachmentMediaKind(msg) {
  // Voice messages are audio attachments too (same has_attachment/
  // attachment_mime shape) — checked first so they route to the
  // dedicated voice-message player instead of the generic one.
  if (isVoiceMessage(msg)) return 'voice';

  const isAudioAttachment =
    isAudio(msg.attachment_mime) ||
    isAudio(msg.attachment_name);

  if (isAudioAttachment) return 'audio';

  // Detect video attachments by MIME type or file extension
  const isVideoAttachment =
    isVideo(msg.attachment_mime) ||
    ['mp4', 'webm', 'mov'].includes(
      (msg.attachment_name || '')
        .split('.')
        .pop()
        .toLowerCase()
    );

  if (isVideoAttachment) return 'video';

  return null;
}

// Initializes the audio/video player for a message's attachment,
// if it needs one.
//
// IMPORTANT: this takes the message's *actual element* directly
// (the one built by buildChatMessageEl/buildDmMessageEl), rather
// than looking it up with document.querySelector('.chat-msg[...]').
// The element doesn't even need to be attached to the document yet -
// the player is built by querying inside `messageEl`, not the global
// document, so there is no dependency on DOM insertion timing/order
// and no risk of matching a same-numbered message in the wrong list
// (chat message ids and DM message ids are independent sequences).
export function mountAttachmentMedia(msg, messageEl, scope) {
  if (!messageEl || !msg.has_attachment) return;
  const kind = attachmentMediaKind(msg);
  if (kind === 'voice') {
    renderVoiceMessage(msg, scope, messageEl);
  } else if (kind === 'audio') {
    renderAudio(msg, scope, messageEl);
  } else if (kind === 'video') {
    renderVideo(msg, scope, messageEl);
  }
}

export function renderAttachment(msg, scope) {
  const isImage =
    msg.attachment_mime &&
    msg.attachment_mime.startsWith('image/');

  const prefix = scope === 'dm' ? 'dm-att' : 'att';

  const mediaKind = attachmentMediaKind(msg);

  // Audio/video attachments are handled by their respective players.
  // Emit an empty placeholder here; mountAttachmentMedia() (called by
  // chat.js/dm.js right after the message element is built) fills it
  // in synchronously.
  if (mediaKind) {
    return '';
  }

  // Image attachment
  if (isImage) {
    // Chat messages carry `username`/`user_id`
    // DM messages carry `sender_username`/`sender_id`
    // The image viewer needs the sender's identity.
    const username =
      msg.username ||
      msg.sender_username ||
      '';

    const userId =
      msg.user_id ??
      msg.sender_id ??
      '';

    return `
    <div class="chat-attachment-image-wrap">
      <div
        class="chat-attachment-image"
        id="${prefix}-${msg.id}"
        data-scope="${scope}"
        data-filename="${escapeAttr(msg.attachment_name)}"
        data-username="${escapeAttr(username)}"
        data-user-id="${escapeAttr(userId)}"
        onclick="window.openImageViewer(this)"
      >
        <div class="loading-state">
          <div class="spin"></div>
        </div>
      </div>

      <button
        type="button"
        class="chat-attachment-image-dl"
        title="Download ${escapeAttr(msg.attachment_name)}"
        onclick="event.stopPropagation(); window.downloadAttachment(${msg.id}, '${escapeAttr(msg.attachment_name)}', '${scope}')"
      >
        ${ICONS.download}
      </button>
    </div>`;
  }

  // Generic file attachment
  return `
  <div
    class="chat-attachment"
    onclick="window.downloadAttachment(${msg.id}, '${escapeAttr(msg.attachment_name)}', '${scope}')"
  >
    ${ICONS.file}

    <div class="chat-attachment-info">
      <div class="chat-attachment-name">
        ${escapeHtml(msg.attachment_name)}
      </div>

      <div class="chat-attachment-size">
        ${formatBytes(msg.attachment_size)}
      </div>
    </div>

    ${ICONS.download}
  </div>`;
}

export async function loadChatImage(id, scope) {
  const prefix = scope === 'dm' ? 'dm-att' : 'att';
  const key = `${prefix}-${id}`;

  const el = document.getElementById(key);

  if (!el) return;

  // Return existing in-flight request for the same element
  if (pendingLoads.has(key)) {
    return pendingLoads.get(key).promise;
  }

  const controller = new AbortController();

  const loadPromise = (async () => {
    try {
      const url =
        scope === 'dm'
          ? `/api/dm/attachments/${id}`
          : `/api/chat/attachments/${id}`;

      const blob = await fetchBlob(url, {
        signal: controller.signal
      });

      // If the element was removed while fetching,
      // there is nothing left to update.
      if (!document.body.contains(el)) {
        return;
      }

      // Revoke old blob URL if present
      const oldUrl = el.dataset.blobUrl;

      if (oldUrl) {
        URL.revokeObjectURL(oldUrl);
      }

      const objectURL = URL.createObjectURL(blob);

      el.dataset.blobUrl = objectURL;

      // Build image element safely
      el.innerHTML = '';

      const img = document.createElement('img');

      img.src = objectURL;
      img.alt = 'attachment';

      img.onerror = () => {
        URL.revokeObjectURL(objectURL);

        delete el.dataset.blobUrl;

        el.innerHTML =
          '<div class="text-muted">Image broken</div>';
      };

      el.appendChild(img);

    } catch (e) {
      if (e.name === 'AbortError') {
        return;
      }

      // If element still exists, show error
      if (document.body.contains(el)) {
        el.innerHTML =
          '<div class="text-muted">Failed to load image</div>';
      }

    } finally {
      // Only delete the pending entry if it's still our own request
      if (pendingLoads.get(key)?.promise === loadPromise) {
        pendingLoads.delete(key);
      }
    }
  })();

  pendingLoads.set(key, {
    promise: loadPromise,
    controller
  });

  return loadPromise;
}

/**
 * Revoke all blob URLs inside a container and cancel any pending loads
 * for the elements being removed.
 *
 * @param {HTMLElement} container - the message list element
 * @param {'chat'|'dm'} scope - determines the attachment prefix
 */
export function cleanupImageUrls(container, scope) {
  if (!container) return;

  const prefix = scope === 'dm' ? 'dm-att' : 'att';

  // Abort pending loads for all image elements inside this container
  container
    .querySelectorAll('.chat-attachment-image')
    .forEach(el => {
      const id = el.id.split('-').pop();
      const key = `${prefix}-${id}`;

      const entry = pendingLoads.get(key);

      if (entry) {
        entry.controller.abort();
        pendingLoads.delete(key);
      }
    });

  // Revoke blob URLs stored as data attributes
  container
    .querySelectorAll('[data-blob-url]')
    .forEach(el => {
      const url = el.dataset.blobUrl;

      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
        el.removeAttribute('data-blob-url');
      }
    });
}

/**
 * Cancel all pending attachment loads
 * (e.g. on logout or full UI reset).
 */
export function cancelAllAttachmentLoads() {
  for (const { controller } of pendingLoads.values()) {
    controller.abort();
  }

  pendingLoads.clear();
}

/**
 * Downloads an attachment.
 *
 * Note on large files:
 * The current implementation loads the entire file into memory via
 * `fetchBlob`.
 *
 * A better approach for production is to obtain a short-lived download
 * token from the server and redirect the browser directly.
 */
export async function downloadAttachment(id, name, scope) {
  try {
    const url =
      scope === 'dm'
        ? `/api/dm/attachments/${id}?download=1`
        : `/api/chat/attachments/${id}?download=1`;

    const blob = await fetchBlob(url);

    const objectURL = URL.createObjectURL(blob);

    const a = document.createElement('a');

    a.href = objectURL;
    a.download = name || 'download';

    // Revoke the blob URL shortly after the download starts
    a.addEventListener(
      'click',
      () => {
        setTimeout(() => {
          URL.revokeObjectURL(objectURL);
        }, 100);
      },
      { once: true }
    );

    document.body.appendChild(a);

    a.click();

    a.remove();

  } catch (e) {
    showToast(
      'Download failed: ' + e.message,
      'error'
    );
  }
}

// Expose for inline onclick
window.downloadAttachment = downloadAttachment;

