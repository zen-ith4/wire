const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { chatUpload } = require('../config/multer');

const {
  getRecentMessages,
  getMessagesBefore,
  getMessagesSince,
  sendMessage,
  sendMessageWithAttachment,
  getAttachment,
  deleteMessage,
  toggleReaction,
} = require('../controllers/chat.controller');


// Get latest chat messages
router.get(
  '/messages/recent',
  authenticate,
  getRecentMessages
);


// Get messages before a specific message
router.get(
  '/messages/before',
  authenticate,
  getMessagesBefore
);


// Get messages since timestamp/id
router.get(
  '/messages',
  authenticate,
  getMessagesSince
);


// Send text message
router.post(
  '/messages',
  authenticate,
  sendMessage
);


// Send message with attachment
router.post(
  '/upload',
  authenticate,
  chatUpload.single('file'),
  sendMessageWithAttachment
);


// Download message attachment
router.get(
  '/attachments/:messageId',
  authenticate,
  getAttachment
);


// Delete a message (sender or admin only — checked in controller)
router.delete(
  '/messages/:messageId',
  authenticate,
  deleteMessage
);


// Toggle a reaction on a message (add if not present, remove if it is)
router.post(
  '/messages/:messageId/reactions',
  authenticate,
  toggleReaction
);


module.exports = router;