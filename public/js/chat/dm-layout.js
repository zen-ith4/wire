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
// (A seam repair can change how far a group reaches, so it re-derives
// the rows after the seam until they stop changing; see propagate().)
//
// Grouping is decided from the messages' own timestamps (the backend
// `timestamp`), never from render timing:
//   - a different sender always starts a new group, so a message from
//     the other person breaks the current user's run;
//   - the current user's (outgoing) run is a WINDOW: it lasts
//     OWN_GROUP_WINDOW_MS from the FIRST message of the run, then the
//     next outgoing message starts a new group;
//   - the other person's (incoming) run only breaks on inactivity: more
//     than PEER_GROUP_GAP_MS since their previous message;
//   - a new calendar day (date separator) or the unread marker also
//     starts a new group, because a divider sits between the rows.
// The first timestamp of each group is kept on its rows as
// data-group-start (epoch ms) so the outgoing window can be measured
// from the group's first message without walking back through the list.
//
// Calendar days use the browser's local timezone, the same as
// formatDate() in core/utils.js.
// ============================================================

const JOIN_PREV = 'chat-msg--joined-prev';
const JOIN_NEXT = 'chat-msg--joined-next';
const DIVIDER = 'dm-divider';
const MSG_ROW = 'chat-msg';

// Outgoing: how long after the first message of a run the current
// user's next message may still be visually attached to it.
export const OWN_GROUP_WINDOW_MS = 30 * 60 * 1000;
// Incoming: the longest silence between two messages from the other
// person that still keeps them in one group.
export const PEER_GROUP_GAP_MS = 30 * 60 * 1000;

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

// Epoch ms of a message's backend timestamp (NaN when missing/invalid).
export function messageTime(msg) {
  return msg && msg.timestamp ? new Date(msg.timestamp).getTime() : NaN;
}

// The one place that decides whether `msg` continues `prev`'s group.
// `prevStart` is the epoch ms of the first message of prev's group.
// `myId` is the current user's id, which is what makes a message
// "outgoing" (different rule from the other person's, see the header).
export function joinsPrevious(prev, prevStart, msg, { boundaryId = null, myId = null } = {}) {
  if (!prev) return false;
  if (boundaryId != null && msg.id === boundaryId) return false;
  if (!sameSender(prev, msg)) return false;
  if (dayKey(prev.timestamp) !== dayKey(msg.timestamp)) return false;

  const at = messageTime(msg);
  const prevAt = messageTime(prev);
  if (Number.isNaN(at) || Number.isNaN(prevAt)) return false;

  if (myId != null && Number(msg.sender_id) === Number(myId)) {
    // Outgoing: measured from the first message of the run. If the
    // start is unknown (the row above was not laid out by this module)
    // the previous message is the best available anchor.
    const start = Number.isFinite(prevStart) ? prevStart : prevAt;
    return at - start <= OWN_GROUP_WINDOW_MS;
  }
  return at - prevAt <= PEER_GROUP_GAP_MS;
}

function setJoinPrev(el, on) {
  el.classList.toggle(JOIN_PREV, on);
}

function setJoinNext(el, on) {
  el.classList.toggle(JOIN_NEXT, on);
}

// Epoch ms of the first message of the group `el` belongs to.
function readGroupStart(el) {
  const n = Number(el?.dataset?.groupStart);
  return el?.dataset?.groupStart ? n : NaN;
}

function writeGroupStart(el, ms) {
  el.dataset.groupStart = Number.isFinite(ms) ? String(ms) : '';
}

// Group start for a row that does (join) or does not continue `prev`.
function groupStartFor(join, prev, prevStart, msg) {
  if (!join) return messageTime(msg);
  return Number.isFinite(prevStart) ? prevStart : messageTime(prev);
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
 * `myId` is the current user's id (outgoing vs incoming grouping).
 * Returns { add(msg, el), unreadInserted }.
 */
export function createLayoutBuilder(
  parent,
  { prevMsg = null, prevEl = null, boundaryId = null, myId = null } = {}
) {
  let pMsg = prevMsg;
  let pEl = prevEl;
  let pDay = prevMsg ? dayKey(prevMsg.timestamp) : null;
  let pStart = prevEl ? readGroupStart(prevEl) : NaN;

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
        !newDay &&
        !isBoundary &&
        pMsg !== null &&
        joinsPrevious(pMsg, pStart, msg, { boundaryId, myId });
      setJoinPrev(el, join);
      if (join && pEl) setJoinNext(pEl, true);

      pStart = groupStartFor(join, pMsg, pStart, msg);
      writeGroupStart(el, pStart);

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

// The next message row after `el` (dividers and other nodes skipped).
function nextRow(el) {
  let n = el.nextElementSibling;
  while (n && !n.classList.contains(MSG_ROW)) n = n.nextElementSibling;
  return n;
}

/**
 * A changed seam can change where the group that follows it starts
 * (a new first message, a deleted one, an older page joining the top),
 * and the outgoing window is measured from that start — so rows below
 * the seam may need to join or split. Re-derives them one by one and
 * stops at the first row whose state did not change. `msgOf(row)`
 * returns a row's message data (null for rows without any, which end
 * the walk).
 */
function propagate(fromEl, fromMsg, fromStart, { boundaryId, myId, msgOf }) {
  let pEl = fromEl;
  let pMsg = fromMsg;
  let pStart = fromStart;
  for (;;) {
    const el = nextRow(pEl);
    if (!el) return;
    const msg = msgOf(el);
    if (!msg) return;

    const join = joinsPrevious(pMsg, pStart, msg, { boundaryId, myId });
    const start = groupStartFor(join, pMsg, pStart, msg);
    const unchanged =
      el.classList.contains(JOIN_PREV) === join &&
      Object.is(readGroupStart(el), start);

    setJoinPrev(el, join);
    setJoinNext(pEl, join);
    writeGroupStart(el, start);
    if (unchanged) return;

    pEl = el;
    pMsg = msg;
    pStart = start;
  }
}

/**
 * Re-derives everything that depends on the pair (prev, next) after
 * the list changed between them. prev/next are message data and their
 * rows; any may be null (list edge). Cheap: touches only the dividers
 * directly above `nextEl`, the two rows' join classes and — through
 * propagate(), when `msgOf` is given — the rows below for as long as
 * their grouping actually changes.
 * Returns true if an unread marker was (re)inserted.
 */
export function repairSeam({
  prevMsg,
  prevEl,
  nextMsg,
  nextEl,
  boundaryId,
  myId = null,
  msgOf = null,
}) {
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

  const prevStart = hasPrev ? readGroupStart(prevEl) : NaN;
  const join =
    hasPrev && joinsPrevious(prevMsg, prevStart, nextMsg, { boundaryId, myId });
  setJoinPrev(nextEl, join);
  if (prevEl) setJoinNext(prevEl, join);

  const start = groupStartFor(join, prevMsg, prevStart, nextMsg);
  writeGroupStart(nextEl, start);
  if (msgOf) propagate(nextEl, nextMsg, start, { boundaryId, myId, msgOf });
  return isBoundary;
}
