const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { dmUpload } = require('../config/multer');

const {
  getConversations,
  getUnreadCount,
  getRecentMessages,
  getMessagesBefore,
  getMessagesSince,
  sendMessage,
  sendMessageWithAttachment,
  getAttachment,
  deleteMessage,
  toggleReaction,
} = require('../controllers/dm.controller');


// Conversation list
router.get(
  '/conversations',
  authenticate,
  getConversations
);


// Total unread messages
router.get(
  '/unread-count',
  authenticate,
  getUnreadCount
);


// Recent DM messages
router.get(
  '/messages/:peerId/recent',
  authenticate,
  getRecentMessages
);


// Older messages pagination
router.get(
  '/messages/:peerId/before',
  authenticate,
  getMessagesBefore
);


// New messages polling
router.get(
  '/messages/:peerId/since',
  authenticate,
  getMessagesSince
);


// Send text DM
router.post(
  '/messages',
  authenticate,
  sendMessage
);


// Send DM with file
router.post(
  '/upload',
  authenticate,
  dmUpload.single('file'),
  sendMessageWithAttachment
);


// Download DM attachment
router.get(
  '/attachments/:messageId',
  authenticate,
  getAttachment
);


// Delete a DM (sender or admin only — checked in controller)
router.delete(
  '/messages/:messageId',
  authenticate,
  deleteMessage
);


// Toggle a reaction on a DM (either participant — checked in controller)
router.post(
  '/messages/:messageId/reactions',
  authenticate,
  toggleReaction
);


module.exports = router;