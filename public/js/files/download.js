// ============================================================
// Downloads for the Files tab — ONE implementation shared by the file
// list, the media viewer and the shared-link page.
//
//   Native Capacitor -> FileTransfer into Wire/<Images|Videos|Audio|Files>/
//                        under external storage (see downloadDestination.js)
//   Browser/Electron -> XMLHttpRequest -> Blob -> <a download>
//
// Both report to the shared Wire progress bar
// (window.__wireDownloadProgress, media/attachments.js). Behaviour is
// the same as the code that used to live in files.js; the only change
// is that the request is described by a "source" instead of being
// hard-wired to the current folder:
//
//   { url, filename, headers? }
//
// `headers` are sent IN ADDITION to the normal Authorization header
// (the shared-link download uses X-Share-Token so the token never
// appears in a URL).
// ============================================================

import { getToken, logout } from '../core/auth.js';
import { resolveServerUrl } from '../core/server.js';
import { Capacitor, FileTransfer } from '../vendor/capacitor.js';
import { showToast } from '../core/utils.js';
import { sanitizeFilename, resolveNativeDestination } from './downloadDestination.js';

function isNativeCapacitor() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// Re-exported for anything that already imports sanitizeFilename from here.
export { sanitizeFilename };

function createDownloadId() {
  return `files-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sessionExpired() {
  try {
    logout();
  } catch (logoutError) {
    console.error('[Files] Logout failed:', logoutError);
  }
}

async function downloadNative(source, safeName, downloadId) {
  const token = getToken();

  if (!token) {
    throw new Error('Authentication required');
  }

  // Wire/<Images|Videos|Audio|Files>/<name>, created on demand — see
  // downloadDestination.js. `source.mimeType` is optional; when a
  // caller doesn't have it, classification falls back to the file
  // extension.
  let destination;

  try {
    destination = await resolveNativeDestination(source.mimeType, safeName);
  } catch (error) {
    console.error('[Files Download] Could not prepare Wire folder:', error);
    throw new Error('Could not create the Wire download folder');
  }

  const { uri: destinationUri, filename: finalName } = destination;

  let progressListener = null;

  try {
    window.__wireDownloadProgress?.start(downloadId, finalName);

    progressListener = await FileTransfer.addListener('progress', (progress) => {
      if (!progress) return;

      window.__wireDownloadProgress?.progress(downloadId, {
        bytes: Number(progress.bytes) || 0,
        contentLength: Number(progress.contentLength) || 0,
      });
    });

    const result = await FileTransfer.downloadFile({
      url: resolveServerUrl(source.url),
      path: destinationUri,
      headers: {
        ...(source.headers || {}),
        Authorization: `Bearer ${token}`,
      },
      progress: true,
      connectTimeout: 60_000,
      readTimeout: 60_000,
    });

    window.__wireDownloadProgress?.finish(downloadId);

    return { ...result, uri: destinationUri, filename: finalName };

  } catch (error) {
    window.__wireDownloadProgress?.fail(downloadId);

    const status = Number(error?.data?.httpStatus ?? error?.httpStatus ?? 0);

    if (status === 401) {
      sessionExpired();
      throw new Error('Session expired');
    }

    const serverBody = error?.data?.body;

    if (status) {
      throw new Error(
        `Download failed (${status})${serverBody ? `: ${serverBody}` : ''}`
      );
    }

    throw error;

  } finally {
    if (progressListener) {
      try {
        await progressListener.remove();
      } catch (error) {
        console.warn('[Files Download] Failed to remove progress listener:', error);
      }
    }
  }
}

// XHR (not fetch) so the shared progress bar receives real progress.
async function downloadWeb(source, safeName, downloadId) {
  const token = getToken();

  if (!token) {
    throw new Error('Authentication required');
  }

  const blob = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open('GET', resolveServerUrl(source.url), true);
    xhr.responseType = 'blob';
    xhr.timeout = 120_000;

    for (const [key, value] of Object.entries(source.headers || {})) {
      xhr.setRequestHeader(key, value);
    }

    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.addEventListener('progress', (event) => {
      window.__wireDownloadProgress?.progress(downloadId, {
        bytes: Number(event.loaded) || 0,
        contentLength: event.lengthComputable ? Number(event.total) || 0 : 0,
      });
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
        return;
      }

      if (xhr.status === 401) {
        // A share-link 401 is a real session problem (the link itself
        // answers 404), so the same handling as before applies.
        sessionExpired();
        reject(new Error('Session expired'));
        return;
      }

      const message = `Download failed (${xhr.status})`;

      if (
        xhr.response instanceof Blob &&
        xhr.response.size > 0 &&
        xhr.status >= 400
      ) {
        xhr.response
          .text()
          .then((body) => {
            let detail = body;

            // Servers answer with {"error": "..."}: show just the message.
            try {
              detail = JSON.parse(body).error || body;
            } catch {
              /* plain text */
            }

            reject(new Error(detail ? `${message}: ${detail}` : message));
          })
          .catch(() => reject(new Error(message)));

        return;
      }

      reject(new Error(message));
    });

    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => reject(new Error('Download cancelled')));
    xhr.addEventListener('timeout', () => reject(new Error('Download timed out')));

    xhr.send();
  });

  if (!(blob instanceof Blob)) {
    throw new Error('Invalid download response');
  }

  const objectURL = URL.createObjectURL(blob);

  try {
    const a = document.createElement('a');

    a.href = objectURL;
    a.download = safeName;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

  } finally {
    setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
  }
}

/**
 * Downloads a file described by `source` ({ url, filename, headers? }).
 * Never throws: failures are reported with a toast, exactly like the
 * old files.js downloadFile().
 */
export async function downloadFromSource(source) {
  try {
    const filename = sanitizeFilename(source.filename);
    const downloadId = createDownloadId();

    if (isNativeCapacitor()) {
      const result = await downloadNative(source, filename, downloadId);
      // The final name can differ from `filename` if a same-named file
      // already existed in that Wire category folder.
      showToast(`Downloaded: ${result?.filename || filename}`, 'success');
      return;
    }

    // The wrapper owns start/finish/fail for the whole transfer;
    // downloadWeb() only performs the XHR.
    window.__wireDownloadProgress?.start(downloadId, filename);

    try {
      await downloadWeb(source, filename, downloadId);
      window.__wireDownloadProgress?.finish(downloadId);
      showToast(`Downloaded: ${filename}`, 'success');

    } catch (error) {
      window.__wireDownloadProgress?.fail(downloadId);
      throw error;
    }

  } catch (e) {
    console.error('[Files Download] Failed:', e);
    showToast('Download failed: ' + (e?.message || 'Unknown error'), 'error');
  }
}

/** Source for a file inside a folder (the normal authenticated route). */
export function folderFileSource(folderId, subpath, file) {
  return {
    url:
      `/api/files/download/${folderId}` +
      `?subpath=${encodeURIComponent(subpath || '')}` +
      `&file=${encodeURIComponent(file)}`,
    filename: file,
  };
}

/** Source for a shared-link file (token travels in a header, not the URL). */
export function shareLinkSource(token, filename) {
  return {
    url: '/api/share/links/file',
    filename,
    headers: { 'X-Share-Token': token },
  };
}
