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

// Loaded image attachments, keyed by the same `${prefix}-${id}` used
// everywhere else in this file. Deliberately kept independent of any
// particular DOM element/container: conversations get re-rendered
// from scratch every time the user switches back to them (see
// dm.js's per-conversation cache), and without this an already-
// loaded image would otherwise be re-fetched from the server every
// single time its message happens to be rebuilt, even though nothing
// about the underlying file changed. A Map preserves insertion
// order, which the simple eviction below relies on.
const imageBlobCache = new Map();
const MAX_CACHED_IMAGES = 80;

function cacheImageUrl(key, url) {
  imageBlobCache.set(key, url);
  // Cheap LRU-ish cap: once we're over budget, drop the
  // longest-untouched entry. get() below re-inserts on read so
  // recently-viewed images are the ones that survive.
  while (imageBlobCache.size > MAX_CACHED_IMAGES) {
    const oldestKey = imageBlobCache.keys().next().value;
    const oldestUrl = imageBlobCache.get(oldestKey);
    imageBlobCache.delete(oldestKey);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
  }
}

function getCachedImageUrl(key) {
  const url = imageBlobCache.get(key);
  if (url === undefined) return undefined;
  // Refresh recency so this entry isn't the next one evicted.
  imageBlobCache.delete(key);
  imageBlobCache.set(key, url);
  return url;
}

/**
 * CSS `aspect-ratio` value for an image attachment's placeholder.
 * Uses the real pixel dimensions captured at upload time
 * (attachment_width/height — see utils/imageDimensions.js on the
 * backend) when available, so the reserved box already matches the
 * image's actual proportions before a single byte of it has been
 * fetched. Falls back to a stable generic ratio for attachments that
 * predate that column (or whose format couldn't be parsed), which is
 * still far better than no reservation at all.
 */
function imageAspectRatio(msg) {
  const w = Number(msg.attachment_width);
  const h = Number(msg.attachment_height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return `${w} / ${h}`;
  }
  return '4 / 3';
}

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
    ['mp4', 'webm', 'mov', 'mkv', 'mjpeg'].includes(
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

  // renderVoiceMessage/renderAudio/renderVideo are async (they await
  // a scoped media-token fetch before building the player - see
  // media/mediaToken.js) but are intentionally not awaited here:
  // mountAttachmentMedia() itself stays synchronous so callers don't
  // have to change. Without a .catch() here though, any rejection
  // past that first await (a failed token fetch, a network error)
  // becomes an unhandled promise rejection - logged by the browser
  // but never surfaced anywhere useful, and the attachment just
  // silently never renders. Catch and log explicitly instead.
  let renderPromise;
  if (kind === 'voice') {
    renderPromise = renderVoiceMessage(msg, scope, messageEl);
  } else if (kind === 'audio') {
    renderPromise = renderAudio(msg, scope, messageEl);
  } else if (kind === 'video') {
    renderPromise = renderVideo(msg, scope, messageEl);
  }

  if (renderPromise && typeof renderPromise.catch === 'function') {
    renderPromise.catch((err) => {
      console.error(
        `Failed to render ${kind} attachment for message ${msg.id}:`,
        err
      );
    });
  }
}

/**
 * A small icon-only download button for an image attachment, meant
 * to sit in the message's meta row next to Reply/Delete instead of
 * floating on top of the image itself — on small images the old
 * overlaid button covered too much of the picture. Returns '' for
 * non-image (or missing) attachments; other attachment types already
 * have their own inline download affordance in renderAttachment().
 */
export function imageDownloadButtonHtml(msg, scope) {
  const isImage =
    msg.has_attachment &&
    msg.attachment_mime &&
    msg.attachment_mime.startsWith('image/');

  if (!isImage) return '';

  return `
    <button
      type="button"
      class="chat-msg-download"
      title="Download ${escapeAttr(msg.attachment_name)}"
      onclick="window.downloadAttachment(${msg.id}, '${escapeAttr(msg.attachment_name)}', '${scope}')"
    >${ICONS.download}</button>`;
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

    const key = `${prefix}-${msg.id}`;
    const ratio = imageAspectRatio(msg);
    const cachedUrl = getCachedImageUrl(key);

    // Already loaded earlier in this session (e.g. the user is
    // switching back to a conversation they had open before): render
    // the <img> directly, already visible, with no spinner and no
    // network request. loadChatImage() (still called by
    // buildChatMessageEl/buildDmMessageEl right after this markup is
    // inserted) checks the same cache and is a no-op in this case.
    const innerHtml = cachedUrl
      ? `<img src="${escapeAttr(cachedUrl)}" alt="attachment" class="loaded" data-blob-url="${escapeAttr(cachedUrl)}">`
      : `<div class="loading-state"><div class="spin"></div></div>`;

    return `
    <div class="chat-attachment-image-wrap">
      <div
        class="chat-attachment-image"
        id="${key}"
        style="aspect-ratio:${ratio};"
        data-scope="${scope}"
        data-filename="${escapeAttr(msg.attachment_name)}"
        data-username="${escapeAttr(username)}"
        data-user-id="${escapeAttr(userId)}"
        ${cachedUrl ? `data-blob-url="${escapeAttr(cachedUrl)}"` : ''}
        onclick="window.openImageViewer(this)"
      >${innerHtml}</div>
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

  // Already loaded (this session) and cached — renderAttachment()
  // already rendered the <img> synchronously from cache in this
  // case, so there's nothing left to do. Guards against the case
  // where a cache entry was populated by a fetch that resolved
  // *after* this particular element was built from stale (pre-cache)
  // markup, e.g. two rapid re-renders of the same message.
  const cachedUrl = getCachedImageUrl(key);
  if (cachedUrl) {
    if (!el.querySelector('img')) {
      el.innerHTML = `<img src="${cachedUrl}" alt="attachment" class="loaded" data-blob-url="${cachedUrl}">`;
    }
    el.dataset.blobUrl = cachedUrl;
    return;
  }

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

      const objectURL = URL.createObjectURL(blob);
      // Cache regardless of whether `el` is still on screen — the
      // user may have already switched away from this conversation
      // by the time the fetch resolves, but the blob is just as
      // valid the next time this message is rendered.
      cacheImageUrl(key, objectURL);

      // If the element was removed (or replaced) while fetching,
      // there is nothing left to update on screen right now.
      const liveEl = document.getElementById(key);
      if (!liveEl || !document.body.contains(liveEl)) {
        return;
      }

      // Build image element safely
      liveEl.innerHTML = '';
      liveEl.dataset.blobUrl = objectURL;

      const img = document.createElement('img');
      img.src = objectURL;
      img.alt = 'attachment';
      img.dataset.blobUrl = objectURL;

      img.onerror = () => {
        imageBlobCache.delete(key);
        URL.revokeObjectURL(objectURL);
        delete liveEl.dataset.blobUrl;
        liveEl.innerHTML =
          '<div class="text-muted">Image broken</div>';
      };

      // Fade in once actually decoded/painted, rather than the
      // instant the network request resolves — smoother reveal, and
      // avoids a flash for images that decode near-instantly anyway.
      if (img.decode) {
        img.decode().then(() => img.classList.add('loaded')).catch(() => img.classList.add('loaded'));
      } else {
        img.onload = () => img.classList.add('loaded');
      }

      liveEl.appendChild(img);

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
 * Cancels any in-flight image fetches for a container that's about
 * to be torn down (e.g. switching conversations, or a background
 * refresh replacing the message list). Deliberately does NOT revoke
 * already-loaded blob URLs: those stay in the persistent
 * imageBlobCache (see above) so switching back to this same
 * conversation later can render its images instantly, with no
 * re-fetch. Use revokeAttachmentImage() instead when a specific
 * image attachment is genuinely gone for good (its message deleted).
 *
 * @param {HTMLElement} container - the message list element being discarded
 * @param {'chat'|'dm'} scope - determines the attachment prefix
 */
export function cleanupImageUrls(container, scope) {
  if (!container) return;

  const prefix = scope === 'dm' ? 'dm-att' : 'att';

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
}

/**
 * Revokes and forgets a single attachment's cached blob URL. Call
 * this when the underlying message has actually been deleted (not on
 * ordinary navigation — see cleanupImageUrls above), so the browser
 * can reclaim the memory instead of it sitting in imageBlobCache
 * forever pointing at content nobody can view anymore.
 *
 * @param {number|string} id - the message id
 * @param {'chat'|'dm'} scope
 */
export function revokeAttachmentImage(id, scope) {
  const prefix = scope === 'dm' ? 'dm-att' : 'att';
  const key = `${prefix}-${id}`;

  const entry = pendingLoads.get(key);
  if (entry) {
    entry.controller.abort();
    pendingLoads.delete(key);
  }

  const url = imageBlobCache.get(key);
  if (url) {
    imageBlobCache.delete(key);
    URL.revokeObjectURL(url);
  }
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

