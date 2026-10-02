// ============================================================
// Files media viewer — image / video / audio.
//
// Built for the Files tab (the chat viewers are tied to message
// attachments). One native modal <dialog>; content is created per item
// and torn down on navigation and close.
//
// STREAMING, NOT DOWNLOADING
//   The viewer never fetches file bytes itself. It asks the item for a
//   short-lived, single-file media URL (item.getMedia()) and hands that
//   to a plain <img>/<video>/<audio>, so the browser streams it with
//   Range requests. No Blob, no object URL, nothing held in JS memory.
//   If a long playback outlives the URL's token (seeking issues new
//   requests), the element's `error` fires and we transparently mint a
//   new URL and resume at the same position.
//
// An `item` is:
//   {
//     name, kind: 'image'|'video'|'audio',
//     size?, modified?,
//     getMedia: () => Promise<{ url, mime?, size?, modified? }>,
//     download: () => Promise<void>       // the shared download code
//   }
// ============================================================

import { esc } from './html.js';
import { ICONS, fileIcon } from '../icons.js';
import { formatBytes, formatDate } from '../core/utils.js';
import { openDialog } from './dialog.js';
import { buildAudioPlayer } from './audio-ui.js';
import { describeType, formatDuration } from './kinds.js';
import { pushOverlay, closeOverlay } from '../core/navigation.js';

const MAX_RECOVERIES = 3;
const SWIPE_DISTANCE = 60;

export function openViewer({ items, index = 0 }) {
  if (!Array.isArray(items) || !items.length) return null;

  let current = Math.min(Math.max(index, 0), items.length - 1);
  let loadSeq = 0;
  let itemAbort = null;
  let mediaEl = null;
  let audioUi = null;
  let zoomed = false;
  let closed = false;

  const { dialog, panel, close } = openDialog({
    variant: 'viewer',
    label: 'File preview',
    className: 'files-viewer',
    onClose: () => {
      closed = true;
      loadSeq++;
      teardownItem();

      // Fires for every close path (X button, backdrop, Escape,
      // programmatic close() — including Android Back, which calls
      // close() below), so navigation history can never go stale.
      closeOverlay('files-viewer');
    },
  });

  // Stepping between files inside the viewer (prev/next) is internal
  // viewer state, not application navigation — this is ONE history
  // entry regardless of how many files get viewed before it closes.
  pushOverlay('files-viewer', close);

  panel.innerHTML = `
    <header class="fv-bar">
      <button type="button" class="fv-btn fv-close" aria-label="Close preview" autofocus>
        ${ICONS.close}
      </button>
      <div class="fv-title">
        <div class="fv-name" id="fv-name"></div>
        <div class="fv-meta"></div>
      </div>
      <div class="fv-actions">
        <button type="button" class="fv-btn fv-zoom hidden" aria-pressed="false" aria-label="Show actual size" title="Actual size">
          <span class="fv-zoom-label">1:1</span>
        </button>
        <button type="button" class="fv-btn fv-download" aria-label="Download" title="Download">
          ${ICONS.download}
        </button>
      </div>
    </header>

    <div class="fv-stage" tabindex="-1"></div>

    <button type="button" class="fv-nav fv-prev" aria-label="Previous file" title="Previous (PageUp)">${ICONS.chevronLeft}</button>
    <button type="button" class="fv-nav fv-next" aria-label="Next file" title="Next (PageDown)">${ICONS.chevronRight}</button>
  `;

  dialog.setAttribute('aria-labelledby', 'fv-name');
  dialog.removeAttribute('aria-label');

  const $ = (sel) => panel.querySelector(sel);
  const nameEl = $('.fv-name');
  const metaEl = $('.fv-meta');
  const stage = $('.fv-stage');
  const zoomBtn = $('.fv-zoom');
  const prevBtn = $('.fv-prev');
  const nextBtn = $('.fv-next');

  const multiple = items.length > 1;
  prevBtn.hidden = nextBtn.hidden = !multiple;

  // ---------------- lifecycle ----------------

  function teardownItem() {
    itemAbort?.abort();
    itemAbort = null;

    const el = mediaEl;
    mediaEl = null;
    audioUi = null;

    if (el) {
      try {
        el.pause?.();
      } catch {
        /* not a media element */
      }

      // Detach the source so the browser cancels the in-flight
      // streaming request instead of buffering a closed player.
      el.removeAttribute('src');
      el.load?.();
    }

    stage.replaceChildren();
    stage.classList.remove('is-zoomed');
    zoomed = false;
  }

  function setMeta(item, extra = []) {
    const parts = [
      describeType(item.name, item.kind),
      item.size != null ? formatBytes(item.size) : null,
      item.modified ? formatDate(item.modified) : null,
      ...extra,
    ].filter(Boolean);

    metaEl.textContent = parts.join(' · ');
  }

  function showLoading() {
    stage.innerHTML = `
      <div class="fv-state" role="status">
        <span class="spin" aria-hidden="true"></span>
        <span class="fv-state-text">Loading…</span>
      </div>
    `;
  }

  function showError(item, message) {
    teardownMediaOnly();

    stage.innerHTML = `
      <div class="fv-state fv-state--error" role="alert">
        <div class="fv-state-icon" aria-hidden="true">${fileIcon(item.name, 'file')}</div>
        <div class="fv-state-title">Can't preview this file</div>
        <div class="fv-state-text">${esc(message || 'Something went wrong while loading it.')}</div>
        <div class="fv-state-actions">
          <button type="button" class="btn btn-primary" data-act="download">${ICONS.download} Download</button>
          <button type="button" class="btn" data-act="retry">Try again</button>
        </div>
      </div>
    `;

    zoomBtn.classList.add('hidden');
    stage.querySelector('[data-act="download"]')?.focus({ preventScroll: true });
  }

  // Like teardownItem() but keeps the abort controller (used when an
  // error replaces the media element inside the same item load).
  function teardownMediaOnly() {
    const el = mediaEl;
    mediaEl = null;
    audioUi = null;

    if (el) {
      try {
        el.pause?.();
      } catch {
        /* ignore */
      }

      el.removeAttribute('src');
      el.load?.();
    }
  }

  // ---------------- per-kind builders ----------------

  function buildImage(item, media, signal) {
    const img = document.createElement('img');
    img.className = 'fv-img';
    img.alt = item.name;
    img.decoding = 'async';
    img.draggable = false;

    img.addEventListener('load', () => {
      stage.querySelector('.fv-state')?.remove();
      img.classList.add('is-ready');
      zoomBtn.classList.remove('hidden');

      if (img.naturalWidth && img.naturalHeight) {
        setMeta(item, [`${img.naturalWidth} × ${img.naturalHeight}`]);
      }
    }, { signal });

    img.addEventListener('error', () => {
      showError(item, 'The image could not be loaded.');
    }, { signal });

    img.src = media.url;
    stage.appendChild(img);

    return img;
  }

  function buildVideo(item, media, signal, recover) {
    const video = document.createElement('video');
    video.className = 'fv-video';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('controlslist', 'nodownload');
    video.setAttribute('aria-label', item.name);

    video.addEventListener('loadedmetadata', () => {
      stage.querySelector('.fv-state')?.remove();
      video.classList.add('is-ready');

      const extra = [];
      if (video.videoWidth && video.videoHeight) {
        extra.push(`${video.videoWidth} × ${video.videoHeight}`);
      }
      if (Number.isFinite(video.duration)) {
        extra.push(formatDuration(video.duration));
      }
      setMeta(item, extra);
      video.focus({ preventScroll: true });
    }, { signal });

    video.addEventListener('error', () => recover(video), { signal });

    video.src = media.url;
    stage.appendChild(video);

    return video;
  }

  function buildAudio(item, media, signal, recover) {
    const ui = buildAudioPlayer({ signal });
    const { audio } = ui;

    ui.setLoading(true);

    // Title inside the player card too — on phones the top bar may
    // have truncated it.
    const title = document.createElement('div');
    title.className = 'fa-title';
    title.textContent = item.name;
    ui.el.insertBefore(title, ui.el.querySelector('.fa-seek'));

    audio.addEventListener('loadedmetadata', () => {
      stage.querySelector('.fv-state')?.remove();
      ui.el.classList.add('is-ready');
      ui.setLoading(false);
      setMeta(item, Number.isFinite(audio.duration) ? [formatDuration(audio.duration)] : []);
      ui.focusPrimary();

      // The user just chose to open a "player": start it. If the
      // browser blocks autoplay the play button simply stays "Play".
      if (!ui.startedOnce) {
        ui.startedOnce = true;
        ui.togglePlay();
      }
    }, { signal });

    audio.addEventListener('error', () => recover(audio), { signal });

    audio.src = media.url;
    // The player card carries its own loading state on the play button.
    stage.querySelector('.fv-state')?.remove();
    stage.appendChild(ui.el);
    audioUi = ui;

    return audio;
  }

  // ---------------- show one item ----------------

  async function showItem(nextIndex) {
    current = nextIndex;
    const item = items[current];
    const seq = ++loadSeq;

    teardownItem();
    itemAbort = new AbortController();
    const { signal } = itemAbort;

    nameEl.textContent = item.name;
    setMeta(item);
    zoomBtn.classList.add('hidden');
    zoomBtn.setAttribute('aria-pressed', 'false');
    stage.dataset.kind = item.kind;
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === items.length - 1;
    showLoading();

    let media;

    try {
      media = await item.getMedia();
    } catch (error) {
      if (seq === loadSeq && !closed) showError(item, error?.message);
      return;
    }

    if (seq !== loadSeq || closed) return;

    if (media.size != null && item.size == null) item.size = media.size;
    if (media.modified && !item.modified) item.modified = media.modified;
    setMeta(item);

    let recoveries = 0;
    let hasLoaded = false;

    // <video>/<audio> only: a token that expired mid-playback shows up
    // as an `error`. Mint a fresh URL and resume where we were.
    const recover = async (el) => {
      if (seq !== loadSeq || closed) return;

      if (!hasLoaded || recoveries >= MAX_RECOVERIES) {
        showError(item, "The file couldn't be played. It may be unsupported by this device.");
        return;
      }

      recoveries++;

      const position = el.currentTime || 0;
      const wasPlaying = !el.paused;

      try {
        const fresh = await item.getMedia();
        if (seq !== loadSeq || closed) return;

        el.addEventListener('loadedmetadata', () => {
          if (position > 0) el.currentTime = position;
          if (wasPlaying) el.play().catch(() => {});
        }, { once: true, signal });

        el.src = fresh.url;

      } catch (error) {
        if (seq === loadSeq && !closed) showError(item, error?.message);
      }
    };

    const tracked = (build) => (...args) => {
      const el = build(...args);
      el.addEventListener('loadedmetadata', () => { hasLoaded = true; }, { signal });
      return el;
    };

    if (item.kind === 'image') {
      mediaEl = buildImage(item, media, signal);
    } else if (item.kind === 'video') {
      mediaEl = tracked(buildVideo)(item, media, signal, recover);
    } else {
      mediaEl = tracked(buildAudio)(item, media, signal, recover);
    }
  }

  // ---------------- controls ----------------

  $('.fv-close').addEventListener('click', close);

  $('.fv-download').addEventListener('click', () => {
    items[current].download();
  });

  const go = (delta) => {
    const next = current + delta;
    if (next >= 0 && next < items.length) showItem(next);
  };

  prevBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => go(1));

  zoomBtn.addEventListener('click', () => {
    zoomed = !zoomed;
    stage.classList.toggle('is-zoomed', zoomed);
    zoomBtn.setAttribute('aria-pressed', String(zoomed));
    zoomBtn.setAttribute('aria-label', zoomed ? 'Fit to screen' : 'Show actual size');
    zoomBtn.title = zoomed ? 'Fit to screen' : 'Actual size';
    zoomBtn.querySelector('.fv-zoom-label').textContent = zoomed ? 'Fit' : '1:1';
  });

  stage.addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act;

    if (act === 'download') items[current].download();
    if (act === 'retry') showItem(current);
  });

  // Arrow keys move between images. For video/audio they must keep
  // seeking (native controls / our slider), so there PageUp/PageDown
  // or the on-screen buttons are used.
  dialog.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest('input, select, textarea')) return;

    // PageUp/PageDown step through files for every kind (they don't
    // clash with seeking), so keyboard users are never stranded on a
    // video/audio item.
    if (event.key === 'PageUp') {
      event.preventDefault();
      go(-1);
      return;
    }

    if (event.key === 'PageDown') {
      event.preventDefault();
      go(1);
      return;
    }

    if (items[current].kind !== 'image') return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    }
  });

  // Swipe between images (touch/pen). Disabled while zoomed, where a
  // horizontal drag is a pan.
  let swipe = null;

  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || zoomed || items[current].kind !== 'image') return;
    swipe = { x: event.clientX, y: event.clientY };
  });

  stage.addEventListener('pointerup', (event) => {
    if (!swipe) return;

    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;

    if (Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dy) < Math.abs(dx) / 2) {
      go(dx < 0 ? 1 : -1);
    }
  });

  stage.addEventListener('pointercancel', () => { swipe = null; });

  showItem(current);

  return { close };
}
