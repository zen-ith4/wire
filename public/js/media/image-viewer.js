// ============================================================
// Image viewer / lightbox
//
// Opens when a chat/DM image attachment is clicked (wired in
// attachments.js's renderAttachment() -> window.openImageViewer,
// same pattern as window.downloadAttachment). Reuses the blob URL
// that loadChatImage() already fetched and stored on the attachment
// element (see attachments.js) instead of loading the image again,
// and reuses downloadAttachment() itself for the Download button.
// ============================================================

import { downloadAttachment } from './attachments.js';
import { avatarHtml } from '../ui/avatar.js';

// Cycle through a few sensible zoom levels rather than free-form
// scaling — keeps the image centered and predictable to reset.
const ZOOM_LEVELS = [1, 1.75, 2.5];

let zoomIndex = 0;
let current = null; // { msgId, scope, filename } for the open image

// Pan state (only meaningful while zoomIndex > 0). Reset on every
// open and every zoom-level change so the image always starts centered.
let panX = 0, panY = 0;
let maxPanX = 0, maxPanY = 0;
let isPanning = false;
let panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;

function getEls() {
  return {
    modal: document.getElementById('image-viewer'),
    img: document.getElementById('image-viewer-img'),
    stage: document.querySelector('.image-viewer-stage'),
    usernameEl: document.getElementById('image-viewer-username'),
    avatarSlot: document.getElementById('image-viewer-avatar-slot'),
  };
}

function applyTransform(img) {
  const scale = ZOOM_LEVELS[zoomIndex];
  img.style.transform = scale === 1 ? '' : `translate(${panX}px, ${panY}px) scale(${scale})`;
  img.classList.toggle('zoomed', scale > 1);
}

// How far the image can be panned before it would leave the stage
// with empty space showing — keeps dragging from stranding the
// image somewhere unreachable/off-screen.
function updatePanLimits(img, stage) {
  const scale = ZOOM_LEVELS[zoomIndex];
  if (scale <= 1) { maxPanX = 0; maxPanY = 0; return; }
  const stageRect = stage.getBoundingClientRect();
  const scaledW = img.clientWidth * scale;
  const scaledH = img.clientHeight * scale;
  maxPanX = Math.max(0, (scaledW - stageRect.width) / 2);
  maxPanY = Math.max(0, (scaledH - stageRect.height) / 2);
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function openImageViewer(el) {
  const blobUrl = el.dataset.blobUrl;
  if (!blobUrl) return; // image hasn't finished loading yet — nothing to show

  const { modal, img, usernameEl, avatarSlot } = getEls();
  if (!modal || !img) return;

  current = {
    msgId: el.id.split('-').pop(), // same id-parsing approach as cleanupImageUrls()
    scope: el.dataset.scope,
    filename: el.dataset.filename || 'download',
  };

  zoomIndex = 0;
  panX = 0; panY = 0;
  img.style.transform = '';
  img.classList.remove('zoomed', 'panning');
  img.src = blobUrl;
  img.alt = current.filename;

  if (usernameEl) usernameEl.textContent = el.dataset.username || '';
  // The sender who uploaded the image, not the logged-in viewer —
  // reuses the same avatarHtml() used everywhere else in the app.
  if (avatarSlot) {
    const userId = el.dataset.userId;
    avatarSlot.innerHTML = userId
      ? avatarHtml(userId, el.dataset.username || '', 'chat-avatar', false)
      : '';
  }

  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

export function closeImageViewer() {
  const { modal, img } = getEls();
  if (!modal || !modal.classList.contains('active')) return;

  modal.classList.remove('active');
  document.body.style.overflow = '';

  // Don't revoke the blob URL here — it's owned by the attachment
  // element (attachments.js revokes it on cleanup/reload), the
  // viewer only ever borrows it.
  if (img) {
    img.removeAttribute('src');
    img.style.transform = '';
    img.classList.remove('zoomed', 'panning');
  }
  zoomIndex = 0;
  panX = 0; panY = 0;
  isPanning = false;
  current = null;
}

export function toggleImageViewerZoom() {
  const { img, stage } = getEls();
  if (!img || !img.getAttribute('src')) return;

  zoomIndex = (zoomIndex + 1) % ZOOM_LEVELS.length;
  panX = 0; panY = 0; // recenter on every zoom-level change
  updatePanLimits(img, stage);
  applyTransform(img);
}

export function downloadImageViewerImage() {
  if (!current) return;
  downloadAttachment(current.msgId, current.filename, current.scope);
}

// Exposed for inline onclick handlers, same convention used
// throughout the app (window.downloadAttachment, window.closePreview, etc.)
window.openImageViewer = openImageViewer;
window.closeImageViewer = closeImageViewer;
window.toggleImageViewerZoom = toggleImageViewerZoom;
window.downloadImageViewerImage = downloadImageViewerImage;

// ---------------------------------------------------------------
// Drag-to-pan (mouse + touch, via Pointer Events) while zoomed in.
// Registered once against the static #image-viewer-img element —
// it never gets recreated, so this never needs re-binding or risks
// duplicate listeners.
// ---------------------------------------------------------------
(function initPanning() {
  const img = document.getElementById('image-viewer-img');
  const stage = document.querySelector('.image-viewer-stage');
  if (!img || !stage) return;

  img.addEventListener('pointerdown', (e) => {
    if (ZOOM_LEVELS[zoomIndex] === 1) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = panX;
    panOriginY = panY;
    img.classList.add('panning');
    img.setPointerCapture(e.pointerId);
  });

  img.addEventListener('pointermove', (e) => {
    if (!isPanning) return;
    panX = clamp(panOriginX + (e.clientX - panStartX), -maxPanX, maxPanX);
    panY = clamp(panOriginY + (e.clientY - panStartY), -maxPanY, maxPanY);
    applyTransform(img);
  });

  function endPan(e) {
    if (!isPanning) return;
    isPanning = false;
    img.classList.remove('panning');
    if (e && img.hasPointerCapture?.(e.pointerId)) {
      img.releasePointerCapture(e.pointerId);
    }
  }
  img.addEventListener('pointerup', endPan);
  img.addEventListener('pointercancel', endPan);

  // Belt-and-suspenders: some browsers still attempt native
  // image drag-and-drop (the "ghost thumbnail" in the middle of
  // the screen) even with draggable="false" on slow paint cycles.
  img.addEventListener('dragstart', (e) => e.preventDefault());
})();

// Escape-to-close, registered once — same pattern as the profile
// card and confirm modal.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('image-viewer');
  if (modal && modal.classList.contains('active')) {
    closeImageViewer();
  }
});
