import { fetchBlob } from '../core/api.js';
import { ICONS } from '../icons.js';
import { loadingState, emptyState, escapeHtml, escapeAttr } from '../core/utils.js';

// State to manage concurrency
let abortController = null;
let requestId = 0;
let isClosing = false;

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

  // Cancel any previous preview that is still loading
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();
  isClosing = false;   // reset closing flag

  // Increment request id – we'll only process the latest
  const currentRequestId = ++requestId;

  // Clean up previous preview's resources
  if (content.dataset.blobUrl) {
    URL.revokeObjectURL(content.dataset.blobUrl);
    delete content.dataset.blobUrl;
  }
  revokeBlobUrls(content);

  modal.classList.add('active');
  content.innerHTML = loadingState();

  try {
    const url = `/api/files/preview/${folderId}?subpath=${encodeURIComponent(subpath)}&file=${encodeURIComponent(file)}`;
    const blob = await fetchBlob(url, { signal: abortController.signal });

    // Discard response if a newer preview was started
    if (currentRequestId !== requestId) {
      // Revoke the blob URL we just created (it won't be used)
      const objectURL = URL.createObjectURL(blob);
      URL.revokeObjectURL(objectURL);
      return;
    }

    const objectURL = URL.createObjectURL(blob);
    content.dataset.blobUrl = objectURL;

    switch (type) {
      case 'image':
        content.innerHTML = `<img src="${objectURL}" alt="${escapeAttr(file)}" />`;
        break;
      case 'video':
        content.innerHTML = `<video controls autoplay src="${objectURL}"></video>`;
        break;
      case 'audio':
        content.innerHTML = `<audio controls autoplay src="${objectURL}"></audio>`;
        break;
      default:
        // Unsupported type – revoke the blob we just created
        URL.revokeObjectURL(objectURL);
        delete content.dataset.blobUrl;
        content.innerHTML = emptyState(ICONS.file, 'Unsupported file type');
    }
  } catch (e) {
    // If the request was aborted because the user closed the modal, don't show an error
    if (e.name === 'AbortError' || isClosing) return;

    content.innerHTML = emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message));
    delete content.dataset.blobUrl;
  } finally {
    // If this request was the last one, clear the stored controller
    if (currentRequestId === requestId) {
      abortController = null;
    }
  }
}

export function closePreview() {
  const modal = document.getElementById('preview-modal');
  const content = document.getElementById('preview-content');
  if (!modal || !content) return;

  // Set flag to suppress error display in the openPreview catch
  isClosing = true;

  // Cancel any ongoing fetch
  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  // Revoke all blob URLs
  revokeBlobUrls(content);
  if (content.dataset.blobUrl) {
    URL.revokeObjectURL(content.dataset.blobUrl);
    delete content.dataset.blobUrl;
  }

  content.innerHTML = '';
  modal.classList.remove('active');
}

/**
 * Recursively revoke all blob URLs found in an element's subtree.
 */
function revokeBlobUrls(container) {
  if (!container) return;

  // Custom attribute
  container.querySelectorAll('[data-blob-url]').forEach(el => {
    const url = el.dataset.blobUrl;
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
      el.removeAttribute('data-blob-url');
    }
  });

  // Media element src
  container.querySelectorAll('img[src^="blob:"], video[src^="blob:"], audio[src^="blob:"], source[src^="blob:"]').forEach(el => {
    if (el.src && el.src.startsWith('blob:')) {
      URL.revokeObjectURL(el.src);
      el.removeAttribute('src');
    }
  });
}

// Close when clicking the backdrop only
document.getElementById('preview-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    closePreview();
  }
});