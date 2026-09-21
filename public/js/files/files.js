// ============================================================
// Files tab ("My Files")
//
// Architecture (unchanged): app-router -> showFiles()/renderFiles(),
// data from /api/files/* and /api/share/*, view-ownership through
// core/view-session.js claimRender(), stale-while-revalidate on tab
// switches, uploads through files/upload.js, downloads through
// files/download.js (native Capacitor vs browser/Electron).
//
// What changed:
//   - The layout is mounted ONCE (#files-root). Navigating folders,
//     sorting, uploading and sharing repaint only the region that
//     changed (sidebar / header / list) instead of replacing the whole
//     view and showing a full-screen spinner.
//   - No inline event attributes and no window.* globals. All input is
//     handled by ONE delegated listener that looks rows up by index or
//     numeric id, so file/folder names are never interpolated into
//     JavaScript (the old onclick="previewFile('<name>')" pattern was
//     injectable through a crafted filename).
//   - Clicking a file opens the Files viewer for image/video/audio and
//     downloads everything else.
// ============================================================

import { api } from '../core/api.js';
import { resolveServerUrl } from '../core/server.js';
import { claimRender, isUserTypingIn } from '../core/view-session.js';

import { ICONS, fileIcon } from '../icons.js';
import {
  showToast,
  loadingState,
  emptyState,
  formatBytes,
  formatDate,
} from '../core/utils.js';

import {
  progressBarHtml,
  showUploadProgress,
  updateUploadProgress,
  hideUploadProgress,
  xhrUpload,
} from './upload.js';

import { esc } from './html.js';
import { previewKind, tileKind } from './kinds.js';
import { downloadFromSource, folderFileSource } from './download.js';
import { openViewer } from './viewer.js';
import { openLinkDialog } from './links.js';
import {
  openShareDialog,
  createShareFolder,
  deleteShareFolder,
  validateFolderName,
} from './share.js';

// ------------------------------------------------------------
// State (memory only; dropped on logout)
// ------------------------------------------------------------

let currentFolderId = null;
let currentSubpath = '';
let currentFolders = [];
let currentEntries = [];
let currentCanWrite = false;
let myFoldersById = new Map();
let sortState = { key: 'name', dir: 1 };

// Phones (<=760px, see responsive.css): the folder list and the file
// listing are two full-screen panes. Which one shows has to live here
// because the layout can be repainted at any time. Desktop ignores it.
let showFolderList = false;

// 'ready' | 'loading' | 'error' — state of the file LIST only.
let listingState = 'ready';
let listingError = '';

let filesLoaded = false; // a complete listing has been painted at least once
let filesSig = '';       // signature of the data currently painted

let listingSeq = 0;      // latest listing request wins

window.addEventListener('wire:logout', () => {
  currentFolderId = null;
  currentSubpath = '';
  currentFolders = [];
  currentEntries = [];
  currentCanWrite = false;
  myFoldersById = new Map();
  showFolderList = false;
  listingState = 'ready';
  listingError = '';
  filesLoaded = false;
  filesSig = '';
  listingSeq++;
});

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

const $root = () => document.getElementById('files-root');
const $ = (sel) => $root()?.querySelector(sel);

const isOwner = (folderId) => myFoldersById.has(Number(folderId));

function filesListUrl(folderId, subpath) {
  return `/api/files/list/${folderId}?subpath=${encodeURIComponent(subpath)}`;
}

function sortEntries() {
  const { key, dir } = sortState;

  currentEntries.sort((a, b) => {
    // Folders always first, whatever the sort.
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;

    let cmp = 0;

    if (key === 'name') {
      cmp = a.name.localeCompare(b.name, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    } else if (key === 'size') {
      cmp = a.size - b.size;
    } else if (key === 'modified') {
      cmp = new Date(a.modified) - new Date(b.modified);
    }

    return cmp * dir;
  });
}

function announce(text) {
  const live = $('.files-live');
  if (live) live.textContent = text;
}

// ------------------------------------------------------------
// Shell (mounted once) + region painters
// ------------------------------------------------------------

function mountShell() {
  const main = document.getElementById('content-area');

  main.innerHTML = `
    <div class="files-layout" id="files-root">
      <aside class="files-sidebar" aria-label="Folders">
        <div class="files-sidebar-head">
          <h2 class="files-sidebar-title">Folders</h2>
          <button type="button" class="files-newbtn" data-act="new-folder" aria-expanded="false" aria-controls="files-newfolder">
            ${ICONS.plus}<span>New</span>
          </button>
        </div>

        <form class="files-newfolder" id="files-newfolder" data-form="new-folder" hidden novalidate>
          <label class="sr-only" for="new-folder-name">New folder name</label>
          <div class="files-newfolder-row">
            <input
              type="text"
              id="new-folder-name"
              class="files-input"
              placeholder="Folder name"
              maxlength="60"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
            >
            <button type="submit" class="btn btn-primary files-btn-sm">Create</button>
            <button type="button" class="btn files-btn-sm" data-act="new-folder-cancel">Cancel</button>
          </div>
          <p class="files-newfolder-error" role="alert"></p>
        </form>

        <div class="files-folder-scroll">
          <div id="files-folder-list"></div>
        </div>
      </aside>

      <section class="files-main" aria-label="Files">
        <header class="files-header">
          <button type="button" class="files-back" data-act="back" aria-label="Back to folders">
            ${ICONS.arrowLeft}
          </button>
          <nav class="files-crumbs" aria-label="Breadcrumb"></nav>
          <span class="files-count" aria-hidden="true"></span>
          <button type="button" class="btn btn-primary files-upload" data-act="upload" aria-label="Upload files" hidden>
            ${ICONS.upload}<span>Upload</span>
          </button>
        </header>

        ${progressBarHtml('file-upload-progress')}

        <div class="files-toolbar">
          <label class="sr-only" for="files-sort-key">Sort by</label>
          <select id="files-sort-key" class="files-sort-select" data-change="sort-key">
            <option value="name">Name</option>
            <option value="modified">Date modified</option>
            <option value="size">Size</option>
          </select>
          <button type="button" class="files-sort-dir" data-act="sort-dir"></button>
        </div>

        <div class="files-body" id="files-body" tabindex="-1"></div>
        <p class="sr-only files-live" role="status" aria-live="polite"></p>
      </section>

      <input type="file" id="upload-input" class="hidden" multiple>
    </div>
  `;

  const root = $root();

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('change', onChange);
}

function paintAll() {
  paintSidebar();
  paintHeader();
  paintList();
  syncPane();
}

function syncPane() {
  const root = $root();
  if (!root) return;

  // Phones: show the folder pane only when asked to (or when there is
  // nothing else to show). Desktop CSS shows both panes regardless.
  root.classList.toggle('is-list', showFolderList || currentFolders.length === 0);
}

// ---- sidebar ----

function folderSubtitle(folder, mine) {
  if (mine) {
    return mine.shared_with_count > 0
      ? `Shared with ${mine.shared_with_count}`
      : 'Only you';
  }

  return folder.can_write ? 'Shared with you · Can edit' : 'Shared with you · View only';
}

function folderRowHtml(folder) {
  const id = Number(folder.id);
  const active = id === Number(currentFolderId);
  const mine = myFoldersById.get(id);
  const name = esc(folder.display_name);

  return `
    <li class="files-folder${active ? ' is-active' : ''}" data-folder="${id}">
      <button type="button" class="files-folder-main" data-act="folder" data-folder="${id}"${active ? ' aria-current="true"' : ''}>
        <span class="files-tile files-tile--folder" aria-hidden="true">${ICONS.folder}</span>
        <span class="files-folder-text">
          <span class="files-folder-name">${name}</span>
          <span class="files-folder-sub">${esc(folderSubtitle(folder, mine))}</span>
        </span>
      </button>
      ${mine ? `
        <span class="files-folder-actions">
          <button type="button" class="files-action" data-act="folder-share" data-folder="${id}"
            aria-label="Share folder ${name}" title="Share">${ICONS.userPlus}</button>
          <button type="button" class="files-action files-action--danger" data-act="folder-delete" data-folder="${id}"
            aria-label="Delete folder ${name}" title="Delete">${ICONS.trash}</button>
        </span>
      ` : ''}
    </li>
  `;
}

function paintSidebar() {
  const host = $('#files-folder-list');
  if (!host) return;

  if (currentFolders.length === 0) {
    host.innerHTML = `
      <div class="files-side-empty">
        ${emptyState(
          ICONS.folders,
          'No folders yet',
          'Create one with “New”, or ask an admin to grant you access.'
        )}
      </div>
    `;
    return;
  }

  const mine = currentFolders.filter((f) => myFoldersById.has(Number(f.id)));
  const shared = currentFolders.filter((f) => !myFoldersById.has(Number(f.id)));

  const group = (label, list) => list.length ? `
    ${label ? `<h3 class="files-group">${label}</h3>` : ''}
    <ul class="files-folder-list">${list.map(folderRowHtml).join('')}</ul>
  ` : '';

  const labelled = mine.length > 0 && shared.length > 0;

  host.innerHTML =
    group(labelled ? 'Your folders' : '', mine) +
    group(labelled ? 'Shared with you' : '', shared);
}

// ---- header ----

function paintHeader() {
  const root = $root();
  if (!root) return;

  const hasFolders = currentFolders.length > 0;
  const rootName =
    currentFolders.find((f) => Number(f.id) === Number(currentFolderId))?.display_name ||
    'Files';

  const segments = currentSubpath ? currentSubpath.split('/') : [];

  // Every crumb is a <button> looked up by depth (0 = folder root), so
  // no path text is ever put in an attribute.
  const items = [
    { label: rootName, depth: 0, last: segments.length === 0 },
    ...segments.map((label, i) => ({
      label,
      depth: i + 1,
      last: i === segments.length - 1,
    })),
  ];

  const crumbs = $('.files-crumbs');

  crumbs.hidden = !hasFolders;
  crumbs.innerHTML = hasFolders ? `
    <ol class="files-crumb-list">
      ${items.map((c) => `
        <li class="files-crumb${c.last ? ' is-current' : ''}${c.depth === 0 ? ' is-root' : ''}">
          ${c.last
            ? `<span class="files-crumb-text" aria-current="page" title="${esc(c.label)}">${esc(c.label)}</span>`
            : `<button type="button" class="files-crumb-btn" data-act="crumb" data-depth="${c.depth}" title="${esc(c.label)}">${esc(c.label)}</button>`}
        </li>
      `).join('')}
    </ol>
  ` : '';

  const count = currentEntries.length;
  const countEl = $('.files-count');

  countEl.textContent =
    hasFolders && listingState === 'ready'
      ? `${count} item${count === 1 ? '' : 's'}`
      : '';

  const upload = $('.files-upload');
  upload.hidden = !(hasFolders && currentCanWrite);

  // Back button: in a sub-folder it goes up one level; at the folder
  // root it reveals the folder list. Only visible on phones.
  const back = $('.files-back');
  const inSub = currentSubpath !== '';

  back.setAttribute('aria-label', inSub ? 'Up one level' : 'Back to folders');
  back.title = inSub ? 'Up one level' : 'Folders';

  // Sort controls (phone toolbar; desktop uses the column headers)
  const keySelect = $('#files-sort-key');
  if (keySelect) keySelect.value = sortState.key;

  const dirBtn = $('.files-sort-dir');
  if (dirBtn) {
    const asc = sortState.dir === 1;
    dirBtn.textContent = asc ? 'A → Z' : 'Z → A';
    dirBtn.setAttribute('aria-label', asc ? 'Ascending. Switch to descending' : 'Descending. Switch to ascending');
  }

  $root().classList.toggle('has-folders', hasFolders);
}

// ---- list ----

function skeletonHtml() {
  return `
    <ul class="files-list files-list--skeleton" aria-hidden="true">
      ${Array.from({ length: 7 }, () => `
        <li class="files-skel"><span class="files-skel-tile"></span><span class="files-skel-line"></span></li>
      `).join('')}
    </ul>
  `;
}

function sortHeadHtml() {
  const th = (key, label, cls = '') => {
    const active = sortState.key === key;
    const state = active
      ? (sortState.dir === 1 ? ', sorted ascending' : ', sorted descending')
      : '';

    return `
      <span class="files-th ${cls}">
        <button type="button" class="files-sort${active ? ' is-active' : ''}" data-act="sort" data-key="${key}"
          aria-label="Sort by ${label}${state}">
          ${label}<span class="files-sort-caret" aria-hidden="true">${active ? (sortState.dir === 1 ? '↑' : '↓') : ''}</span>
        </button>
      </span>
    `;
  };

  return `
    <div class="files-list-head">
      ${th('name', 'Name')}
      ${th('size', 'Size', 'is-right')}
      ${th('modified', 'Modified', 'is-right')}
      <span class="files-th files-th--actions" aria-hidden="true"></span>
    </div>
  `;
}

function entryRowHtml(entry, index) {
  const isDir = entry.type === 'dir';
  const name = esc(entry.name);
  const size = isDir ? '' : formatBytes(entry.size);
  const date = formatDate(entry.modified);
  const kind = previewKind(entry.name);

  const meta = [size, date].filter(Boolean).join(' · ');
  const openLabel = isDir
    ? `Open folder ${entry.name}`
    : kind ? `Preview ${entry.name}` : `Download ${entry.name}`;

  return `
    <li class="files-row${isDir ? ' is-dir' : ''}">
      <button type="button" class="files-row-main" data-act="open" data-i="${index}" aria-label="${esc(openLabel)}">
        <span class="files-tile files-tile--${tileKind(entry.name, entry.type)}" aria-hidden="true">${fileIcon(entry.name, entry.type)}</span>
        <span class="files-row-text">
          <span class="files-row-name" title="${name}">${name}</span>
          <span class="files-row-meta">${esc(meta)}</span>
        </span>
      </button>
      <span class="files-row-size">${isDir ? '—' : esc(size)}</span>
      <span class="files-row-date">${esc(date)}</span>
      <span class="files-row-actions">
        ${isDir ? `<span class="files-row-chevron" aria-hidden="true">${ICONS.chevronRight}</span>` : `
          <button type="button" class="files-action" data-act="download" data-i="${index}"
            aria-label="Download ${name}" title="Download">${ICONS.download}</button>
          ${isOwner(currentFolderId) ? `
            <button type="button" class="files-action" data-act="link" data-i="${index}"
              aria-label="Create share link for ${name}" title="Share link">${ICONS.link}</button>
          ` : ''}
        `}
      </span>
    </li>
  `;
}

function paintList() {
  const body = $('#files-body');
  if (!body) return;

  body.setAttribute('aria-busy', listingState === 'loading' ? 'true' : 'false');

  if (currentFolders.length === 0) {
    body.innerHTML = `
      <div class="files-empty">
        ${emptyState(
          ICONS.folders,
          'No folders yet',
          'Create one from the Folders list, or ask an admin to grant you access.'
        )}
        <button type="button" class="btn btn-primary files-empty-cta files-only-phone" data-act="show-folders">Open folders</button>
      </div>
    `;
    return;
  }

  if (listingState === 'loading') {
    body.innerHTML = skeletonHtml();
    return;
  }

  if (listingState === 'error') {
    body.innerHTML = `
      <div class="files-empty" role="alert">
        ${emptyState(ICONS.empty, 'Couldn’t load this folder', esc(listingError))}
        <button type="button" class="btn files-empty-cta" data-act="retry">Try again</button>
      </div>
    `;
    return;
  }

  if (currentEntries.length === 0) {
    body.innerHTML = `
      <div class="files-empty">
        ${emptyState(
          ICONS.folder,
          'This folder is empty',
          currentCanWrite
            ? 'Upload files, or drop them anywhere in this window.'
            : 'Nothing has been added yet.'
        )}
        ${currentCanWrite ? `<button type="button" class="btn btn-primary files-empty-cta" data-act="upload">${ICONS.upload}<span>Upload files</span></button>` : ''}
      </div>
    `;
    return;
  }

  sortEntries();

  body.innerHTML = `
    <div class="files-table">
      ${sortHeadHtml()}
      <ul class="files-list" aria-label="Files and folders">
        ${currentEntries.map(entryRowHtml).join('')}
      </ul>
    </div>
  `;
}

// ------------------------------------------------------------
// Data loading
// ------------------------------------------------------------

// Fetches everything the view needs and commits it in one step (a
// failed request never leaves folders from one response next to
// entries from another). Resolves to { folders, data, sig }, or null
// when a newer render superseded this one.
async function loadFilesData(isCurrent) {
  // The listing only depends on the folders response to *validate* the
  // remembered folder, so start it in parallel when one is known.
  const guessId = currentFolderId;
  const guessSubpath = currentSubpath;
  const guess = guessId ? api(filesListUrl(guessId, guessSubpath)) : null;

  if (guess) guess.catch(() => {}); // a discarded guess must not be unhandled

  const [folders, mineResponse] = await Promise.all([
    api('/api/files/folders'),
    api('/api/share/mine'),
  ]);

  if (!isCurrent()) return null;

  const mineFolders = Array.isArray(mineResponse)
    ? mineResponse
    : (mineResponse.folders || []);

  let folderId = null;
  let subpath = '';
  let data = { entries: [], can_write: false };

  if (folders.length > 0) {
    const stillValid = guessId && folders.find((f) => f.id == guessId);

    if (stillValid) {
      folderId = guessId;
      subpath = guessSubpath;
    } else {
      folderId = folders[0].id;
      subpath = '';
    }

    data = stillValid && guess
      ? await guess
      : await api(filesListUrl(folderId, subpath));

    if (!isCurrent()) return null;
  }

  const sig = JSON.stringify([
    folders,
    mineFolders,
    folderId,
    subpath,
    data.entries || [],
    !!data.can_write,
  ]);

  currentFolders = folders;
  myFoldersById = new Map(mineFolders.map((f) => [Number(f.id), f]));
  currentFolderId = folderId;
  currentSubpath = subpath;
  currentEntries = data.entries || [];
  currentCanWrite = data.can_write || false;
  listingState = 'ready';
  listingError = '';

  return { folders, data, sig };
}

function filesErrorHtml(e) {
  return `<div class="card">${emptyState(ICONS.empty, 'Something went wrong', esc(e.message))}</div>`;
}

/** Forced fresh load of everything (first visit, folder created/deleted). */
export async function renderFiles() {
  // #content-area is shared by every view: only write to it while this
  // render still owns it (see core/view-session.js).
  const isCurrent = claimRender('files');
  if (!isCurrent()) return;

  const main = document.getElementById('content-area');
  const mounted = !!$root();

  // A repaint of an already-mounted view keeps the layout and only
  // shows the skeleton in the list; a first load shows the spinner.
  if (mounted) {
    listingState = 'loading';
    paintList();
  } else {
    main.innerHTML = loadingState();
  }

  try {
    const result = await loadFilesData(isCurrent);
    if (!result) return;

    if (!$root()) mountShell();

    paintAll();

    filesLoaded = true;
    filesSig = result.sig;

  } catch (e) {
    if (!isCurrent()) return;

    if (mounted && $root()) {
      listingState = 'error';
      listingError = e.message;
      paintList();
    } else {
      main.innerHTML = filesErrorHtml(e);
    }
  }
}

/** Tab switch: paint from memory instantly, revalidate in the background. */
export async function showFiles() {
  if (!filesLoaded) return renderFiles();

  const isCurrent = claimRender('files');
  if (!isCurrent()) return;

  const main = document.getElementById('content-area');

  // 1. Local paint: everything needed is already in memory.
  mountShell();
  listingState = 'ready';
  paintAll();

  // 2. Background revalidation. Nothing blocks on this.
  try {
    const result = await loadFilesData(isCurrent);

    if (!result || result.sig === filesSig || isUserTypingIn(main)) return;

    paintAll();
    filesSig = result.sig;

  } catch (e) {
    // Keep showing what we have; a real failure surfaces on the next
    // action (api() already handles an expired session itself).
    console.warn('[Files] Background refresh failed:', e);
  }
}

// ------------------------------------------------------------
// Navigation inside the view (partial repaints)
// ------------------------------------------------------------

async function loadListing({ folderId = currentFolderId, subpath = currentSubpath, focusBody = false } = {}) {
  const isCurrent = claimRender('files');
  const seq = ++listingSeq;

  currentFolderId = folderId;
  currentSubpath = subpath;
  listingState = 'loading';

  paintSidebar();
  paintHeader();
  paintList();
  syncPane();

  try {
    const data = await api(filesListUrl(folderId, subpath));

    if (!isCurrent() || seq !== listingSeq) return;

    currentEntries = data.entries || [];
    currentCanWrite = data.can_write || false;
    listingState = 'ready';
    listingError = '';

    filesSig = ''; // force the next tab-switch revalidation to repaint

    paintHeader();
    paintList();

    const label = currentSubpath ? currentSubpath.split('/').pop() : $('.files-crumb.is-root')?.textContent?.trim();
    announce(`${label || 'Folder'}, ${currentEntries.length} item${currentEntries.length === 1 ? '' : 's'}`);

    if (focusBody) $('#files-body')?.focus({ preventScroll: true });

  } catch (e) {
    if (!isCurrent() || seq !== listingSeq) return;

    listingState = 'error';
    listingError = e.message;
    paintHeader();
    paintList();
  }
}

function selectFolder(id) {
  showFolderList = false;
  loadListing({ folderId: Number(id), subpath: '', focusBody: true });
}

function goToDepth(depth) {
  const parts = currentSubpath ? currentSubpath.split('/') : [];

  loadListing({ subpath: parts.slice(0, depth).join('/'), focusBody: true });
}

function enterFolder(name) {
  loadListing({
    subpath: currentSubpath ? `${currentSubpath}/${name}` : name,
    focusBody: true,
  });
}

// ------------------------------------------------------------
// Opening files
// ------------------------------------------------------------

function mediaTokenFor(folderId, subpath, file) {
  const query = `subpath=${encodeURIComponent(subpath)}&file=${encodeURIComponent(file)}`;

  return async () => {
    const media = await api(`/api/files/media-token/${folderId}?${query}`);

    return {
      url: resolveServerUrl(
        `/api/files/stream/${folderId}?${query}&token=${encodeURIComponent(media.token)}`
      ),
      mime: media.mime,
      size: media.size,
      modified: media.modified,
    };
  };
}

function viewerItem(folderId, subpath, entry) {
  return {
    name: entry.name,
    kind: previewKind(entry.name),
    size: entry.size,
    modified: entry.modified,
    getMedia: mediaTokenFor(folderId, subpath, entry.name),
    download: () => downloadFromSource(folderFileSource(folderId, subpath, entry.name)),
  };
}

function downloadEntry(entry) {
  return downloadFromSource(
    folderFileSource(currentFolderId, currentSubpath, entry.name)
  );
}

function openEntry(entry) {
  if (entry.type === 'dir') {
    enterFolder(entry.name);
    return;
  }

  if (!previewKind(entry.name)) {
    // Not something the viewer can show: a click means "get the file".
    downloadEntry(entry);
    return;
  }

  // Everything previewable in this folder, in the order it is shown,
  // so the viewer can step through it. Capture folder/subpath now: the
  // viewer must not follow later navigation.
  const folderId = currentFolderId;
  const subpath = currentSubpath;

  const playable = currentEntries.filter(
    (e) => e.type !== 'dir' && previewKind(e.name)
  );

  openViewer({
    items: playable.map((e) => viewerItem(folderId, subpath, e)),
    index: Math.max(0, playable.indexOf(entry)),
  });
}

// ------------------------------------------------------------
// Uploads
// ------------------------------------------------------------

async function uploadOneDriveFile(file, progressLabel, folderId, subpath) {
  const form = new FormData();

  form.append('file', file);
  form.append('subpath', subpath);

  showUploadProgress('file-upload-progress', progressLabel || file.name);

  try {
    await xhrUpload(
      `/api/files/upload/${folderId}`,
      form,
      (pct) => updateUploadProgress('file-upload-progress', pct)
    );

    return true;

  } catch (e) {
    showToast(`${file.name}: ${e.message}`, 'error');
    return false;

  } finally {
    hideUploadProgress('file-upload-progress');
  }
}

export async function uploadFilesMultiple(fileList) {
  if (!currentCanWrite) {
    showToast("You don't have write access to this folder", 'error');
    return;
  }

  const files = Array.from(fileList);

  // The destination is fixed when the upload starts, even if the user
  // opens another folder while a big file is still going up.
  const folderId = currentFolderId;
  const subpath = currentSubpath;

  let succeeded = 0;

  for (let i = 0; i < files.length; i++) {
    const label = files.length > 1
      ? `${files[i].name} (${i + 1}/${files.length})`
      : files[i].name;

    if (await uploadOneDriveFile(files[i], label, folderId, subpath)) {
      succeeded++;
    }
  }

  if (succeeded > 0) {
    // Repaint the listing only if the user is still looking at the
    // folder that received the files.
    if ($root() && folderId === currentFolderId && subpath === currentSubpath) {
      loadListing({ folderId, subpath });
    }

    showToast(
      succeeded === files.length
        ? `Uploaded ${succeeded} file${succeeded === 1 ? '' : 's'}`
        : `Uploaded ${succeeded}/${files.length} files`,
      succeeded === files.length ? 'success' : 'error'
    );
  }
}

export function canUploadToCurrentFolder() {
  return currentCanWrite;
}

// ------------------------------------------------------------
// Event handling (one delegated listener per mount)
// ------------------------------------------------------------

function entryFrom(target) {
  const i = Number(target.closest('[data-i]')?.dataset.i);

  return Number.isInteger(i) ? currentEntries[i] : undefined;
}

function toggleNewFolder(open) {
  const form = $('#files-newfolder');
  const btn = $('[data-act="new-folder"]');
  if (!form) return;

  form.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));

  if (open) {
    $('#new-folder-name').focus();
  } else {
    $('#new-folder-name').value = '';
    $('.files-newfolder-error').textContent = '';
    btn.focus({ preventScroll: true });
  }
}

async function refreshEverything() {
  filesLoaded = false;
  await renderFiles();
}

function onClick(event) {
  const el = event.target.closest('[data-act]');
  if (!el || !$root()?.contains(el)) return;

  const act = el.dataset.act;

  switch (act) {
    case 'folder': selectFolder(el.dataset.folder); break;

    case 'folder-share': {
      const id = Number(el.dataset.folder);
      const folder = currentFolders.find((f) => Number(f.id) === id);
      if (!folder) break;

      openShareDialog({
        folderId: id,
        folderName: folder.display_name,
        onChanged: (count) => {
          const mine = myFoldersById.get(id);
          if (mine) mine.shared_with_count = count;
          filesSig = '';
          paintSidebar();
        },
      });
      break;
    }

    case 'folder-delete': {
      const id = Number(el.dataset.folder);
      const folder = currentFolders.find((f) => Number(f.id) === id);
      if (!folder) break;

      deleteShareFolder(id, folder.display_name).then((deleted) => {
        if (deleted) refreshEverything();
      });
      break;
    }

    case 'new-folder': toggleNewFolder(true); break;
    case 'new-folder-cancel': toggleNewFolder(false); break;

    case 'back':
      if (currentSubpath) {
        const parts = currentSubpath.split('/');
        loadListing({ subpath: parts.slice(0, -1).join('/'), focusBody: true });
      } else {
        showFolderList = true;
        syncPane();
      }
      break;

    case 'show-folders': showFolderList = true; syncPane(); break;

    case 'crumb': goToDepth(Number(el.dataset.depth)); break;

    case 'sort': {
      const key = el.dataset.key;

      sortState = sortState.key === key
        ? { key, dir: -sortState.dir }
        : { key, dir: 1 };

      paintHeader();
      paintList();
      break;
    }

    case 'sort-dir':
      sortState = { ...sortState, dir: -sortState.dir };
      paintHeader();
      paintList();
      break;

    case 'open': {
      const entry = entryFrom(el);
      if (entry) openEntry(entry);
      break;
    }

    case 'download': {
      const entry = entryFrom(el);
      if (entry) downloadEntry(entry);
      break;
    }

    case 'link': {
      const entry = entryFrom(el);
      if (entry) {
        openLinkDialog({
          folderId: currentFolderId,
          subpath: currentSubpath,
          file: entry.name,
        });
      }
      break;
    }

    case 'upload': $('#upload-input')?.click(); break;

    case 'retry': loadListing(); break;

    default: break;
  }
}

async function onSubmit(event) {
  const form = event.target.closest('[data-form="new-folder"]');
  if (!form) return;

  event.preventDefault();

  const input = $('#new-folder-name');
  const errorEl = $('.files-newfolder-error');
  const problem = validateFolderName(input.value);

  errorEl.textContent = problem;
  if (problem) {
    input.focus();
    return;
  }

  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;

  try {
    await createShareFolder(input.value);
    toggleNewFolder(false);
    await refreshEverything();
    showToast('Folder created', 'success');

  } catch (e) {
    errorEl.textContent = e.message;

  } finally {
    submit.disabled = false;
  }
}

function onChange(event) {
  const target = event.target;

  if (target.id === 'upload-input') {
    const files = Array.from(target.files || []);

    // Reset first so choosing the same file again still fires 'change'.
    target.value = '';

    if (files.length) uploadFilesMultiple(files);
    return;
  }

  if (target.dataset.change === 'sort-key') {
    sortState = { key: target.value, dir: 1 };
    paintHeader();
    paintList();
  }
}
