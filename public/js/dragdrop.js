// ============================================================
// Drag & drop upload
//
// Single window-level drop zone that detects the currently open view
// (Group Chat / DM / My Files) and forwards dropped files to the
// existing upload functions.
// ============================================================
import { uploadChatFiles } from './chat.js';
import { uploadDmFiles, getDmActivePeer } from './dm.js';
import { uploadFilesMultiple, canUploadToCurrentFolder } from './files.js';
import { showToast } from './utils.js';

let dragDepth = 0;
let overlay = null;
let subEl = null;
let initialized = false;

function isFileDrag(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes('Files');
}

function blockEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

function setOverlayActive(active) {
  if (!overlay) return;
  overlay.classList.toggle('active', active);
}

function resetOverlay() {
  dragDepth = 0;
  setOverlayActive(false);
}

function getDropContext() {
  const hasDmView = !!document.getElementById('dm-messages');
  const hasChatView = !!document.getElementById('chat-messages');
  const hasFilesView = !!document.getElementById('folder-select');
  const hasDmList = !!document.getElementById('dm-conv-list');

  if (hasDmView && getDmActivePeer()) {
    return {
      type: 'dm',
      message: `Send to ${getDmActivePeer().username}`,
    };
  }
  if (hasChatView) {
    return {
      type: 'chat',
      message: 'Files will be posted to Group Chat',
    };
  }
  if (hasFilesView) {
    return {
      type: 'files',
      message: canUploadToCurrentFolder()
        ? 'Files will be added to this folder'
        : "You don't have write access to this folder",
    };
  }
  if (hasDmList) {
    return {
      type: 'dm-list',
      message: 'Open a conversation first',
    };
  }
  return {
    type: 'unsupported',
    message: "This page doesn't support drag & drop uploads",
  };
}

function handleDrop(files) {
  const { type } = getDropContext();

  if (type === 'dm') {
    uploadDmFiles(files);
    return;
  }
  if (type === 'chat') {
    uploadChatFiles(files);
    return;
  }
  if (type === 'files') {
    if (!canUploadToCurrentFolder()) {
      showToast("You don't have write access to this folder", 'error');
      return;
    }
    uploadFilesMultiple(files);
    return;
  }
  if (type === 'dm-list') {
    showToast('Open a conversation first', 'error');
    return;
  }
  showToast("Drag & drop isn't available on this page", 'info');
}

export function initDragDrop() {
  if (initialized) return;
  initialized = true;

  overlay = document.getElementById('dropzone-overlay');
  subEl = document.getElementById('dropzone-sub');
  if (!overlay) return; // markup missing, fail quietly

  const updateSubtitle = () => {
    if (!subEl) return;
    subEl.textContent = getDropContext().message;
  };

  window.addEventListener('dragenter', (event) => {
    // preventDefault()/stopPropagation() always run here, even if
    // isFileDrag() can't confirm a file yet: some browsers (older
    // Safari in particular) don't reliably populate
    // dataTransfer.types until the 'drop' event itself, so gating
    // preventDefault() behind that check can let a 'dragenter' slip
    // through unblocked — and once that happens the browser may
    // handle the eventual drop itself (e.g. navigating to/opening
    // the dropped file) instead of ever reaching our 'drop' handler.
    // isFileDrag() still gates the *overlay UI*, since we only want
    // to show "drop to upload" for actual file drags.
    blockEvent(event);
    if (!isFileDrag(event)) return;
    dragDepth += 1;
    updateSubtitle();
    setOverlayActive(true);
  });

  window.addEventListener('dragover', (event) => {
    // Same reasoning as 'dragenter' above — this one is the event
    // that actually determines whether the browser allows a 'drop'
    // to fire at all, so it must always be blocked unconditionally.
    blockEvent(event);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  });

  window.addEventListener('dragleave', (event) => {
    blockEvent(event);
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setOverlayActive(false);
  });

  window.addEventListener('dragend', resetOverlay);

  window.addEventListener('drop', (event) => {
    // Always blocked — this is what stops the browser from
    // navigating to/opening the dropped file in place of our upload
    // flow. Whether it actually was a file drop is then determined
    // the reliable way: checking event.dataTransfer.files directly,
    // which (unlike 'types' during dragenter/dragover) browsers
    // populate correctly by the time 'drop' fires.
    blockEvent(event);
    resetOverlay();

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    handleDrop(files);
  });

  // Safety net: if the overlay itself gets events, don't let the browser
  // do its default “open the file” nonsense.
  overlay.addEventListener('dragover', blockEvent);
  overlay.addEventListener('drop', blockEvent);
}
