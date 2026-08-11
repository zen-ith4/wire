const { getDb } = require('../config/database');

// نکته: ستون واقعی در جدول direct_messages، created_at است نه timestamp.
// برای اینکه فرانت‌اند (که msg.timestamp را می‌خواند) دست‌نخورده بماند،
// همیشه created_at را با AS timestamp می‌خوانیم.
const DM_SELECT = `
  SELECT dm.id, dm.sender_id, dm.recipient_id, su.username AS sender_username,
         dm.content, dm.created_at AS timestamp, dm.read_at,
         dm.attachment_name, dm.attachment_size, dm.attachment_mime
  FROM direct_messages dm
  JOIN users su ON su.id = dm.sender_id
`;

function getConversations(userId) {
  return getDb().prepare(`
    SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id
    FROM direct_messages WHERE sender_id = ? OR recipient_id = ?
  `).all(userId, userId, userId);
}

function getLastMessage(userId, peerId) {
  return getDb().prepare(`
    SELECT content, attachment_name, sender_id, created_at AS timestamp
    FROM direct_messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, peerId, peerId, userId);
}

function getUnreadCount(recipientId, senderId) {
  return getDb().prepare(`
    SELECT COUNT(*) c FROM direct_messages
    WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL
  `).get(senderId, recipientId).c;
}

function getTotalUnread(userId) {
  return getDb().prepare(
    'SELECT COUNT(*) c FROM direct_messages WHERE recipient_id = ? AND read_at IS NULL'
  ).get(userId).c;
}

function markRead(peerId, myId) {
  getDb().prepare(`
    UPDATE direct_messages SET read_at = ?
    WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL
  `).run(new Date().toISOString(), peerId, myId);
}

function getRecentDmMessages(userId, peerId, limit) {
  const rows = getDb().prepare(`
    ${DM_SELECT}
    WHERE (dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?)
    ORDER BY dm.created_at DESC LIMIT ?
  `).all(userId, peerId, peerId, userId, limit);
  rows.reverse();
  return rows;
}

function getDmMessagesBefore(userId, peerId, before, limit) {
  const rows = getDb().prepare(`
    ${DM_SELECT}
    WHERE ((dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?))
      AND dm.created_at < ?
    ORDER BY dm.created_at DESC LIMIT ?
  `).all(userId, peerId, peerId, userId, before, limit);
  rows.reverse();
  return rows;
}

function getDmMessagesSince(userId, peerId, since, limit) {
  return getDb().prepare(`
    ${DM_SELECT}
    WHERE ((dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?))
      AND dm.created_at > ?
    ORDER BY dm.created_at ASC LIMIT ?
  `).all(userId, peerId, peerId, userId, since, limit);
}

function insertDmMessage(senderId, recipientId, content, timestamp) {
  return getDb().prepare(`
    INSERT INTO direct_messages (sender_id, recipient_id, content, created_at)
    VALUES (?, ?, ?, ?)
  `).run(senderId, recipientId, content, timestamp);
}

function insertDmMessageWithAttachment(senderId, recipientId, content, timestamp, filename, originalName, size, mime) {
  return getDb().prepare(`
    INSERT INTO direct_messages (sender_id, recipient_id, content, created_at,
                                 attachment_path, attachment_name, attachment_size, attachment_mime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(senderId, recipientId, content, timestamp, filename, originalName, size, mime);
}

function findDmMessageById(id) {
  return getDb().prepare('SELECT * FROM direct_messages WHERE id = ?').get(id);
}

function findDmMessageWithUser(id) {
  return getDb().prepare(`${DM_SELECT} WHERE dm.id = ?`).get(id);
}

function deleteDmMessage(id) {
  return getDb().prepare('DELETE FROM direct_messages WHERE id = ?').run(id);
}

module.exports = {
  getConversations,
  getLastMessage,
  getUnreadCount,
  getTotalUnread,
  markRead,
  getRecentDmMessages,
  getDmMessagesBefore,
  getDmMessagesSince,
  insertDmMessage,
  insertDmMessageWithAttachment,
  findDmMessageById,
  findDmMessageWithUser,
  deleteDmMessage,
};
