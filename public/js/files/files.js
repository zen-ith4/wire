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
//     handled by ONE delegated listener. A file action (open / download /
//     share link) reads its target from the row it was clicked in — never
//     from an array position or from module state — and names are only
//     ever written through esc(), never into JavaScript (the old
//     onclick="previewFile('<name>')" pattern was injectable through a
//     crafted filename).
//   - Clicking a file opens the Files viewer for image/video/audio and
//     downloads everything else.
//   - The owner of a folder can delete files and sub-folders from a row's
//     action buttons (files/delete.js: confirm + DELETE request); the row
//     is then removed from the view in place, no reload.
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
import { deleteEntry } from './delete.js';
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
let currentEntries = [];   // raw server order — never sorted or mutated in place

// The folder/subpath `currentEntries` were LISTED FOR. Deliberately separate
// from currentFolderId/currentSubpath, which is where the user is heading:
// loadListing() moves that immediately, while the entries only change when
// the response arrives. Rows are stamped with the pair that produced them.
let listedFolderId = null;
let listedSubpath = '';
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

// Deletions in flight (one key per file/folder, see entryKey()). A row in
// this set is inert, and a second delete for the same entry is ignored.
const deleting = new Set();

// The viewer that is currently open, with the identities of the files it
// can step through, so a deletion can close it if it would leave it
// showing something that no longer exists. close() on a viewer the user
// already closed is a no-op.
let activeViewer = null;

window.addEventListener('wire:logout', () => {
  currentFolderId = null;
  currentSubpath = '';
  currentFolders = [];
  currentEntries = [];
  listedFolderId = null;
  listedSubpath = '';
  currentCanWrite = false;
  myFoldersById = new Map();
  showFolderList = false;
  listingState = 'ready';
  listingError = '';
  filesLoaded = false;
  filesSig = '';
  listingSeq++;
  deleting.clear();
  activeViewer = null;
});

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

const $root = () => document.getElementById('files-root');
const $ = (sel) => $root()?.querySelector(sel);

const isOwner = (folderId) => myFoldersById.has(Number(folderId));

// Identity of one entry: folder + sub-path + name (NUL can't occur in any
// of them, so keys never collide).
const entryKey = (folderId, subpath, name) =>
  `${Number(folderId)}\u0000${subpath}\u0000${name}`;

function filesListUrl(folderId, subpath) {
  return `/api/files/list/${folderId}?subpath=${encodeURIComponent(subpath)}`;
}

// Returns a sorted COPY. The old in-place sort reordered the very array
// other code held (and that the change-detection signature was computed
// from), so what was on screen and what a later lookup saw could differ.
function sortedEntries() {
  const { key, dir } = sortState;

  return [...currentEntries].sort((a, b) => {
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

// Every row is SELF-DESCRIBING: the <li> carries the folder, sub-path and
// name of the file it shows, and its buttons resolve their target from
// that row alone (see rowTarget()). Nothing an action does depends on a
// position in some array or on whatever the module state happens to be
// when the click lands, so a row can never act on a different file than
// the one it displays. Values go through esc(), which escapes quotes, so
// a hostile file name can't break out of the attribute.
function entryRowHtml(entry) {
  const isDir = entry.type === 'dir';
  const name = esc(entry.name);
  const size = isDir ? '' : formatBytes(entry.size);
  const date = formatDate(entry.modified);
  const kind = previewKind(entry.name);

  const meta = [size, date].filter(Boolean).join(' · ');
  const openLabel = isDir
    ? `Open folder ${entry.name}`
    : kind ? `Preview ${entry.name}` : `Download ${entry.name}`;

  const owner = isOwner(listedFolderId);
  const busy = deleting.has(entryKey(listedFolderId, listedSubpath, entry.name));

  const deleteBtn = owner ? `
          <button type="button" class="files-action files-action--danger" data-act="delete"
            aria-label="Delete ${isDir ? 'folder ' : ''}${name}" title="Delete">${ICONS.trash}</button>
  ` : '';

  return `
    <li class="files-row${isDir ? ' is-dir' : ''}${busy ? ' is-deleting' : ''}"${busy ? ' inert aria-busy="true"' : ''}
        data-folder="${Number(listedFolderId)}"
        data-subpath="${esc(listedSubpath)}"
        data-name="${name}"
        data-type="${isDir ? 'dir' : 'file'}"
        data-kind="${kind || ''}"
        data-size="${Number(entry.size) || 0}"
        data-modified="${esc(entry.modified)}">
      <button type="button" class="files-row-main" data-act="open" aria-label="${esc(openLabel)}">
        <span class="files-tile files-tile--${tileKind(entry.name, entry.type)}" aria-hidden="true">${fileIcon(entry.name, entry.type)}</span>
        <span class="files-row-text">
          <span class="files-row-name" title="${name}">${name}</span>
          <span class="files-row-meta">${esc(meta)}</span>
        </span>
      </button>
      <span class="files-row-size">${isDir ? '—' : esc(size)}</span>
      <span class="files-row-date">${esc(date)}</span>
      <span class="files-row-actions">
        ${isDir ? `
          ${deleteBtn}
          <span class="files-row-chevron" aria-hidden="true">${ICONS.chevronRight}</span>
        ` : `
          <button type="button" class="files-action" data-act="download"
            aria-label="Download ${name}" title="Download">${ICONS.download}</button>
          ${owner ? `
            <button type="button" class="files-action" data-act="link"
              aria-label="Create share link for ${name}" title="Share link">${ICONS.link}</button>
          ` : ''}
          ${deleteBtn}
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

  body.innerHTML = `
    <div class="files-table">
      ${sortHeadHtml()}
      <ul class="files-list" aria-label="Files and folders">
        ${sortedEntries().map(entryRowHtml).join('')}
      </ul>
    </div>
  `;
}

// ------------------------------------------------------------
// Data loading
// ------------------------------------------------------------

// Fetches everything the view needs and RETURNS it as a snapshot — it does
// not touch module state. Committing is applyFilesData()'s job, and it is
// only called by a caller that is about to repaint the DOM from it.
//
// That split is the fix for the "wrong file" bug: this function used to
// assign the fresh (raw server order) entries to module state itself. The
// tab-switch revalidation then discarded the result when nothing had
// changed and did not repaint — leaving the DOM (rows in the sorted order
// the user sees) next to state in a different order. State and DOM now
// always change together or not at all.
//
// Resolves to a snapshot, or null when a newer render superseded this one.
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

  return { folders, mineFolders, folderId, subpath, data, sig };
}

// Commits a snapshot from loadFilesData() to module state. Every field the
// painters read is assigned here in one synchronous step; the caller
// repaints straight after.
function applyFilesData({ folders, mineFolders, folderId, subpath, data }) {
  currentFolders = folders;
  myFoldersById = new Map(mineFolders.map((f) => [Number(f.id), f]));
  currentFolderId = folderId;
  currentSubpath = subpath;
  setListing(folderId, subpath, data);
  listingState = 'ready';
  listingError = '';
}

// The entries, the location they belong to and the write permission for
// that location always change together.
function setListing(folderId, subpath, data) {
  listedFolderId = folderId;
  listedSubpath = subpath;
  currentEntries = data.entries || [];
  currentCanWrite = data.can_write || false;
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

    applyFilesData(result);

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

  // The remembered entries only describe the location the user is on if the
  // last listing actually finished for it. If they left while a folder was
  // still loading (or its load failed), memory holds the PREVIOUS folder's
  // files — painting them under the new location would be exactly the
  // mismatch this view must never show. Load it properly instead.
  if (listedFolderId !== currentFolderId || listedSubpath !== currentSubpath) {
    return renderFiles();
  }

  // 1. Local paint: everything needed is already in memory.
  mountShell();
  listingState = 'ready';
  paintAll();

  // 2. Background revalidation. Nothing blocks on this.
  try {
    const result = await loadFilesData(isCurrent);

    // Unchanged, or the user is typing: leave BOTH the DOM and the state
    // exactly as they are (nothing was committed, so they still agree).
    if (!result || result.sig === filesSig || isUserTypingIn(main)) return;

    applyFilesData(result);
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

    setListing(folderId, subpath, data);
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

function enterFolder(target) {
  loadListing({
    folderId: target.folderId,
    subpath: target.subpath ? `${target.subpath}/${target.name}` : target.name,
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

// What a row IS, read from the row itself (see entryRowHtml()). This is the
// only way an action learns which file it belongs to.
function targetFromRow(row) {
  const d = row.dataset;

  return {
    row,
    folderId: Number(d.folder),
    subpath: d.subpath,
    name: d.name,
    type: d.type,
    kind: d.kind || null,
    size: Number(d.size),
    modified: d.modified,
  };
}

/** The row a click landed in, as a target — or null. */
function rowTarget(el) {
  const row = el.closest('.files-row');

  return row ? targetFromRow(row) : null;
}

function viewerItem(target) {
  return {
    name: target.name,
    kind: target.kind,
    size: target.size,
    modified: target.modified,
    getMedia: mediaTokenFor(target.folderId, target.subpath, target.name),
    download: () => downloadTarget(target),
  };
}

function downloadTarget(target) {
  return downloadFromSource(
    folderFileSource(target.folderId, target.subpath, target.name)
  );
}

function openTarget(target) {
  if (target.type === 'dir') {
    enterFolder(target);
    return;
  }

  if (!target.kind) {
    // Not something the viewer can show: a click means "get the file".
    downloadTarget(target);
    return;
  }

  // Everything previewable in this list, in the order it is SHOWN, so the
  // viewer can step through it. Built from the rendered rows (each
  // self-describing), never from module state: what the viewer offers is
  // exactly what is on screen. The identities are captured now — the
  // viewer must not follow later navigation.
  const playable = Array.from(
    target.row.parentElement.querySelectorAll('.files-row:not(.is-dir)')
  )
    .filter((row) => row.dataset.kind)
    .map(targetFromRow);

  const viewer = openViewer({
    items: playable.map(viewerItem),
    index: Math.max(0, playable.findIndex((t) => t.row === target.row)),
  });

  activeViewer = viewer
    ? {
        close: viewer.close,
        items: playable.map(({ folderId, subpath, name }) => ({ folderId, subpath, name })),
      }
    : null;
}

// ------------------------------------------------------------
// Deleting
// ------------------------------------------------------------

const joinPath = (subpath, name) => (subpath ? `${subpath}/${name}` : name);

// Is `item` the deleted entry, or (for a deleted folder) inside it?
function isAffectedByDelete(item, deleted) {
  if (item.folderId !== deleted.folderId) return false;

  const itemPath = joinPath(item.subpath, item.name);
  const deletedPath = joinPath(deleted.subpath, deleted.name);

  return itemPath === deletedPath ||
    (deleted.type === 'dir' && itemPath.startsWith(`${deletedPath}/`));
}

// Puts the row into / out of its in-progress state without repainting the
// list (a repaint would drop focus and scroll anchoring). Repaints get the
// same state from entryRowHtml() via the `deleting` set.
function setRowBusy(target, busy) {
  const rows = $('#files-body')?.querySelectorAll('.files-row') || [];

  for (const row of rows) {
    const d = row.dataset;

    if (
      Number(d.folder) === target.folderId &&
      d.subpath === target.subpath &&
      d.name === target.name
    ) {
      row.classList.toggle('is-deleting', busy);
      row.toggleAttribute('inert', busy);

      if (busy) row.setAttribute('aria-busy', 'true');
      else row.removeAttribute('aria-busy');
    }
  }
}

// Takes the deleted entry out of the list that is on screen, in place.
// Only if the user is still looking at the listing it belonged to —
// otherwise there is nothing on screen to update, and filesSig = ''
// makes the next tab-switch revalidation repaint from the server.
function removeEntryFromView(target) {
  filesSig = '';

  if (!$root() || listedFolderId !== target.folderId || listedSubpath !== target.subpath) return;

  currentEntries = currentEntries.filter((entry) => entry.name !== target.name);

  paintHeader();
  paintList();
  announce(`${target.name} deleted`);

  // The button that had focus is gone; keep keyboard users in the list.
  if (!$root().contains(document.activeElement)) {
    $('#files-body')?.focus({ preventScroll: true });
  }
}

async function deleteTarget(target) {
  if (!isOwner(target.folderId)) return;

  const key = entryKey(target.folderId, target.subpath, target.name);
  if (deleting.has(key)) return;

  const { status, error } = await deleteEntry(target, {
    onStart: () => {
      deleting.add(key);
      setRowBusy(target, true);
    },
  });

  if (status === 'cancelled') return;

  deleting.delete(key);

  if (status === 'failed') {
    setRowBusy(target, false);

    // Already gone (deleted elsewhere): the row is stale, reload it.
    if (/not found/i.test(error?.message || '') && $root() &&
        listedFolderId === target.folderId && listedSubpath === target.subpath) {
      loadListing({ folderId: target.folderId, subpath: target.subpath });
    }

    return;
  }

  if (activeViewer?.items.some((item) => isAffectedByDelete(item, target))) {
    activeViewer.close();
    activeViewer = null;
  }

  removeEntryFromView(target);
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

    // Each of these three acts on the row the button is IN.
    case 'open': {
      const target = rowTarget(el);
      if (target) openTarget(target);
      break;
    }

    case 'download': {
      const target = rowTarget(el);
      if (target) downloadTarget(target);
      break;
    }

    case 'delete': {
      const target = rowTarget(el);
      if (target) deleteTarget(target);
      break;
    }

    case 'link': {
      const target = rowTarget(el);
      if (target) {
        openLinkDialog({
          folderId: target.folderId,
          subpath: target.subpath,
          file: target.name,
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
