// ============================================================
// Settings > Keyboard Shortcuts
// ------------------------------------------------------------
// Lists every shortcut in core/shortcuts.js and lets the user
// rebind or reset each one. Same local-repaint convention as
// settings-message-sounds.js: one delegated click listener on the
// section root, innerHTML regenerated from current state after
// every change — nothing here is a network write, so there's no
// need to touch settings.js's renderSettings()/settings-stale
// machinery used by the server-backed categories.
// ============================================================

import { ICONS } from '../icons.js';
import { escapeHtml, showToast, emptyState } from '../core/utils.js';
import { showConfirm } from '../ui/confirm.js';
import {
  getAllShortcuts,
  setShortcutCombo,
  clearShortcutCombo,
  resetShortcut,
  resetAllShortcuts,
  findConflict,
  formatCombo,
  comboFromEvent,
  isModifierOnlyKey,
  isReservedCombo,
  setRecordingActive,
} from '../core/shortcuts.js';

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

function keyChipsHtml(combo) {
  const parts = formatCombo(combo);
  if (!parts.length) {
    return '<span class="shortcut-key shortcut-key-empty">Not set</span>';
  }
  return parts
    .map((part) => `<kbd class="shortcut-key">${escapeHtml(part)}</kbd>`)
    .join('');
}

function shortcutRowHtml(s, recordingId) {
  const recording = s.id === recordingId;

  const editContent = recording
    ? '<span class="shortcut-recording">Press keys…</span>'
    : keyChipsHtml(s.combo);

  return `
    <div class="settings-row shortcut-row">

      <div>
        <div class="settings-row-label">
          ${escapeHtml(s.label)}
        </div>

        ${s.sublabel ? `
        <div class="settings-row-sublabel">
          ${escapeHtml(s.sublabel)}
        </div>` : ''}
      </div>

      <div class="shortcut-row-controls">

        <button
          type="button"
          class="shortcut-edit-btn${recording ? ' recording' : ''}"
          data-action="edit"
          data-id="${escapeHtml(s.id)}"
          aria-label="Change shortcut for ${escapeHtml(s.label)}">

          ${editContent}

        </button>

        ${s.isCustom ? `
        <button
          type="button"
          class="icon-btn shortcut-reset-btn"
          data-action="reset"
          data-id="${escapeHtml(s.id)}"
          title="Reset to default"
          aria-label="Reset ${escapeHtml(s.label)} to default">
          ${ICONS.reset || ''}
        </button>` : ''}

      </div>

    </div>
  `;
}

function dynamicHtml(recordingId) {
  const shortcuts = getAllShortcuts();

  if (!shortcuts.length) {
    return emptyState(
      ICONS.keyboard || ICONS.empty,
      'No keyboard shortcuts yet',
      "Wire doesn't have any configurable keyboard shortcuts available right now."
    );
  }

  const anyCustom = shortcuts.some((s) => s.isCustom);

  const rowsHtml = shortcuts
    .map((s) => shortcutRowHtml(s, recordingId))
    .join('');

  const resetAllHtml = shortcuts.length > 1 ? `
    <div class="settings-reset-row">
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        id="shortcuts-reset-all"
        ${anyCustom ? '' : 'disabled'}>
        Reset all shortcuts
      </button>
    </div>
  ` : '';

  return `
    <div class="shortcut-list">
      ${rowsHtml}
    </div>
    ${resetAllHtml}
  `;
}

export function renderShortcuts() {
  return `
    <div class="settings-section" id="keyboard-shortcuts-root">

      <div class="settings-section-title">
        Keyboard Shortcuts
      </div>

      <div id="keyboard-shortcuts-dynamic">
        ${dynamicHtml(null)}
      </div>

    </div>
  `;
}

// ------------------------------------------------------------
// Binding
// ------------------------------------------------------------

export function bindShortcutSettings() {
  const root = document.getElementById('keyboard-shortcuts-root');
  const dynamic = document.getElementById('keyboard-shortcuts-dynamic');
  if (!root || !dynamic) return;

  let recordingId = null;
  let keyListener = null;

  function stopListening() {
    if (keyListener) {
      document.removeEventListener('keydown', keyListener, true);
      keyListener = null;
    }
    setRecordingActive(false);
  }

  function repaint() {
    dynamic.innerHTML = dynamicHtml(recordingId);
  }

  function endRecording() {
    stopListening();
    recordingId = null;
    repaint();
  }

  function beginRecording(id) {
    stopListening();
    recordingId = id;
    setRecordingActive(true);
    repaint();

    keyListener = (e) => {
      // The section was replaced (category closed, or a re-render
      // happened elsewhere in Settings) — stop owning input instead
      // of swallowing keystrokes the app no longer expects us to.
      if (!root.isConnected) {
        stopListening();
        recordingId = null;
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (
        e.key === 'Escape' &&
        !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
      ) {
        endRecording();
        return;
      }

      // A bare modifier isn't a shortcut yet — keep waiting for the
      // key that completes the combination.
      if (isModifierOnlyKey(e.key)) return;

      const combo = comboFromEvent(e);

      if (isReservedCombo(combo)) {
        showToast('That combination is reserved by the browser', 'error');
        return;
      }

      const conflict = findConflict(combo, id);

      if (conflict) {
        stopListening();

        const comboLabel = formatCombo(combo).join('+');

        showConfirm(
          `"${comboLabel}" is already assigned to "${conflict.label}". Reassign it here?`,
          {
            title: 'Shortcut already in use',
            confirmText: 'Reassign',
            cancelText: 'Cancel',
            danger: false,
          }
        ).then((ok) => {
          if (ok) {
            clearShortcutCombo(conflict.id);
            setShortcutCombo(id, combo);
          }
          recordingId = null;
          repaint();
        });
        return;
      }

      setShortcutCombo(id, combo);
      recordingId = null;
      stopListening();
      repaint();
    };

    document.addEventListener('keydown', keyListener, true);
  }

  root.addEventListener('click', (event) => {
    const editBtn = event.target.closest('[data-action="edit"]');
    if (editBtn) {
      beginRecording(editBtn.dataset.id);
      return;
    }

    const resetBtn = event.target.closest('[data-action="reset"]');
    if (resetBtn) {
      resetShortcut(resetBtn.dataset.id);
      repaint();
      return;
    }

    const resetAllBtn = event.target.closest('#shortcuts-reset-all');
    if (resetAllBtn && !resetAllBtn.disabled) {
      showConfirm(
        'Reset all keyboard shortcuts to their defaults?',
        {
          title: 'Reset all shortcuts',
          confirmText: 'Reset all',
          cancelText: 'Cancel',
          danger: true,
        }
      ).then((ok) => {
        if (ok) {
          resetAllShortcuts();
          repaint();
        }
      });
    }
  });
}
