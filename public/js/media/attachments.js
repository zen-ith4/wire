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

// Native modal <dialog>s (My Files viewer/share dialogs) render in the
// top layer, above any z-index, so the progress bar has to live inside
// the topmost open one while it is showing. Moves the existing element
// (appendChild re-parents) and falls back to <body>.
function hostDownloadProgressUI() {
  const el = downloadProgressState.element;

  if (!el) {
    return;
  }

  const dialogs = document.querySelectorAll('dialog[open]');
  const host = dialogs.length ? dialogs[dialogs.length - 1] : document.body;

  if (el.parentNode !== host) {
    host.appendChild(el);
  }
}

function ensureDownloadProgressUI() {
  if (
    downloadProgressState.element &&
    document.body.contains(
      downloadProgressState.element
    )
  ) {
    hostDownloadProgressUI();
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

function updateDownloadSpeed(
  item,
  bytes
) {
  if (
    !Number.isFinite(bytes) ||
    bytes < 0
  ) {
    return;
  }

  const now =
    performance.now();

  if (
    !Number.isFinite(
      item.lastBytes
    )
  ) {
    item.lastBytes =
      bytes;

    item.lastTime =
      now;

    return;
  }

  const deltaBytes =
    bytes -
    item.lastBytes;

  const deltaTime =
    now -
    item.lastTime;

  if (
    deltaBytes < 0
  ) {
    item.lastBytes =
      bytes;

    item.lastTime =
      now;

    item.speed =
      0;

    return;
  }

  /*
   * Don't calculate speed from tiny intervals.
   * Otherwise the displayed value jumps around like a caffeinated squirrel.
   */
  if (
    deltaTime < 200
  ) {
    return;
  }

  const instantSpeed =
    deltaBytes /
    (deltaTime / 1000);

  if (
    Number.isFinite(
      instantSpeed
    ) &&
    instantSpeed >= 0
  ) {
    if (
      item.speed > 0
    ) {
      item.speed =
        item.speed * 0.70 +
        instantSpeed * 0.30;

    } else {
      item.speed =
        instantSpeed;
    }
  }

  item.lastBytes =
    bytes;

  item.lastTime =
    now;
}

function updateDownloadProgressUI() {
  ensureDownloadProgressStyle();
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

    info.textContent =
      '';

    return;
  }

  info.style.opacity =
    '1';

  /*
   * One active download:
   * show exact percentage whenever Content-Length is known.
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

    const speedText =
      formatDownloadSpeed(
        item.speed
      );

    const name =
      item.name ||
      'Downloading';

    if (
      total > 0
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

      info.textContent =
        speedText
          ? `${name} · ${percentText} · ${speedText}`
          : `${name} · ${percentText}`;

      return;
    }

    /*
     * No Content-Length.
     * We know speed but cannot honestly calculate percentage.
     */
    fill.style.width =
      '35%';

    fill.style.animation =
      'wire-download-progress-indeterminate 1.1s ease-in-out infinite';

    info.textContent =
      speedText
        ? `${name} · ${speedText}`
        : name;

    return;
  }

  /*
   * Multiple simultaneous downloads.
   *
   * Each client can report progress independently, but native
   * FileTransfer events do not provide a reliable transfer ID.
   *
   * For multiple downloads we therefore calculate an aggregate
   * percentage only when every active item has a known total.
   *
   * Otherwise use an indeterminate bar.
   */
  let totalBytes =
    0;

  let downloadedBytes =
    0;

  let allTotalsKnown =
    true;

  let combinedSpeed =
    0;

  for (
    const item
    of activeDownloads.values()
  ) {
    const bytes =
      Number(item.bytes) ||
      0;

    const total =
      Number(item.total) ||
      0;

    downloadedBytes +=
      bytes;

    combinedSpeed +=
      Number(item.speed) || 0;

    if (
      total <= 0
    ) {
      allTotalsKnown =
        false;

    } else {
      totalBytes +=
        total;
    }
  }

  const speedText =
    formatDownloadSpeed(
      combinedSpeed
    );

  if (
    allTotalsKnown &&
    totalBytes > 0
  ) {
    const percent =
      Math.min(
        100,
        Math.max(
          0,
          (downloadedBytes / totalBytes) *
            100
        )
      );

    fill.style.animation =
      'none';

    fill.style.width =
      `${percent}%`;

    info.textContent =
      speedText
        ? `${count} downloads · ${Math.round(percent)}% · ${speedText}`
        : `${count} downloads · ${Math.round(percent)}%`;

    return;
  }

  fill.style.width =
    '35%';

  fill.style.animation =
    'wire-download-progress-indeterminate 1.1s ease-in-out infinite';

  info.textContent =
    speedText
      ? `${count} downloads · ${speedText}`
      : `${count} downloads`;
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
        performance.now()
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

  if (
    Number.isFinite(bytes) &&
    bytes >= 0
  ) {
    item.bytes =
      bytes;

    updateDownloadSpeed(
      item,
      bytes
    );
  }

  if (
    Number.isFinite(total) &&
    total > 0
  ) {
    item.total =
      total;
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
 * Shared manager.
 *
 * files.js uses the same object, so Drive downloads and attachment
 * downloads share exactly one progress bar.
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

    if (
      oldestUrl
    ) {
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

  imageBlobCache.delete(
    key
  );

  imageBlobCache.set(
    key,
    url
  );

  return url;
}

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

function attachmentMediaKind(
  msg
) {
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

  if (
    mediaKind
  ) {
    return '';
  }

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

function isNativeCapacitor() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

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


/* =========================================================
 * NATIVE DOWNLOAD
 * ========================================================= */

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

  const url =
    scope === 'dm'
      ? `/api/dm/attachments/${id}?download=1`
      : `/api/chat/attachments/${id}?download=1`;

  const resolvedUrl =
    resolveServerUrl(
      url
    );

  const safeName =
    sanitizeFilename(
      name
    );

  const destinationUri =
    `file:///storage/emulated/0/Download/${safeName}`;

  console.log(
    '[Download] Native download:',
    {
      id,
      scope,
      name:
        safeName,
      url:
        resolvedUrl,
      destination:
        destinationUri,
      downloadId
    }
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

          const bytes =
            Number(
              progress.bytes
            ) || 0;

          const contentLength =
            Number(
              progress.contentLength
            ) || 0;

          updateDownloadProgress(
            downloadId,
            {
              bytes,
              contentLength
            }
          );
        }
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


/* =========================================================
 * WEB / ELECTRON STREAMING DOWNLOAD
 * ========================================================= */

/**
 * Browser and Electron both use the normal Fetch API.
 *
 * Instead of fetchBlob(), this reads response.body chunk-by-chunk,
 * allowing the same progress UI to work in:
 *
 *   - normal browser
 *   - PWA
 *   - Electron
 *
 * The server's Content-Length is used for percentage when available.
 */
async function downloadAttachmentWeb(
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

  const url =
    scope === 'dm'
      ? `/api/dm/attachments/${id}?download=1`
      : `/api/chat/attachments/${id}?download=1`;

  const resolvedUrl =
    resolveServerUrl(
      url
    );

  console.log(
    '[Download] Web/Electron streaming download:',
    {
      id,
      scope,
      name,
      url:
        resolvedUrl,
      downloadId
    }
  );

  const response =
    await fetch(
      resolvedUrl,
      {
        method:
          'GET',

        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );

  if (
    !response.ok
  ) {
    if (
      response.status ===
      401
    ) {
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

      throw new Error(
        'Session expired'
      );
    }

    let serverBody =
      '';

    try {
      serverBody =
        await response.text();

    } catch {
      // Ignore body parsing failure.
    }

    throw new Error(
      `Download failed (${response.status})${
        serverBody
          ? `: ${serverBody}`
          : ''
      }`
    );
  }

  /*
   * Content-Length is the only reliable way for a normal HTTP
   * response to expose an exact total byte count.
   *
   * If absent, the progress UI remains indeterminate but speed
   * still works.
   */
  const contentLength =
    Number(
      response.headers.get(
        'content-length'
      )
    );

  const total =
    Number.isFinite(
      contentLength
    ) &&
    contentLength > 0
      ? contentLength
      : 0;

  updateDownloadProgress(
    downloadId,
    {
      bytes:
        0,

      contentLength:
        total
    }
  );

  /*
   * Some older WebViews may not expose response.body.
   *
   * In that case fall back to response.blob().
   * The download still works, but exact streaming progress is
   * unavailable in that environment.
   */
  if (
    !response.body ||
    typeof response.body.getReader !==
      'function'
  ) {
    const blob =
      await response.blob();

    updateDownloadProgress(
      downloadId,
      {
        bytes:
          blob.size,

        contentLength:
          total ||
          blob.size
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

    return;
  }

  const reader =
    response.body.getReader();

  const chunks =
    [];

  let downloaded =
    0;

  try {
    while (
      true
    ) {
      const {
        done,
        value
      } =
        await reader.read();

      if (
        done
      ) {
        break;
      }

      if (
        value
      ) {
        chunks.push(
          value
        );

        downloaded +=
          value.byteLength;

        updateDownloadProgress(
          downloadId,
          {
            bytes:
              downloaded,

            contentLength:
              total
          }
        );
      }
    }

  } finally {
    try {
      reader.releaseLock();

    } catch {
      // Nothing to release.
    }
  }

  /*
   * Reconstruct a Blob after the stream is complete.
   *
   * This keeps the existing browser/Electron download behavior
   * without requiring filesystem-specific APIs.
   */
  const blob =
    new Blob(
      chunks,
      {
        type:
          response.headers.get(
            'content-type'
          ) ||
          'application/octet-stream'
      }
    );

  updateDownloadProgress(
    downloadId,
    {
      bytes:
        downloaded,

      contentLength:
        total ||
        downloaded
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


/* =========================================================
 * PUBLIC DOWNLOAD API
 * ========================================================= */

export async function downloadAttachment(
  id,
  name,
  scope
) {
  const filename =
    sanitizeFilename(
      name
    );

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

    /*
     * Browser + Electron.
     *
     * Both use streaming Fetch here, so both get:
     *
     *   percentage
     *   downloaded bytes
     *   speed
     *
     * when the server supplies Content-Length.
     */
    await downloadAttachmentWeb(
      id,
      filename,
      scope,
      downloadId
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

window.downloadAttachment =
  downloadAttachment;
