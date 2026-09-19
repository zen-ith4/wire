import { fetchBlob } from '../core/api.js';
import { getToken, logout } from '../core/auth.js';
import { resolveServerUrl } from '../core/server.js';

import {
  Capacitor,
  FileTransfer
} from '../vendor/capacitor.js';

import { ICONS } from '../icons.js';
import {
  showToast,
  escapeAttr,
  escapeHtml,
  formatBytes
} from '../core/utils.js';

import { isAudio, renderAudio } from './audio-player.js';
import { isVideo, renderVideo } from './video-player.js';
import {
  isVoiceMessage,
  renderVoiceMessage
} from './voice-message.js';

// Track pending loads: key = `${prefix}-${id}`, value = { promise, controller }
const pendingLoads = new Map();

// Loaded image attachments, keyed by the same `${prefix}-${id}` used
// everywhere else in this file.
const imageBlobCache = new Map();
const MAX_CACHED_IMAGES = 80;

function cacheImageUrl(key, url) {
  imageBlobCache.set(key, url);

  // Cheap LRU-ish cap: once we're over budget, drop the
  // longest-untouched entry.
  while (imageBlobCache.size > MAX_CACHED_IMAGES) {
    const oldestKey =
      imageBlobCache.keys().next().value;

    const oldestUrl =
      imageBlobCache.get(oldestKey);

    imageBlobCache.delete(oldestKey);

    if (oldestUrl) {
      URL.revokeObjectURL(oldestUrl);
    }
  }
}

function getCachedImageUrl(key) {
  const url =
    imageBlobCache.get(key);

  if (url === undefined) {
    return undefined;
  }

  // Refresh recency.
  imageBlobCache.delete(key);
  imageBlobCache.set(key, url);

  return url;
}

/**
 * CSS `aspect-ratio` value for an image attachment placeholder.
 */
function imageAspectRatio(msg) {
  const w =
    Number(msg.attachment_width);

  const h =
    Number(msg.attachment_height);

  if (
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0
  ) {
    return `${w} / ${h}`;
  }

  return '4 / 3';
}

/**
 * Detect which media player, if any, a message's attachment needs.
 */
function attachmentMediaKind(msg) {
  // Voice messages are audio attachments too.
  if (isVoiceMessage(msg)) {
    return 'voice';
  }

  const isAudioAttachment =
    isAudio(msg.attachment_mime) ||
    isAudio(msg.attachment_name);

  if (isAudioAttachment) {
    return 'audio';
  }

  const isVideoAttachment =
    isVideo(msg.attachment_mime) ||
    [
      'mp4',
      'webm',
      'mov',
      'mkv',
      'mjpeg'
    ].includes(
      (msg.attachment_name || '')
        .split('.')
        .pop()
        .toLowerCase()
    );

  if (isVideoAttachment) {
    return 'video';
  }

  return null;
}

/**
 * Initializes the audio/video player for a message attachment.
 */
export function mountAttachmentMedia(
  msg,
  messageEl,
  scope
) {
  if (
    !messageEl ||
    !msg.has_attachment
  ) {
    return;
  }

  const kind =
    attachmentMediaKind(msg);

  let renderPromise;

  if (kind === 'voice') {
    renderPromise =
      renderVoiceMessage(
        msg,
        scope,
        messageEl
      );
  } else if (kind === 'audio') {
    renderPromise =
      renderAudio(
        msg,
        scope,
        messageEl
      );
  } else if (kind === 'video') {
    renderPromise =
      renderVideo(
        msg,
        scope,
        messageEl
      );
  }

  if (
    renderPromise &&
    typeof renderPromise.catch === 'function'
  ) {
    renderPromise.catch((err) => {
      console.error(
        `Failed to render ${kind} attachment for message ${msg.id}:`,
        err
      );
    });
  }
}

/**
 * Small icon-only download button for image attachments.
 */
export function imageDownloadButtonHtml(
  msg,
  scope
) {
  const isImage =
    msg.has_attachment &&
    msg.attachment_mime &&
    msg.attachment_mime.startsWith(
      'image/'
    );

  if (!isImage) {
    return '';
  }

  return `
    <button
      type="button"
      class="chat-msg-download"
      title="Download ${escapeAttr(msg.attachment_name)}"
      onclick="window.downloadAttachment(${msg.id}, '${escapeAttr(msg.attachment_name)}', '${scope}')"
    >${ICONS.download}</button>`;
}

export function renderAttachment(
  msg,
  scope
) {
  const isImage =
    msg.attachment_mime &&
    msg.attachment_mime.startsWith(
      'image/'
    );

  const prefix =
    scope === 'dm'
      ? 'dm-att'
      : 'att';

  const mediaKind =
    attachmentMediaKind(msg);

  // Audio/video attachments are handled by their players.
  if (mediaKind) {
    return '';
  }

  // Image attachment.
  if (isImage) {
    const username =
      msg.username ||
      msg.sender_username ||
      '';

    const userId =
      msg.user_id ??
      msg.sender_id ??
      '';

    const key =
      `${prefix}-${msg.id}`;

    const ratio =
      imageAspectRatio(msg);

    const cachedUrl =
      getCachedImageUrl(key);

    const innerHtml =
      cachedUrl
        ? `
        <img
          src="${escapeAttr(cachedUrl)}"
          alt="attachment"
          class="loaded"
          data-blob-url="${escapeAttr(cachedUrl)}"
        >
      `
        : `
        <div class="loading-state">
          <div class="spin"></div>
        </div>
      `;

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
        ${
          cachedUrl
            ? `data-blob-url="${escapeAttr(cachedUrl)}"`
            : ''
        }
        onclick="window.openImageViewer(this)"
      >${innerHtml}</div>
    </div>`;
  }

  // Generic file attachment.
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

export async function loadChatImage(
  id,
  scope
) {
  const prefix =
    scope === 'dm'
      ? 'dm-att'
      : 'att';

  const key =
    `${prefix}-${id}`;

  const el =
    document.getElementById(key);

  if (!el) {
    return;
  }

  // Already loaded and cached.
  const cachedUrl =
    getCachedImageUrl(key);

  if (cachedUrl) {
    if (!el.querySelector('img')) {
      el.innerHTML = `
        <img
          src="${cachedUrl}"
          alt="attachment"
          class="loaded"
          data-blob-url="${cachedUrl}"
        >
      `;
    }

    el.dataset.blobUrl =
      cachedUrl;

    return;
  }

  // Existing in-flight request.
  if (pendingLoads.has(key)) {
    return pendingLoads.get(key).promise;
  }

  const controller =
    new AbortController();

  const loadPromise =
    (async () => {
      try {
        const url =
          scope === 'dm'
            ? `/api/dm/attachments/${id}`
            : `/api/chat/attachments/${id}`;

        const blob =
          await fetchBlob(
            url,
            {
              signal:
                controller.signal
            }
          );

        const objectURL =
          URL.createObjectURL(blob);

        // Cache regardless of whether the element is still visible.
        cacheImageUrl(
          key,
          objectURL
        );

        const liveEl =
          document.getElementById(key);

        if (
          !liveEl ||
          !document.body.contains(
            liveEl
          )
        ) {
          return;
        }

        liveEl.innerHTML = '';

        liveEl.dataset.blobUrl =
          objectURL;

        const img =
          document.createElement('img');

        img.src =
          objectURL;

        img.alt =
          'attachment';

        img.dataset.blobUrl =
          objectURL;

        img.onerror = () => {
          imageBlobCache.delete(
            key
          );

          URL.revokeObjectURL(
            objectURL
          );

          delete liveEl.dataset.blobUrl;

          liveEl.innerHTML =
            '<div class="text-muted">Image broken</div>';
        };

        if (img.decode) {
          img.decode()
            .then(() => {
              img.classList.add(
                'loaded'
              );
            })
            .catch(() => {
              img.classList.add(
                'loaded'
              );
            });
        } else {
          img.onload = () => {
            img.classList.add(
              'loaded'
            );
          };
        }

        liveEl.appendChild(img);

      } catch (e) {
        if (
          e.name === 'AbortError'
        ) {
          return;
        }

        console.error(
          `Failed to load image attachment ${id}:`,
          e
        );

        if (
          document.body.contains(el)
        ) {
          el.innerHTML =
            '<div class="text-muted">Failed to load image</div>';
        }

      } finally {
        if (
          pendingLoads.get(key)
            ?.promise === loadPromise
        ) {
          pendingLoads.delete(key);
        }
      }
    })();

  pendingLoads.set(
    key,
    {
      promise:
        loadPromise,
      controller
    }
  );

  return loadPromise;
}

/**
 * Cancels in-flight image fetches for a container being removed.
 */
export function cleanupImageUrls(
  container,
  scope
) {
  if (!container) {
    return;
  }

  const prefix =
    scope === 'dm'
      ? 'dm-att'
      : 'att';

  container
    .querySelectorAll(
      '.chat-attachment-image'
    )
    .forEach(el => {
      const id =
        el.id.split('-').pop();

      const key =
        `${prefix}-${id}`;

      const entry =
        pendingLoads.get(key);

      if (entry) {
        entry.controller.abort();
        pendingLoads.delete(key);
      }
    });
}

/**
 * Revokes and forgets a single cached attachment image.
 */
export function revokeAttachmentImage(
  id,
  scope
) {
  const prefix =
    scope === 'dm'
      ? 'dm-att'
      : 'att';

  const key =
    `${prefix}-${id}`;

  const entry =
    pendingLoads.get(key);

  if (entry) {
    entry.controller.abort();
    pendingLoads.delete(key);
  }

  const url =
    imageBlobCache.get(key);

  if (url) {
    imageBlobCache.delete(key);
    URL.revokeObjectURL(url);
  }
}

/**
 * Cancel all pending attachment loads.
 */
export function cancelAllAttachmentLoads() {
  for (
    const { controller }
    of pendingLoads.values()
  ) {
    controller.abort();
  }

  pendingLoads.clear();
}

/* =========================================================
 * DOWNLOAD HELPERS
 * ========================================================= */

/**
 * Returns true when running inside a native Capacitor platform.
 *
 * Web/PWA keeps using the normal browser download path.
 */
function isNativeCapacitor() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Make a filename safe for filesystem paths.
 *
 * This deliberately keeps the extension and normal characters,
 * while removing characters that are problematic in Android paths.
 */
function sanitizeFilename(name) {
  const original =
    typeof name === 'string'
      ? name.trim()
      : '';

  const cleaned =
    original
      .replace(
        /[\/\\?%*:|"<>]/g,
        '_'
      )
      .replace(
        /[\u0000-\u001F\u007F]/g,
        '_'
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();

  return cleaned || 'download';
}

/**
 * Handle an authentication failure coming from native FileTransfer.
 *
 * fetchBlob() already handles this for normal web fetches, so native
 * downloads need to mirror that behavior because FileTransfer does
 * not pass through fetchBlob().
 */
function handleNativeDownloadAuthError(
  error
) {
  const status =
    Number(
      error?.data?.httpStatus ??
      error?.httpStatus ??
      0
    );

  if (status !== 401) {
    return false;
  }

  if (
    typeof logout === 'function'
  ) {
    try {
      logout();
    } catch (logoutError) {
      console.error(
        '[Download] Logout failed:',
        logoutError
      );
    }
  }

  return true;
}

/**
 * Download using Capacitor native FileTransfer.
 *
 * Authentication:
 *   Authorization: Bearer <Wire token>
 *
 * Storage:
 *   Android public Downloads folder
 *
 * Android 10:
 *   Directly targets:
 *
 *   /storage/emulated/0/Download/
 *
 * This works with the Android 10 legacy external-storage mode
 * already configured in AndroidManifest.xml.
 */
async function downloadAttachmentNative(
  id,
  name,
  scope
) {
  const token =
    getToken();

  if (!token) {
    throw new Error(
      'Authentication required'
    );
  }

  const safeName =
    sanitizeFilename(name);

  const url =
    scope === 'dm'
      ? `/api/dm/attachments/${id}?download=1`
      : `/api/chat/attachments/${id}?download=1`;

  const resolvedUrl =
    resolveServerUrl(url);

  console.log(
    '[Download] Native download:',
    {
      id,
      scope,
      name: safeName,
      url: resolvedUrl
    }
  );

  /*
   * Public Android Downloads directory.
   *
   * IMPORTANT:
   *
   * This is:
   *
   *   /storage/emulated/0/Download/
   *
   * NOT:
   *
   *   /storage/emulated/0/Documents/
   */
  const destinationUri =
    `file:///storage/emulated/0/Download/${safeName}`;

  console.log(
    '[Download] Native destination:',
    destinationUri
  );

  let progressListener =
    null;

  try {
    /*
     * Progress is useful for large attachments and also gives us
     * proof in logcat that the native transfer is actually moving.
     */
    progressListener =
      await FileTransfer.addListener(
        'progress',
        progress => {
          if (!progress) {
            return;
          }

          console.log(
            '[Download] Progress:',
            {
              bytes:
                progress.bytes,

              contentLength:
                progress.contentLength
            }
          );
        }
      );

    console.log(
      '[Download] Starting native transfer...'
    );

    const result =
      await FileTransfer.downloadFile({
        url:
          resolvedUrl,

        path:
          destinationUri,

        headers: {
          Authorization:
            `Bearer ${token}`
        },

        progress:
          true,

        /*
         * One minute to establish the connection and one minute
         * between received chunks.
         */
        connectTimeout:
          60_000,

        readTimeout:
          60_000
      });

    console.log(
      '[Download] Native transfer complete:',
      result
    );

    return {
      ...result,

      uri:
        destinationUri,

      filename:
        safeName
    };

  } catch (error) {
    console.error(
      '[Download] Native transfer failed:',
      error
    );

    /*
     * FileTransfer does not pass through fetchBlob(), so authentication
     * errors have to be handled here.
     */
    if (
      handleNativeDownloadAuthError(
        error
      )
    ) {
      throw new Error(
        'Session expired'
      );
    }

    const status =
      error?.data?.httpStatus ??
      error?.httpStatus;

    const serverBody =
      error?.data?.body;

    if (status) {
      throw new Error(
        `Download failed (${status})${
          serverBody
            ? `: ${serverBody}`
            : ''
        }`
      );
    }

    throw error;

  } finally {
    if (progressListener) {
      try {
        await progressListener.remove();
      } catch (error) {
        console.warn(
          '[Download] Failed to remove progress listener:',
          error
        );
      }
    }
  }
}

/**
 * Browser/PWA download fallback.
 *
 * This is intentionally kept separate from the Capacitor native path.
 */
async function downloadAttachmentWeb(
  id,
  name,
  scope
) {
  const url =
    scope === 'dm'
      ? `/api/dm/attachments/${id}?download=1`
      : `/api/chat/attachments/${id}?download=1`;

  console.log(
    '[Download] Web download:',
    {
      id,
      scope,
      name,
      url
    }
  );

  const blob =
    await fetchBlob(url);

  console.log(
    '[Download] Blob received:',
    {
      size:
        blob.size,

      type:
        blob.type
    }
  );

  const objectURL =
    URL.createObjectURL(blob);

  try {
    const a =
      document.createElement('a');

    a.href =
      objectURL;

    a.download =
      name ||
      'download';

    document.body.appendChild(a);

    a.click();

    a.remove();

  } finally {
    /*
     * Give the browser a little time to consume the object URL before
     * revoking it. Immediate revocation is unreliable in some browsers.
     */
    setTimeout(() => {
      URL.revokeObjectURL(
        objectURL
      );
    }, 1000);
  }
}

/**
 * Downloads an attachment.
 *
 * Native Capacitor:
 *   FileTransfer + Authorization Bearer
 *   -> /storage/emulated/0/Download/
 *
 * Browser:
 *   fetchBlob() + Blob URL + <a download>
 */
export async function downloadAttachment(
  id,
  name,
  scope
) {
  const filename =
    sanitizeFilename(name);

  try {
    console.log(
      '[Download] Requested:',
      {
        id,
        name:
          filename,
        scope,
        native:
          isNativeCapacitor()
      }
    );

    if (
      isNativeCapacitor()
    ) {
      await downloadAttachmentNative(
        id,
        filename,
        scope
      );

      showToast(
        `Downloaded: ${filename}`,
        'success'
      );

      return;
    }

    await downloadAttachmentWeb(
      id,
      filename,
      scope
    );

  } catch (e) {
    console.error(
      '[Download] Failed:',
      e
    );

    showToast(
      'Download failed: ' +
        (
          e?.message ||
          'Unknown error'
        ),
      'error'
    );
  }
}

// Expose for inline onclick.
window.downloadAttachment =
  downloadAttachment;
