const { getDb } = require('../config/database');


// نکته: ستون واقعی در جدول messages، created_at است نه timestamp.
// برای اینکه فرانت‌اند (که msg.timestamp را می‌خواند) دست‌نخورده بماند،
// همیشه created_at را با AS timestamp می‌خوانیم.
const CHAT_SELECT = `
  SELECT
    m.id,
    m.user_id,
    u.username,
    m.content,
    m.created_at AS timestamp,
    m.attachment_name,
    m.attachment_size,
    m.attachment_mime
  FROM messages m
  JOIN users u
    ON u.id = m.user_id
`;


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


  return rows.reverse();
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


  return rows.reverse();
}



function getMessagesSince(since, limit = 50) {

  limit = normalizeLimit(limit);


  return getDb()
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

}



function insertChatMessage(
  userId,
  content,
  timestamp
) {

  return getDb()
    .prepare(`
      INSERT INTO messages
      (
        user_id,
        content,
        created_at
      )
      VALUES (?, ?, ?)
    `)
    .run(
      userId,
      content,
      timestamp
    );

}



function insertChatMessageWithAttachment(
  userId,
  content,
  timestamp,
  filename,
  originalName,
  size,
  mime
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
        attachment_mime
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      userId,
      content,
      timestamp,
      filename,
      originalName,
      size,
      mime
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

  return getDb()
    .prepare(`
      ${CHAT_SELECT}
      WHERE m.id = ?
    `)
    .get(id);

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
