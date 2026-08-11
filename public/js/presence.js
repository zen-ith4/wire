// ============================================================
// Online/offline presence
//
// Tracks which users are currently online, driven by the server's
// 'presence:snapshot' / 'presence:online' / 'presence:offline'
// socket events (wired in socket.js).
//
// Deliberately a plain Set + a *single* change-listener registration
// (see avatar.js), not one subscription per rendered avatar — this
// app re-renders whole views via innerHTML very frequently (see the
// rest of chat.js/dm.js/admin.js), so a per-element subscription
// would leak one listener every single render. Consumers instead
// just query the live DOM for `.presence-dot` elements when
// something changes.
// ============================================================

const onlineUsers = new Set();
const listeners = new Set(); // fn(userId|null, isOnline|null) — null pair means "full refresh"

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

export function setUserOffline(userId) {
  const id = Number(userId);
  if (!onlineUsers.has(id)) return;
  onlineUsers.delete(id);
  listeners.forEach((fn) => fn(id, false));
}

export function isUserOnline(userId) {
  return onlineUsers.has(Number(userId));
}

export function onPresenceChange(fn) {
  listeners.add(fn);
}
