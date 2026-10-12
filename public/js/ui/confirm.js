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

let bound = false;

// Delegated click handling for the static #confirm-modal markup. No inline onclick="" so it
// also works under an ENFORCED CSP (script-src 'self' blocks inline handlers).
function bindOnce(modal) {
  if (bound) return;
  bound = true;
  modal.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    const action = btn && modal.contains(btn) ? btn.dataset.action : null;
    if (action === 'confirm-ok') settle(true);
    else if (action === 'confirm-cancel') settle(false);
    else if (e.target === modal) settle(false); // backdrop click
  });
}

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

  bindOnce(modal);

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

// Legacy hooks from when index.html used inline onclick="" handlers. Nothing in the
// markup calls them any more (dead code, kept so other lanes' code cannot break).
window.__confirmModalOk = () => settle(true);
window.__confirmModalCancel = () => settle(false);
