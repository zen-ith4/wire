// ============================================================
// Native <dialog> helper for the Files tab (share dialogs, link
// dialog, media viewer).
//
// Uses showModal() so the browser provides the parts a fake modal has
// to imitate: the rest of the page becomes inert (no tabbing or
// clicking behind it), Escape closes it, focus is contained, and it is
// in the top layer (no z-index wars). Styling lives in
// css/features/sharing.css and files-viewer.css.
//
// Variants:
//   'modal'  centred card on desktop, bottom sheet on phones
//   'viewer' full-screen (media viewer)
// ============================================================

const openDialogs = new Set();

/**
 * @param {object} opts
 * @param {'modal'|'viewer'} [opts.variant]
 * @param {string} [opts.label]      aria-label (when there is no visible title)
 * @param {string} [opts.className]
 * @param {() => void} [opts.onClose] runs once, after the dialog is closed
 * @returns {{ dialog: HTMLDialogElement, panel: HTMLElement, close: () => void }}
 */
export function openDialog({
  variant = 'modal',
  label = '',
  className = '',
  onClose = null,
} = {}) {
  const opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  const dialog = document.createElement('dialog');
  dialog.className = `files-dialog files-dialog--${variant} ${className}`.trim();

  if (label) dialog.setAttribute('aria-label', label);

  const panel = document.createElement('div');
  panel.className = 'files-dialog-panel';
  dialog.appendChild(panel);

  // Close on a click on the backdrop only. Requiring the press to
  // START on the backdrop too means dragging a text selection out of
  // the panel doesn't dismiss the dialog.
  let pressStartedOnBackdrop = false;

  dialog.addEventListener('pointerdown', (event) => {
    pressStartedOnBackdrop = event.target === dialog;
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && pressStartedOnBackdrop) {
      close();
    }

    pressStartedOnBackdrop = false;
  });

  let finished = false;

  dialog.addEventListener('close', () => {
    if (finished) return;
    finished = true;

    openDialogs.delete(entry);

    try {
      onClose?.();
    } catch (error) {
      console.error('[Files] dialog onClose failed:', error);
    }

    dialog.remove();

    // Most browsers restore focus themselves; this covers the rest
    // (older WebViews) and the case where the opener re-rendered.
    if (opener && opener.isConnected) {
      try {
        opener.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  });

  function close() {
    if (dialog.open) {
      dialog.close();
    } else if (!finished) {
      dialog.dispatchEvent(new Event('close'));
    }
  }

  const entry = { dialog, close };
  openDialogs.add(entry);

  document.body.appendChild(dialog);
  dialog.showModal();

  return { dialog, panel, close };
}

/** Closes every open Files dialog (used on logout). */
export function closeAllDialogs() {
  for (const entry of Array.from(openDialogs)) {
    entry.close();
  }
}

// Nothing from a signed-out session may stay on screen.
window.addEventListener('wire:logout', closeAllDialogs);
