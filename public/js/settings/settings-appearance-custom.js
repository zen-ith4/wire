// ============================================================
// Settings → Appearance: Custom background, Advanced, Resets
//
// Markup + behaviour for the three blocks added to the existing
// Appearance page. State lives elsewhere:
//   custom-background.js     image, prefs, live layer
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
  POSITION_OPTIONS,
  applyCandidate,
  buildBackgroundVars,
  getActiveSource,
  getCustomBackgroundPrefs,
  prepareCandidate,
  releaseCandidate,
  removeCustomBackground,
  resetBackgroundControls,
  resetCustomBackground,
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
            Use your own image behind the app. It stays on
            this device and is never uploaded.
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
        class="custom-bg-preview"
        id="custom-bg-preview"
        role="img"
        aria-label="Background preview"></div>

      <div class="custom-bg-actions">

        <label class="btn btn-sm custom-bg-file-btn">
          <span id="custom-bg-file-label">
            ${prefs.hasImage ? 'Replace image…' : 'Choose image…'}
          </span>

          <input
            type="file"
            class="custom-bg-file-input"
            id="custom-bg-file"
            accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
            aria-label="Choose a background image from this device (JPG, PNG, WebP or GIF)">
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
        </div>

        <div
          class="appearance-slider-row"
          id="custom-bg-animate-row"
          ${prefs.animated ? '' : 'hidden'}>

          <div>
            <div class="settings-row-label">
              Play animation
            </div>

            <div class="settings-row-sublabel">
              Turn off to show a still frame and save battery.
              Always still when your device asks for reduced motion.
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

let previewSrc = null;

function previewState() {
  const prefs = getCustomBackgroundPrefs();

  if (candidate) {
    const playing =
      candidate.animated && shouldPlayAnimation(prefs);

    return {
      prefs: { ...prefs, animated: candidate.animated },
      animated: candidate.animated,
      playing,
      src:
        candidate.animated && !playing && candidate.posterUrl
          ? candidate.posterUrl
          : candidate.url
    };
  }

  if (prefs.enabled && prefs.hasImage) {
    const active = getActiveSource();

    if (active) {
      return {
        prefs,
        animated: prefs.animated,
        playing: active.playing,
        src: active.src
      };
    }
  }

  return { prefs, animated: false, playing: false, src: null };
}

function applyPreviewVars(preview, state) {
  const vars = buildBackgroundVars(
    { ...state.prefs, animated: state.animated },
    {
      src: state.src,
      playing: state.playing,
      // The preview is a fraction of the screen; shrink the blur so
      // it reads the same.
      blurScale: 0.3
    }
  );

  for (const [key, value] of Object.entries(vars)) {
    preview.style.setProperty(key, value);
  }
}

function renderPreview({ rebuild = false } = {}) {
  const preview = $('custom-bg-preview');
  if (!preview) return;

  const state = previewState();

  if (rebuild || previewSrc !== state.src) {
    previewSrc = state.src;
    preview.textContent = '';

    if (!state.src) {
      const prefs = state.prefs;
      const empty = document.createElement('div');
      empty.className = 'custom-bg-preview-empty';
      empty.textContent =
        prefs.hasImage && !prefs.enabled
          ? 'Custom background is off'
          : 'No custom background selected';

      preview.appendChild(empty);
    } else {
      const surface = document.createElement('div');
      surface.className = 'cbg-surface';

      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      img.src = state.src;

      surface.appendChild(img);
      preview.appendChild(surface);

      const received = document.createElement('div');
      received.className = 'custom-bg-sample';
      received.textContent = 'Hey, is this readable?';

      const own = document.createElement('div');
      own.className = 'custom-bg-sample is-own';
      own.textContent = 'Looks good to me.';

      preview.append(received, own);
    }
  }

  if (state.src) applyPreviewVars(preview, state);
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
      ? 'Replace image…'
      : 'Choose image…';

  const animated = candidate ? candidate.animated : prefs.animated;
  $('custom-bg-animate-row').hidden = !animated;

  setSlider($('custom-bg-opacity'), prefs.opacity);
  setSlider($('custom-bg-dim'), prefs.dim);
  setSlider($('custom-bg-blur'), prefs.blur);
  $('custom-bg-fit').value = prefs.fit;
  $('custom-bg-position').value = prefs.position;
  setSwitch($('custom-bg-animate'), prefs.animate);

  renderPreview();
}

function discardCandidate() {
  releaseCandidate(candidate);
  candidate = null;
  previewSrc = null;
}

function bindCustomBackground() {
  const block = $('custom-bg-block');
  if (!block) return;

  candidate = null;
  previewSrc = null;

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

  // --- pick a file ---
  $('custom-bg-file').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files && input.files[0];

    input.value = '';

    if (!file) return;

    setStatus('Preparing image…');

    try {
      const next = await prepareCandidate(file);

      discardCandidate();
      candidate = next;

      setStatus('Preview only — choose Apply to use it.');
      syncCustomBackgroundUi();
    } catch (error) {
      const message =
        error?.message || "Couldn't read that image.";

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
    } catch {
      setStatus("Couldn't save the image on this device.", true);
      showToast("Couldn't save the image on this device.", 'error');
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
    await removeCustomBackground();

    discardCandidate();
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

    previewSrc = null;
    renderPreview();
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
