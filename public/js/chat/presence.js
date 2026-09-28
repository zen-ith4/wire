// ============================================================
// Online/offline presence
//
// Tracks which users are currently online, driven by the server's
// 'presence:snapshot' / 'presence:online' / 'presence:offline'
// socket events (wired in socket.js).
//
// Deliberately a plain Set + a *single* change-listener registration
// (see dm.js/profile-card.js), not one subscription per rendered avatar —
// this app re-renders whole views via innerHTML very frequently (see the
// rest of chat.js/dm.js/admin.js), so a per-element subscription
// would leak one listener every single render. Consumers instead
// just query the live DOM for online-status elements when
// something changes.
// ============================================================

const onlineUsers = new Set();
const listeners = new Set(); // fn(userId|null, isOnline|null) — null pair means "full refresh"

// ------------------------------------------------------------
// Last seen
//
// Separate from onlineUsers above: a user can be offline with a known
// last-seen time, offline with none yet (nothing has told us), or
// online (in which case any stale last-seen value just isn't shown —
// see getPresenceStatusText). Server visibility rules (the "Show Last
// Seen & Online Status" setting) are already enforced before any of
// this data reaches the client — see controllers/me.controller.js and
// config/socket.js — so nothing here needs to re-check that setting.
// ------------------------------------------------------------
const lastSeenAt = new Map(); // userId -> ISO string | null

window.addEventListener('wire:logout', () => {
  onlineUsers.clear();
  lastSeenAt.clear();
});

export function setOnlineSnapshot(userIds) {
  onlineUsers.clear();
  userIds.forEach((id) => onlineUsers.add(Number(id)));
  listeners.forEach((fn) => fn(null, null));
}

export function setUserOnline(userId) {
  const id = Number(userId);
  if (onlineUsers.has(id)) return;
  onlineUsers.add(id);
  listeners.forEach((fn) => fn(id, true));
}

export function setUserOffline(userId, lastSeenIso = undefined) {
  const id = Number(userId);
  if (lastSeenIso !== undefined) {
    lastSeenAt.set(id, lastSeenIso || null);
  }
  if (!onlineUsers.has(id)) {
    // Already offline — still notify if a fresh last-seen value came
    // in (e.g. the background profile fetch in dm.js/profile-card.js),
    // so an open thread/card repaints with it.
    if (lastSeenIso !== undefined) listeners.forEach((fn) => fn(id, false));
    return;
  }
  onlineUsers.delete(id);
  listeners.forEach((fn) => fn(id, false));
}

export function isUserOnline(userId) {
  return onlineUsers.has(Number(userId));
}

export function setLastSeenAt(userId, iso) {
  lastSeenAt.set(Number(userId), iso || null);
}

export function getLastSeenAt(userId) {
  return lastSeenAt.get(Number(userId)) || null;
}

// "Last seen 5m ago" / "Last seen just now" / "Last seen Sep 12" —
// null when there's nothing to show (unknown, or the other person is
// currently online).
export function formatLastSeen(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;

  const diffMinutes = Math.floor((Date.now() - then) / 60000);
  if (diffMinutes < 1) return 'Last seen just now';
  if (diffMinutes < 60) return `Last seen ${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `Last seen ${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `Last seen ${diffDays}d ago`;

  return `Last seen ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

// Single source of truth for what a presence indicator's text should
// read right now — "Online", "Last seen …", or "Offline" when nothing
// more specific is known yet.
export function getPresenceStatusText(userId) {
  if (isUserOnline(userId)) return 'Online';
  return formatLastSeen(getLastSeenAt(userId)) || 'Offline';
}

export function onPresenceChange(fn) {
  listeners.add(fn);
}

// Re-runs every subscriber for `userId` without an actual online/
// offline transition — used after a background fetch fills in a
// last-seen value the live socket events haven't sent yet (opening a
// DM thread or profile card for someone who was already offline
// before this session started).
export function refreshPresenceDisplay(userId) {
  const id = Number(userId);
  listeners.forEach((fn) => fn(id, isUserOnline(id)));
}
