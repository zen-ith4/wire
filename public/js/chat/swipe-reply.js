// ============================================================
// Swipe to reply (touch)
// ------------------------------------------------------------
// Shared between group Chat and DMs.
//
// Behaviour
//   - Touch pointers only (pointerType === 'touch'). Mouse/pen never start
//     it, so desktop is untouched.
//   - ALL messages reply by swiping LEFT (right -> left), regardless of
//     whether the message was sent or received.
//   - Vertical scrolling is never intercepted: nothing is captured or moved
//     until the finger has travelled >= LOCK_PX and that travel is clearly
//     horizontal. Anything more vertical/diagonal is left to the browser
//     (and `touch-action: pan-y` on .chat-msg, see messages.css, keeps the
//     browser from panning horizontally so pointer events keep arriving).
//   - The row follows the finger 1:1 up to COMMIT_PX, then with resistance,
//     and can never travel further than MAX_TRANSLATE_PX.
//   - Releasing at/after COMMIT_PX calls onReply(id) exactly once; releasing
//     earlier (or a pointercancel) just springs the row back.
//
// Wiring: one bindSwipeToReply(container, ...) per messages container,
// called right where the container is created. All listeners live ON that
// container (event delegation for every message inside it) — nothing is
// attached to document/window, so when a view re-renders and the old
// container is discarded its listeners go with it, and re-binding the same
// element is a no-op.
// ============================================================

import { ICONS } from '../icons.js';

// Finger travel before we decide "this is a horizontal swipe" (and the
// row starts moving). The row's own movement starts from 0 at this point,
// so it never jumps.
const LOCK_PX = 10;

// Travel must be at least this many times larger horizontally than
// vertically (~34° from horizontal) to count as a swipe.
const HORIZONTAL_RATIO = 1.5;

// Row travel (after LOCK_PX) needed for a release to trigger Reply.
const COMMIT_PX = 64;

// Beyond COMMIT_PX the row only follows at this fraction of the finger…
const OVERSHOOT_RESISTANCE = 0.3;

// …and never past this many px in total.
const MAX_TRANSLATE_PX = 84;

// Spring-back duration. Same fixed 180ms / ease as the existing DM
// swipe-back gesture (dm.js), skipped under prefers-reduced-motion.
const RETURN_MS = 180;

// The click the browser synthesizes after a swipe is swallowed for this long.
const CLICK_SUPPRESS_MS = 400;

// Anything a touch can legitimately "do" on its own inside a message.
// A swipe that starts on one of these is left alone entirely (taps still
// work, sliders/waveforms/video controls still scrub, links still open).
const INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'label',
  'video',
  'audio',
  'canvas',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="slider"]',
  // Scrub surfaces of the media players (see media/*.js). The play/
  // volume/download controls inside them are buttons/inputs already.
  '.video-player',
  '.voice-message-wave',
  '.audio-player-waveform',
  '.voice-message-volume-slider-wrap',
  '.audio-player-volume-slider-wrap',
  // Escape hatch for future message widgets.
  '[data-no-swipe-reply]',
].join(',');

const bindings = new WeakMap(); // container -> unbind()

function prefersReducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// True when the user has a live text selection touching this message
// (long-press select, then dragging): that drag belongs to the selection.
function selectionTouches(el) {
  const sel = window.getSelection?.();
  return (
    !!sel &&
    !sel.isCollapsed &&
    sel.rangeCount > 0 &&
    sel.containsNode(el, true)
  );
}

/**
 * @param {HTMLElement|null} container  the scrolling messages element
 *   (#chat-messages / #dm-messages). Its .chat-msg[data-msg-id] children
 *   are the swipeable rows.
 * @param {object} options
 * @param {(id:number) => void} options.onReply  called once per completed
 *   swipe with the numeric message id; should reuse the existing Reply action.
 * @param {(e:PointerEvent, dir:number) => boolean} [options.shouldIgnoreStart]
 *   return true to not start a swipe for this touch.
 *   dir is always -1 because Reply is always triggered by a
 *   right-to-left swipe. Used by DMs to leave the left-edge swipe-back alone.
 * @returns {() => void} unbind function (safe to call more than once)
 */
export function bindSwipeToReply(
  container,
  { onReply, shouldIgnoreStart } = {}
) {
  if (!container || typeof onReply !== 'function') return () => {};

  const existing = bindings.get(container);
  if (existing) return existing; // already bound: never double-register

  // At most one gesture at a time.
  //   { pointerId, startX, startY, msgEl, id, dir,
  //     active, armed, indicator }
  let gesture = null;

  // Spring-back still in flight: { finish, timer }
  let pendingSettle = null;

  let suppressClickUntil = 0;

  // Reply is ALWAYS right -> left.
  // Negative dx means the finger moved toward the left.
  const REPLY_DIRECTION = -1;

  function flushSettle() {
    if (pendingSettle) pendingSettle.finish();
  }

  function releaseCapture(pointerId) {
    try {
      if (container.hasPointerCapture?.(pointerId)) {
        container.releasePointerCapture(pointerId);
      }
    } catch {
      /* pointer already gone */
    }
  }

  function buildIndicator(g) {
    const el = document.createElement('div');

    el.className =
      'swipe-reply-indicator ' +
      (g.dir < 0
        ? 'swipe-reply-indicator--right'
        : 'swipe-reply-indicator--left');

    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = ICONS.reply;

    // Vertically centre it on the part of the message that is actually
    // on screen, so tall messages / attachments don't park it off-screen.
    const r = g.msgEl.getBoundingClientRect();
    const c = container.getBoundingClientRect();

    const top = Math.max(r.top, c.top);
    const bottom = Math.min(r.bottom, c.bottom);

    const mid =
      bottom > top
        ? (top + bottom) / 2
        : (r.top + r.bottom) / 2;

    el.style.top = `${mid - r.top}px`;

    g.msgEl.appendChild(el);
    return el;
  }

  function activate(g) {
    g.active = true;

    flushSettle();

    try {
      // Route the rest of this touch (incl. pointerup) here even if the
      // finger leaves the row, or the row is re-rendered under it.
      container.setPointerCapture(g.pointerId);
    } catch {
      /* ignore */
    }

    container.classList.add('is-swiping-reply');
    g.msgEl.classList.add('swipe-reply-active');

    g.msgEl.style.transition = 'none';

    g.indicator = buildIndicator(g);
  }

  function update(g, dx) {
    // dir is always -1.
    //
    // Example:
    //   right -> left: dx = -80
    //   dx * -1 = 80  -> valid reply movement
    //
    //   left -> right: dx = +80
    //   dx * -1 = -80 -> rejected by onPointerMove
    const d = Math.max(0, dx * g.dir - LOCK_PX);

    const x =
      d <= COMMIT_PX
        ? d
        : Math.min(
            MAX_TRANSLATE_PX,
            COMMIT_PX +
              (d - COMMIT_PX) * OVERSHOOT_RESISTANCE
          );

    const progress = Math.min(1, d / COMMIT_PX);

    g.msgEl.style.transform =
      `translate3d(${g.dir * x}px, 0, 0)`;

    g.indicator.style.opacity = String(progress);
    g.indicator.style.transform =
      `scale(${0.6 + 0.4 * progress})`;

    const armed = d >= COMMIT_PX;

    if (armed !== g.armed) {
      g.armed = armed;
      g.indicator.classList.toggle('is-armed', armed);
    }
  }

  // Animate the row (and indicator) back to rest, then remove every
  // trace of the gesture from the DOM.
  function settle(g) {
    const { msgEl, indicator } = g;

    const ms = prefersReducedMotion() ? 0 : RETURN_MS;
    let timer = null;

    const entry = {
      finish() {
        clearTimeout(timer);

        msgEl.style.transition = '';
        msgEl.style.transform = '';

        msgEl.classList.remove('swipe-reply-active');

        indicator.remove();

        container.classList.remove('is-swiping-reply');

        if (pendingSettle === entry) {
          pendingSettle = null;
        }
      },
    };

    if (ms === 0) {
      entry.finish();
      return;
    }

    msgEl.style.transition =
      `transform ${ms}ms ease`;

    msgEl.style.transform = '';

    indicator.style.transition =
      `opacity ${ms}ms ease, transform ${ms}ms ease`;

    indicator.style.opacity = '0';
    indicator.style.transform = 'scale(0.6)';

    timer = setTimeout(entry.finish, ms + 30);
    entry.timer = timer;

    pendingSettle = entry;
  }

  function cancelGesture() {
    const g = gesture;
    gesture = null;

    if (!g) return;

    releaseCapture(g.pointerId);

    if (g.active) {
      settle(g);
    }
  }

  // ---------------------------------------------------------- handlers --

  function onPointerDown(e) {
    if (e.pointerType !== 'touch') return;

    // A second finger (pinch etc.) or a stale gesture: drop the current
    // one; a non-primary pointer never starts a new swipe.
    if (gesture) cancelGesture();

    if (!e.isPrimary) return;

    const target = e.target;

    const msgEl = target?.closest?.('.chat-msg');

    if (!msgEl || !container.contains(msgEl)) return;

    if (target.closest(INTERACTIVE_SELECTOR)) return;

    const id = Number(msgEl.dataset.msgId);

    if (!Number.isFinite(id)) return;

    // IMPORTANT:
    // Reply is always right -> left.
    //
    // We intentionally do NOT inspect:
    //   - .own
    //   - message alignment
    //   - CSS direction / RTL
    //
    // The gesture direction is identical for sent and received messages.
    const dir = REPLY_DIRECTION;

    // DMs can use this hook to keep the left-edge navigation swipe-back
    // from being confused with swipe-to-reply.
    if (shouldIgnoreStart?.(e, dir)) return;

    if (selectionTouches(msgEl)) return;

    flushSettle();

    gesture = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      msgEl,
      id,
      dir,
      active: false,
      armed: false,
      indicator: null,
    };
  }

  function onPointerMove(e) {
    const g = gesture;

    if (!g || e.pointerId !== g.pointerId) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (!g.active) {
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);

      // Not enough movement to know yet (tiny wobble stays a tap).
      if (adx < LOCK_PX && ady < LOCK_PX) return;

      // Vertical or diagonal -> normal scrolling.
      // Let go for good.
      if (adx < ady * HORIZONTAL_RATIO) {
        gesture = null;
        return;
      }

      // Reply is ONLY right -> left.
      //
      // dx < 0 means the finger moved left.
      // dx > 0 means the finger moved right and must NOT activate Reply.
      if (dx * g.dir <= 0) {
        gesture = null;
        return;
      }

      // A selection appeared since touchdown: its drag, not ours.
      if (selectionTouches(g.msgEl)) {
        gesture = null;
        return;
      }

      activate(g);
    }

    update(g, dx);
  }

  function onPointerUp(e) {
    const g = gesture;

    if (!g || e.pointerId !== g.pointerId) return;

    // Clear first: nothing below can trigger Reply twice.
    gesture = null;

    if (!g.active) return;

    suppressClickUntil =
      performance.now() + CLICK_SUPPRESS_MS;

    releaseCapture(g.pointerId);

    const trigger =
      g.armed &&
      g.msgEl.isConnected;

    settle(g);

    if (trigger) {
      onReply(g.id);
    }
  }

  function onPointerCancel(e) {
    const g = gesture;

    if (!g || e.pointerId !== g.pointerId) return;

    cancelGesture();
  }

  // Capture moving away from the container without a pointerup/cancel
  // (e.g. the container was torn down). Ignore the implicit-capture
  // hand-off from the touched child to the container at activation:
  // that lostpointercapture is dispatched on the child, not on the
  // container.
  function onLostPointerCapture(e) {
    if (e.target !== container) return;

    const g = gesture;

    if (!g || e.pointerId !== g.pointerId) return;

    cancelGesture();
  }

  // The click a browser fires after a drag must not open an image,
  // trigger a quote-jump, etc.
  function onClickCapture(e) {
    if (
      suppressClickUntil &&
      performance.now() < suppressClickUntil
    ) {
      suppressClickUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  container.addEventListener(
    'pointerdown',
    onPointerDown
  );

  container.addEventListener(
    'pointermove',
    onPointerMove
  );

  container.addEventListener(
    'pointerup',
    onPointerUp
  );

  container.addEventListener(
    'pointercancel',
    onPointerCancel
  );

  container.addEventListener(
    'lostpointercapture',
    onLostPointerCapture
  );

  container.addEventListener(
    'click',
    onClickCapture,
    true
  );

  function unbind() {
    if (bindings.get(container) !== unbind) return;

    bindings.delete(container);

    container.removeEventListener(
      'pointerdown',
      onPointerDown
    );

    container.removeEventListener(
      'pointermove',
      onPointerMove
    );

    container.removeEventListener(
      'pointerup',
      onPointerUp
    );

    container.removeEventListener(
      'pointercancel',
      onPointerCancel
    );

    container.removeEventListener(
      'lostpointercapture',
      onLostPointerCapture
    );

    container.removeEventListener(
      'click',
      onClickCapture,
      true
    );

    if (gesture) {
      const g = gesture;
      gesture = null;

      releaseCapture(g.pointerId);

      if (g.active) {
        settle(g);
      }
    }

    flushSettle();
  }

  bindings.set(container, unbind);

  return unbind;
}
