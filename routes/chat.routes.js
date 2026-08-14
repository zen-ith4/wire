const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { mediaAuth } = require('../middleware/mediaAuth');
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



// Download / stream message attachment
//
// IMPORTANT:
// This uses mediaAuth instead of authenticate because
// <video src=""> cannot send Authorization headers.
router.get(
  '/attachments/:messageId',
  mediaAuth,
  getAttachment
);



// Delete a message
router.delete(
  '/messages/:messageId',
  authenticate,
  deleteMessage
);



// Toggle reaction
router.post(
  '/messages/:messageId/reactions',
  authenticate,
  toggleReaction
);



module.exports = router;