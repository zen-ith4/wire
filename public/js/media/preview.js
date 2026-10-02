import { fetchBlob } from '../core/api.js';
import { ICONS } from '../icons.js';
import {
  loadingState,
  emptyState,
  escapeHtml,
  escapeAttr
} from '../core/utils.js';
import { pushOverlay, closeOverlay } from '../core/navigation.js';

// State to manage concurrency
let abortController = null;
let requestId = 0;
let isClosing = false;

/**
 * Creates a poster image from the first decoded video frame.
 *
 * The video is loaded from the already-downloaded Blob, so this does not
 * require another network request. The resulting poster is returned as
 * a Blob URL and must be revoked by the caller.
 *
 * @param {Blob} blob
 * @returns {Promise<string|null>}
 */
async function createVideoPoster(blob) {
  const video = document.createElement('video');

  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;

  const videoUrl = URL.createObjectURL(blob);
  video.src = videoUrl;

  try {
    // Wait until the first frame is actually available.
    await new Promise((resolve, reject) => {
      const onLoadedData = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(
          video.error ||
          new Error('Failed to decode video preview')
        );
      };

      const cleanup = () => {
        video.removeEventListener('loadeddata', onLoadedData);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadeddata', onLoadedData, { once: true });
      video.addEventListener('error', onError, { once: true });

      // In case the event fired before listeners were attached.
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        cleanup();
        resolve();
      }
    });

    const width = video.videoWidth;
    const height = video.videoHeight;

    if (!width || !height) {
      return null;
    }

    /*
     * Make sure the video is positioned at the beginning.
     *
     * Usually loadeddata already gives us the first frame, but explicitly
     * seeking to 0 makes the intended behavior clear.
     */
    if (video.currentTime !== 0) {
      await new Promise((resolve) => {
        const onSeeked = () => {
          cleanup();
          resolve();
        };

        const cleanup = () => {
          video.removeEventListener('seeked', onSeeked);
        };

        video.addEventListener('seeked', onSeeked, { once: true });

        video.currentTime = 0;

        // Some videos are already effectively at time 0.
        if (video.currentTime === 0) {
          cleanup();
          resolve();
        }
      });
    }

    const canvas = document.createElement('canvas');

    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');

    if (!context) {
      return null;
    }

    // Copy the current video frame into the canvas.
    context.drawImage(video, 0, 0, width, height);

    const posterBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => {
          if (result) {
            resolve(result);
          } else {
            reject(new Error('Failed to create video poster'));
          }
        },
        'image/jpeg',
        0.85
      );
    });

    return URL.createObjectURL(posterBlob);
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();

    URL.revokeObjectURL(videoUrl);
  }
}

/**
 * Revokes the poster URL stored on the preview content.
 */
function revokePosterUrl(content) {
  if (!content) return;

  if (content.dataset.posterUrl) {
    URL.revokeObjectURL(content.dataset.posterUrl);
    delete content.dataset.posterUrl;
  }
}

/**
 * Opens a media preview modal.
 * @param {'image'|'video'|'audio'} type
 * @param {number|string} folderId   - current folder ID
 * @param {string} subpath           - current navigation subpath
 * @param {string} file              - file name to preview
 */
export async function openPreview(type, folderId, subpath, file) {
  const modal = document.getElementById('preview-modal');
  const content = document.getElementById('preview-content');

  if (!modal || !content) return;

  // Cancel any previous preview that is still loading.
  if (abortController) {
    abortController.abort();
  }

  abortController = new AbortController();
  isClosing = false;

  // Increment request id – we'll only process the latest request.
  const currentRequestId = ++requestId;

  // Clean up previous preview resources.
  if (content.dataset.blobUrl) {
    URL.revokeObjectURL(content.dataset.blobUrl);
    delete content.dataset.blobUrl;
  }

  revokePosterUrl(content);
  revokeBlobUrls(content);

  modal.classList.add('active');
  content.innerHTML = loadingState();

  // Not currently reachable from any call site in the app (the Files
  // tab and share-link preview both use files/viewer.js's
  // openViewer() instead), but wired defensively so Android Back
  // behaves correctly if this modal is ever hooked up again.
  pushOverlay('preview', closePreview);

  try {
    const url =
      `/api/files/preview/${folderId}` +
      `?subpath=${encodeURIComponent(subpath)}` +
      `&file=${encodeURIComponent(file)}`;

    const blob = await fetchBlob(url, {
      signal: abortController.signal
    });

    // Discard response if a newer preview was started.
    if (currentRequestId !== requestId || isClosing) {
      return;
    }

    const objectURL = URL.createObjectURL(blob);
    content.dataset.blobUrl = objectURL;

    switch (type) {
      case 'image':
        content.innerHTML = `
          <img
            src="${objectURL}"
            alt="${escapeAttr(file)}"
          />
        `;
        break;

      case 'video': {
        /*
         * Generate a real first-frame poster before showing the video.
         *
         * This is especially useful on mobile/WebView where the video
         * element may not display its first frame until playback begins.
         */
        let posterUrl = null;

        try {
          posterUrl = await createVideoPoster(blob);
        } catch (posterError) {
          // Poster generation is optional. The video itself can still play.
          console.warn(
            '[Preview] Failed to generate video poster:',
            posterError
          );
        }

        // The request may have become obsolete while the poster was being
        // generated.
        if (currentRequestId !== requestId || isClosing) {
          if (posterUrl) {
            URL.revokeObjectURL(posterUrl);
          }

          URL.revokeObjectURL(objectURL);
          delete content.dataset.blobUrl;
          return;
        }

        if (posterUrl) {
          content.dataset.posterUrl = posterUrl;
        }

        content.innerHTML = `
          <video
            controls
            playsinline
            preload="metadata"
            ${posterUrl ? `poster="${escapeAttr(posterUrl)}"` : ''}
            src="${escapeAttr(objectURL)}">
          </video>
        `;

        break;
      }

      case 'audio':
        content.innerHTML = `
          <audio
            controls
            autoplay
            src="${escapeAttr(objectURL)}">
          </audio>
        `;
        break;

      default:
        // Unsupported type – revoke the blob we just created.
        URL.revokeObjectURL(objectURL);
        delete content.dataset.blobUrl;

        content.innerHTML = emptyState(
          ICONS.file,
          'Unsupported file type'
        );
    }
  } catch (e) {
    // If the request was aborted because the user closed the modal,
    // don't show an error.
    if (e.name === 'AbortError' || isClosing) {
      return;
    }

    content.innerHTML = emptyState(
      ICONS.empty,
      'Failed to load',
      escapeHtml(e.message)
    );

    delete content.dataset.blobUrl;
  } finally {
    // If this request was the last one, clear the stored controller.
    if (currentRequestId === requestId) {
      abortController = null;
    }
  }
}

export function closePreview() {
  const modal = document.getElementById('preview-modal');
  const content = document.getElementById('preview-content');

  if (!modal || !content) return;

  // Suppress error display in openPreview's catch block.
  isClosing = true;

  // Cancel any ongoing fetch.
  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  // Revoke poster URL.
  revokePosterUrl(content);

  // Revoke all blob URLs.
  revokeBlobUrls(content);

  if (content.dataset.blobUrl) {
    URL.revokeObjectURL(content.dataset.blobUrl);
    delete content.dataset.blobUrl;
  }

  content.innerHTML = '';
  modal.classList.remove('active');

  closeOverlay('preview');
}

/**
 * Recursively revoke all blob URLs found in an element's subtree.
 */
function revokeBlobUrls(container) {
  if (!container) return;

  // Custom data-blob-url attributes.
  container
    .querySelectorAll('[data-blob-url]')
    .forEach((el) => {
      const url = el.dataset.blobUrl;

      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
        el.removeAttribute('data-blob-url');
      }
    });

  // Media element src attributes.
  container
    .querySelectorAll(
      'img[src^="blob:"], ' +
      'video[src^="blob:"], ' +
      'audio[src^="blob:"], ' +
      'source[src^="blob:"]'
    )
    .forEach((el) => {
      if (el.src && el.src.startsWith('blob:')) {
        URL.revokeObjectURL(el.src);
        el.removeAttribute('src');
      }
    });
}

// Close when clicking the backdrop only.
document
  .getElementById('preview-modal')
  ?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closePreview();
    }
  });
