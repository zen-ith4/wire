// ============================================================
// Settings → Appearance: "My message colors"
//
// Controls for the gradient painted on the bubbles the viewer
// sends, and optionally on incoming bubbles too. State and
// persistence live in theme.js; this file only renders the block
// and turns clicks into edits.
//
// Editing works on a DRAFT copy. The live preview shows the draft,
// and nothing is stored until Save is pressed. Discard drops the
// draft; Reset restores Wire's default colors immediately.
// ============================================================

import { ICONS } from '../icons.js';
import { escapeHtml, showToast } from '../core/utils.js';

import {
  OWN_BUBBLE_GRADIENT_LIMITS,
  applyOwnBubbleGradient,
  buildOwnBubbleGradientVars,
  contrastTextFor,
  getCurrentAccentHex,
  getOwnBubbleGradient,
  getOwnBubbleTextContrast,
  getUseAccentForBubbles,
  mixHex,
  normalizeOwnBubbleGradient,
  resetOwnBubbleGradient,
  rgbStringFromHex
} from './theme.js';

import {
  setSlider,
  setSwitch,
  sliderRow,
  switchButton
} from './settings-appearance-custom.js';

const { minStops, maxStops } = OWN_BUBBLE_GRADIENT_LIMITS;

let saved = null;
let draft = null;

function $(id) {
  return document.getElementById(id);
}

function sameConfig(a, b) {
  return (
    JSON.stringify(normalizeOwnBubbleGradient(a)) ===
    JSON.stringify(normalizeOwnBubbleGradient(b))
  );
}

// ---------------- markup ----------------

function stopsHtml(stops) {
  return stops
    .map((stop, index) => `
      <div class="own-gradient-stop">

        <input
          type="color"
          class="own-gradient-color"
          value="${escapeHtml(stop.color)}"
          data-og-color="${index}"
          aria-label="Color ${index + 1}"
          title="Color ${index + 1}">

        <div class="own-gradient-stop-position">
          <div class="sound-volume-control">
            <input
              type="range"
              class="sound-slider"
              id="own-gradient-pos-${index}"
              min="0"
              max="100"
              step="1"
              value="${stop.position}"
              data-unit="%"
              data-og-position="${index}"
              style="--sound-volume:${stop.position}%"
              aria-label="Color ${index + 1} position">

            <output
              class="sound-volume-value"
              for="own-gradient-pos-${index}">${stop.position}%</output>
          </div>
        </div>

        <button
          type="button"
          class="btn btn-sm btn-ghost"
          data-og-remove="${index}"
          aria-label="Remove color ${index + 1}"
          title="Remove color"
          ${stops.length <= minStops ? 'disabled' : ''}>
          ${ICONS.close || '×'}
        </button>

      </div>
    `)
    .join('');
}

export function renderOwnBubbleGradientSection() {
  const config = getOwnBubbleGradient();

  return `
    <div
      class="settings-row settings-row-column"
      id="own-bubble-gradient-block">

      <div class="own-gradient-head">
        <div>
          <div class="settings-row-label">
            My message colors
          </div>

          <div class="settings-row-sublabel">
            Give the bubbles you send a gradient.
          </div>
        </div>

        ${switchButton({
          id: 'own-gradient-toggle',
          on: config.enabled,
          label: 'Use a gradient for my message bubbles'
        })}
      </div>

      <div
        class="own-gradient-head"
        id="own-gradient-others-row"
        ${config.enabled ? '' : 'hidden'}>
        <div>
          <div class="settings-row-label">
            Apply to Other Users' Messages
          </div>

          <div class="settings-row-sublabel">
            Use the same gradient on messages you receive, in
            direct messages and group chats.
          </div>
        </div>

        ${switchButton({
          id: 'own-gradient-others-toggle',
          on: config.applyToOthers,
          label: "Apply the gradient to other users' messages"
        })}
      </div>

      <div
        class="own-bubble-preview"
        id="own-bubble-preview"
        role="img"
        aria-label="Preview of your message bubbles">

        <div class="chat-msg">
          <div class="chat-msg-content">
            <div class="chat-bubble">Hey, how's it going?</div>
          </div>
        </div>

        <div class="chat-msg own">
          <div class="chat-msg-content">
            <div class="chat-bubble">Going great, thanks!</div>
          </div>
        </div>

      </div>

      <div
        class="own-gradient-controls"
        id="own-gradient-controls"
        ${config.enabled ? '' : 'hidden'}>

        ${sliderRow({
          id: 'own-gradient-angle',
          label: 'Direction',
          hint: 'The angle the colors flow along',
          min: OWN_BUBBLE_GRADIENT_LIMITS.minAngle,
          max: OWN_BUBBLE_GRADIENT_LIMITS.maxAngle,
          value: config.angle,
          unit: 'deg',
          attrs: 'data-og="angle"'
        })}

        <div>
          <div class="settings-row-label">
            Colors
          </div>

          <div class="settings-row-sublabel">
            Use ${minStops} to ${maxStops} colors. Each position sets
            where that color sits along the gradient.
          </div>
        </div>

        <div
          class="own-gradient-stops"
          id="own-gradient-stops">
          ${stopsHtml(config.stops)}
        </div>

        <div>
          <button
            type="button"
            class="btn btn-sm"
            id="own-gradient-add">
            Add color
          </button>
        </div>

      </div>

      <div class="own-gradient-actions">

        <button
          type="button"
          class="btn btn-sm btn-primary"
          id="own-gradient-save">
          Save colors
        </button>

        <button
          type="button"
          class="btn btn-sm"
          id="own-gradient-discard">
          Discard
        </button>

        <button
          type="button"
          class="btn btn-sm btn-ghost"
          id="own-gradient-reset">
          Reset to default
        </button>

        <span
          class="own-gradient-status"
          id="own-gradient-status"
          role="status"
          aria-live="polite"></span>

      </div>

    </div>
  `;
}

// ---------------- sync ----------------

// Paints the draft into the preview. Uses the same CSS values the
// real chat will use, and the viewer's accent for the incoming
// bubble, so what is shown is what will be saved.
function applyPreview() {
  const preview = $('own-bubble-preview');
  if (!preview) return;

  const config = normalizeOwnBubbleGradient(draft);

  if (config.enabled) {
    const vars = buildOwnBubbleGradientVars(config);

    preview.dataset.ownGradient = 'on';
    preview.style.setProperty('--own-bubble-gradient', vars.gradient);
    preview.style.setProperty('--own-bubble-text', vars.text);
  } else {
    delete preview.dataset.ownGradient;
    preview.style.removeProperty('--own-bubble-gradient');
    preview.style.removeProperty('--own-bubble-text');
  }

  if (config.enabled && config.applyToOthers) {
    preview.dataset.ownGradientOthers = 'on';
  } else {
    delete preview.dataset.ownGradientOthers;
  }

  if (getUseAccentForBubbles()) {
    const rgb = rgbStringFromHex(getCurrentAccentHex());

    preview.style.setProperty('--message-accent', `rgb(${rgb})`);
    preview.style.setProperty('--message-accent-contrast', contrastTextFor(rgb));
  } else {
    preview.style.removeProperty('--message-accent');
    preview.style.removeProperty('--message-accent-contrast');
  }
}

// WCAG minimum for large text / UI. Below this the message text may be
// hard to read, so the user gets a warning (saving is still allowed).
const MIN_READABLE_CONTRAST = 3;

function syncActions() {
  const dirty = !sameConfig(draft, saved);

  ['own-gradient-save', 'own-gradient-discard'].forEach(id => {
    const button = $(id);
    if (button) button.disabled = !dirty;
  });

  const messages = [];

  if (dirty) {
    messages.push('Unsaved changes');
  }

  if (
    draft.enabled &&
    getOwnBubbleTextContrast(draft) < MIN_READABLE_CONTRAST
  ) {
    messages.push('Text may be hard to read with these colors');
  }

  const status = $('own-gradient-status');
  if (status) {
    status.textContent = messages.join(' · ');
  }
}

function syncStops() {
  const list = $('own-gradient-stops');
  if (list) {
    list.innerHTML = stopsHtml(draft.stops);
  }

  const add = $('own-gradient-add');
  if (add) {
    add.disabled = draft.stops.length >= maxStops;
  }
}

// Full refresh of every control from the draft. Used for structural
// changes; typing/dragging uses the lighter update in the input
// handler so the color picker keeps its focus.
function syncUi() {
  setSwitch($('own-gradient-toggle'), draft.enabled);
  setSwitch($('own-gradient-others-toggle'), draft.applyToOthers);

  const othersRow = $('own-gradient-others-row');
  if (othersRow) othersRow.hidden = !draft.enabled;

  const controls = $('own-gradient-controls');
  if (controls) controls.hidden = !draft.enabled;

  setSlider($('own-gradient-angle'), draft.angle);

  syncStops();
  syncActions();
  applyPreview();
}

// ---------------- edits ----------------

function addStop() {
  if (draft.stops.length >= maxStops) return;

  const sorted = [...draft.stops].sort(
    (a, b) => a.position - b.position
  );

  // New color goes halfway between the last two stops.
  const [before, after] = sorted.slice(-2);

  draft.stops.push({
    color: mixHex(before.color, after.color, 0.5),
    position: Math.round((before.position + after.position) / 2)
  });
}

function removeStop(index) {
  if (draft.stops.length <= minStops) return;
  draft.stops.splice(index, 1);
}

function saveDraft() {
  const config = normalizeOwnBubbleGradient(draft);

  applyOwnBubbleGradient(config);

  saved = config;
  draft = normalizeOwnBubbleGradient(config);

  syncUi();
  showToast('Message colors saved', 'success');
}

function discardDraft() {
  draft = normalizeOwnBubbleGradient(saved);
  syncUi();
}

function resetToDefault() {
  resetOwnBubbleGradient();

  saved = getOwnBubbleGradient();
  draft = normalizeOwnBubbleGradient(saved);

  syncUi();
  showToast('Message colors reset', 'success');
}

// ---------------- binding ----------------

export function bindOwnBubbleGradient() {
  const block = $('own-bubble-gradient-block');
  if (!block) return;

  saved = getOwnBubbleGradient();
  draft = normalizeOwnBubbleGradient(saved);

  syncUi();

  block.addEventListener('click', event => {
    if (event.target.closest('#own-gradient-toggle')) {
      draft.enabled = !draft.enabled;
      syncUi();
      return;
    }

    if (event.target.closest('#own-gradient-others-toggle')) {
      draft.applyToOthers = !draft.applyToOthers;
      syncUi();
      return;
    }

    if (event.target.closest('#own-gradient-add')) {
      addStop();
      syncUi();
      return;
    }

    const remove = event.target.closest('[data-og-remove]');

    if (remove) {
      removeStop(Number(remove.dataset.ogRemove));
      syncUi();
      return;
    }

    if (event.target.closest('#own-gradient-save')) {
      saveDraft();
      return;
    }

    if (event.target.closest('#own-gradient-discard')) {
      discardDraft();
      return;
    }

    if (event.target.closest('#own-gradient-reset')) {
      resetToDefault();
    }
  });

  block.addEventListener('input', event => {
    const target = event.target;

    if (target.id === 'own-gradient-angle') {
      draft.angle = Number(target.value);
      setSlider(target, draft.angle);

    } else if (target.matches('[data-og-color]')) {
      draft.stops[Number(target.dataset.ogColor)].color =
        target.value.toUpperCase();

    } else if (target.matches('[data-og-position]')) {
      const index = Number(target.dataset.ogPosition);

      draft.stops[index].position = Number(target.value);
      setSlider(target, draft.stops[index].position);

    } else {
      return;
    }

    syncActions();
    applyPreview();
  });

  // `change` fires when a slider is released or a color picker
  // closes. Re-sorting here (not on `input`) keeps the list stable
  // while dragging, then shows colors in gradient order.
  block.addEventListener('change', event => {
    if (!event.target.matches('[data-og-position], [data-og-color]')) {
      return;
    }

    draft.stops.sort((a, b) => a.position - b.position);
    syncStops();
    syncActions();
    applyPreview();
  });
}
