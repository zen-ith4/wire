// ============================================================
// Tap-to-reveal message actions (touch)
// ------------------------------------------------------------
// On devices without hover, a message's action buttons (React, Reply,
// Copy, Download, Delete) are never drawn by default. Tapping a message
// adds .is-actions-open to that row (CSS in features/messages.css shows
// the buttons for rows carrying it); tapping another message, or the
// same one again, moves/removes it — at most one row is open.
// Desktop is untouched: it keeps the existing :hover reveal.
//
// One delegated `click` listener per message-list element (the element
// is rebuilt on every render, so nothing accumulates).
// dm.js has its own variant of the toggle because it is combined with
// double-tap-to-react; both share the ignore list below.
// ============================================================

// Taps on these belong to the control itself and never toggle a row.
export const TAP_IGNORE_SELECTOR =
  'a,button,input,textarea,select,label,video,audio,[role="button"],' +
  '.reply-quote,.reactions-row,.chat-attachment,.chat-attachment-image-wrap,' +
  '[data-no-swipe-reply]';

const noHover = window.matchMedia?.('(hover: none)');

export function isTouchClick(e) {
  return e.pointerType === 'touch' || (!e.pointerType && !!noHover?.matches);
}

// .is-actions-open shows the row's action bar; .is-actions-armed makes
// it tappable (dm.js delays that by the double-tap window, here there is
// no double-tap so both are set together).
function setOpen(row, on) {
  row.classList.toggle('is-actions-open', on);
  row.classList.toggle('is-actions-armed', on);
}

export function bindTapReveal(container) {
  let openRow = null;

  container.addEventListener('click', (e) => {
    if (!isTouchClick(e)) return;
    if (e.target.closest(TAP_IGNORE_SELECTOR)) return;
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) return;

    const row = e.target.closest('.chat-msg');
    if (openRow && openRow !== row) setOpen(openRow, false);
    if (!row || !container.contains(row)) {
      openRow = null;
      return;
    }
    setOpen(row, !row.classList.contains('is-actions-open'));
    openRow = row.classList.contains('is-actions-open') ? row : null;
  });
}
