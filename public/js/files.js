import { api, fetchBlob } from './api.js';
import { ICONS, fileIcon } from './icons.js';
import { showToast, loadingState, emptyState, formatBytes, formatDate, escapeHtml, escapeAttr } from './utils.js';
import { 
  progressBarHtml, 
  showUploadProgress, 
  updateUploadProgress, 
  hideUploadProgress,
  xhrUpload 
} from './upload.js';
import { openPreview } from './preview.js';
import { escapeJsString } from './share.js';

let currentFolderId = null;
let currentSubpath = '';
let currentFolders = [];
let currentEntries = [];
let currentCanWrite = false;
let sortState = { key: 'name', dir: 1 };
let myFoldersById = new Map(); // folder id -> { shared_with_count } for folders the current user owns

// ====================== توابع داخلی ======================

function sortEntries() {
  const { key, dir } = sortState;
  currentEntries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    let cmp = 0;
    if (key === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    else if (key === 'size') cmp = a.size - b.size;
    else if (key === 'modified') cmp = new Date(a.modified) - new Date(b.modified);
    return cmp * dir;
  });
}

// ====================== توابع عمومی (برای onclick) ======================
window.goToPath = function(path) {
  currentSubpath = path || '';
  renderFiles();
};

window.changeFolder = function(id) {
  currentFolderId = Number(id);
  currentSubpath = '';
  renderFiles();
};

window.enterFolder = function(name) {
  currentSubpath = currentSubpath ? `${currentSubpath}/${name}` : name;
  renderFiles();
};

window.previewFile = async function(file) {
  const ext = file.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    openPreview('image', currentFolderId, currentSubpath, file);
  } else if (['mp4', 'webm', 'mov'].includes(ext)) {
    openPreview('video', currentFolderId, currentSubpath, file);
  } else if (['mp3', 'wav', 'flac', 'ogg'].includes(ext)) {
    openPreview('audio', currentFolderId, currentSubpath, file);
  } else {
    window.downloadFile(file);   // ← درست شد
  }
};

async function downloadFile(file) {
  try {
    const url = `/api/files/download/${currentFolderId}?subpath=${encodeURIComponent(currentSubpath)}&file=${encodeURIComponent(file)}`;
    const blob = await fetchBlob(url);
    const objectURL = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectURL;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
  } catch (e) {
    showToast('Download failed: ' + e.message, 'error');
  }
}
window.downloadFile = downloadFile;

window.copyLink = function(file) {
  const url = location.origin + `/api/files/download/${currentFolderId}?subpath=${encodeURIComponent(currentSubpath)}&file=${encodeURIComponent(file)}`;
  navigator.clipboard?.writeText(url).then(
    () => showToast('Link copied', 'success'),
    () => showToast('Could not copy link', 'error')
  );
};

window.toggleSort = function(key) {
  if (sortState.key === key) sortState.dir *= -1;
  else { sortState.key = key; sortState.dir = 1; }
  renderFileCard(currentFolders, { entries: currentEntries, can_write: currentCanWrite });
};

// Core single-file upload, shared by the file-picker flow
// (window.uploadFile) and the drag-and-drop flow (uploadFilesMultiple).
async function uploadOneDriveFile(file, progressLabel) {
  const form = new FormData();
  form.append('file', file);
  form.append('subpath', currentSubpath);
  showUploadProgress('file-upload-progress', progressLabel || file.name);
  try {
    await xhrUpload(`/api/files/upload/${currentFolderId}`, form, (pct) => updateUploadProgress('file-upload-progress', pct));
    return true;
  } catch (e) {
    showToast(`${file.name}: ${e.message}`, 'error');
    return false;
  } finally {
    hideUploadProgress('file-upload-progress');
  }
}

window.uploadFile = async function() {
  const input = document.getElementById('upload-input');
  const file = input.files[0];
  if (!file) return;
  const ok = await uploadOneDriveFile(file);
  if (ok) {
    input.value = '';
    renderFiles();
    showToast('Uploaded successfully', 'success');
  }
};

// Drag-and-drop entry point (see dragdrop.js). Uploads sequentially
// into the currently open folder/subpath, then refreshes the listing
// once at the end (rather than per file, to avoid flicker).
export async function uploadFilesMultiple(fileList) {
  if (!currentCanWrite) {
    showToast("You don't have write access to this folder", 'error');
    return;
  }
  const files = Array.from(fileList);
  let succeeded = 0;
  for (let i = 0; i < files.length; i++) {
    const label = files.length > 1 ? `${files[i].name} (${i + 1}/${files.length})` : files[i].name;
    if (await uploadOneDriveFile(files[i], label)) succeeded++;
  }
  if (succeeded > 0) {
    renderFiles();
    showToast(
      succeeded === files.length
        ? `Uploaded ${succeeded} file${succeeded === 1 ? '' : 's'}`
        : `Uploaded ${succeeded}/${files.length} files`,
      succeeded === files.length ? 'success' : 'error'
    );
  }
}

// Lets dragdrop.js check permission before even attempting a drop
// upload in the Files view.
export function canUploadToCurrentFolder() {
  return currentCanWrite;
}

window.showNewFolderInput = function() {
  const row = document.getElementById('new-folder-row');
  if (!row) return;
  row.classList.remove('hidden');
  document.getElementById('new-folder-name')?.focus();
};

// ====================== رندر اصلی ======================
export async function renderFiles() {
  const main = document.getElementById('content-area');
  main.innerHTML = loadingState();
  try {
    // My Files (everything I can browse — owned + shared to me) and
    // My Shares (just the folders I own, with sharing metadata) are
    // two existing, unchanged endpoints — merged here into one panel
    // instead of two separate pages, rather than building a new
    // combined backend endpoint for it.
    const [folders, mineResponse] = await Promise.all([
      api('/api/files/folders'),
      api('/api/share/mine'),
    ]);

    currentFolders = folders;
    const mineFolders = Array.isArray(mineResponse) ? mineResponse : (mineResponse.folders || []);
    myFoldersById = new Map(mineFolders.map(f => [f.id, f]));

    if (folders.length === 0) {
      currentFolderId = null;
      currentSubpath = '';
      currentEntries = [];
      currentCanWrite = false;
      renderFileCard([], { entries: [], can_write: false });
      return;
    }

    if (!currentFolderId || !folders.find(f => f.id == currentFolderId)) {
      currentFolderId = folders[0].id;
      currentSubpath = '';
    }
    
    const data = await api(`/api/files/list/${currentFolderId}?subpath=${encodeURIComponent(currentSubpath)}`);
    currentEntries = data.entries || [];
    currentCanWrite = data.can_write || false;
    renderFileCard(folders, data);
  } catch (e) {
    main.innerHTML = `<div class="card">${emptyState(ICONS.empty, 'Something went wrong', escapeHtml(e.message))}</div>`;
  }
}

function folderRowHtml(folder) {
  const active = folder.id == currentFolderId;
  const mine = myFoldersById.get(folder.id);
  const preview = mine
    ? (mine.shared_with_count > 0 ? `Shared with ${mine.shared_with_count}` : 'Only you')
    : (folder.can_write ? 'Shared with you · Can edit' : 'Shared with you · Read only');

  return `
    <div class="dm-conv${active ? ' active' : ''}" data-folder="${folder.id}" onclick="window.changeFolder(${folder.id})">
      <div class="chat-avatar">${ICONS.folder}</div>
      <div class="conv-info">
        <div class="dm-conv-name">${escapeHtml(folder.display_name)}</div>
        <div class="dm-conv-preview">${escapeHtml(preview)}</div>
      </div>
      ${mine ? `
        <button class="icon-btn" title="Share" onclick="event.stopPropagation(); window.openShareModal(${folder.id}, '${escapeJsString(folder.display_name)}')">${ICONS.userPlus}</button>
        <button class="icon-btn" title="Delete" onclick="event.stopPropagation(); window.deleteMyShareFolder(${folder.id}, '${escapeJsString(folder.display_name)}')">${ICONS.trash}</button>
      ` : ''}
    </div>
  `;
}

function renderFileCard(folders, data) {
  const main = document.getElementById('content-area');
  const crumbs = currentSubpath ? currentSubpath.split('/') : [];

  let rootName = 'No folders';
  if (folders.length > 0) {
    rootName = folders.find(f => f.id == currentFolderId)?.display_name || 'Root';
  }

  let breadcrumbHtml = `<div class="breadcrumb">
    <a onclick="goToPath('')">${escapeHtml(rootName)}</a>`;

  crumbs.forEach((c, i) => {
    const pathTo = crumbs.slice(0, i + 1).join('/');
    breadcrumbHtml += `<span class="sep">/</span>`;
    breadcrumbHtml += i === crumbs.length - 1
      ? `<span class="current">${escapeHtml(c)}</span>`
      : `<a onclick="goToPath('${escapeAttr(pathTo)}')">${escapeHtml(c)}</a>`;
  });
  breadcrumbHtml += `</div>`;

  let mainThreadContent = '';

  if (folders.length === 0) {
    mainThreadContent = `
      <div style="display:flex; justify-content:center; align-items:center; height:100%;">
        ${emptyState(ICONS.folders, 'No folders yet', 'Create one from the sidebar, or ask an admin to grant you access.')}
      </div>
    `;
  } else {
    let rowsHtml = '';
    if (data.entries.length === 0) {
      rowsHtml = `<tr><td colspan="4">${emptyState(ICONS.folder, 'This folder is empty', 'Upload something to see it here.')}</td></tr>`;
    } else {
      sortEntries();
      currentEntries.forEach(entry => {
        const isDir = entry.type === 'dir';
        rowsHtml += `<tr class="file-row">
          <td onclick="${isDir ? `enterFolder('${escapeAttr(entry.name)}')` : `previewFile('${escapeAttr(entry.name)}')`}">
            <div class="file-name">${fileIcon(entry.name, entry.type)}<span>${escapeHtml(entry.name)}</span></div>
          </td>
          <td class="col-right">${isDir ? '—' : formatBytes(entry.size)}</td>
          <td class="col-right">${formatDate(entry.modified)}</td>
          <td>
            <div class="row-actions">
              ${!isDir ? `<button class="icon-btn" title="Download" onclick="event.stopPropagation(); downloadFile('${escapeAttr(entry.name)}')">${ICONS.download}</button>
              <button class="icon-btn" title="Copy link" onclick="event.stopPropagation(); copyLink('${escapeAttr(entry.name)}')">${ICONS.link}</button>` : ''}
            </div>
          </td>
        </tr>`;
      });
    }

    mainThreadContent = `
      ${progressBarHtml('file-upload-progress')}
      <table class="file-table">
        <thead><tr>
          <th onclick="toggleSort('name')">Name</th>
          <th class="col-right" onclick="toggleSort('size')">Size</th>
          <th class="col-right" onclick="toggleSort('modified')">Modified</th>
          <th></th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  }

  const topBarControls = folders.length > 0 ? `
    <div style="flex:1;"></div>
    <span class="text-muted" style="font-size:12px;flex-shrink:0;">${data.entries.length} item${data.entries.length === 1 ? '' : 's'}</span>
    ${currentCanWrite ? `<button class="btn btn-primary btn-sm" onclick="document.getElementById('upload-input').click()">${ICONS.upload} Upload</button>` : ''}
  ` : `<div style="flex:1;"></div>`;

  main.innerHTML = `
    <div class="dm-layout">
      <div class="dm-sidebar">
        <div class="conv-header">
          <div class="conv-header-row">
            <span class="conv-header-label">Folders</span>
            <button class="btn-new-message" onclick="window.showNewFolderInput()">${ICONS.plus} New</button>
          </div>
          <div class="conv-search-wrap hidden" id="new-folder-row">
            <input type="text" id="new-folder-name" placeholder="Folder name (e.g. Photos)" class="conv-search-input" style="padding-left:12px;" onkeypress="if(event.key==='Enter') window.addMyShareFolder()">
          </div>
        </div>
        <div id="files-folder-list" class="dm-conv-list">${folders.map(folderRowHtml).join('')}</div>
      </div>
      <div class="dm-thread">
        <div class="chat-top-bar">
          ${breadcrumbHtml}
          ${topBarControls}
        </div>
        <div style="flex:1;overflow-y:auto;padding:16px 24px;">
          ${mainThreadContent}
        </div>
      </div>
    </div>
    <input type="file" id="upload-input" class="hidden" onchange="uploadFile()">
  `;
}