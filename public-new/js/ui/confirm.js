// ============================================================
// Styled confirm dialog — replaces window.confirm(), which
// renders as an unstyled native browser popup with no CSS control.
// Uses the same .modal / .modal-content glass styling every other
// modal in this app already uses (see #share-modal, #preview-modal
// in index.html), so it looks consistent instead of jarring.
//
// Usage: const ok = await showConfirm('Delete this message?');
// ============================================================

let resolvePending = null;

export function showConfirm(message, opts = {}) {
  const {
    title = 'Are you sure?',
    confirmText = 'Delete',
    cancelText = 'Cancel',
    danger = true,
  } = opts;

  const modal = document.getElementById('confirm-modal');

  // Defensive fallback in the unlikely case the static markup is
  // missing from index.html — keeps the app functional either way.
  if (!modal) {
    return Promise.resolve(window.confirm(message));
  }

  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-message').textContent = message;

  const okBtn = document.getElementById('confirm-modal-ok');
  okBtn.textContent = confirmText;
  okBtn.className = 'btn btn-sm ' + (danger ? 'btn-danger' : 'btn-primary');
  document.getElementById('confirm-modal-cancel').textContent = cancelText;

  // If a previous confirm() somehow never settled, don't leak it —
  // treat it as cancelled before opening the new one.
  if (resolvePending) {
    resolvePending(false);
    resolvePending = null;
  }

  modal.classList.add('active');

  return new Promise((resolve) => {
    resolvePending = resolve;
  });
}

function settle(result) {
  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.remove('active');
  if (resolvePending) {
    resolvePending(result);
    resolvePending = null;
  }
}

// Referenced from the static onclick="" handlers in index.html,
// same pattern as window.closeShareModal / window.closePreview.
window.__confirmModalOk = () => settle(true);
window.__confirmModalCancel = () => settle(false);
