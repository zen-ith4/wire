const path = require('path');
const fs = require('fs');
const constants = require('../config/constants');
const { CHAT_MIME_MAP } = require('../config/multer');
const {
  getConversations,
  getLastMessage,
  getTotalUnread,
  getUnreadCount,
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

function getConversationsHandler(req, res) {
  const peers = getConversations(req.user.id);

  const result = peers.map(({ peer_id }) => {
    const peer = findUserById(peer_id);
    const lastMsg = getLastMessage(req.user.id, peer_id);
    const unread = getUnreadCount(req.user.id, peer_id);

    return {
      peer_id,
      username: peer ? peer.username : 'Deleted user',
      last_message: lastMsg
        ? (lastMsg.content || (lastMsg.attachment_name ? '📎 Attachment' : ''))
        : '',
      last_timestamp: lastMsg ? lastMsg.timestamp : null,
      unread_count: unread,
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
  const timestamp = new Date().toISOString();
  const info = insertDmMessage(req.user.id, recipient_id, trimmed, timestamp);

  const fullMsg = findDmMessageWithUser(info.lastInsertRowid);
  fullMsg.has_attachment = !!fullMsg.attachment_name;

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
  const timestamp = new Date().toISOString();

  const info = insertDmMessageWithAttachment(
    req.user.id,
    recipient_id,
    caption,
    timestamp,
    req.file.filename,
    originalName,
    req.file.size,
    mime
  );

  const fullMsg = findDmMessageWithUser(info.lastInsertRowid);
  fullMsg.has_attachment = !!fullMsg.attachment_name;

  emitNewDirectMessage(fullMsg);
  res.json(fullMsg);
}

function getAttachment(req, res) {
  const msg = findDmMessageById(req.params.messageId);

  if (!msg || !msg.attachment_path) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  if (msg.sender_id !== req.user.id && msg.recipient_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const filePath = path.join(constants.DM_UPLOAD_DIR, msg.attachment_path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', msg.attachment_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(msg.attachment_name)}"`);
  fs.createReadStream(filePath).pipe(res);
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