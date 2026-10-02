const { getDb } = require('../config/database');

/**
 * Adds the reaction if the user hasn't reacted with this exact
 * emoji on this message yet, removes it if they have — this IS the
 * toggle behavior, driven entirely by the UNIQUE constraint on
 * (message_type, message_id, user_id, emoji) rather than a
 * check-then-act race (the DELETE either finds a row or it doesn't;
 * there's no window where two toggles could both "add").
 */
function toggleReaction(messageType, messageId, userId, emoji) {
  const db = getDb();

  const existing = db
    .prepare(`
      SELECT id FROM message_reactions
      WHERE message_type = ? AND message_id = ? AND user_id = ? AND emoji = ?
    `)
    .get(messageType, messageId, userId, emoji);

  if (existing) {
    db.prepare(`DELETE FROM message_reactions WHERE id = ?`).run(existing.id);
    return 'removed';
  }

  db.prepare(`
    INSERT INTO message_reactions (message_type, message_id, user_id, emoji)
    VALUES (?, ?, ?, ?)
  `).run(messageType, messageId, userId, emoji);

  return 'added';
}

function groupRows(rows) {
  const byEmoji = new Map();

  for (const row of rows) {
    if (!byEmoji.has(row.emoji)) {
      byEmoji.set(row.emoji, { emoji: row.emoji, count: 0, user_ids: [], usernames: [] });
    }
    const group = byEmoji.get(row.emoji);
    group.count++;
    group.user_ids.push(row.user_id);
    group.usernames.push(row.username);
  }

  return Array.from(byEmoji.values());
}

/**
 * Grouped reactions for a single message: [{ emoji, count, user_ids, usernames }]
 */
function getReactionsForMessage(messageType, messageId) {
  const rows = getDb()
    .prepare(`
      SELECT mr.emoji, mr.user_id, u.username
      FROM message_reactions mr
      JOIN users u ON u.id = mr.user_id
      WHERE mr.message_type = ? AND mr.message_id = ?
      ORDER BY mr.created_at ASC
    `)
    .all(messageType, messageId);

  return groupRows(rows);
}

/**
 * Same as getReactionsForMessage but batched across many message
 * ids in one query — used when loading a page of messages, so
 * rendering N messages doesn't cost N separate queries.
 * Returns { [message_id]: [{ emoji, count, user_ids, usernames }] }
 */
function getReactionsForMessages(messageType, messageIds) {
  if (!messageIds || messageIds.length === 0) return {};

  const placeholders = messageIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`
      SELECT mr.message_id, mr.emoji, mr.user_id, u.username
      FROM message_reactions mr
      JOIN users u ON u.id = mr.user_id
      WHERE mr.message_type = ? AND mr.message_id IN (${placeholders})
      ORDER BY mr.created_at ASC
    `)
    .all(messageType, ...messageIds);

  const rowsByMessage = new Map();
  for (const row of rows) {
    if (!rowsByMessage.has(row.message_id)) rowsByMessage.set(row.message_id, []);
    rowsByMessage.get(row.message_id).push(row);
  }

  const result = {};
  for (const [messageId, messageRows] of rowsByMessage.entries()) {
    result[messageId] = groupRows(messageRows);
  }
  return result;
}

module.exports = {
  toggleReaction,
  getReactionsForMessage,
  getReactionsForMessages
};
