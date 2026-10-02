// ============================================================
// Settings > Message sounds
// ------------------------------------------------------------
// Master switch, volume, and per-kind (sent / received) sound
// selection with previews and custom local files.
//
// All state lives in messageSoundManager (notifications/
// message-sounds.js); this file is only the UI. The body is
// re-rendered from the manager's settings snapshot after every
// change, and one delegated listener handles every control, so
// nothing needs re-binding after a repaint.
//
// Custom sounds are local to this device: the picked file is
// decoded to validate it, stored in IndexedDB by the manager, and
// never uploaded. Only the file *name* is ever shown - browsers
// and WebViews don't expose the real path, and we don't ask for one.
// ============================================================

import { ICONS } from '../icons.js';
import { escapeHtml, escapeAttr, showToast } from '../core/utils.js';
import { showConfirm } from '../ui/confirm.js';
import {
  messageSoundManager,
  SOUND_PRESETS,
  CUSTOM_SOUND_LIMITS,
  CUSTOM_SOUND_ACCEPT,
} from '../notifications/message-sounds.js';

const KIND_LABELS = {
  sent: {
    title: 'Sent message',
    sub: 'Plays after one of your messages is sent',
    aria: 'sent message sound',
  },
  received: {
    title: 'Received message',
    sub: 'Plays when a new message arrives',
    aria: 'received message sound',
  },
};

const KINDS = ['sent', 'received'];

// Transient UI state (not persisted): inline errors and "checking"
// flags per kind.
const ui = {
  errors: { sent: '', received: '' },
  busy: { sent: false, received: false },
};

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

function presetName(id) {
  const preset = SOUND_PRESETS.find((p) => p.id === id);
  return preset ? preset.name : 'Default';
}

function customMeta(custom) {
  const parts = [];
  if (custom.duration) parts.push(`${custom.duration.toFixed(1)} s`);
  if (custom.size) {
    parts.push(`${Math.max(1, Math.round(custom.size / 1024))} KB`);
  }
  return parts.join(' · ');
}

function currentLabel(selection) {
  if (selection.useCustom && selection.custom) {
    return `Custom · ${escapeHtml(selection.custom.name)}`;
  }
  return escapeHtml(presetName(selection.preset));
}

function playButton(kind, choice, label, dis) {
  return `
    <button
      type="button"
      class="sound-play"
      data-action="preview"
      data-kind="${kind}"
      ${choice ? `data-choice="${choice}"` : ''}
      data-fid="play-${kind}-${choice || 'current'}"
      aria-label="${escapeAttr(label)}"
      title="${escapeAttr(label)}"${dis}>
      ${ICONS.play || ''}
    </button>
  `;
}

function presetOption(kind, preset, selection, dis) {
  const selected =
    !selection.useCustom && selection.preset === preset.id;

  return `
    <div class="sound-option${selected ? ' selected' : ''}">

      <button
        type="button"
        class="sound-option-select"
        data-action="select"
        data-kind="${kind}"
        data-choice="${preset.id}"
        data-fid="select-${kind}-${preset.id}"
        aria-pressed="${selected}"${dis}>

        <span class="sound-option-dot" aria-hidden="true"></span>

        <span class="sound-option-text">
          <span class="sound-option-name">${preset.name}</span>
        </span>

      </button>

      ${playButton(kind, preset.id, `Preview ${preset.name}`, dis)}

    </div>
  `;
}

function customOption(kind, selection, dis) {
  const custom = selection.custom;
  const selected = selection.useCustom && Boolean(custom);
  const busy = ui.busy[kind];

  const sub = custom
    ? `<span class="sound-option-sub">${escapeHtml(custom.name)}</span>
       <span class="sound-option-meta">${customMeta(custom)}</span>`
    : `<span class="sound-option-sub">Use your own sound file</span>`;

  return `
    <div class="sound-option sound-option-custom${
      selected ? ' selected' : ''
    }">

      <button
        type="button"
        class="sound-option-select"
        data-action="select"
        data-kind="${kind}"
        data-choice="custom"
        data-fid="select-${kind}-custom"
        aria-pressed="${selected}"${dis}>

        <span class="sound-option-dot" aria-hidden="true"></span>

        <span class="sound-option-text">
          <span class="sound-option-name">Custom</span>
          ${sub}
        </span>

      </button>

      ${
        custom
          ? playButton(kind, 'custom', 'Preview custom sound', dis)
          : ''
      }

    </div>

    <div class="sound-custom-actions">

      <button
        type="button"
        class="btn btn-sm"
        data-action="upload"
        data-kind="${kind}"
        data-fid="upload-${kind}"${busy ? ' disabled' : dis}>
        ${ICONS.upload || ''}
        ${
          busy
            ? 'Checking file…'
            : custom
            ? 'Replace sound'
            : 'Upload custom sound'
        }
      </button>

      ${
        custom
          ? `
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          data-action="remove"
          data-kind="${kind}"
          data-fid="remove-${kind}"${dis}>
          ${ICONS.trash || ''}
          Remove
        </button>`
          : ''
      }

    </div>
  `;
}

function kindCard(kind, settings, dis) {
  const selection = settings[kind];
  const labels = KIND_LABELS[kind];
  const error = ui.errors[kind];

  return `
    <div class="sound-card" data-kind="${kind}">

      <div class="sound-card-head">

        <div class="sound-card-title">
          <div class="settings-row-label">${labels.title}</div>
          <div class="settings-row-sublabel">
            ${labels.sub}
          </div>
          <div class="sound-current">
            <span class="sound-current-label">Selected</span>
            <span class="sound-current-name">${currentLabel(selection)}</span>
          </div>
        </div>

        ${playButton(kind, '', `Play ${labels.aria}`, dis)}

      </div>

      <div
        class="sound-options"
        role="group"
        aria-label="${escapeAttr(labels.title)} sound">

        ${SOUND_PRESETS.map((preset) =>
          presetOption(kind, preset, selection, dis)
        ).join('')}

        ${customOption(kind, selection, dis)}

      </div>

      ${
        error
          ? `<div class="sound-error" role="alert">${escapeHtml(error)}</div>`
          : ''
      }

    </div>
  `;
}

function bodyHtml() {
  const settings = messageSoundManager.getSettings();
  const dis = settings.enabled ? '' : ' disabled';

  const { maxBytes, maxSeconds } = CUSTOM_SOUND_LIMITS;

  return `
    <div class="settings-row">

      <div>
        <div class="settings-row-label">Message sounds</div>

        <div class="settings-row-sublabel">
          Play a soft sound when you send a direct message
          and when a new one arrives
        </div>
      </div>

      <button
        type="button"
        class="switch${settings.enabled ? ' on' : ''}"
        id="message-sounds-toggle"
        data-action="toggle"
        data-fid="toggle"
        role="switch"
        aria-checked="${settings.enabled}"
        aria-label="Message sounds">

        <span class="switch-thumb"></span>

      </button>

    </div>

    <div
      class="sound-controls${settings.enabled ? '' : ' is-off'}">

      <div class="settings-row sound-volume-row">

        <div>
          <div class="settings-row-label">Volume</div>

          <div class="settings-row-sublabel">
            Only changes Wire's message sounds
          </div>
        </div>

        <div class="sound-volume-control">

          <input
            type="range"
            class="sound-slider"
            id="message-sound-volume"
            min="0"
            max="100"
            step="1"
            value="${settings.volume}"
            style="--sound-volume:${settings.volume}%"
            aria-label="Message sound volume"${dis}>

          <output
            class="sound-volume-value"
            id="message-sound-volume-value"
            for="message-sound-volume">${settings.volume}%</output>

        </div>

      </div>

      ${KINDS.map((kind) => kindCard(kind, settings, dis)).join('')}

      <div class="sound-footnote">
        Custom sounds stay on this device. Short files only —
        up to ${maxSeconds} seconds and ${Math.round(maxBytes / 1024)} KB.
      </div>

      <div class="sound-reset-row">
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          data-action="reset"
          data-fid="reset"${dis}>
          Reset to defaults
        </button>
      </div>

    </div>
  `;
}

export function renderMessageSounds() {
  return `
    <div class="settings-section" id="message-sounds-root">

      <div class="settings-section-title">
        Message sounds
      </div>

      <div id="message-sounds-body">
        ${bodyHtml()}
      </div>

      <input
        type="file"
        id="message-sound-file"
        accept="${escapeAttr(CUSTOM_SOUND_ACCEPT)}"
        hidden>

    </div>
  `;
}

// ------------------------------------------------------------
// Behavior
// ------------------------------------------------------------

function previewFor(kind, choice) {
  return kind === 'sent'
    ? messageSoundManager.previewSent(choice)
    : messageSoundManager.previewReceived(choice);
}

function toastForPreview(result) {
  if (!result) return;

  if (result.ok) {
    if (result.fallback) {
      showToast(
        "Your custom sound couldn't be loaded, so a built-in sound played",
        'error'
      );
    }
    return;
  }

  switch (result.reason) {
    case 'muted':
      showToast('Volume is set to 0%');
      break;
    case 'unsupported':
      showToast("This device can't play sounds", 'error');
      break;
    default:
      showToast("Couldn't play that sound", 'error');
  }
}

export function bindMessageSoundSettings() {
  const root = document.getElementById('message-sounds-root');
  const body = document.getElementById('message-sounds-body');
  const fileInput = document.getElementById('message-sound-file');

  if (!root || !body || !fileInput) return;

  // Start each visit with a clean slate.
  KINDS.forEach((kind) => {
    ui.errors[kind] = '';
    ui.busy[kind] = false;
  });

  let pickerKind = null;

  const repaint = () => {
    const focusId =
      document.activeElement?.dataset?.fid || null;

    body.innerHTML = bodyHtml();

    if (focusId) {
      const el = body.querySelector(
        `[data-fid="${focusId}"]`
      );
      if (el && !el.disabled) el.focus({ preventScroll: true });
    }
  };

  // Repaint when the manager changes something underneath us (e.g. a
  // stored custom sound turned out to be missing). Stop listening
  // once this page has been replaced.
  const unsubscribe = messageSoundManager.onChange(() => {
    if (!root.isConnected) {
      unsubscribe();
      return;
    }
    // The volume slider repaints itself; don't fight an active drag.
    if (document.activeElement?.id === 'message-sound-volume') {
      return;
    }
    repaint();
  });

  const openPicker = (kind) => {
    if (ui.busy[kind]) return;
    pickerKind = kind;
    fileInput.value = '';
    fileInput.click();
  };

  root.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;

    const { action, kind, choice } = target.dataset;

    switch (action) {
      case 'toggle': {
        const next = !messageSoundManager.isEnabled();
        messageSoundManager.setEnabled(next);
        repaint();

        // Turning sounds on plays a preview. The click is also the
        // user gesture browsers need before they will play audio.
        if (next) {
          toastForPreview(
            await messageSoundManager.previewReceived()
          );
        }
        break;
      }

      case 'select': {
        ui.errors[kind] = '';

        if (choice === 'custom') {
          const current = messageSoundManager.getSettings()[kind];
          if (!current.custom) {
            openPicker(kind);
            repaint();
            break;
          }
        }

        if (kind === 'sent') {
          messageSoundManager.setSentSound(choice);
        } else {
          messageSoundManager.setReceivedSound(choice);
        }

        repaint();
        break;
      }

      case 'preview':
        toastForPreview(await previewFor(kind, choice || undefined));
        break;

      case 'upload':
        ui.errors[kind] = '';
        openPicker(kind);
        repaint();
        break;

      case 'remove':
        ui.errors[kind] = '';
        await messageSoundManager.removeCustomSound(kind);
        repaint();
        break;

      case 'reset': {
        const ok = await showConfirm(
          'Reset volume, sound choices and custom sounds to their defaults?',
          {
            title: 'Reset message sounds',
            confirmText: 'Reset',
            danger: false,
          }
        );

        if (!ok) break;

        KINDS.forEach((k) => {
          ui.errors[k] = '';
        });
        await messageSoundManager.resetToDefaults();
        repaint();
        break;
      }
    }
  });

  // Applies immediately while dragging; no repaint, so the drag is
  // never interrupted.
  root.addEventListener('input', (event) => {
    if (event.target.id !== 'message-sound-volume') return;

    const applied = messageSoundManager.setVolume(
      event.target.value
    );

    event.target.style.setProperty('--sound-volume', `${applied}%`);

    const out = document.getElementById(
      'message-sound-volume-value'
    );
    if (out) out.textContent = `${applied}%`;
  });

  fileInput.addEventListener('change', async () => {
    const kind = pickerKind;
    const file = fileInput.files && fileInput.files[0];

    pickerKind = null;

    // Cancelled picker, or nothing to do.
    if (!kind || !file) {
      fileInput.value = '';
      return;
    }

    ui.busy[kind] = true;
    ui.errors[kind] = '';
    repaint();

    const result = await messageSoundManager.setCustomSound(
      kind,
      file
    );

    // Drop our reference to the file straight away.
    fileInput.value = '';

    ui.busy[kind] = false;

    if (!result.ok) {
      ui.errors[kind] = result.message;
    }

    repaint();
  });
}
