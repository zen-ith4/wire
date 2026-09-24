// ============================================================
// DM message-list layout: date separators, unread marker and
// sender grouping.
// ------------------------------------------------------------
// Pure presentation. Message data, the cache in dm.js and the message
// elements themselves are untouched; this module only decides which
// small divider elements sit between messages and which "joined"
// modifier classes a message row carries:
//
//   chat-msg--joined-prev   same group as the message above
//   chat-msg--joined-next   same group as the message below
//
// standalone = neither, first = next only, middle = both, last = prev
// only. CSS (features/messages.css) turns those into spacing, corners
// and the hidden avatar/name of non-first rows.
//
// Invariant: a divider always sits IMMEDIATELY BEFORE the message it
// introduces. Every incremental update (append, prepend, delete) only
// has to repair the one seam it touches — nothing rescans the list.
//
// Calendar days use the browser's local timezone, the same as
// formatDate() in core/utils.js.
// ============================================================

const JOIN_PREV = 'chat-msg--joined-prev';
const JOIN_NEXT = 'chat-msg--joined-next';
const DIVIDER = 'dm-divider';

const DAY_LABEL = { year: 'numeric', month: 'long', day: 'numeric' };
const TIME_LABEL = { hour: '2-digit', minute: '2-digit' };
const FULL_LABEL = { dateStyle: 'medium', timeStyle: 'short' };

// ---------- Formatting ----------

export function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatDayLabel(iso) {
  return new Date(iso).toLocaleDateString(undefined, DAY_LABEL);
}

export function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, TIME_LABEL);
}

export function formatFullDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, FULL_LABEL);
}

// ---------- Divider elements ----------

// role="separator" + aria-label announces the date once; the visible
// text is aria-hidden so it isn't read a second time.
function buildDateSeparatorEl(iso) {
  const label = formatDayLabel(iso);
  const el = document.createElement('div');
  el.className = `${DIVIDER} ${DIVIDER}--date`;
  el.setAttribute('role', 'separator');
  el.setAttribute('aria-label', label);
  const span = document.createElement('span');
  span.className = 'dm-divider-label';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = label;
  el.appendChild(span);
  return el;
}

function buildUnreadMarkerEl() {
  const el = document.createElement('div');
  el.className = `${DIVIDER} ${DIVIDER}--unread`;
  el.setAttribute('role', 'separator');
  el.setAttribute('aria-label', 'New messages');
  const span = document.createElement('span');
  span.className = 'dm-divider-label';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = 'New messages';
  el.appendChild(span);
  return el;
}

// ---------- Grouping rules ----------

function sameSender(a, b) {
  return Number(a.sender_id) === Number(b.sender_id);
}

// The one place that decides whether `msg` continues `prev`'s group.
// Date changes and the unread boundary always start a new group.
function joinsPrevious(prev, msg, boundaryId) {
  if (!prev) return false;
  if (boundaryId != null && msg.id === boundaryId) return false;
  if (dayKey(prev.timestamp) !== dayKey(msg.timestamp)) return false;
  return sameSender(prev, msg);
}

function setJoinPrev(el, on) {
  el.classList.toggle(JOIN_PREV, on);
}

function setJoinNext(el, on) {
  el.classList.toggle(JOIN_NEXT, on);
}

// ---------- Unread boundary ----------

/**
 * Id of the first message from the peer the server had not yet
 * marked read when it was fetched (read_at is null in that response —
 * the server marks the conversation read only AFTER building it), or
 * null. Own messages are never "unread".
 */
export function findFirstUnreadId(messages, myId) {
  for (const m of messages) {
    if (Number(m.sender_id) !== Number(myId) && m.read_at == null) {
      return m.id;
    }
  }
  return null;
}

// ---------- Batch builder (initial render, sync, older pages, live) ----------

/**
 * Appends messages to `parent` (a DocumentFragment or the list), with
 * separators and join classes. `prevMsg`/`prevEl` describe what is
 * already above the first appended message (null for a fresh list).
 * Returns { add(msg, el), unreadInserted }.
 */
export function createLayoutBuilder(
  parent,
  { prevMsg = null, prevEl = null, boundaryId = null } = {}
) {
  let pMsg = prevMsg;
  let pEl = prevEl;
  let pDay = prevMsg ? dayKey(prevMsg.timestamp) : null;

  const builder = {
    unreadInserted: false,
    add(msg, el) {
      const day = dayKey(msg.timestamp);
      const newDay = pMsg === null || day !== pDay;
      const isBoundary = boundaryId != null && msg.id === boundaryId;

      if (newDay) parent.appendChild(buildDateSeparatorEl(msg.timestamp));
      if (isBoundary) {
        parent.appendChild(buildUnreadMarkerEl());
        builder.unreadInserted = true;
      }

      const join =
        !newDay && !isBoundary && pMsg !== null && sameSender(pMsg, msg);
      setJoinPrev(el, join);
      if (join && pEl) setJoinNext(pEl, true);

      parent.appendChild(el);
      pMsg = msg;
      pEl = el;
      pDay = day;
    },
  };
  return builder;
}

// ---------- Seam repair (prepend / delete) ----------

function isDivider(node) {
  return !!node && node.classList?.contains(DIVIDER);
}

/**
 * Re-derives everything that depends on the pair (prev, next) after
 * the list changed between them. prev/next are message data and their
 * rows; any may be null (list edge). Cheap: touches only the dividers
 * directly above `nextEl` and the two rows' join classes.
 * Returns true if an unread marker was (re)inserted.
 */
export function repairSeam({ prevMsg, prevEl, nextMsg, nextEl, boundaryId }) {
  if (!nextEl) {
    if (prevEl) {
      setJoinNext(prevEl, false);
      // Dividers that introduced the removed last row are now trailing.
      while (isDivider(prevEl.nextElementSibling)) {
        prevEl.nextElementSibling.remove();
      }
    }
    return false;
  }

  let s = nextEl.previousElementSibling;
  while (isDivider(s)) {
    const before = s.previousElementSibling;
    s.remove();
    s = before;
  }

  const hasPrev = !!(prevMsg && prevEl);
  const newDay =
    !hasPrev || dayKey(prevMsg.timestamp) !== dayKey(nextMsg.timestamp);
  const isBoundary = boundaryId != null && nextMsg.id === boundaryId;

  if (newDay) nextEl.before(buildDateSeparatorEl(nextMsg.timestamp));
  if (isBoundary) nextEl.before(buildUnreadMarkerEl());

  const join = hasPrev && joinsPrevious(prevMsg, nextMsg, boundaryId);
  setJoinPrev(nextEl, join);
  if (prevEl) setJoinNext(prevEl, join);
  return isBoundary;
}
