import { api } from '../core/api.js';
import { getToken, logout } from '../core/auth.js';
import { resolveServerUrl } from '../core/server.js';
import { claimRender, isUserTypingIn } from '../core/view-session.js';

import {
  Capacitor,
  FileTransfer
} from '../vendor/capacitor.js';

import { ICONS, fileIcon } from '../icons.js';
import {
  showToast,
  loadingState,
  emptyState,
  formatBytes,
  formatDate,
  escapeHtml,
  escapeAttr
} from '../core/utils.js';

import {
  progressBarHtml,
  showUploadProgress,
  updateUploadProgress,
  hideUploadProgress,
  xhrUpload
} from './upload.js';

import { openPreview } from '../media/preview.js';
import { escapeJsString } from './share.js';

let currentFolderId = null;
let currentSubpath = '';
let currentFolders = [];
let currentEntries = [];
let currentCanWrite = false;
let sortState = { key: 'name', dir: 1 };

let myFoldersById = new Map();

// Phones (<=760px, see responsive.css): the folder list and the file
// listing are two full-screen panes, like Messages. Every navigation in
// this view re-renders the whole layout, so which pane is showing has to
// live here rather than in the DOM. Files come first (like desktop, which
// opens the first folder); the header's back arrow reveals the folder list
// and picking a folder brings the files back. No effect on desktop.
let showFolderList = false;

// ====================== داخلی ======================

function sortEntries() {
  const { key, dir } =
    sortState;

  currentEntries.sort(
    (a, b) => {
      if (
        a.type !== b.type
      ) {
        return a.type === 'dir'
          ? -1
          : 1;
      }

      let cmp = 0;

      if (
        key === 'name'
      ) {
        cmp =
          a.name.localeCompare(
            b.name,
            undefined,
            {
              sensitivity: 'base',
              numeric: true
            }
          );

      } else if (
        key === 'size'
      ) {
        cmp =
          a.size - b.size;

      } else if (
        key === 'modified'
      ) {
        cmp =
          new Date(a.modified) -
          new Date(b.modified);
      }

      return cmp * dir;
    }
  );
}

// ====================== عمومی برای onclick ======================

window.goToPath =
  function(path) {
    currentSubpath =
      path || '';

    renderFiles();
  };

window.changeFolder =
  function(id) {
    currentFolderId =
      Number(id);

    currentSubpath =
      '';

    showFolderList =
      false;

    renderFiles();
  };

window.openFolderListMobile =
  function() {
    showFolderList =
      true;

    document
      .querySelector('.dm-layout')
      ?.classList.remove(
        'showing-thread'
      );
  };

window.enterFolder =
  function(name) {
    currentSubpath =
      currentSubpath
        ? `${currentSubpath}/${name}`
        : name;

    renderFiles();
  };

window.previewFile =
  async function(file) {
    const ext =
      file
        .split('.')
        .pop()
        .toLowerCase();

    if (
      [
        'jpg',
        'jpeg',
        'png',
        'gif',
        'webp'
      ].includes(ext)
    ) {
      openPreview(
        'image',
        currentFolderId,
        currentSubpath,
        file
      );

    } else if (
      [
        'mp4',
        'webm',
        'mov'
      ].includes(ext)
    ) {
      openPreview(
        'video',
        currentFolderId,
        currentSubpath,
        file
      );

    } else if (
      [
        'mp3',
        'wav',
        'flac',
        'ogg'
      ].includes(ext)
    ) {
      openPreview(
        'audio',
        currentFolderId,
        currentSubpath,
        file
      );

    } else {
      window.downloadFile(
        file
      );
    }
  };

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

function createDownloadId(
  file
) {
  return (
    `files-${currentFolderId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`
  );
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

  try {
    logout();

  } catch (logoutError) {
    console.error(
      '[Files] Logout failed:',
      logoutError
    );
  }

  return true;
}

/**
 * Native Android download.
 *
 * Files are written directly to:
 *
 * /storage/emulated/0/Download/
 *
 * The server still receives the normal Wire Bearer token.
 *
 * Progress is handled by the shared Wire download progress manager:
 *
 * window.__wireDownloadProgress
 */
async function downloadFileNative(
  file,
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
      file
    );

  const relativeSubpath =
    currentSubpath || '';

  const url =
    `/api/files/download/${currentFolderId}` +
    `?subpath=${encodeURIComponent(relativeSubpath)}` +
    `&file=${encodeURIComponent(file)}`;

  const resolvedUrl =
    resolveServerUrl(
      url
    );

  console.log(
    '[Files Download] Native download:',
    {
      folderId:
        currentFolderId,

      subpath:
        relativeSubpath,

      file:
        safeName,

      url:
        resolvedUrl,

      downloadId
    }
  );

  const destinationUri =
    `file:///storage/emulated/0/Download/${safeName}`;

  console.log(
    '[Files Download] Destination:',
    destinationUri
  );

  let progressListener =
    null;

  try {
    window.__wireDownloadProgress?.start(
      downloadId,
      safeName
    );

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

          console.log(
            '[Files Download] Progress:',
            {
              bytes,
              contentLength,
              downloadId
            }
          );

          window.__wireDownloadProgress?.progress(
            downloadId,
            {
              bytes,
              contentLength
            }
          );
        }
      );

    console.log(
      '[Files Download] Starting native transfer...'
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
      '[Files Download] Native transfer complete:',
      result
    );

    window.__wireDownloadProgress?.finish(
      downloadId
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
      '[Files Download] Native transfer failed:',
      error
    );

    window.__wireDownloadProgress?.fail(
      downloadId
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
    if (
      progressListener
    ) {
      try {
        await progressListener.remove();

      } catch (error) {
        console.warn(
          '[Files Download] Failed to remove progress listener:',
          error
        );
      }
    }
  }
}

/**
 * Browser/Electron download.
 *
 * Uses XMLHttpRequest instead of fetchBlob() so the shared download
 * progress UI receives real download progress events.
 */
async function downloadFileWeb(
  file,
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
    `/api/files/download/${currentFolderId}` +
    `?subpath=${encodeURIComponent(currentSubpath)}` +
    `&file=${encodeURIComponent(file)}`;

  console.log(
    '[Files Download] Web download:',
    {
      file,
      url,
      downloadId
    }
  );

  const blob =
    await new Promise(
      (
        resolve,
        reject
      ) => {
        const xhr =
          new XMLHttpRequest();

        xhr.open(
          'GET',
          url,
          true
        );

        xhr.responseType =
          'blob';

        xhr.timeout =
          120_000;

        xhr.setRequestHeader(
          'Authorization',
          `Bearer ${token}`
        );

        xhr.addEventListener(
          'progress',
          event => {
            const bytes =
              Number(
                event.loaded
              ) || 0;

            const contentLength =
              event.lengthComputable
                ? Number(
                    event.total
                  ) || 0
                : 0;

            window.__wireDownloadProgress?.progress(
              downloadId,
              {
                bytes,
                contentLength
              }
            );
          }
        );

        xhr.addEventListener(
          'load',
          () => {
            if (
              xhr.status >= 200 &&
              xhr.status < 300
            ) {
              resolve(
                xhr.response
              );

              return;
            }

            if (
              xhr.status === 401
            ) {
              try {
                logout();

              } catch (logoutError) {
                console.error(
                  '[Files Download] Logout failed:',
                  logoutError
                );
              }

              reject(
                new Error(
                  'Session expired'
                )
              );

              return;
            }

            let message =
              `Download failed (${xhr.status})`;

            if (
              xhr.response instanceof Blob &&
              xhr.response.size > 0 &&
              xhr.status >= 400
            ) {
              xhr.response
                .text()
                .then(
                  body => {
                    reject(
                      new Error(
                        body
                          ? `${message}: ${body}`
                          : message
                      )
                    );
                  }
                )
                .catch(
                  () => {
                    reject(
                      new Error(
                        message
                      )
                    );
                  }
                );

              return;
            }

            reject(
              new Error(
                message
              )
            );
          }
        );

        xhr.addEventListener(
          'error',
          () => {
            reject(
              new Error(
                'Network error'
              )
            );
          }
        );

        xhr.addEventListener(
          'abort',
          () => {
            reject(
              new Error(
                'Download cancelled'
              )
            );
          }
        );

        xhr.addEventListener(
          'timeout',
          () => {
            reject(
              new Error(
                'Download timed out'
              )
            );
          }
        );

        xhr.send();
      }
    );

  console.log(
    '[Files Download] Blob received:',
    {
      size:
        blob?.size,

      type:
        blob?.type
    }
  );

  if (
    !(blob instanceof Blob)
  ) {
    throw new Error(
      'Invalid download response'
    );
  }

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
      sanitizeFilename(
        file
      );

    document.body.appendChild(
      a
    );

    a.click();

    document.body.removeChild(
      a
    );

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
 * Download a file from the Wire Drive.
 *
 * Native Capacitor:
 *   FileTransfer
 *   -> Android Download/
 *   -> shared Wire download progress UI
 *
 * Browser/Electron:
 *   XMLHttpRequest
 *   -> Blob
 *   -> <a download>
 *   -> shared Wire download progress UI
 */
async function downloadFile(
  file
) {
  try {
    const filename =
      sanitizeFilename(
        file
      );

    const downloadId =
      createDownloadId(
        file
      );

    console.log(
      '[Files Download] Requested:',
      {
        folderId:
          currentFolderId,

        subpath:
          currentSubpath,

        file:
          filename,

        native:
          isNativeCapacitor(),

        downloadId
      }
    );

    if (
      isNativeCapacitor()
    ) {
      await downloadFileNative(
        file,
        downloadId
      );

      showToast(
        `Downloaded: ${filename}`,
        'success'
      );

      return;
    }

    /*
     * Browser/Electron use the shared progress UI.
     *
     * downloadFileWeb() only performs the XHR transfer, while this
     * wrapper owns start/finish/fail for the complete transfer.
     */
    window.__wireDownloadProgress?.start(
      downloadId,
      filename
    );

    try {
      await downloadFileWeb(
        file,
        downloadId
      );

      window.__wireDownloadProgress?.finish(
        downloadId
      );

      showToast(
        `Downloaded: ${filename}`,
        'success'
      );

    } catch (error) {
      window.__wireDownloadProgress?.fail(
        downloadId
      );

      throw error;
    }

  } catch (e) {
    console.error(
      '[Files Download] Failed:',
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

window.downloadFile =
  downloadFile;

// ====================== لینک ======================

window.copyLink =
  function(file) {
    const url =
      location.origin +
      `/api/files/download/${currentFolderId}` +
      `?subpath=${encodeURIComponent(currentSubpath)}` +
      `&file=${encodeURIComponent(file)}`;

    navigator.clipboard
      ?.writeText(url)
      .then(
        () =>
          showToast(
            'Link copied',
            'success'
          ),

        () =>
          showToast(
            'Could not copy link',
            'error'
          )
      );
  };

window.toggleSort =
  function(key) {
    if (
      sortState.key === key
    ) {
      sortState.dir *=
        -1;

    } else {
      sortState.key =
        key;

      sortState.dir =
        1;
    }

    renderFileCard(
      currentFolders,
      {
        entries:
          currentEntries,

        can_write:
          currentCanWrite
      }
    );
  };

// ====================== UPLOAD ======================

async function uploadOneDriveFile(
  file,
  progressLabel
) {
  const form =
    new FormData();

  form.append(
    'file',
    file
  );

  form.append(
    'subpath',
    currentSubpath
  );

  showUploadProgress(
    'file-upload-progress',
    progressLabel ||
      file.name
  );

  try {
    await xhrUpload(
      `/api/files/upload/${currentFolderId}`,
      form,
      pct =>
        updateUploadProgress(
          'file-upload-progress',
          pct
        )
    );

    return true;

  } catch (e) {
    showToast(
      `${file.name}: ${e.message}`,
      'error'
    );

    return false;

  } finally {
    hideUploadProgress(
      'file-upload-progress'
    );
  }
}

window.uploadFile =
  async function() {
    const input =
      document.getElementById(
        'upload-input'
      );

    const file =
      input.files[0];

    if (!file) {
      return;
    }

    const ok =
      await uploadOneDriveFile(
        file
      );

    if (ok) {
      input.value =
        '';

      renderFiles();

      showToast(
        'Uploaded successfully',
        'success'
      );
    }
  };

export async function uploadFilesMultiple(
  fileList
) {
  if (
    !currentCanWrite
  ) {
    showToast(
      "You don't have write access to this folder",
      'error'
    );

    return;
  }

  const files =
    Array.from(
      fileList
    );

  let succeeded =
    0;

  for (
    let i = 0;
    i < files.length;
    i++
  ) {
    const label =
      files.length > 1
        ? `${files[i].name} (${i + 1}/${files.length})`
        : files[i].name;

    if (
      await uploadOneDriveFile(
        files[i],
        label
      )
    ) {
      succeeded++;
    }
  }

  if (
    succeeded > 0
  ) {
    renderFiles();

    showToast(
      succeeded === files.length
        ? `Uploaded ${succeeded} file${succeeded === 1 ? '' : 's'}`
        : `Uploaded ${succeeded}/${files.length} files`,
      succeeded === files.length
        ? 'success'
        : 'error'
    );
  }
}

export function canUploadToCurrentFolder() {
  return currentCanWrite;
}

window.showNewFolderInput =
  function() {
    const row =
      document.getElementById(
        'new-folder-row'
      );

    if (!row) {
      return;
    }

    row.classList.remove(
      'hidden'
    );

    document
      .getElementById(
        'new-folder-name'
      )
      ?.focus();
  };

// ====================== رندر اصلی ======================

// ---------------------------------------------------------------------
// Data loading + rendering
//
// Two entry points share one loader:
//
//   renderFiles()  forced fresh render (spinner -> network -> paint).
//                  Used by everything that just changed something
//                  (upload, delete, share, folder change, breadcrumb).
//
//   showFiles()    tab switch. If this view has been loaded before it
//                  paints from the in-memory state *immediately* (no
//                  spinner, no network) and revalidates in the
//                  background, touching the DOM again only when the
//                  server data actually differs. First visit behaves
//                  exactly like renderFiles().
//
// The state kept here is the same folder/listing data this module
// already held; it lives in memory only and is dropped on logout.
// ---------------------------------------------------------------------

let filesLoaded = false; // a complete listing has been painted at least once
let filesSig = '';       // signature of the data that is currently painted

window.addEventListener('wire:logout', () => {
  currentFolderId = null;
  currentSubpath = '';
  currentFolders = [];
  currentEntries = [];
  currentCanWrite = false;
  myFoldersById = new Map();
  showFolderList = false;
  filesLoaded = false;
  filesSig = '';
});

function filesListUrl(folderId, subpath) {
  return `/api/files/list/${folderId}?subpath=${encodeURIComponent(subpath)}`;
}

// Fetches everything the Files view needs and commits it to the module
// state in one step (so a failed request can never leave folders from
// one response next to entries from another). Resolves to
// { folders, data, sig }, or null when a newer render superseded this one.
async function loadFilesData(isCurrent) {
  // The listing request only depends on the folders response to
  // *validate* the remembered folder. When a folder is already known,
  // start its listing in parallel with folders/share instead of
  // waiting for them (one round trip instead of two). If the folder
  // turns out to be gone we discard the guess and fall back.
  const guessId = currentFolderId;
  const guessSubpath = currentSubpath;
  const guess =
    guessId
      ? api(filesListUrl(guessId, guessSubpath))
      : null;

  if (guess) {
    guess.catch(() => {}); // a discarded guess must not surface as an unhandled rejection
  }

  const [folders, mineResponse] = await Promise.all([
    api('/api/files/folders'),
    api('/api/share/mine')
  ]);

  if (!isCurrent()) {
    return null;
  }

  const mineFolders =
    Array.isArray(mineResponse)
      ? mineResponse
      : (mineResponse.folders || []);

  let folderId = null;
  let subpath = '';
  let data = { entries: [], can_write: false };

  if (folders.length > 0) {
    const stillValid =
      guessId &&
      folders.find(f => f.id == guessId);

    if (stillValid) {
      folderId = guessId;
      subpath = guessSubpath;
    } else {
      folderId = folders[0].id;
      subpath = '';
    }

    data =
      stillValid && guess
        ? await guess
        : await api(filesListUrl(folderId, subpath));

    if (!isCurrent()) {
      return null;
    }
  }

  const sig = JSON.stringify([
    folders,
    mineFolders,
    folderId,
    subpath,
    data.entries || [],
    !!data.can_write
  ]);

  currentFolders = folders;
  myFoldersById = new Map(mineFolders.map(f => [f.id, f]));
  currentFolderId = folderId;
  currentSubpath = subpath;
  currentEntries = data.entries || [];
  currentCanWrite = data.can_write || false;

  return { folders, data, sig };
}

function filesErrorHtml(e) {
  return `<div class="card">${
    emptyState(
      ICONS.empty,
      'Something went wrong',
      escapeHtml(
        e.message
      )
    )
  }</div>`;
}

export async function renderFiles() {
  // #content-area is shared by every view: only write to it while this
  // render still owns it (see core/view-session.js).
  const isCurrent =
    claimRender(
      'files'
    );

  if (!isCurrent()) {
    return;
  }

  const main =
    document.getElementById(
      'content-area'
    );

  main.innerHTML =
    loadingState();

  try {
    const result =
      await loadFilesData(
        isCurrent
      );

    if (!result) {
      return;
    }

    renderFileCard(
      result.folders,
      result.data
    );

    filesLoaded = true;
    filesSig = result.sig;

  } catch (e) {
    if (!isCurrent()) {
      return;
    }

    main.innerHTML =
      filesErrorHtml(e);
  }
}

export async function showFiles() {
  if (!filesLoaded) {
    return renderFiles();
  }

  const isCurrent =
    claimRender(
      'files'
    );

  if (!isCurrent()) {
    return;
  }

  const main =
    document.getElementById(
      'content-area'
    );

  // 1. Local paint: everything needed is already in memory.
  renderFileCard(
    currentFolders,
    {
      entries: currentEntries,
      can_write: currentCanWrite
    }
  );

  // 2. Background revalidation. Nothing blocks on this.
  try {
    const result =
      await loadFilesData(
        isCurrent
      );

    if (
      !result ||
      result.sig === filesSig ||
      isUserTypingIn(main)
    ) {
      return;
    }

    renderFileCard(
      result.folders,
      result.data
    );

    filesSig = result.sig;

  } catch (e) {
    // Keep showing what we have; a real failure surfaces on the next
    // action (api() already handles an expired session itself).
    console.warn(
      '[Files] Background refresh failed:',
      e
    );
  }
}

function folderRowHtml(
  folder
) {
  const active =
    folder.id ==
    currentFolderId;

  const mine =
    myFoldersById.get(
      folder.id
    );

  const preview =
    mine
      ? (
          mine.shared_with_count > 0
            ? `Shared with ${mine.shared_with_count}`
            : 'Only you'
        )
      : (
          folder.can_write
            ? 'Shared with you · Can edit'
            : 'Shared with you · Read only'
        );

  return `
    <div
      class="dm-conv${active ? ' active' : ''}"
      data-folder="${folder.id}"
      onclick="window.changeFolder(${folder.id})"
    >
      <div class="chat-avatar">
        ${ICONS.folder}
      </div>

      <div class="conv-info">
        <div class="dm-conv-name">
          ${escapeHtml(
            folder.display_name
          )}
        </div>

        <div class="dm-conv-preview">
          ${escapeHtml(
            preview
          )}
        </div>
      </div>

      ${
        mine
          ? `
        <button
          class="icon-btn"
          title="Share"
          onclick="event.stopPropagation(); window.openShareModal(${folder.id}, '${escapeJsString(folder.display_name)}')"
        >
          ${ICONS.userPlus}
        </button>

        <button
          class="icon-btn"
          title="Delete"
          onclick="event.stopPropagation(); window.deleteMyShareFolder(${folder.id}, '${escapeJsString(folder.display_name)}')"
        >
          ${ICONS.trash}
        </button>
      `
          : ''
      }
    </div>
  `;
}

function renderFileCard(
  folders,
  data
) {
  const main =
    document.getElementById(
      'content-area'
    );

  const crumbs =
    currentSubpath
      ? currentSubpath.split('/')
      : [];

  let rootName =
    'No folders';

  if (
    folders.length > 0
  ) {
    rootName =
      folders.find(
        f =>
          f.id ==
          currentFolderId
      )?.display_name ||
      'Root';
  }

  let breadcrumbHtml =
    `<div class="breadcrumb">
      <a onclick="goToPath('')">
        ${escapeHtml(
          rootName
        )}
      </a>`;

  crumbs.forEach(
    (c, i) => {
      const pathTo =
        crumbs
          .slice(
            0,
            i + 1
          )
          .join('/');

      breadcrumbHtml +=
        `<span class="sep">/</span>`;

      breadcrumbHtml +=
        i ===
        crumbs.length - 1
          ? `
            <span class="current">
              ${escapeHtml(c)}
            </span>
          `
          : `
            <a onclick="goToPath('${escapeAttr(pathTo)}')">
              ${escapeHtml(c)}
            </a>
          `;
    }
  );

  breadcrumbHtml +=
    `</div>`;

  let mainThreadContent =
    '';

  if (
    folders.length === 0
  ) {
    mainThreadContent = `
      <div
        style="
          display:flex;
          justify-content:center;
          align-items:center;
          height:100%;
        "
      >
        ${
          emptyState(
            ICONS.folders,
            'No folders yet',
            'Create one from the sidebar, or ask an admin to grant you access.'
          )
        }
      </div>
    `;

  } else {
    let rowsHtml =
      '';

    if (
      data.entries.length === 0
    ) {
      rowsHtml =
        `<tr>
          <td colspan="4">
            ${
              emptyState(
                ICONS.folder,
                'This folder is empty',
                'Upload something to see it here.'
              )
            }
          </td>
        </tr>`;

    } else {
      sortEntries();

      currentEntries.forEach(
        entry => {
          const isDir =
            entry.type ===
            'dir';

          rowsHtml += `
            <tr class="file-row">
              <td
                onclick="${
                  isDir
                    ? `enterFolder('${escapeAttr(entry.name)}')`
                    : `previewFile('${escapeAttr(entry.name)}')`
                }"
              >
                <div class="file-name">
                  ${
                    fileIcon(
                      entry.name,
                      entry.type
                    )
                  }

                  <span>
                    ${escapeHtml(
                      entry.name
                    )}
                  </span>
                </div>
              </td>

              <td class="col-right">
                ${
                  isDir
                    ? '—'
                    : formatBytes(
                        entry.size
                      )
                }
              </td>

              <td class="col-right">
                ${
                  formatDate(
                    entry.modified
                  )
                }
              </td>

              <td>
                <div class="row-actions">
                  ${
                    !isDir
                      ? `
                        <button
                          class="icon-btn"
                          title="Download"
                          onclick="event.stopPropagation(); downloadFile('${escapeAttr(entry.name)}')"
                        >
                          ${ICONS.download}
                        </button>

                        <button
                          class="icon-btn"
                          title="Copy link"
                          onclick="event.stopPropagation(); copyLink('${escapeAttr(entry.name)}')"
                        >
                          ${ICONS.link}
                        </button>
                      `
                      : ''
                  }
                </div>
              </td>
            </tr>
          `;
        }
      );
    }

    mainThreadContent = `
      ${progressBarHtml(
        'file-upload-progress'
      )}

      <div class="table-scroll">
        <table class="file-table">
          <thead>
            <tr>
              <th
                onclick="toggleSort('name')"
              >
                Name
              </th>

              <th
                class="col-right"
                onclick="toggleSort('size')"
              >
                Size
              </th>

              <th
                class="col-right"
                onclick="toggleSort('modified')"
              >
                Modified
              </th>

              <th></th>
            </tr>
          </thead>

          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;
  }

  const topBarControls =
    folders.length > 0
      ? `
        <div style="flex:1;"></div>

        <span
          class="text-muted"
          style="
            font-size:12px;
            flex-shrink:0;
          "
        >
          ${
            data.entries.length
          }
          item${
            data.entries.length === 1
              ? ''
              : 's'
          }
        </span>

        ${
          currentCanWrite
            ? `
              <button
                class="btn btn-primary btn-sm"
                onclick="document.getElementById('upload-input').click()"
              >
                ${ICONS.upload}
                Upload
              </button>
            `
            : ''
        }
      `
      : `
        <div style="flex:1;"></div>
      `;

  main.innerHTML = `
    <div
      class="dm-layout${
        folders.length > 0 &&
        !showFolderList
          ? ' showing-thread'
          : ''
      }"
    >
      <div class="dm-sidebar">
        <div class="conv-header">
          <div class="conv-header-row">
            <span class="conv-header-label">
              Folders
            </span>

            <button
              class="btn-new-message"
              onclick="window.showNewFolderInput()"
            >
              ${ICONS.plus}
              New
            </button>
          </div>

          <div
            class="conv-search-wrap hidden"
            id="new-folder-row"
          >
            <input
              type="text"
              id="new-folder-name"
              placeholder="Folder name (e.g. Photos)"
              class="conv-search-input"
              style="padding-left:12px;"
              onkeypress="if(event.key==='Enter') window.addMyShareFolder()"
            >
          </div>
        </div>

        <div
          id="files-folder-list"
          class="dm-conv-list"
        >
          ${
            folders
              .map(
                folderRowHtml
              )
              .join('')
          }
        </div>
      </div>

      <div class="dm-thread">
        <div class="chat-top-bar">
          <button
            class="icon-btn dm-back-btn"
            title="Folders"
            onclick="window.openFolderListMobile()"
          >
            ${ICONS.arrowLeft}
          </button>

          ${breadcrumbHtml}

          ${topBarControls}
        </div>

        <div class="files-body">
          ${mainThreadContent}
        </div>
      </div>
    </div>

    <input
      type="file"
      id="upload-input"
      class="hidden"
      onchange="uploadFile()"
    >
  `;
}
