const path = require('path');
const fs = require('fs');
const constants = require('../config/constants');
const { CHAT_MIME_MAP } = require('../config/multer');
const {
  getConversationsSummary,
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
} = require('../services/dm.service');
const { findUserById } = require('../services/user.service');
const { toggleReaction, getReactionsForMessage, getReactionsForMessages } = require('../services/reaction.service');
const { emitNewDirectMessage, emitDirectMessageDeleted, emitDirectReactionUpdate } = require('../services/socket.service');
const { clampLimit, withDmFlags, withReactions } = require('../utils/helpers');

// Accepts whatever the client sent for reply_to_id and normalizes it
// to either a positive integer or null. For DMs we additionally
// require — beyond just being a well-formed id — that the referenced
// message actually belongs to *this* conversation (sender/recipient
// pair), otherwise a fabricated id could pull another conversation's
// message content into this thread's reply preview. An id that's a
// good match structurally but doesn't resolve (already deleted) is
// still allowed through: DM_SELECT's LEFT JOIN degrades that to
// reply_to: null, rendered as "Original message deleted".
function normalizeDmReplyToId(value, userId, peerId) {

  if (value === undefined || value === null || value === '') {
    return null;
  }

  const id = Number.parseInt(value, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const target = findDmMessageById(id);

  if (!target) {
    // Already gone — still a legitimate reply target (falls back to
    // "Original message deleted"), just can't be conversation-checked.
    return id;
  }

  const belongsToConversation =
    (target.sender_id === userId && target.recipient_id === peerId) ||
    (target.sender_id === peerId && target.recipient_id === userId);

  return belongsToConversation ? id : null;
}

// Same reasoning as chat.controller.js's isVoiceMessageFlag(): only
// honor the client's "this is a voice message" flag when the
// resolved attachment mime is actually audio, so a client can't tag
// an arbitrary upload to have it render in the compact voice UI.
function isVoiceMessageFlag(rawValue, mime) {
  const truthy =
    rawValue === '1' ||
    rawValue === 'true' ||
    rawValue === true;

  return truthy && typeof mime === 'string' && mime.startsWith('audio/');
}

function getConversationsHandler(req, res) {
  // getConversationsSummary() batches what used to be 1 + 3 queries
  // per conversation (peer lookup, last message, unread count) into
  // 3 fixed queries total — see the comment on it in dm.service.js.
  const conversations = getConversationsSummary(req.user.id);

  const result = conversations.map(({ peer_id, username, lastMessage, unreadCount }) => {
    return {
      peer_id,
      username: username || 'Deleted user',
      last_message: lastMessage
        ? (lastMessage.content || (lastMessage.attachment_name ? (lastMessage.is_voice_message ? '🎤 Voice message' : '📎 Attachment') : ''))
        : '',
      last_timestamp: lastMessage ? lastMessage.timestamp : null,
      unread_count: unreadCount,
    };
  }).sort((a, b) => (b.last_timestamp || '').localeCompare(a.last_timestamp || ''));

  res.json(result);
}

function getUnreadCountHandler(req, res) {
  const count = getTotalUnread(req.user.id);
  res.json({ count });
}

function getRecentMessagesHandler(req, res) {
  const peerId = parseInt(req.params.peerId);
  const limit = clampLimit(req.query.limit);
  const messages = getRecentDmMessages(req.user.id, peerId, limit);
  markRead(peerId, req.user.id);
  const reactions = getReactionsForMessages('dm', messages.map(m => m.id));
  res.json(withReactions(withDmFlags(messages), reactions));
}

function getMessagesBeforeHandler(req, res) {
  const peerId = parseInt(req.params.peerId);
  const before = typeof req.query.before === 'string' ? req.query.before : new Date().toISOString();
  const limit = clampLimit(req.query.limit);
  const messages = getDmMessagesBefore(req.user.id, peerId, before, limit);
  const reactions = getReactionsForMessages('dm', messages.map(m => m.id));
  res.json(withReactions(withDmFlags(messages), reactions));
}

function getMessagesSinceHandler(req, res) {
  const peerId = parseInt(req.params.peerId);
  const since = typeof req.query.since === 'string' ? req.query.since : '1970-01-01T00:00:00.000Z';
  const limit = clampLimit(req.query.limit, 100, 200);
  const messages = getDmMessagesSince(req.user.id, peerId, since, limit);
  markRead(peerId, req.user.id);
  const reactions = getReactionsForMessages('dm', messages.map(m => m.id));
  res.json(withReactions(withDmFlags(messages), reactions));
}

function sendMessage(req, res) {
  const { recipient_id, content } = req.body || {};

  if (!recipient_id) {
    return res.status(400).json({ error: 'recipient_id required' });
  }

  if (Number(recipient_id) === req.user.id) {
    return res.status(400).json({ error: "You can't message yourself" });
  }

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  const target = findUserById(recipient_id);
  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  const trimmed = content.trim().slice(0, 2000);
  const replyToId = normalizeDmReplyToId(req.body?.reply_to_id, req.user.id, Number(recipient_id));
  const timestamp = new Date().toISOString();
  const info = insertDmMessage(req.user.id, recipient_id, trimmed, timestamp, replyToId);

  const fullMsg = findDmMessageWithUser(info.lastInsertRowid);
  fullMsg.has_attachment = !!fullMsg.attachment_name;
  fullMsg.is_voice_message = Boolean(fullMsg.is_voice_message);

  emitNewDirectMessage(fullMsg);
  res.json(fullMsg);
}

function sendMessageWithAttachment(req, res) {
  const recipient_id = req.body.recipient_id;
  const cleanup = () => {
    if (req.file) fs.unlink(req.file.path, () => {});
  };

  if (!recipient_id) {
    cleanup();
    return res.status(400).json({ error: 'recipient_id required' });
  }

  if (Number(recipient_id) === req.user.id) {
    cleanup();
    return res.status(400).json({ error: "You can't message yourself" });
  }

  const target = findUserById(recipient_id);
  if (!target) {
    cleanup();
    return res.status(404).json({ error: 'User not found' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const originalName = path.basename(req.file.originalname);
  const ext = path.extname(originalName).toLowerCase();
  const mime = CHAT_MIME_MAP[ext] || req.file.mimetype || 'application/octet-stream';
  const caption = (req.body.content || '').trim().slice(0, 2000);
  const replyToId = normalizeDmReplyToId(req.body?.reply_to_id, req.user.id, Number(recipient_id));
  const isVoiceMessage = isVoiceMessageFlag(req.body?.is_voice_message, mime);
  const timestamp = new Date().toISOString();

  const info = insertDmMessageWithAttachment(
    req.user.id,
    recipient_id,
    caption,
    timestamp,
    req.file.filename,
    originalName,
    req.file.size,
    mime,
    replyToId,
    isVoiceMessage
  );

  const fullMsg = findDmMessageWithUser(info.lastInsertRowid);
  fullMsg.has_attachment = !!fullMsg.attachment_name;
  fullMsg.is_voice_message = Boolean(fullMsg.is_voice_message);

  emitNewDirectMessage(fullMsg);
  res.json(fullMsg);
}

function getAttachment(req, res) {
  const messageId = Number(req.params.messageId);

  if (!Number.isInteger(messageId)) {
    return res.status(400).json({
      error: 'Invalid message id'
    });
  }

  const msg = findDmMessageById(messageId);

  if (!msg || !msg.attachment_path) {
    return res.status(404).json({
      error: 'Attachment not found'
    });
  }

  // Only sender or recipient can access the attachment
  if (
    msg.sender_id !== req.user.id &&
    msg.recipient_id !== req.user.id
  ) {
    return res.status(403).json({
      error: 'Access denied'
    });
  }

  const filePath = path.join(
    constants.DM_UPLOAD_DIR,
    msg.attachment_path
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'Attachment not found'
    });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  const contentType =
    msg.attachment_mime ||
    'application/octet-stream';

  const disposition =
    req.query.download
      ? 'attachment'
      : 'inline';

  res.setHeader(
    'Content-Type',
    contentType
  );

  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename*=UTF-8''${encodeURIComponent(
      msg.attachment_name
    )}`
  );

  // --------------------------------------------------
  // DOWNLOAD
  // --------------------------------------------------

  if (req.query.download) {
    res.setHeader(
      'Content-Length',
      fileSize
    );

    const downloadStream = fs.createReadStream(filePath);
    // See the identical comment in chat.controller.js's getAttachment
    // — without this, a client disconnecting mid-download leaves the
    // server still reading the rest of the file off disk for no one.
    req.on('close', () => {
      if (!downloadStream.destroyed) downloadStream.destroy();
    });
    return downloadStream.pipe(res);
  }

  // --------------------------------------------------
  // VIDEO / AUDIO RANGE SUPPORT
  // --------------------------------------------------

  const range = req.headers.range;

  // Browser did not request a range
  if (!range) {
    res.setHeader(
      'Content-Length',
      fileSize
    );

    res.setHeader(
      'Accept-Ranges',
      'bytes'
    );

    const fullStream = fs.createReadStream(filePath);
    req.on('close', () => {
      if (!fullStream.destroyed) fullStream.destroy();
    });
    return fullStream.pipe(res);
  }

  // --------------------------------------------------
  // PARSE RANGE
  // --------------------------------------------------

  const match = range.match(
    /bytes=(\d*)-(\d*)/
  );

  if (!match) {
    return res
      .status(416)
      .setHeader(
        'Content-Range',
        `bytes */${fileSize}`
      )
      .end();
  }

  let start = match[1]
    ? Number(match[1])
    : 0;

  let end = match[2]
    ? Number(match[2])
    : fileSize - 1;

  // Suffix range:
  // bytes=-500000
  if (!match[1] && match[2]) {
    const suffixLength =
      Number(match[2]);

    start = Math.max(
      fileSize - suffixLength,
      0
    );

    end = fileSize - 1;
  }

  // --------------------------------------------------
  // VALIDATE RANGE
  // --------------------------------------------------

  if (
    start < 0 ||
    end >= fileSize ||
    start > end
  ) {
    return res
      .status(416)
      .setHeader(
        'Content-Range',
        `bytes */${fileSize}`
      )
      .end();
  }

  const chunkSize =
    end - start + 1;

  // --------------------------------------------------
  // PARTIAL RESPONSE
  // --------------------------------------------------

  res.status(206);

  res.setHeader(
    'Content-Range',
    `bytes ${start}-${end}/${fileSize}`
  );

  res.setHeader(
    'Accept-Ranges',
    'bytes'
  );

  res.setHeader(
    'Content-Length',
    chunkSize
  );

  // --------------------------------------------------
  // STREAM REQUESTED CHUNK
  // --------------------------------------------------

  const stream =
    fs.createReadStream(filePath, {
      start,
      end
    });

  stream.on('error', (err) => {
    console.error(
      'DM attachment stream error:',
      err.message
    );

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });

  // Same reasoning as chat.controller.js's getAttachment — this is
  // the range endpoint video/audio scrubbing hits, and each seek
  // cancels the previous in-flight range request from the browser's
  // side. Destroying the stream when the request closes stops the
  // server from continuing to read an abandoned byte range off disk.
  req.on('close', () => {
    if (!stream.destroyed) stream.destroy();
  });

  stream.pipe(res);
}

function deleteMessage(req, res) {
  const id = parseInt(req.params.messageId, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  const msg = findDmMessageById(id);
  if (!msg) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const isOwner = msg.sender_id === req.user.id;
  const isAdmin = !!req.user.is_admin;

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'You can only delete your own messages' });
  }

  if (msg.attachment_path) {
    const filePath = path.join(constants.DM_UPLOAD_DIR, msg.attachment_path);
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error('Failed to delete DM attachment:', err.message);
      }
    });
  }

  deleteDmMessage(id);

  emitDirectMessageDeleted({
    id,
    sender_id: msg.sender_id,
    recipient_id: msg.recipient_id,
  });

  res.json({ success: true, id });
}

function toggleReactionHandler(req, res) {
  const id = parseInt(req.params.messageId, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  const emoji = (req.body.emoji || '').trim();
  if (!emoji || emoji.length > 32) {
    return res.status(400).json({ error: 'Invalid emoji' });
  }

  const msg = findDmMessageById(id);
  if (!msg) {
    return res.status(404).json({ error: 'Message not found' });
  }

  // Either side of the conversation can react — unlike delete
  // (sender/admin only), reacting doesn't modify someone else's
  // content, so the recipient is allowed too.
  const isParticipant = msg.sender_id === req.user.id || msg.recipient_id === req.user.id;
  if (!isParticipant) {
    return res.status(403).json({ error: 'You do not have access to this conversation' });
  }

  const action = toggleReaction('dm', id, req.user.id, emoji);
  const reactions = getReactionsForMessage('dm', id);

  emitDirectReactionUpdate({
    message_id: id,
    sender_id: msg.sender_id,
    recipient_id: msg.recipient_id,
    reactions,
  });

  res.json({ success: true, action, reactions });
}

module.exports = {
  getConversations: getConversationsHandler,
  getUnreadCount: getUnreadCountHandler,
  getRecentMessages: getRecentMessagesHandler,
  getMessagesBefore: getMessagesBeforeHandler,
  getMessagesSince: getMessagesSinceHandler,
  sendMessage,
  sendMessageWithAttachment,
  getAttachment,
  deleteMessage,
  toggleReaction: toggleReactionHandler,
};