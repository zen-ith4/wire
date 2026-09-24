// ============================================================
// Message actions: right-click (desktop) / tap (touch)
// ------------------------------------------------------------
// A message's action bar (React, Reply, Copy, Download, Delete) is
// never drawn by default and is NOT revealed by hovering. It opens
//   - desktop / Electron: on the message's `contextmenu` event (right
//     click). The native browser menu is suppressed on message bubbles
//     only; everywhere else it is left alone. The bar opens at the
//     pointer and is kept inside the visible message list.
//   - touch: by tapping the message. It sits beside the message itself,
//     on the side opposite the sender (own message -> left, incoming ->
//     right).
// Both add .is-actions-open (+ .is-actions-armed) to the row (CSS in
// features/messages.css shows the bar for rows carrying them); at most
// one row is open. A right-clicked row also gets .is-context-open,
// which is what lets a grouped DM row show its own timestamp.
//
// One delegated listener per message-list element (the element is
// rebuilt on every render, so nothing accumulates).
// dm.js has its own tap toggle because it is combined with
// double-tap-to-react; both share the ignore list below and
// placeActionBar()/bindContextMenu().
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

// ---------- Action bar placement ----------

const EDGE_GAP = 8; // px kept between the bar and the visible edges
const POINTER_GAP = 2; // px between the pointer and the bar's nearest corner
const MESSAGE_GAP = 7; // px between the message body and the touch action bar

function clamp(v, min, max) {
  return max < min ? min : Math.min(Math.max(v, min), max);
}

// The part of the message list that is actually on screen: the list's
// box intersected with the viewport, minus the floating header that
// overlays the top of the list.
function visibleBounds(container) {
  const vv = window.visualViewport;
  const vLeft = vv ? vv.offsetLeft : 0;
  const vTop = vv ? vv.offsetTop : 0;
  const vRight = vLeft + (vv ? vv.width : document.documentElement.clientWidth);
  const vBottom = vTop + (vv ? vv.height : window.innerHeight);

  const r = container.getBoundingClientRect();
  const b = {
    left: Math.max(vLeft, r.left),
    right: Math.min(vRight, r.right),
    top: Math.max(vTop, r.top),
    bottom: Math.min(vBottom, r.bottom),
  };

  const header = container.previousElementSibling;
  if (header?.classList?.contains('chat-header-glass')) {
    b.top = Math.max(b.top, header.getBoundingClientRect().bottom);
  }

  return b;
}

/**
 * Find the actual visual body of the message.
 *
 * The action bar must be positioned relative to the bubble/attachment,
 * not relative to the entire message column.
 */
function getMessageBody(row) {
  return row.querySelector(
    '.chat-bubble, .chat-attachment-image-wrap, .chat-attachment'
  );
}

/**
 * Positions a row's (already open) action bar and keeps it inside the
 * visible message list. The bar stays where CSS puts it; this only sets
 * a translate (--menu-dx / --menu-dy) so nothing in the flow moves.
 *
 *   anchor {x, y}  desktop: top-left corner at the pointer; flips to the
 *                  left of / above the pointer when it would not fit.
 *
 *   no anchor      touch: beside the actual message body, on the side
 *                  opposite the sender:
 *                    own message     -> left of the bubble
 *                    incoming message -> right of the bubble
 *
 * The touch menu is vertically centered against the actual message body.
 */
export function placeActionBar(row, container, anchor = null) {
  const bar = row.querySelector('.chat-msg-actions-bar');
  if (!bar || !container) return;

  // Reset the transform first so getBoundingClientRect() gives us the
  // bar's natural CSS position. We then calculate the required delta.
  bar.style.setProperty('--menu-dx', '0px');
  bar.style.setProperty('--menu-dy', '0px');

  const r = bar.getBoundingClientRect();
  if (!r.width || !r.height) return;

  const b = visibleBounds(container);
  let left;
  let top;

  if (anchor) {
    // Desktop/context-menu behavior:
    // corner just off the pointer, mirrored when there is no room.
    left = anchor.x + POINTER_GAP;
    top = anchor.y + POINTER_GAP;

    if (left + r.width > b.right - EDGE_GAP) {
      left = anchor.x - POINTER_GAP - r.width;
    }

    if (top + r.height > b.bottom - EDGE_GAP) {
      top = anchor.y - POINTER_GAP - r.height;
    }
  } else {
    // ----------------------------------------------------------
    // Touch/mobile positioning
    // ----------------------------------------------------------
    // IMPORTANT:
    // Do NOT use the message-column edges here.
    //
    // The action bar belongs directly beside the actual message
    // bubble. This prevents short/narrow messages from having
    // their action menu jump to the far edge of the chat column.
    // ----------------------------------------------------------

    const body = getMessageBody(row);

    if (!body) return;

    const bodyRect = body.getBoundingClientRect();

    if (row.classList.contains('own')) {
      // Outgoing message:
      // [ ACTIONS ][ gap ][ MESSAGE ]
      left = bodyRect.left - r.width - MESSAGE_GAP;
    } else {
      // Incoming message:
      // [ MESSAGE ][ gap ][ ACTIONS ]
      left = bodyRect.right + MESSAGE_GAP;
    }

    // Keep the action bar vertically centered against the message
    // body instead of using the action container's own position.
    top = bodyRect.top + (bodyRect.height - r.height) / 2;
  }

  // Safety bounds. Normally the bar remains directly beside the bubble.
  // These clamps only prevent it from being rendered outside the
  // visible chat area on very narrow screens or near viewport edges.
  left = clamp(
    left,
    b.left + EDGE_GAP,
    b.right - EDGE_GAP - r.width
  );

  top = clamp(
    top,
    b.top + EDGE_GAP,
    b.bottom - EDGE_GAP - r.height
  );

  bar.style.setProperty('--menu-dx', `${Math.round(left - r.left)}px`);
  bar.style.setProperty('--menu-dy', `${Math.round(top - r.top)}px`);
}

// ---------- Desktop: right-click menu ----------

let ctx = null; // { row, container, scrollTop } — the open menu (at most one)

function onDocPointerDown(e) {
  if (!e.target.closest?.('.chat-msg-actions-bar')) closeContextMenu();
}

// Runs in the capture phase, i.e. before the message list's own
// handler: any new context-menu request first closes the open menu, and
// a right-click on another message then opens its own.
function onDocContextMenu(e) {
  if (!e.target.closest?.('.chat-msg-actions-bar')) closeContextMenu();
}

function onDocKeyDown(e) {
  if (e.key === 'Escape') closeContextMenu();
}

// The bar is anchored to the pointer, so a real scroll of the list (or
// the page) would leave it stranded. A few px of scrollTop is not the
// user: opening the menu can pull a bar that overhung the end of the
// list back inside it, and the browser then clamps scrollTop by a pixel
// or so — that must not close the menu it just opened.
const SCROLL_SLOP_PX = 3;

function onDocScroll(e) {
  if (!ctx) return;

  if (e.target === ctx.container) {
    if (Math.abs(ctx.container.scrollTop - ctx.scrollTop) > SCROLL_SLOP_PX) {
      closeContextMenu();
    }
  } else if (e.target === document || e.target.contains?.(ctx.row)) {
    closeContextMenu();
  }
}

export function closeContextMenu() {
  if (!ctx) return;

  const { row } = ctx;
  ctx = null;

  row.classList.remove(
    'is-actions-open',
    'is-actions-armed',
    'is-context-open'
  );

  // :focus-within keeps a bar visible for keyboard users; a button that
  // was just clicked must not pin the closed menu open.
  const active = document.activeElement;

  if (
    active &&
    active.closest?.('.chat-msg-actions-bar') &&
    row.contains(active)
  ) {
    active.blur();
  }

  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('contextmenu', onDocContextMenu, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
  document.removeEventListener('scroll', onDocScroll, true);
  window.removeEventListener('resize', closeContextMenu);
  window.removeEventListener('blur', closeContextMenu);
}

function openContextMenu(row, container, x, y) {
  closeContextMenu();

  row.classList.add(
    'is-actions-open',
    'is-actions-armed',
    'is-context-open'
  );

  placeActionBar(row, container, { x, y });

  ctx = {
    row,
    container,
    scrollTop: container.scrollTop,
  };

  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('contextmenu', onDocContextMenu, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  document.addEventListener('scroll', onDocScroll, true);
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);
}

/**
 * Right-click on a message opens its action bar at the pointer and
 * suppresses the native context menu for that message only.
 * Not handled here (native behavior is kept): right-clicks outside the
 * messages, on the avatar / row padding, on a row with no action bar
 * (e.g. a failed-to-decrypt placeholder) and touch long-presses.
 */
export function bindContextMenu(container) {
  container.addEventListener('contextmenu', (e) => {
    if (isTouchClick(e)) return;

    const row = e.target.closest('.chat-msg');
    if (!row || !container.contains(row)) return;
    if (!e.target.closest('.chat-msg-content')) return;
    if (!row.querySelector('.chat-msg-actions-bar')) return;

    e.preventDefault();

    if (e.target.closest('.chat-msg-actions-bar')) return;

    openContextMenu(row, container, e.clientX, e.clientY);
  });

  // Choosing an action closes the menu. The button's own handler has
  // already run (it sits below this listener in the bubbling order).
  container.addEventListener('click', (e) => {
    if (ctx && e.target.closest('.chat-msg-actions-bar')) {
      closeContextMenu();
    }
  });
}

// ---------- Touch: tap to reveal ----------

// .is-actions-open shows the row's action bar; .is-actions-armed makes
// it tappable (dm.js delays that by the double-tap window, here there is
// no double-tap so both are set together).
function setOpen(row, on, container) {
  row.classList.toggle('is-actions-open', on);
  row.classList.toggle('is-actions-armed', on);

  if (on) {
    placeActionBar(row, container);
  }
}

export function bindTapReveal(container) {
  bindContextMenu(container);

  let openRow = null;

  container.addEventListener('click', (e) => {
    if (!isTouchClick(e)) return;
    if (e.target.closest(TAP_IGNORE_SELECTOR)) return;

    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) return;

    const row = e.target.closest('.chat-msg');

    if (openRow && openRow !== row) {
      setOpen(openRow, false, container);
    }

    if (!row || !container.contains(row)) {
      openRow = null;
      return;
    }

    setOpen(row, !row.classList.contains('is-actions-open'), container);

    openRow = row.classList.contains('is-actions-open') ? row : null;
  });
}