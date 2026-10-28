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
import { pushOverlay, closeOverlay } from '../core/navigation.js';
import { registerActions } from '../ui/actions.js';

// Cycle through a few sensible zoom levels for the toolbar
// button/double-tap (keeps those predictable and easy to reset);
// pinch-to-zoom below overrides these with continuous scaling
// while the gesture is active.
const ZOOM_LEVELS = [1, 1.75, 2.5];
const MIN_SCALE = 1;
const MAX_SCALE = 4;

let zoomIndex = 0;
let scale = 1; // current continuous scale — normally equals ZOOM_LEVELS[zoomIndex], but pinch can set any value in between
let current = null; // { msgId, scope, filename } for the open image

// Pan state (only meaningful while scale > 1). Reset on every
// open and every zoom-level change so the image always starts centered.
let panX = 0, panY = 0;
let maxPanX = 0, maxPanY = 0;
let isPanning = false;
let panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;

// Active pointers during a potential pinch gesture, keyed by
// pointerId -> {x, y}. Pointer Events report each touch separately
// (unlike mouse events), so tracking this map is what lets us
// detect "exactly two fingers down" and measure the distance
// between them without any touch-specific APIs.
const activePointers = new Map();
let isPinching = false;
let pinchStartDist = 0;
let pinchStartScale = 1;

// Double-tap detection (a tap being a pointer that went down and up
// again without turning into a drag or a pinch).
let lastTapTime = 0;
let lastTapX = 0, lastTapY = 0;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 30; // px

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
  img.style.transform = scale === 1 ? '' : `translate(${panX}px, ${panY}px) scale(${scale})`;
  img.classList.toggle('zoomed', scale > 1);
}

// How far the image can be panned before it would leave the stage
// with empty space showing — keeps dragging from stranding the
// image somewhere unreachable/off-screen.
function updatePanLimits(img, stage) {
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
  scale = 1;
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

  // Android Back should close the viewer and reveal the DM thread it
  // was opened from, not navigate away from the conversation.
  pushOverlay('image-viewer', closeImageViewer);
}

export function closeImageViewer() {
  const { modal, img } = getEls();
  if (!modal || !modal.classList.contains('active')) return;

  modal.classList.remove('active');
  document.body.style.overflow = '';

  // Keeps navigation history in sync no matter how the viewer was
  // closed — the X button, the backdrop, Escape, or Android Back.
  closeOverlay('image-viewer');

  // Don't revoke the blob URL here — it's owned by the attachment
  // element (attachments.js revokes it on cleanup/reload), the
  // viewer only ever borrows it.
  if (img) {
    img.removeAttribute('src');
    img.style.transform = '';
    img.classList.remove('zoomed', 'panning');
  }
  zoomIndex = 0;
  scale = 1;
  panX = 0; panY = 0;
  isPanning = false;
  isPinching = false;
  activePointers.clear();
  current = null;
}

export function toggleImageViewerZoom() {
  const { img, stage } = getEls();
  if (!img || !img.getAttribute('src')) return;

  zoomIndex = (zoomIndex + 1) % ZOOM_LEVELS.length;
  scale = ZOOM_LEVELS[zoomIndex];
  panX = 0; panY = 0; // recenter on every zoom-level change
  updatePanLimits(img, stage);
  applyTransform(img);
}

export function downloadImageViewerImage() {
  if (!current) return;
  downloadAttachment(current.msgId, current.filename, current.scope);
}

// Exposed for attachments.js (its inline onclick calls it), same convention
// used throughout the app (window.downloadAttachment, window.closePreview, etc.)
window.openImageViewer = openImageViewer;

// Markup in index.html carries data-action names (see ui/actions.js).
// The backdrop closes on any click outside [data-stop] (the bar and the
// image), which is what the old inline stopPropagation() gave us.
// Clicks on the bar and the image must not reach document-level listeners
// (the old inline stopPropagation did this). Stopping only on [data-stop]
// keeps clicks on the stage and the backdrop bubbling, as before.
document.querySelectorAll('#image-viewer [data-stop]').forEach((el) => {
  el.addEventListener('click', (e) => e.stopPropagation());
});

registerActions({
  'image-viewer-close': () => closeImageViewer(),
  'image-viewer-zoom': () => toggleImageViewerZoom(),
  'image-viewer-download': () => downloadImageViewerImage(),
  'image-viewer-backdrop': (el, e) => {
    if (!e.target.closest('[data-stop]')) closeImageViewer();
  },
});

// ---------------------------------------------------------------
// Pinch-to-zoom, drag-to-pan, and double-tap — all via Pointer
// Events against the static #image-viewer-img element (it never
// gets recreated, so this never needs re-binding or risks duplicate
// listeners). Pointer Events report each touch point as its own
// stream of down/move/up events, which is what makes tracking two
// simultaneous fingers in `activePointers` possible without any
// touch-specific APIs.
// ---------------------------------------------------------------
(function initGestures() {
  const img = document.getElementById('image-viewer-img');
  const stage = document.querySelector('.image-viewer-stage');
  if (!img || !stage) return;

  // Was an inline ondragstart="return false;" in index.html.
  img.addEventListener('dragstart', (e) => e.preventDefault());

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // After a pinch ends, snap `zoomIndex` to whichever preset is
  // closest to where the user left it — purely bookkeeping so the
  // zoom *button* (which just cycles ZOOM_LEVELS) continues from a
  // sensible place instead of jumping around after a pinch.
  function settleZoomIndex() {
    let closest = 0;
    let closestDiff = Infinity;
    ZOOM_LEVELS.forEach((level, i) => {
      const diff = Math.abs(level - scale);
      if (diff < closestDiff) { closestDiff = diff; closest = i; }
    });
    zoomIndex = closest;
  }

  function startPan(x, y) {
    isPanning = true;
    panStartX = x;
    panStartY = y;
    panOriginX = panX;
    panOriginY = panY;
    img.classList.add('panning');
  }

  function endPan() {
    isPanning = false;
    img.classList.remove('panning');
  }

  img.addEventListener('pointerdown', (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    img.setPointerCapture(e.pointerId);

    if (activePointers.size === 2) {
      // Second finger just landed — a pan in progress (if any)
      // becomes a pinch instead.
      endPan();
      const [p1, p2] = [...activePointers.values()];
      isPinching = true;
      pinchStartDist = dist(p1, p2) || 1;
      pinchStartScale = scale;
      img.classList.add('panning'); // reuses the "no transition" rule so pinch updates aren't laggy
    } else if (activePointers.size === 1 && scale > 1) {
      startPan(e.clientX, e.clientY);
    }
  });

  img.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (isPinching && activePointers.size >= 2) {
      const [p1, p2] = [...activePointers.values()];
      const newDist = dist(p1, p2) || 1;
      scale = clamp(pinchStartScale * (newDist / pinchStartDist), MIN_SCALE, MAX_SCALE);
      updatePanLimits(img, stage);
      panX = clamp(panX, -maxPanX, maxPanX);
      panY = clamp(panY, -maxPanY, maxPanY);
      applyTransform(img);
    } else if (isPanning) {
      panX = clamp(panOriginX + (e.clientX - panStartX), -maxPanX, maxPanX);
      panY = clamp(panOriginY + (e.clientY - panStartY), -maxPanY, maxPanY);
      applyTransform(img);
    }
  });

  function handleUp(e) {
    const wasSingleTap =
      activePointers.size === 1 && !isPanning && !isPinching &&
      activePointers.has(e.pointerId);

    activePointers.delete(e.pointerId);
    if (img.hasPointerCapture?.(e.pointerId)) {
      img.releasePointerCapture(e.pointerId);
    }

    if (isPinching && activePointers.size < 2) {
      isPinching = false;
      img.classList.remove('panning');
      settleZoomIndex();
      if (scale < 1.05) {
        // Pinched back down past ~1x — snap fully closed instead of
        // leaving it at some barely-zoomed-in in-between value.
        scale = 1; zoomIndex = 0; panX = 0; panY = 0;
        applyTransform(img);
      } else if (activePointers.size === 1) {
        // One finger still down after the second lifts — resume as
        // an ordinary single-finger pan from here rather than
        // dropping the gesture entirely.
        const remaining = [...activePointers.values()][0];
        startPan(remaining.x, remaining.y);
      }
      return;
    }

    if (isPanning) endPan();

    // Double-tap: two quick, roughly-in-place single-finger taps.
    if (wasSingleTap) {
      const now = Date.now();
      const moved = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY);
      if (now - lastTapTime < DOUBLE_TAP_MS && moved < DOUBLE_TAP_SLOP) {
        lastTapTime = 0; // consume so a third tap doesn't chain into another toggle
        const { stage: s } = getEls();
        if (scale > 1) {
          scale = 1; zoomIndex = 0; panX = 0; panY = 0;
        } else {
          zoomIndex = 1;
          scale = ZOOM_LEVELS[zoomIndex];
          panX = 0; panY = 0;
        }
        updatePanLimits(img, s);
        applyTransform(img);
      } else {
        lastTapTime = now;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
      }
    }
  }
  img.addEventListener('pointerup', handleUp);
  img.addEventListener('pointercancel', (e) => {
    activePointers.delete(e.pointerId);
    isPinching = false;
    endPan();
    img.classList.remove('panning');
  });

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
