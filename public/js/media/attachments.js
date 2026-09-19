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


/* =========================================================
 * SHARED DOWNLOAD PROGRESS UI
 * ========================================================= */

const downloadProgressState = {
  activeDownloads: new Map(),
  element: null,
  track: null,
  fill: null,
  info: null
};

function ensureDownloadProgressUI() {
  if (
    downloadProgressState.element &&
    document.body.contains(
      downloadProgressState.element
    )
  ) {
    return;
  }

  const container =
    document.createElement('div');

  container.id =
    'wire-download-progress';

  container.style.cssText = `
    position:fixed;
    top:0;
    left:0;
    right:0;
    z-index:2147483647;
    pointer-events:none;
    font-family:inherit;
  `;

  const track =
    document.createElement('div');

  track.style.cssText = `
    width:100%;
    height:3px;
    background:rgba(255,255,255,.10);
    overflow:hidden;
  `;

  const fill =
    document.createElement('div');

  fill.style.cssText = `
    width:0%;
    height:100%;
    background:var(--accent,#4da6ff);
    transition:width:.15s ease;
    transform-origin:left center;
  `;

  track.appendChild(
    fill
  );

  const info =
    document.createElement('div');

  info.style.cssText = `
    position:absolute;
    top:7px;
    left:50%;
    transform:translateX(-50%);
    max-width:calc(100vw - 24px);
    padding:4px 10px;
    border-radius:999px;
    background:rgba(15,15,20,.88);
    color:rgba(255,255,255,.92);
    border:1px solid rgba(255,255,255,.10);
    box-shadow:0 4px 16px rgba(0,0,0,.22);
    font-size:11px;
    line-height:1.2;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    opacity:0;
    transition:opacity:.15s ease;
  `;

  container.appendChild(
    track
  );

  container.appendChild(
    info
  );

  document.body.appendChild(
    container
  );

  downloadProgressState.element =
    container;

  downloadProgressState.track =
    track;

  downloadProgressState.fill =
    fill;

  downloadProgressState.info =
    info;
}

function formatDownloadSpeed(
  bytesPerSecond
) {
  if (
    !Number.isFinite(
      bytesPerSecond
    ) ||
    bytesPerSecond <= 0
  ) {
    return '';
  }

  return `${formatBytes(
    bytesPerSecond
  )}/s`;
}

function updateDownloadProgressUI() {
  ensureDownloadProgressUI();

  const {
    activeDownloads,
    fill,
    info
  } = downloadProgressState;

  const count =
    activeDownloads.size;

  if (
    count === 0
  ) {
    fill.style.width =
      '0%';

    fill.style.animation =
      'none';

    info.style.opacity =
      '0';

    return;
  }

  info.style.opacity =
    '1';

  /*
   * One active download:
   *
   * We can safely show its real percentage.
   */
  if (
    count === 1
  ) {
    const item =
      activeDownloads
        .values()
        .next()
        .value;

    const bytes =
      Number(item.bytes) ||
      0;

    const total =
      Number(item.total) ||
      0;

    const speed =
      formatDownloadSpeed(
        item.speed
      );

    if (
      total > 0 &&
      bytes >= 0
    ) {
      const percent =
        Math.min(
          100,
          Math.max(
            0,
            (bytes / total) * 100
          )
        );

      fill.style.animation =
        'none';

      fill.style.width =
        `${percent}%`;

      const percentText =
        `${Math.round(
          percent
        )}%`;

      const name =
        item.name ||
        'Downloading';

      info.textContent =
        speed
          ? `${name} · ${percentText} · ${speed}`
          : `${name} · ${percentText}`;

    } else {
      /*
       * Server didn't provide Content-Length.
       * Don't invent a percentage.
       */
      fill.style.width =
        '35%';

      fill.style.animation =
        'wire-download-progress-indeterminate 1.1s ease-in-out infinite';

      const speedText =
        speed
          ? ` · ${speed}`
          : '';

      info.textContent =
        `${item.name || 'Downloading'}${speedText}`;
    }

    return;
  }

  /*
   * Multiple simultaneous downloads.
   *
   * FileTransfer progress events don't expose a reliable transfer ID,
   * so combining byte counters from different transfers can produce
   * nonsense. Use an indeterminate bar instead.
   */
  fill.style.width =
    '35%';

  fill.style.animation =
    'wire-download-progress-indeterminate 1.1s ease-in-out infinite';

  let bestSpeed =
    0;

  for (
    const item
    of activeDownloads.values()
  ) {
    if (
      Number.isFinite(
        item.speed
      ) &&
      item.speed > bestSpeed
    ) {
      bestSpeed =
        item.speed;
    }
  }

  const speedText =
    formatDownloadSpeed(
      bestSpeed
    );

  info.textContent =
    `${count} downloads${
      speedText
        ? ` · ${speedText}`
        : ''
    }`;
}

function ensureDownloadProgressStyle() {
  if (
    document.getElementById(
      'wire-download-progress-style'
    )
  ) {
    return;
  }

  const style =
    document.createElement('style');

  style.id =
    'wire-download-progress-style';

  style.textContent = `
    @keyframes wire-download-progress-indeterminate {
      0% {
        transform:translateX(-100%);
      }

      50% {
        transform:translateX(80%);
      }

      100% {
        transform:translateX(280%);
      }
    }
  `;

  document.head.appendChild(
    style
  );
}

function startDownloadProgress(
  id,
  name
) {
  ensureDownloadProgressStyle();
  ensureDownloadProgressUI();

  downloadProgressState.activeDownloads.set(
    id,
    {
      id,
      name:
        name ||
        'Downloading',
      bytes:
        0,
      total:
        0,
      speed:
        0,
      lastBytes:
        0,
      lastTime:
        Date.now()
    }
  );

  updateDownloadProgressUI();
}

function updateDownloadProgress(
  id,
  progress
) {
  const item =
    downloadProgressState
      .activeDownloads
      .get(id);

  if (
    !item ||
    !progress
  ) {
    return;
  }

  const bytes =
    Number(
      progress.bytes
    );

  const total =
    Number(
      progress.contentLength
    );

  const now =
    Date.now();

  if (
    Number.isFinite(bytes) &&
    bytes >= 0
  ) {
    item.bytes =
      bytes;
  }

  if (
    Number.isFinite(total) &&
    total > 0
  ) {
    item.total =
      total;
  }

  /*
   * Speed is calculated per transfer.
   *
   * We intentionally don't merge byte counters from multiple
   * transfers because FileTransfer progress events don't identify
   * which transfer generated an event.
   */
  if (
    Number.isFinite(bytes) &&
    bytes >= item.lastBytes &&
    now > item.lastTime
  ) {
    const deltaBytes =
      bytes -
      item.lastBytes;

    const deltaTime =
      now -
      item.lastTime;

    if (
      deltaTime >= 150
    ) {
      const instantSpeed =
        deltaBytes /
        (deltaTime / 1000);

      /*
       * Light smoothing so the number doesn't jump around wildly.
       */
      if (
        item.speed > 0
      ) {
        item.speed =
          item.speed * 0.65 +
          instantSpeed * 0.35;
      } else {
        item.speed =
          instantSpeed;
      }

      item.lastBytes =
        bytes;

      item.lastTime =
        now;
    }
  }

  updateDownloadProgressUI();
}

function finishDownloadProgress(
  id
) {
  downloadProgressState
    .activeDownloads
    .delete(id);

  updateDownloadProgressUI();
}

function failDownloadProgress(
  id
) {
  downloadProgressState
    .activeDownloads
    .delete(id);

  updateDownloadProgressUI();
}

/*
 * Expose the same manager globally so Files/Drive can use exactly
 * the same bar instead of creating a second independent progress UI.
 */
window.__wireDownloadProgress = {
  start:
    startDownloadProgress,

  progress:
    updateDownloadProgress,

  finish:
    finishDownloadProgress,

  fail:
    failDownloadProgress
};


/* =========================================================
 * IMAGE CACHE
 * ========================================================= */

function cacheImageUrl(
  key,
  url
) {
  imageBlobCache.set(
    key,
    url
  );

  // Cheap LRU-ish cap: once we're over budget, drop the
  // longest-untouched entry.
  while (
    imageBlobCache.size >
    MAX_CACHED_IMAGES
  ) {
    const oldestKey =
      imageBlobCache
        .keys()
        .next()
        .value;

    const oldestUrl =
      imageBlobCache.get(
        oldestKey
      );

    imageBlobCache.delete(
      oldestKey
    );

    if (oldestUrl) {
      URL.revokeObjectURL(
        oldestUrl
      );
    }
  }
}

function getCachedImageUrl(
  key
) {
  const url =
    imageBlobCache.get(
      key
    );

  if (
    url === undefined
  ) {
    return undefined;
  }

  // Refresh recency.
  imageBlobCache.delete(
    key
  );

  imageBlobCache.set(
    key,
    url
  );

  return url;
}

/**
 * CSS `aspect-ratio` value for an image attachment placeholder.
 */
function imageAspectRatio(
  msg
) {
  const w =
    Number(
      msg.attachment_width
    );

  const h =
    Number(
      msg.attachment_height
    );

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
function attachmentMediaKind(
  msg
) {
  // Voice messages are audio attachments too.
  if (
    isVoiceMessage(msg)
  ) {
    return 'voice';
  }

  const isAudioAttachment =
    isAudio(
      msg.attachment_mime
    ) ||
    isAudio(
      msg.attachment_name
    );

  if (
    isAudioAttachment
  ) {
    return 'audio';
  }

  const isVideoAttachment =
    isVideo(
      msg.attachment_mime
    ) ||
    [
      'mp4',
      'webm',
      'mov',
      'mkv',
      'mjpeg'
    ].includes(
      (
        msg.attachment_name ||
        ''
      )
        .split('.')
        .pop()
        .toLowerCase()
    );

  if (
    isVideoAttachment
  ) {
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
    attachmentMediaKind(
      msg
    );

  let renderPromise;

  if (
    kind === 'voice'
  ) {
    renderPromise =
      renderVoiceMessage(
        msg,
        scope,
        messageEl
      );

  } else if (
    kind === 'audio'
  ) {
    renderPromise =
      renderAudio(
        msg,
        scope,
        messageEl
      );

  } else if (
    kind === 'video'
  ) {
    renderPromise =
      renderVideo(
        msg,
        scope,
        messageEl
      );
  }

  if (
    renderPromise &&
    typeof renderPromise.catch ===
      'function'
  ) {
    renderPromise.catch(
      err => {
        console.error(
          `Failed to render ${kind} attachment for message ${msg.id}:`,
          err
        );
      }
    );
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

  if (
    !isImage
  ) {
    return '';
  }

  return `
    <button
      type="button"
      class="chat-msg-download"
      title="Download ${escapeAttr(
        msg.attachment_name
      )}"
      onclick="window.downloadAttachment(${msg.id}, '${escapeAttr(
        msg.attachment_name
      )}', '${scope}')"
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
    attachmentMediaKind(
      msg
    );

  // Audio/video attachments are handled by their players.
  if (
    mediaKind
  ) {
    return '';
  }

  // Image attachment.
  if (
    isImage
  ) {
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
      imageAspectRatio(
        msg
      );

    const cachedUrl =
      getCachedImageUrl(
        key
      );

    const innerHtml =
      cachedUrl
        ? `
        <img
          src="${escapeAttr(
            cachedUrl
          )}"
          alt="attachment"
          class="loaded"
          data-blob-url="${escapeAttr(
            cachedUrl
          )}"
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
        data-filename="${escapeAttr(
          msg.attachment_name
        )}"
        data-username="${escapeAttr(
          username
        )}"
        data-user-id="${escapeAttr(
          userId
        )}"
        ${
          cachedUrl
            ? `data-blob-url="${escapeAttr(
                cachedUrl
              )}"`
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
    onclick="window.downloadAttachment(${msg.id}, '${escapeAttr(
      msg.attachment_name
    )}', '${scope}')"
  >
    ${ICONS.file}

    <div class="chat-attachment-info">
      <div class="chat-attachment-name">
        ${escapeHtml(
          msg.attachment_name
        )}
      </div>

      <div class="chat-attachment-size">
        ${formatBytes(
          msg.attachment_size
        )}
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
    document.getElementById(
      key
    );

  if (!el) {
    return;
  }

  // Already loaded and cached.
  const cachedUrl =
    getCachedImageUrl(
      key
    );

  if (
    cachedUrl
  ) {
    if (
      !el.querySelector(
        'img'
      )
    ) {
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
  if (
    pendingLoads.has(
      key
    )
  ) {
    return pendingLoads.get(
      key
    ).promise;
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
          URL.createObjectURL(
            blob
          );

        // Cache regardless of whether the element is still visible.
        cacheImageUrl(
          key,
          objectURL
        );

        const liveEl =
          document.getElementById(
            key
          );

        if (
          !liveEl ||
          !document.body.contains(
            liveEl
          )
        ) {
          return;
        }

        liveEl.innerHTML =
          '';

        liveEl.dataset.blobUrl =
          objectURL;

        const img =
          document.createElement(
            'img'
          );

        img.src =
          objectURL;

        img.alt =
          'attachment';

        img.dataset.blobUrl =
          objectURL;

        img.onerror =
          () => {
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

        if (
          img.decode
        ) {
          img.decode()
            .then(
              () => {
                img.classList.add(
                  'loaded'
                );
              }
            )
            .catch(
              () => {
                img.classList.add(
                  'loaded'
                );
              }
            );
        } else {
          img.onload =
            () => {
              img.classList.add(
                'loaded'
              );
            };
        }

        liveEl.appendChild(
          img
        );

      } catch (e) {
        if (
          e.name ===
          'AbortError'
        ) {
          return;
        }

        console.error(
          `Failed to load image attachment ${id}:`,
          e
        );

        if (
          document.body.contains(
            el
          )
        ) {
          el.innerHTML =
            '<div class="text-muted">Failed to load image</div>';
        }

      } finally {
        if (
          pendingLoads.get(
            key
          )?.promise ===
          loadPromise
        ) {
          pendingLoads.delete(
            key
          );
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
  if (
    !container
  ) {
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
    .forEach(
      el => {
        const id =
          el.id
            .split('-')
            .pop();

        const key =
          `${prefix}-${id}`;

        const entry =
          pendingLoads.get(
            key
          );

        if (
          entry
        ) {
          entry.controller.abort();
          pendingLoads.delete(
            key
          );
        }
      }
    );
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
    pendingLoads.get(
      key
    );

  if (
    entry
  ) {
    entry.controller.abort();

    pendingLoads.delete(
      key
    );
  }

  const url =
    imageBlobCache.get(
      key
    );

  if (
    url
  ) {
    imageBlobCache.delete(
      key
    );

    URL.revokeObjectURL(
      url
    );
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
 */
function sanitizeFilename(
  name
) {
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

  return cleaned ||
    'download';
}

/**
 * Handle an authentication failure coming from native FileTransfer.
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

  if (
    status !== 401
  ) {
    return false;
  }

  if (
    typeof logout ===
    'function'
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
 */
async function downloadAttachmentNative(
  id,
  name,
  scope,
  downloadId
) {
  const token =
    getToken();

  if (!token) {
    throw new Error(
      'Authentication required'
    );
  }

  const safeName =
    sanitizeFilename(
      name
    );

  const url =
    scope === 'dm'
      ? `/api/dm/attachments/${id}?download=1`
      : `/api/chat/attachments/${id}?download=1`;

  const resolvedUrl =
    resolveServerUrl(
      url
    );

  console.log(
    '[Download] Native download:',
    {
      id,
      scope,
      name:
        safeName,
      url:
        resolvedUrl,
      downloadId
    }
  );

  const destinationUri =
    `file:///storage/emulated/0/Download/${safeName}`;

  console.log(
    '[Download] Native destination:',
    destinationUri
  );

  let progressListener =
    null;

  try {
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
                progress.contentLength,

              downloadId
            }
          );

          updateDownloadProgress(
            downloadId,
            progress
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

    if (
      status
    ) {
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
    if (
      progressListener
    ) {
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
 * The browser fetch path currently doesn't expose streaming progress
 * through fetchBlob(), so no native progress events are emitted here.
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
    await fetchBlob(
      url
    );

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
    URL.createObjectURL(
      blob
    );

  try {
    const a =
      document.createElement(
        'a'
      );

    a.href =
      objectURL;

    a.download =
      name ||
      'download';

    document.body.appendChild(
      a
    );

    a.click();

    a.remove();

  } finally {
    setTimeout(
      () => {
        URL.revokeObjectURL(
          objectURL
        );
      },
      1000
    );
  }
}


/**
 * Downloads an attachment.
 */
export async function downloadAttachment(
  id,
  name,
  scope
) {
  const filename =
    sanitizeFilename(
      name
    );

  /*
   * Unique ID per transfer.
   *
   * This is critical when several downloads start at once.
   */
  const downloadId =
    `attachment-${scope}-${id}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

  startDownloadProgress(
    downloadId,
    filename
  );

  try {
    console.log(
      '[Download] Requested:',
      {
        id,
        name:
          filename,
        scope,
        native:
          isNativeCapacitor(),
        downloadId
      }
    );

    if (
      isNativeCapacitor()
    ) {
      await downloadAttachmentNative(
        id,
        filename,
        scope,
        downloadId
      );

      finishDownloadProgress(
        downloadId
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

    finishDownloadProgress(
      downloadId
    );

  } catch (e) {
    console.error(
      '[Download] Failed:',
      e
    );

    failDownloadProgress(
      downloadId
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
