const { getDb } = require('../config/database');


// نکته: ستون واقعی در جدول messages، created_at است نه timestamp.
// برای اینکه فرانت‌اند (که msg.timestamp را می‌خواند) دست‌نخورده بماند،
// همیشه created_at را با AS timestamp می‌خوانیم.
const CHAT_SELECT = `
  SELECT
    m.id,
    m.user_id,
    u.username,
    u.accent_color,
    m.content,
    m.created_at AS timestamp,
    m.attachment_name,
    m.attachment_size,
    m.attachment_mime,
    m.attachment_width,
    m.attachment_height,
    m.is_voice_message,
    m.reply_to_id,
    rm.id AS reply_id,
    rm.user_id AS reply_user_id,
    ru.username AS reply_username,
    rm.content AS reply_content,
    rm.created_at AS reply_timestamp,
    rm.attachment_name AS reply_attachment_name,
    rm.attachment_mime AS reply_attachment_mime,
    rm.is_voice_message AS reply_is_voice_message
  FROM messages m
  JOIN users u
    ON u.id = m.user_id
  LEFT JOIN messages rm
    ON rm.id = m.reply_to_id
  LEFT JOIN users ru
    ON ru.id = rm.user_id
`;


// Collapses the flat reply_* columns produced by CHAT_SELECT's LEFT
// JOIN into a nested `reply_to` object (or null), matching the shape
// the frontend's buildReplyQuoteHtml()/buildReplyPreview() expect.
// A message with reply_to_id set but reply_id missing means the
// original was deleted — reply_to_id is kept (so we still know this
// was a reply) while reply_to comes back null, which is exactly what
// reply.js's "Original message deleted" fallback checks for.
function shapeReplyTo(row) {

  const {
    reply_id,
    reply_user_id,
    reply_username,
    reply_content,
    reply_timestamp,
    reply_attachment_name,
    reply_attachment_mime,
    reply_is_voice_message,
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
        is_voice_message: Boolean(reply_is_voice_message),
      }
    : null;

  return rest;

}


function shapeReplyToAll(rows) {
  return rows.map(shapeReplyTo);
}


function normalizeLimit(limit) {

  const value = Number(limit);

  if (!Number.isInteger(value) || value <= 0) {
    return 50;
  }

  return Math.min(value, 100);
}



function getRecentMessages(limit = 50) {

  limit = normalizeLimit(limit);

  const rows =
    getDb()
      .prepare(`
        ${CHAT_SELECT}
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
      .all(limit);


  return shapeReplyToAll(rows.reverse());
}



function getMessagesBefore(before, limit = 50) {

  limit = normalizeLimit(limit);


  const rows =
    getDb()
      .prepare(`
        ${CHAT_SELECT}
        WHERE m.created_at < ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
      .all(
        before,
        limit
      );


  return shapeReplyToAll(rows.reverse());
}



function getMessagesSince(since, limit = 50) {

  limit = normalizeLimit(limit);


  const rows = getDb()
    .prepare(`
      ${CHAT_SELECT}
      WHERE m.created_at > ?
      ORDER BY m.created_at ASC
      LIMIT ?
    `)
    .all(
      since,
      limit
    );

  return shapeReplyToAll(rows);

}



function insertChatMessage(
  userId,
  content,
  timestamp,
  replyToId = null
) {

  return getDb()
    .prepare(`
      INSERT INTO messages
      (
        user_id,
        content,
        created_at,
        reply_to_id
      )
      VALUES (?, ?, ?, ?)
    `)
    .run(
      userId,
      content,
      timestamp,
      replyToId
    );

}



function insertChatMessageWithAttachment(
  userId,
  content,
  timestamp,
  filename,
  originalName,
  size,
  mime,
  replyToId = null,
  isVoiceMessage = false,
  width = null,
  height = null
) {

  return getDb()
    .prepare(`
      INSERT INTO messages
      (
        user_id,
        content,
        created_at,
        attachment_path,
        attachment_name,
        attachment_size,
        attachment_mime,
        attachment_width,
        attachment_height,
        reply_to_id,
        is_voice_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      userId,
      content,
      timestamp,
      filename,
      originalName,
      size,
      mime,
      width,
      height,
      replyToId,
      isVoiceMessage ? 1 : 0
    );

}



function findChatMessageById(id) {

  return getDb()
    .prepare(`
      SELECT *
      FROM messages
      WHERE id = ?
    `)
    .get(id);

}



function findChatMessageWithUser(id) {

  const row = getDb()
    .prepare(`
      ${CHAT_SELECT}
      WHERE m.id = ?
    `)
    .get(id);

  return row ? shapeReplyTo(row) : row;

}



function deleteChatMessage(id) {

  return getDb()
    .prepare(`
      DELETE FROM messages
      WHERE id = ?
    `)
    .run(id);

}



module.exports = {
  getRecentMessages,
  getMessagesBefore,
  getMessagesSince,
  insertChatMessage,
  insertChatMessageWithAttachment,
  findChatMessageById,
  findChatMessageWithUser,
  deleteChatMessage,
};
