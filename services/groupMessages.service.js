const { getDb } = require('../config/database');

// Same shape/reasoning as dm.service.js's DM_SELECT + shapeReplyTo:
// created_at is aliased to timestamp for the frontend, and a
// reply_to_id with no resolvable target degrades to reply_to: null
// ("Original message deleted") instead of disappearing.
const GROUP_MESSAGE_SELECT = `
  SELECT gm.id, gm.group_id, gm.sender_id, su.username AS sender_username,
         su.accent_color,
         gm.content, gm.created_at AS timestamp,
         gm.attachment_name, gm.attachment_size, gm.attachment_mime,
         gm.attachment_width, gm.attachment_height, gm.attachment_iv,
         gm.is_voice_message,
         gm.reply_to_id,
         rgm.id AS reply_id, rgm.sender_id AS reply_user_id,
         rsu.username AS reply_username, rgm.content AS reply_content,
         rgm.created_at AS reply_timestamp,
         rgm.attachment_name AS reply_attachment_name,
         rgm.attachment_mime AS reply_attachment_mime,
         rgm.is_voice_message AS reply_is_voice_message
  FROM group_messages gm
  JOIN users su ON su.id = gm.sender_id
  LEFT JOIN group_messages rgm ON rgm.id = gm.reply_to_id
  LEFT JOIN users rsu ON rsu.id = rgm.sender_id
`;

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

function getRecentGroupMessages(groupId, limit) {
  const rows = getDb().prepare(`
    ${GROUP_MESSAGE_SELECT}
    WHERE gm.group_id = ?
    ORDER BY gm.created_at DESC LIMIT ?
  `).all(groupId, limit);
  rows.reverse();
  return shapeReplyToAll(rows);
}

function getGroupMessagesBefore(groupId, before, limit) {
  const rows = getDb().prepare(`
    ${GROUP_MESSAGE_SELECT}
    WHERE gm.group_id = ? AND gm.created_at < ?
    ORDER BY gm.created_at DESC LIMIT ?
  `).all(groupId, before, limit);
  rows.reverse();
  return shapeReplyToAll(rows);
}

function getGroupMessagesSince(groupId, since, limit) {
  const rows = getDb().prepare(`
    ${GROUP_MESSAGE_SELECT}
    WHERE gm.group_id = ? AND gm.created_at > ?
    ORDER BY gm.created_at ASC LIMIT ?
  `).all(groupId, since, limit);
  return shapeReplyToAll(rows);
}

function findGroupMessageById(id) {
  return getDb().prepare('SELECT * FROM group_messages WHERE id = ?').get(id);
}

function findGroupMessageWithUser(id) {
  const row = getDb().prepare(`${GROUP_MESSAGE_SELECT} WHERE gm.id = ?`).get(id);
  return row ? shapeReplyTo(row) : row;
}

// content is always an opaque Sender-Key AES-GCM envelope string —
// this layer never inspects it, same as dm.service.js's
// insertDmMessage/insertDmMessageWithAttachment.
function insertGroupMessage(groupId, senderId, content, timestamp, replyToId = null) {
  return getDb().prepare(`
    INSERT INTO group_messages (group_id, sender_id, content, created_at, reply_to_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(groupId, senderId, content, timestamp, replyToId);
}

function insertGroupMessageWithAttachment(
  groupId, senderId, content, timestamp,
  filename, originalName, size, mime,
  replyToId = null, isVoiceMessage = false, width = null, height = null, attachmentIv = null
) {
  return getDb().prepare(`
    INSERT INTO group_messages (group_id, sender_id, content, created_at,
                                attachment_path, attachment_name, attachment_size, attachment_mime,
                                attachment_width, attachment_height, reply_to_id, is_voice_message, attachment_iv)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(groupId, senderId, content, timestamp, filename, originalName, size, mime, width, height, replyToId, isVoiceMessage ? 1 : 0, attachmentIv);
}

function deleteGroupMessage(id) {
  return getDb().prepare('DELETE FROM group_messages WHERE id = ?').run(id);
}

module.exports = {
  getRecentGroupMessages,
  getGroupMessagesBefore,
  getGroupMessagesSince,
  findGroupMessageById,
  findGroupMessageWithUser,
  insertGroupMessage,
  insertGroupMessageWithAttachment,
  deleteGroupMessage,
};
