// ============================================================
// Settings → Appearance: Custom background, Advanced, Resets
//
// Markup + behaviour for the three blocks added to the existing
// Appearance page. State lives elsewhere:
//   custom-background.js     image / GIF / video, prefs, live layer
//   appearance-surfaces.js   per-surface transparency / blur
// This file is only the controls: it reads current values, writes
// changes through those modules, and keeps the preview in sync.
//
// The slider markup/binding below is one reusable component used
// by every control here (it reuses the existing .sound-slider look).
// ============================================================

import { ICONS } from '../icons.js';
import { escapeHtml, showToast } from '../core/utils.js';
import { showConfirm } from '../ui/confirm.js';

import {
  DEFAULT_AMBIENT_LEVEL,
  DEFAULT_BACKGROUND_ID,
  DEFAULT_BUBBLE_STYLE,
  DEFAULT_FONT_ID,
  applyAmbientLevel,
  applyAnimationsEnabled,
  applyBackgroundTheme,
  applyFontFamily,
  applyMessageBubbleStyle,
  applyTheme,
  applyUseAccentForBubbles
} from './theme.js';

import {
  CUSTOM_BG_CHANGE_EVENT,
  FIT_OPTIONS,
  LIMITS,
  PHONE_LAYOUT_QUERY,
  PHONE_POSITION_SAME,
  PLAYBACK_RETRY_EVENT,
  POSITION_OPTIONS,
  applyCandidate,
  buildBackgroundVars,
  createBackgroundVideo,
  describeBackground,
  getActiveSource,
  getBackgroundInfo,
  getCustomBackgroundPrefs,
  isPhoneLayout,
  playBackgroundVideo,
  prepareCandidate,
  releaseBackgroundVideo,
  releaseCandidate,
  removeCustomBackground,
  resetBackgroundControls,
  resetCustomBackground,
  setBackgroundPlaybackHold,
  setCustomBackgroundPrefs,
  shouldPlayAnimation
} from './custom-background.js';

import {
  SURFACES,
  getBlurAll,
  getBlurMax,
  getSurfaceState,
  isLiteDevice,
  maxTransparency,
  resetSurfaces,
  setBlurAll,
  setSurface
} from './appearance-surfaces.js';

import {
  repaintAllMessageAccents
} from '../chat/message-accent.js';

import { renderSettings } from './settings.js';

// ============================================================
// Reusable controls
// ============================================================

function fillPercent(value, min, max) {
  return max > min
    ? ((value - min) / (max - min)) * 100
    : 0;
}

function formatValue(unit, value) {
  return unit === 'px' ? `${value}px` : `${value}%`;
}

/**
 * One labelled slider row. `attrs` are extra data-* attributes the
 * binder uses to route the change (e.g. data-cbg="opacity").
 */
function sliderRow({
  id,
  label,
  hint = '',
  min,
  max,
  value,
  unit = '%',
  attrs = '',
  disabled = false
}) {
  return `
    <div
      class="appearance-slider-row${disabled ? ' is-disabled' : ''}"
      data-slider-row="${id}">

      <div>
        <div class="settings-row-label">
          ${escapeHtml(label)}
        </div>
        ${
          hint
            ? `<div class="settings-row-sublabel">${escapeHtml(hint)}</div>`
            : ''
        }
      </div>

      <div class="sound-volume-control">
        <input
          type="range"
          class="sound-slider"
          id="${id}"
          min="${min}"
          max="${max}"
          step="1"
          value="${value}"
          data-unit="${unit}"
          style="--sound-volume:${fillPercent(value, min, max)}%"
          aria-label="${escapeHtml(label)}"
          ${attrs}
          ${disabled ? 'disabled' : ''}>

        <output
          class="sound-volume-value"
          for="${id}">${formatValue(unit, value)}</output>
      </div>

    </div>
  `;
}

function switchButton({ id, on, label, attrs = '', disabled = false }) {
  return `
    <button
      type="button"
      class="switch${on ? ' on' : ''}"
      id="${id}"
      role="switch"
      aria-checked="${on}"
      aria-label="${escapeHtml(label)}"
      ${attrs}
      ${disabled ? 'disabled' : ''}>
      <span class="switch-thumb"></span>
    </button>
  `;
}

function setSwitch(el, on) {
  if (!el) return;
  el.classList.toggle('on', on);
  el.setAttribute('aria-checked', String(on));
}

function setSlider(input, value, { disabled } = {}) {
  if (!input) return;

  input.value = String(value);

  const min = Number(input.min);
  const max = Number(input.max);

  input.style.setProperty(
    '--sound-volume',
    `${fillPercent(Number(input.value), min, max)}%`
  );

  const out = input.parentElement?.querySelector('output');
  if (out) {
    out.textContent = formatValue(
      input.dataset.unit,
      Number(input.value)
    );
  }

  if (typeof disabled === 'boolean') {
    input.disabled = disabled;
    input
      .closest('.appearance-slider-row')
      ?.classList.toggle('is-disabled', disabled);
  }
}

// Updates the fill + number for the slider the user is dragging.
function reflectSlider(input) {
  setSlider(input, Number(input.value));
}

// ============================================================
// Custom background — markup
// ============================================================

export function renderCustomBackgroundSection() {
  const prefs = getCustomBackgroundPrefs();
  const on = prefs.enabled && prefs.hasImage;

  const fitOptions = FIT_OPTIONS.map(
    o => `
      <option value="${o.id}"${o.id === prefs.fit ? ' selected' : ''}>
        ${escapeHtml(o.label)}
      </option>`
  ).join('');

  const positionOptions = POSITION_OPTIONS.map(
    o => `
      <option value="${o.id}"${o.id === prefs.position ? ' selected' : ''}>
        ${escapeHtml(o.label)}
      </option>`
  ).join('');

  const phonePositionOptions = [
    { id: PHONE_POSITION_SAME, label: 'Same as desktop' },
    ...POSITION_OPTIONS
  ]
    .map(
      o => `
      <option value="${o.id}"${o.id === prefs.phonePosition ? ' selected' : ''}>
        ${escapeHtml(o.label)}
      </option>`
    )
    .join('');

  return `
    <div
      class="settings-row settings-row-column"
      id="custom-bg-block">

      <div class="custom-bg-head">
        <div>
          <div class="settings-row-label">
            Custom background
          </div>

          <div class="settings-row-sublabel">
            Use your own image, GIF or video behind the app. It
            stays on this device and is never uploaded.
          </div>
        </div>

        ${switchButton({
          id: 'custom-bg-toggle',
          on,
          label: 'Use custom background',
          disabled: !prefs.hasImage
        })}
      </div>

      <div
        class="custom-bg-type"
        id="custom-bg-type"
        ${prefs.hasImage ? '' : 'hidden'}>
        <span
          class="custom-bg-type-badge"
          id="custom-bg-type-badge"></span>
        <span
          class="custom-bg-type-note"
          id="custom-bg-type-note"></span>
      </div>

      <div
        class="custom-bg-preview-wrap"
        id="custom-bg-preview-wrap">
        <div
          class="custom-bg-preview"
          id="custom-bg-preview"
          role="img"
          aria-label="Background preview"></div>
      </div>

      <div class="custom-bg-actions">

        <label class="btn btn-sm custom-bg-file-btn">
          <span id="custom-bg-file-label">
            ${prefs.hasImage ? 'Replace background…' : 'Choose image or video…'}
          </span>

          <input
            type="file"
            class="custom-bg-file-input"
            id="custom-bg-file"
            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.jpg,.jpeg,.png,.webp,.gif,.mp4,.m4v,.mov,.webm"
            aria-label="Choose a background from this device: a JPG, PNG, WebP or GIF image, or an MP4 or WebM video">
        </label>

        <button
          type="button"
          class="btn btn-sm btn-primary"
          id="custom-bg-apply"
          hidden>
          Apply
        </button>

        <button
          type="button"
          class="btn btn-sm"
          id="custom-bg-cancel"
          hidden>
          Cancel
        </button>

        <button
          type="button"
          class="btn btn-sm btn-danger"
          id="custom-bg-remove"
          ${prefs.hasImage ? '' : 'hidden'}>
          Remove background
        </button>

        <span
          class="custom-bg-status"
          id="custom-bg-status"
          role="status"
          aria-live="polite"></span>
      </div>

      <div
        class="custom-bg-controls"
        id="custom-bg-controls"
        ${prefs.hasImage ? '' : 'hidden'}>

        ${sliderRow({
          id: 'custom-bg-opacity',
          label: 'Background opacity',
          hint: 'Lower lets the theme background show through',
          min: LIMITS.opacity.min,
          max: LIMITS.opacity.max,
          value: prefs.opacity,
          attrs: 'data-cbg="opacity"'
        })}

        ${sliderRow({
          id: 'custom-bg-dim',
          label: 'Dimming',
          hint: 'Keeps messages readable over bright images',
          min: LIMITS.dim.min,
          max: LIMITS.dim.max,
          value: prefs.dim,
          attrs: 'data-cbg="dim"'
        })}

        ${sliderRow({
          id: 'custom-bg-blur',
          label: 'Background blur',
          min: LIMITS.blur.min,
          max: LIMITS.blur.max,
          value: prefs.blur,
          unit: 'px',
          attrs: 'data-cbg="blur"'
        })}

        <div class="custom-bg-selects">
          <label>
            Fit
            <select id="custom-bg-fit" data-cbg="fit" aria-label="Background fit">
              ${fitOptions}
            </select>
          </label>

          <label>
            Position
            <select id="custom-bg-position" data-cbg="position" aria-label="Background position">
              ${positionOptions}
            </select>
          </label>

          <label
            id="custom-bg-position-phone-row"
            ${isPhoneLayout() ? '' : 'hidden'}>
            Position on phones
            <select id="custom-bg-position-phone" data-cbg="phonePosition" aria-label="Background position on phones">
              ${phonePositionOptions}
            </select>
          </label>
        </div>

        <div
          class="appearance-slider-row"
          id="custom-bg-animate-row"
          ${prefs.animated ? '' : 'hidden'}>

          <div>
            <div class="settings-row-label" id="custom-bg-animate-label">
              ${prefs.kind === 'video' ? 'Play video' : 'Play animation'}
            </div>

            <div class="settings-row-sublabel">
              Turn off to show a still frame and save battery.
              Always still when your device asks for reduced motion.
              Paused automatically when the app is in the background.
            </div>
          </div>

          ${switchButton({
            id: 'custom-bg-animate',
            on: prefs.animate,
            label: 'Play animated background'
          })}
        </div>

        <div class="settings-reset-row">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            id="custom-bg-reset-controls">
            Reset background controls
          </button>
        </div>

      </div>

    </div>
  `;
}

// ============================================================
// Advanced appearance — markup
// ============================================================

function surfaceCard(surface) {
  const state = getSurfaceState(surface.id);
  const master = getBlurAll();
  const blurMax = getBlurMax();
  const blurActive = master && state.blurOn;

  return `
    <div class="surface-card" data-surface="${surface.id}">

      <div class="surface-card-head">
        <div>
          <div class="settings-row-label">
            ${escapeHtml(surface.label)}
          </div>
          <div class="settings-row-sublabel">
            ${escapeHtml(surface.hint)}
          </div>
        </div>

        <div class="surface-blur-switch">
          <span aria-hidden="true">Blur</span>
          ${switchButton({
            id: `sf-${surface.id}-blur-on`,
            on: state.blurOn,
            label: `${surface.label}: blur`,
            attrs: `data-sf="${surface.id}" data-sf-key="blurOn"`,
            disabled: !master
          })}
        </div>
      </div>

      ${sliderRow({
        id: `sf-${surface.id}-transparency`,
        label: `${surface.label}: transparency`,
        min: 0,
        max: maxTransparency(surface),
        value: state.transparency,
        attrs: `data-sf="${surface.id}" data-sf-key="transparency"`
      })}

      ${sliderRow({
        id: `sf-${surface.id}-blur`,
        label: `${surface.label}: blur amount`,
        min: 1,
        max: blurMax,
        value: Math.min(state.blur, blurMax),
        unit: 'px',
        attrs: `data-sf="${surface.id}" data-sf-key="blur"`,
        disabled: !blurActive
      })}

    </div>
  `;
}

export function renderAdvancedAppearanceSection() {
  const master = getBlurAll();
  const lite = isLiteDevice();

  return `
    <details
      class="settings-advanced"
      id="advanced-appearance">

      <summary class="settings-advanced-summary">
        <span>
          <span class="settings-row-label" style="display:block">
            Advanced
          </span>
          <span class="settings-row-sublabel" style="display:block">
            Transparency and blur for each part of the interface
          </span>
        </span>

        <span
          class="settings-advanced-chevron"
          aria-hidden="true">
          ${ICONS.chevronDown || '⌄'}
        </span>
      </summary>

      <div class="settings-advanced-body">

        <div class="settings-row">
          <div>
            <div class="settings-row-label">
              Blur effects
            </div>

            <div class="settings-row-sublabel">
              Master switch. Turn off to save battery and GPU
              ${lite ? '— blur is also capped on this device and paused behind animated backgrounds' : ''}
            </div>
          </div>

          ${switchButton({
            id: 'adv-blur-all',
            on: master,
            label: 'Blur effects'
          })}
        </div>

        ${SURFACES.map(surfaceCard).join('')}

        <div class="settings-reset-row">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            id="adv-reset">
            Reset advanced appearance
          </button>
        </div>

      </div>

    </details>
  `;
}

export function renderResetAllRow() {
  return `
    <div class="settings-row">
      <div>
        <div class="settings-row-label">
          Reset all appearance settings
        </div>

        <div class="settings-row-sublabel">
          Back to Wire's defaults on this device. Your accent
          color belongs to your account and is left as it is.
        </div>
      </div>

      <button
        type="button"
        class="btn btn-sm btn-danger"
        id="appearance-reset-all">
        Reset all
      </button>
    </div>
  `;
}

// ============================================================
// Binding
// ============================================================

let candidate = null;
let changeHandler = null;

function $(id) {
  return document.getElementById(id);
}

// ---------------- custom background ----------------

function setStatus(message, isError = false) {
  const el = $('custom-bg-status');
  if (!el) return;

  el.textContent = message || '';
  el.classList.toggle('is-error', Boolean(isError));
}

// A programmatic .value change does not tell the custom select
// (ui-enhance.js) to relabel itself; its `change` listener does.
// The handler below writes the same value back, which is harmless.
function setSelect(el, value) {
  if (!el || el.value === value) return;
  el.value = value;
  el.dispatchEvent(new Event('change'));
}

// ---- preview ----------------------------------------------------
//
// One element (#custom-bg-preview), two shapes:
//   desktop  the existing 16:9 box with two sample bubbles;
//   phone    a phone-shaped screen with the aspect ratio of the
//            device's own viewport, showing a real-size chat that
//            is scaled down as a whole, so what you see here is
//            what the conversation will look like.
// "Phone" is the app's own bottom-navigation layout query, not a
// device list, so a narrow desktop window gets it too and no phone
// resolution is hard-coded.
//
// A preview that plays a video owns playback while it is on
// screen: the live background is put on hold (paused, not torn
// down) so the same clip is never decoding twice, and the preview
// lets go of its decoder the moment it scrolls out of view, is
// hidden, or Settings closes.

const PHONE_SCREEN = `
  <div class="cbg-pv-screen" aria-hidden="true">
    <div class="cbg-pv-notch"></div>

    <div class="cbg-pv-status">
      <span>9:41</span>
      <span class="cbg-pv-status-icons">
        <span class="cbg-pv-signal"></span>
        <span class="cbg-pv-battery"></span>
      </span>
    </div>

    <div class="cbg-pv-header">
      <span class="cbg-pv-back">${ICONS.chevronLeft || '‹'}</span>
      <span class="cbg-pv-avatar">A</span>
      <span>
        <div class="cbg-pv-name">Alex</div>
        <div class="cbg-pv-sub">online</div>
      </span>
    </div>

    <div class="cbg-pv-messages">
      <div class="cbg-pv-day">Today</div>
      <div class="cbg-pv-bubble">
        Hey! Did you see the new background?
        <span class="cbg-pv-time">9:38</span>
      </div>
      <div class="cbg-pv-bubble is-own">
        Just set it up. Is the text easy to read?
        <span class="cbg-pv-time">9:39</span>
      </div>
      <div class="cbg-pv-bubble">
        Looks great, and messages stay clear on top of it.
        <span class="cbg-pv-time">9:40</span>
      </div>
      <div class="cbg-pv-bubble is-own">
        Perfect, thanks!
        <span class="cbg-pv-time">9:41</span>
      </div>
    </div>

    <div class="cbg-pv-composer">
      <span>Message</span>
      <i class="cbg-pv-send"></i>
    </div>

    <div class="cbg-pv-home"></div>
  </div>
`;

let previewKey = null;
let previewState_ = null;
let previewVideo = null;
let previewVisible = false;
let previewScale = 0.3;
let previewToken = 0;
let previewRender = 0;
let previewIO = null;
let previewRO = null;
let previewAbort = null;

function afterPaint(fn) {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

function previewState() {
  const prefs = getCustomBackgroundPrefs();

  if (candidate) {
    const wantsMotion =
      candidate.animated && shouldPlayAnimation(prefs);

    const base = {
      prefs: {
        ...prefs,
        kind: candidate.kind,
        animated: candidate.animated
      },
      kind: candidate.kind,
      animated: candidate.animated,
      poster: candidate.posterUrl
    };

    if (candidate.kind === 'video') {
      if (wantsMotion || !candidate.posterUrl) {
        return {
          ...base,
          mode: 'video',
          playing: wantsMotion,
          src: candidate.url
        };
      }

      return {
        ...base,
        mode: 'img',
        playing: false,
        src: candidate.posterUrl
      };
    }

    return {
      ...base,
      mode: 'img',
      playing: wantsMotion,
      src:
        candidate.animated && !wantsMotion && candidate.posterUrl
          ? candidate.posterUrl
          : candidate.url
    };
  }

  if (prefs.enabled && prefs.hasImage) {
    const live = getActiveSource();

    if (live && live.src) {
      return {
        prefs,
        kind: live.kind,
        animated: live.animated,
        poster: live.poster,
        mode: live.mode,
        playing: live.playing,
        src: live.src
      };
    }
  }

  return {
    prefs,
    kind: prefs.kind,
    animated: false,
    poster: null,
    mode: 'none',
    playing: false,
    src: null
  };
}

function applyPreviewVars(preview, state, phone) {
  const vars = buildBackgroundVars(
    { ...state.prefs, animated: state.animated },
    {
      src: state.mode === 'img' ? state.src : null,
      playing: state.playing,
      // The desktop preview is a fraction of the screen, the phone
      // one is the screen scaled by previewScale: shrink the blur
      // by the same factor so it reads the same.
      blurScale: phone ? previewScale : 0.3,
      phone
    }
  );

  for (const [key, value] of Object.entries(vars)) {
    preview.style.setProperty(key, value);
  }
}

// Sizes the phone-shaped preview from the real viewport and the
// room in the column, capped so the controls below stay reachable.
function layoutPreview() {
  const preview = $('custom-bg-preview');
  const wrap = $('custom-bg-preview-wrap');

  if (!preview || !wrap) return;

  if (!preview.classList.contains('is-phone')) {
    for (const name of [
      '--pv-w',
      '--pv-h',
      '--pv-vw',
      '--pv-vh',
      '--pv-k'
    ]) {
      preview.style.removeProperty(name);
    }
    return;
  }

  const vw = Math.max(240, window.innerWidth || 390);
  const vh = Math.max(240, window.innerHeight || 780);

  const ratio = Math.min(2.4, Math.max(0.36, vw / vh));

  // 6px of frame ring on each side.
  const room = Math.max(60, wrap.clientWidth - 12);
  const cap = Math.min(vh * 0.56, 520);

  const height = Math.min(cap, room / ratio);
  const width = height * ratio;

  previewScale = width / vw;

  preview.style.setProperty('--pv-w', `${Math.round(width)}px`);
  preview.style.setProperty('--pv-h', `${Math.round(height)}px`);
  preview.style.setProperty('--pv-vw', `${Math.round(vw)}px`);
  preview.style.setProperty('--pv-vh', `${Math.round(vw / ratio)}px`);
  preview.style.setProperty('--pv-k', previewScale.toFixed(4));
}

function disposePreviewVideo() {
  if (previewVideo) {
    releaseBackgroundVideo(previewVideo);
    previewVideo.removeAttribute('poster');
    previewVideo.remove();
    previewVideo = null;
  }

  setBackgroundPlaybackHold('preview', false);
}

function teardownPreview() {
  previewToken++;

  previewIO?.disconnect();
  previewRO?.disconnect();
  previewAbort?.abort();

  previewIO = null;
  previewRO = null;
  previewAbort = null;

  if (previewRender) {
    cancelAnimationFrame(previewRender);
    previewRender = 0;
  }

  disposePreviewVideo();

  previewKey = null;
  previewState_ = null;
  previewVisible = false;
}

function syncPreviewPlayback() {
  const preview = $('custom-bg-preview');

  if (!preview || !preview.isConnected) {
    teardownPreview();
    return;
  }

  const video = previewVideo;
  const state = previewState_;

  if (!video || !state || state.mode !== 'video') {
    setBackgroundPlaybackHold('preview', false);
    return;
  }

  // Off screen or hidden: no decoding, the poster stands in, and
  // the live background carries on.
  if (!previewVisible || document.hidden) {
    releaseBackgroundVideo(video);
    setBackgroundPlaybackHold('preview', false);
    return;
  }

  // Preview owns playback: hold the live copy before starting.
  setBackgroundPlaybackHold('preview', state.playing);

  const token = previewToken;

  const start = () => {
    if (
      token !== previewToken ||
      video !== previewVideo ||
      !video.isConnected
    ) {
      return;
    }

    if (video.getAttribute('src') !== state.src) {
      video.src = state.src;
    }

    if (state.playing) {
      playBackgroundVideo(video);
    } else {
      video.pause();
    }
  };

  if (video.getAttribute('src') === state.src) {
    start();
  } else {
    // Let the page paint (with the poster) before any decoding.
    afterPaint(start);
  }
}

function buildPreview(preview, state, phone) {
  disposePreviewVideo();

  preview.textContent = '';
  preview.classList.toggle('is-phone', phone);

  if (state.mode === 'none') {
    const empty = document.createElement('div');
    empty.className = 'custom-bg-preview-empty';
    empty.textContent =
      state.prefs.hasImage && !state.prefs.enabled
        ? 'Custom background is off'
        : 'No custom background selected';

    preview.appendChild(empty);
    return;
  }

  const surface = document.createElement('div');
  surface.className = 'cbg-surface';

  let media;

  if (state.mode === 'video') {
    media = createBackgroundVideo();
    if (state.poster) media.poster = state.poster;
    previewVideo = media;
  } else {
    media = document.createElement('img');
    media.alt = '';
    media.decoding = 'async';
    media.draggable = false;
    media.src = state.src;
  }

  surface.appendChild(media);
  preview.appendChild(surface);

  if (phone) {
    preview.insertAdjacentHTML('beforeend', PHONE_SCREEN);
    return;
  }

  const received = document.createElement('div');
  received.className = 'custom-bg-sample';
  received.textContent = 'Hey, is this readable?';

  const own = document.createElement('div');
  own.className = 'custom-bg-sample is-own';
  own.textContent = 'Looks good to me.';

  preview.append(received, own);
}

function renderPreview({ rebuild = false } = {}) {
  const preview = $('custom-bg-preview');
  if (!preview) return;

  const state = previewState();
  const phone = isPhoneLayout();

  const key = [
    phone ? 'phone' : 'desktop',
    state.mode,
    state.src || '',
    state.poster || ''
  ].join('|');

  previewState_ = state;

  if (rebuild || key !== previewKey) {
    previewKey = key;
    buildPreview(preview, state, phone);
  }

  layoutPreview();

  if (state.src) applyPreviewVars(preview, state, phone);

  const info = candidate
    ? describeBackground(candidate)
    : getBackgroundInfo();

  preview.setAttribute(
    'aria-label',
    info
      ? `Background preview: ${info.label.toLowerCase()}`
      : 'Background preview'
  );

  syncPreviewPlayback();
}

function scheduleRenderPreview() {
  if (previewRender) return;

  previewRender = requestAnimationFrame(() => {
    previewRender = 0;

    const preview = $('custom-bg-preview');

    if (!preview || !preview.isConnected) {
      teardownPreview();
      return;
    }

    renderPreview();
  });
}

function setupPreview() {
  teardownPreview();

  const preview = $('custom-bg-preview');
  const wrap = $('custom-bg-preview-wrap');

  if (!preview || !wrap) return;

  previewAbort = new AbortController();
  const { signal } = previewAbort;

  // Visible on screen? (also fires when Settings is closed and the
  // element is removed, which is what lets the decoder go.)
  if (typeof IntersectionObserver === 'function') {
    previewIO = new IntersectionObserver(entries => {
      const last = entries[entries.length - 1];
      previewVisible = last.isIntersecting && preview.isConnected;
      syncPreviewPlayback();
    });

    previewIO.observe(preview);
  } else {
    previewVisible = true;
  }

  if (typeof ResizeObserver === 'function') {
    previewRO = new ResizeObserver(scheduleRenderPreview);
    previewRO.observe(wrap);
  }

  window.addEventListener('resize', scheduleRenderPreview, { signal });
  window.addEventListener('orientationchange', scheduleRenderPreview, { signal });
  window.visualViewport?.addEventListener('resize', scheduleRenderPreview, { signal });

  document.addEventListener('visibilitychange', syncPreviewPlayback, { signal });
  window.addEventListener(PLAYBACK_RETRY_EVENT, syncPreviewPlayback, { signal });

  // Phone <-> desktop layout: a different preview, not a resize. Also
  // the one thing that decides whether "Position on phones" is shown
  // at all — toggle it live so resizing the window (or rotating) never
  // needs Settings to be closed and reopened to catch up.
  try {
    window
      .matchMedia(PHONE_LAYOUT_QUERY)
      .addEventListener(
        'change',
        () => {
          renderPreview({ rebuild: true });
          syncPhonePositionVisibility();
        },
        { signal }
      );
  } catch {
    // Older WebViews.
  }
}

// "Position on phones" only makes sense once the app is actually in its
// mobile layout (bottom-nav instead of sidebar) — same query as the CSS
// that switches navigation (responsive.css) and as PHONE_LAYOUT_QUERY
// above. Keeping the option around but disabled would still invite
// desktop users to fiddle with a setting they can't see the effect of.
function syncPhonePositionVisibility() {
  const row = $('custom-bg-position-phone-row');
  if (row) row.hidden = !isPhoneLayout();
}

function syncCustomBackgroundUi() {
  const prefs = getCustomBackgroundPrefs();
  const on = prefs.enabled && prefs.hasImage;
  const usable = on || Boolean(candidate);

  const toggle = $('custom-bg-toggle');
  setSwitch(toggle, on);
  if (toggle) toggle.disabled = !prefs.hasImage;

  const controls = $('custom-bg-controls');
  if (controls) {
    controls.hidden = !(prefs.hasImage || candidate);
    controls.classList.toggle('is-off', !usable);

    controls
      .querySelectorAll('input[type="range"], select, .switch, button')
      .forEach(el => {
        el.disabled = !usable;
      });
  }

  $('custom-bg-apply').hidden = !candidate;
  $('custom-bg-cancel').hidden = !candidate;
  $('custom-bg-remove').hidden = !prefs.hasImage || Boolean(candidate);

  $('custom-bg-file-label').textContent =
    prefs.hasImage || candidate
      ? 'Replace background…'
      : 'Choose image or video…';

  // Which kind is selected, and what it is.
  const info = candidate
    ? describeBackground(candidate)
    : getBackgroundInfo();

  const type = $('custom-bg-type');

  if (type) {
    type.hidden = !info;

    if (info) {
      const badge = $('custom-bg-type-badge');
      badge.textContent = info.label;
      badge.dataset.kind = info.kind;
      badge.classList.toggle('is-off', !candidate && !on);

      $('custom-bg-type-note').textContent = candidate
        ? [info.detail, 'not applied yet'].filter(Boolean).join(' · ')
        : on
          ? info.detail
          : 'Off';
    }
  }

  const kind = candidate ? candidate.kind : prefs.kind;
  const animated = candidate ? candidate.animated : prefs.animated;

  $('custom-bg-animate-row').hidden = !animated;
  $('custom-bg-animate-label').textContent =
    kind === 'video' ? 'Play video' : 'Play animation';

  setSlider($('custom-bg-opacity'), prefs.opacity);
  setSlider($('custom-bg-dim'), prefs.dim);
  setSlider($('custom-bg-blur'), prefs.blur);
  setSelect($('custom-bg-fit'), prefs.fit);
  setSelect($('custom-bg-position'), prefs.position);
  setSelect($('custom-bg-position-phone'), prefs.phonePosition);
  syncPhonePositionVisibility();
  setSwitch($('custom-bg-animate'), prefs.animate);

  renderPreview();
}

function discardCandidate() {
  // Detach the preview's <video> before its blob URL is revoked.
  disposePreviewVideo();

  releaseCandidate(candidate);
  candidate = null;
  previewKey = null;
}

function saveErrorMessage(error) {
  return error?.name === 'QuotaExceededError'
    ? 'Not enough storage on this device. Try a smaller file.'
    : "Couldn't save the background on this device.";
}

function bindCustomBackground() {
  const block = $('custom-bg-block');
  if (!block) return;

  candidate = null;
  previewKey = null;

  // Live layer finished loading / changed elsewhere.
  if (changeHandler) {
    window.removeEventListener(
      CUSTOM_BG_CHANGE_EVENT,
      changeHandler
    );
  }

  changeHandler = () => {
    if (!$('custom-bg-block')) return;
    syncCustomBackgroundUi();
  };

  window.addEventListener(CUSTOM_BG_CHANGE_EVENT, changeHandler);

  setupPreview();

  let pickSeq = 0;

  // --- pick a file ---
  $('custom-bg-file').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files && input.files[0];

    input.value = '';

    if (!file) return;

    const mine = ++pickSeq;

    setStatus(
      /^video\//.test(file.type) || /\.(mp4|m4v|mov|webm)$/i.test(file.name)
        ? 'Checking video…'
        : 'Preparing image…'
    );

    try {
      const next = await prepareCandidate(file);

      // A newer pick started while this one was being checked.
      if (mine !== pickSeq || !$('custom-bg-block')) {
        releaseCandidate(next);
        return;
      }

      discardCandidate();
      candidate = next;

      setStatus('Preview only — choose Apply to use it.');
      syncCustomBackgroundUi();
    } catch (error) {
      if (mine !== pickSeq) return;

      const message =
        error?.message || "Couldn't read that file.";

      setStatus(message, true);
      showToast(message, 'error');
    }
  });

  // --- apply / cancel / remove ---
  $('custom-bg-apply').addEventListener('click', async () => {
    if (!candidate) return;

    const button = $('custom-bg-apply');
    button.disabled = true;
    setStatus('Saving…');

    try {
      await applyCandidate(candidate);

      discardCandidate();
      setStatus('');
      showToast('Background applied', 'success');
    } catch (error) {
      const message = saveErrorMessage(error);

      setStatus(message, true);
      showToast(message, 'error');
    } finally {
      button.disabled = false;
      syncCustomBackgroundUi();
    }
  });

  $('custom-bg-cancel').addEventListener('click', () => {
    discardCandidate();
    setStatus('');
    syncCustomBackgroundUi();
  });

  $('custom-bg-remove').addEventListener('click', async () => {
    discardCandidate();

    await removeCustomBackground();

    setStatus('');
    showToast('Custom background removed');
    syncCustomBackgroundUi();
  });

  // --- enable / disable ---
  $('custom-bg-toggle').addEventListener('click', () => {
    const prefs = getCustomBackgroundPrefs();
    if (!prefs.hasImage) return;

    const next = !prefs.enabled;

    setSwitch($('custom-bg-toggle'), next);
    setCustomBackgroundPrefs({ enabled: next });

    // Turning off is immediate; turning on finishes (and notifies)
    // once the image has loaded.
    if (!next) syncCustomBackgroundUi();
  });

  // --- live controls ---
  block.addEventListener('input', event => {
    const el = event.target;
    const key = el.dataset?.cbg;

    if (!key || el.type !== 'range') return;

    reflectSlider(el);
    setCustomBackgroundPrefs({ [key]: Number(el.value) });
    renderPreview();
  });

  block.addEventListener('change', event => {
    const el = event.target;
    const key = el.dataset?.cbg;

    if (!key || el.tagName !== 'SELECT') return;

    setCustomBackgroundPrefs({ [key]: el.value });
    renderPreview();
  });

  $('custom-bg-animate').addEventListener('click', () => {
    const next = !getCustomBackgroundPrefs().animate;

    setSwitch($('custom-bg-animate'), next);
    setCustomBackgroundPrefs({ animate: next });

    renderPreview({ rebuild: true });
  });

  $('custom-bg-reset-controls').addEventListener('click', () => {
    resetBackgroundControls();
    syncCustomBackgroundUi();
  });

  syncCustomBackgroundUi();
}

// ---------------- advanced ----------------

function syncAdvancedUi() {
  const master = getBlurAll();
  const blurMax = getBlurMax();

  setSwitch($('adv-blur-all'), master);

  for (const surface of SURFACES) {
    const state = getSurfaceState(surface.id);
    const blurActive = master && state.blurOn;

    const toggle = $(`sf-${surface.id}-blur-on`);
    setSwitch(toggle, state.blurOn);
    if (toggle) toggle.disabled = !master;

    setSlider(
      $(`sf-${surface.id}-transparency`),
      state.transparency
    );

    const blur = $(`sf-${surface.id}-blur`);
    if (blur) blur.max = String(blurMax);
    setSlider(blur, Math.min(state.blur, blurMax), {
      disabled: !blurActive
    });
  }
}

function bindAdvanced() {
  const root = $('advanced-appearance');
  if (!root) return;

  $('adv-blur-all').addEventListener('click', () => {
    setBlurAll(!getBlurAll());
    syncAdvancedUi();
  });

  root.addEventListener('input', event => {
    const el = event.target;
    const id = el.dataset?.sf;

    if (!id || el.type !== 'range') return;

    reflectSlider(el);
    setSurface(id, { [el.dataset.sfKey]: Number(el.value) });
  });

  root.addEventListener('click', event => {
    const el = event.target.closest('.switch[data-sf]');
    if (!el || el.disabled) return;

    const id = el.dataset.sf;
    const next = !el.classList.contains('on');

    setSurface(id, { blurOn: next });
    syncAdvancedUi();
  });

  $('adv-reset').addEventListener('click', () => {
    resetSurfaces();
    syncAdvancedUi();
    showToast('Advanced appearance reset');
  });
}

// ---------------- reset all ----------------

function bindResetAll() {
  const button = $('appearance-reset-all');
  if (!button) return;

  button.addEventListener('click', async () => {
    const confirmed = await showConfirm(
      'This resets theme, background, message style, font, animations, ' +
        'your custom background and all advanced settings on this device. ' +
        'Your accent color is not changed.',
      {
        title: 'Reset all appearance settings?',
        confirmText: 'Reset all',
        cancelText: 'Cancel',
        danger: true
      }
    );

    if (!confirmed) return;

    discardCandidate();

    await resetCustomBackground();
    resetSurfaces();

    applyTheme('dark');
    applyAmbientLevel(DEFAULT_AMBIENT_LEVEL);
    applyBackgroundTheme(DEFAULT_BACKGROUND_ID);
    applyMessageBubbleStyle(DEFAULT_BUBBLE_STYLE);
    applyUseAccentForBubbles(true);
    applyAnimationsEnabled(false);
    applyFontFamily(DEFAULT_FONT_ID);
    repaintAllMessageAccents();

    showToast('Appearance reset', 'success');

    // Repaint the page so every control shows the new values.
    await renderSettings();
  });
}

export function bindCustomAppearance() {
  bindCustomBackground();
  bindAdvanced();
  bindResetAll();
}
