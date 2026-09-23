const { getDb } = require('../config/database');

// نکته: ستون واقعی در جدول direct_messages، created_at است نه timestamp.
// برای اینکه فرانت‌اند (که msg.timestamp را می‌خواند) دست‌نخورده بماند،
// همیشه created_at را با AS timestamp می‌خوانیم.
const DM_SELECT = `
  SELECT dm.id, dm.sender_id, dm.recipient_id, su.username AS sender_username,
         su.accent_color, su.avatar_path AS sender_avatar_path,
         dm.content, dm.created_at AS timestamp, dm.read_at,
         dm.attachment_name, dm.attachment_size, dm.attachment_mime,
         dm.attachment_width, dm.attachment_height,
         dm.is_voice_message,
         dm.reply_to_id,
         rdm.id AS reply_id, rdm.sender_id AS reply_user_id,
         rsu.username AS reply_username, rdm.content AS reply_content,
         rdm.created_at AS reply_timestamp,
         rdm.attachment_name AS reply_attachment_name,
         rdm.attachment_mime AS reply_attachment_mime,
         rdm.is_voice_message AS reply_is_voice_message
  FROM direct_messages dm
  JOIN users su ON su.id = dm.sender_id
  LEFT JOIN direct_messages rdm ON rdm.id = dm.reply_to_id
  LEFT JOIN users rsu ON rsu.id = rdm.sender_id
`;

// Same nesting as chat.service.js's shapeReplyTo — see the comment
// there for why reply_to_id is preserved even when reply_to is null
// (deleted original message).
function shapeReplyTo(row) {

  const {
    reply_id,
    reply_user_id,
    reply_username,
    reply_content,
    reply_timestamp,
    reply_attachment_name,
    reply_attachment_mime,
    ...rest
  } = row;

  rest.reply_to = (rest.reply_to_id != null && reply_id != null)
    ? {
        id: reply_id,
        user_id: reply_user_id,
        username: reply_username,
        content: reply_content,
        timestamp: reply_timestamp,
        has_attachment: Boolean(reply_attachment_name),
        attachment_name: reply_attachment_name,
        attachment_mime: reply_attachment_mime,
      }
    : null;

  return rest;

}

function shapeReplyToAll(rows) {
  return rows.map(shapeReplyTo);
}

function getConversations(userId) {
  return getDb().prepare(`
    SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id
    FROM direct_messages WHERE sender_id = ? OR recipient_id = ?
  `).all(userId, userId, userId);
}

// Everything the conversation-list endpoint needs (peer id, username,
// last message preview, unread count) in three fixed queries instead
// of one query per conversation — getConversationsHandler previously
// called getConversations() once and then, per peer, findUserById() +
// getLastMessage() + getUnreadCount() (1 + 3N queries for N
// conversations). Same data, same shape, just batched:
//   1. one query for the peer list + username (a single JOIN instead
//      of N findUserById() calls)
//   2. one windowed query for every peer's single most recent
//      message at once
//   3. one grouped query for every peer's unread count at once
// The three result sets are then joined in memory by peer_id.
function getConversationsSummary(userId) {
  const peers = getDb().prepare(`
    SELECT
      CASE WHEN dm.sender_id = ? THEN dm.recipient_id ELSE dm.sender_id END AS peer_id,
      u.username
    FROM direct_messages dm
    LEFT JOIN users u
      ON u.id = CASE WHEN dm.sender_id = ? THEN dm.recipient_id ELSE dm.sender_id END
    WHERE dm.sender_id = ? OR dm.recipient_id = ?
    GROUP BY peer_id
  `).all(userId, userId, userId, userId);

  const lastMessageRows = getDb().prepare(`
    SELECT peer_id, content, attachment_name, is_voice_message, timestamp FROM (
      SELECT
        CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id,
        content,
        attachment_name,
        is_voice_message,
        created_at AS timestamp,
        ROW_NUMBER() OVER (
          PARTITION BY CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END
          ORDER BY created_at DESC
        ) AS rn
      FROM direct_messages
      WHERE sender_id = ? OR recipient_id = ?
    )
    WHERE rn = 1
  `).all(userId, userId, userId, userId);

  const unreadRows = getDb().prepare(`
    SELECT sender_id AS peer_id, COUNT(*) AS c
    FROM direct_messages
    WHERE recipient_id = ? AND read_at IS NULL
    GROUP BY sender_id
  `).all(userId);

  const lastMessageByPeer = new Map(lastMessageRows.map(r => [r.peer_id, r]));
  const unreadByPeer = new Map(unreadRows.map(r => [r.peer_id, r.c]));

  return peers.map(({ peer_id, username }) => ({
    peer_id,
    username,
    lastMessage: lastMessageByPeer.get(peer_id) || null,
    unreadCount: unreadByPeer.get(peer_id) || 0,
  }));
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
  return shapeReplyToAll(rows);
}

function getDmMessagesBefore(userId, peerId, before, limit) {
  const rows = getDb().prepare(`
    ${DM_SELECT}
    WHERE ((dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?))
      AND dm.created_at < ?
    ORDER BY dm.created_at DESC LIMIT ?
  `).all(userId, peerId, peerId, userId, before, limit);
  rows.reverse();
  return shapeReplyToAll(rows);
}

function getDmMessagesSince(userId, peerId, since, limit) {
  const rows = getDb().prepare(`
    ${DM_SELECT}
    WHERE ((dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?))
      AND dm.created_at > ?
    ORDER BY dm.created_at ASC LIMIT ?
  `).all(userId, peerId, peerId, userId, since, limit);
  return shapeReplyToAll(rows);
}

function insertDmMessage(senderId, recipientId, content, timestamp, replyToId = null) {
  return getDb().prepare(`
    INSERT INTO direct_messages (sender_id, recipient_id, content, created_at, reply_to_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(senderId, recipientId, content, timestamp, replyToId);
}

function insertDmMessageWithAttachment(senderId, recipientId, content, timestamp, filename, originalName, size, mime, replyToId = null, isVoiceMessage = false, width = null, height = null) {
  return getDb().prepare(`
    INSERT INTO direct_messages (sender_id, recipient_id, content, created_at,
                                 attachment_path, attachment_name, attachment_size, attachment_mime,
                                 attachment_width, attachment_height, reply_to_id, is_voice_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(senderId, recipientId, content, timestamp, filename, originalName, size, mime, width, height, replyToId, isVoiceMessage ? 1 : 0);
}

function findDmMessageById(id) {
  return getDb().prepare('SELECT * FROM direct_messages WHERE id = ?').get(id);
}

function findDmMessageWithUser(id) {
  const row = getDb().prepare(`${DM_SELECT} WHERE dm.id = ?`).get(id);
  return row ? shapeReplyTo(row) : row;
}

function deleteDmMessage(id) {
  return getDb().prepare('DELETE FROM direct_messages WHERE id = ?').run(id);
}

module.exports = {
  getConversations,
  getConversationsSummary,
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
