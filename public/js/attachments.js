import { fetchBlob } from './api.js';
import { ICONS } from './icons.js';
import {
  showToast,
  escapeAttr,
  escapeHtml,
  formatBytes
} from './utils.js';
<<<<<<< Updated upstream
=======
import { isAudio, renderAudio } from './audio-player.js';
>>>>>>> Stashed changes

// Track pending loads: key = `${prefix}-${id}`, value = { promise, controller }
const pendingLoads = new Map();

export function renderAttachment(msg, scope) {
  const isImage =
    msg.attachment_mime &&
    msg.attachment_mime.startsWith('image/');

  const prefix = scope === 'dm' ? 'dm-att' : 'att';

  if (isImage) {
    return `
    <div class="chat-attachment-image-wrap">
      <div class="chat-attachment-image" id="${prefix}-${msg.id}">
        <div class="loading-state">
          <div class="spin"></div>
        </div>
      </div>
      <button type="button" class="chat-attachment-image-dl" title="Download ${escapeAttr(msg.attachment_name)}"
        onclick="event.stopPropagation(); window.downloadAttachment(${msg.id}, '${escapeAttr(msg.attachment_name)}', '${scope}')">
        ${ICONS.download}
      </button>
    </div>`;
  }

  return `
  <div class="chat-attachment"
       onclick="window.downloadAttachment(${msg.id}, '${escapeAttr(msg.attachment_name)}', '${scope}')">

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

  // Return existing in‑flight request for the same element
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

      const blob = await fetchBlob(url, { signal: controller.signal });

      // If the element was removed while fetching, revoke and bail out
      if (!document.body.contains(el)) {
        // No need to revoke anything because we haven't created a URL yet.
        // But just to be safe, no action needed.
        return;
      }

      // Revoke old blob URL if present
      const oldUrl = el.dataset.blobUrl;
      if (oldUrl) URL.revokeObjectURL(oldUrl);

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
        el.innerHTML = '<div class="text-muted">Image broken</div>';
      };
      el.appendChild(img);
    } catch (e) {
      if (e.name === 'AbortError') return; // Aborted → do nothing
      // If element still exists, show error
      if (document.body.contains(el)) {
        el.innerHTML = '<div class="text-muted">Failed to load image</div>';
      }
    } finally {
      // Only delete the pending entry if it's still our own request
      if (pendingLoads.get(key)?.promise === loadPromise) {
        pendingLoads.delete(key);
      }
    }
  })();

  pendingLoads.set(key, { promise: loadPromise, controller });
  return loadPromise;
}

/**
 * Revoke all blob URLs inside a container and cancel any pending loads
 * for the elements being removed.
 *
 * @param {HTMLElement} container – the message list element
 * @param {'chat'|'dm'} scope – determines the attachment prefix
 */
export function cleanupImageUrls(container, scope) {
  if (!container) return;

  const prefix = scope === 'dm' ? 'dm-att' : 'att';

  // Abort pending loads for all image elements inside this container
  container.querySelectorAll('.chat-attachment-image').forEach(el => {
    const id = el.id.split('-').pop(); // message id is the last part of the id
    const key = `${prefix}-${id}`;
    const entry = pendingLoads.get(key);
    if (entry) {
      entry.controller.abort();
      pendingLoads.delete(key);
    }
  });

  // Revoke blob URLs stored as data attributes
  container.querySelectorAll('[data-blob-url]').forEach(el => {
    const url = el.dataset.blobUrl;
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
      el.removeAttribute('data-blob-url');
    }
  });
}

/**
 * Cancel all pending attachment loads (e.g. on logout or full UI reset).
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
 * The current implementation loads the entire file into memory via `fetchBlob`.
 * For multi‑gigabyte files this can cause performance issues.
 *
 * A better approach (recommended for production) is to obtain a short‑lived
 * download token from the server and redirect the browser directly:
 *
 *   const token = await api('/api/chat/attachments/' + id + '/token');
 *   window.location.href = `/api/chat/attachments/${id}?token=${token}`;
 *
 * This avoids JavaScript memory usage and works even if the backend requires
 * an Authorization header (because the token is embedded in the URL).
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
    a.addEventListener('click', () => {
      setTimeout(() => URL.revokeObjectURL(objectURL), 100);
    }, { once: true });

    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    showToast('Download failed: ' + e.message, 'error');
  }
}

// Expose for inline onclick
window.downloadAttachment = downloadAttachment;

// Re-export audio player functions for chat.js / dm.js
export { isAudio, renderAudio };