// ============================================================
// Presence tracking
//
// Purely in-memory and ephemeral by design — online/offline status
// isn't persisted data, it's "is there a live socket for this user
// right now", so there's nothing here that belongs in the database.
//
// A user can have multiple sockets open (several tabs, phone +
// desktop). We ref-count connections per user so "online" only
// flips to "offline" once their *last* socket disconnects, and
// "offline" only flips to "online" on their *first* connection —
// that's what the boolean return values below signal.
// ============================================================

const onlineCounts = new Map(); // user_id -> number of open sockets

/**
 * @returns {boolean} true if this was the user's first connection
 *   (they just transitioned from offline to online).
 */
function markOnline(userId) {
  const count = (onlineCounts.get(userId) || 0) + 1;
  onlineCounts.set(userId, count);
  return count === 1;
}

/**
 * @returns {boolean} true if this was the user's last connection
 *   (they just transitioned from online to offline).
 */
function markOffline(userId) {
  // A user with no open socket was never online: nothing transitions.
  if (!onlineCounts.has(userId)) return false;

  const count = onlineCounts.get(userId) - 1;
  if (count <= 0) {
    onlineCounts.delete(userId);
    return true;
  }
  onlineCounts.set(userId, count);
  return false;
}

function isOnline(userId) {
  return onlineCounts.has(userId);
}

function getOnlineUserIds() {
  return Array.from(onlineCounts.keys());
}

module.exports = {
  markOnline,
  markOffline,
  isOnline,
  getOnlineUserIds,
};
