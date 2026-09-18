const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { mediaAuth } = require('../middleware/mediaAuth');
const { chatUpload } = require('../config/multer');
const { chatWriteLimiter, uploadLimiter } = require('../middleware/rateLimiter');
const { asyncHandler } = require('../middleware/asyncHandler');

const {
  getRecentMessages,
  getMessagesBefore,
  getMessagesSince,
  sendMessage,
  sendMessageWithAttachment,
  getAttachmentMediaToken,
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
  chatWriteLimiter,
  sendMessage
);



// Send message with attachment
router.post(
  '/upload',
  authenticate,
  uploadLimiter,
  chatUpload.single('file'),
  asyncHandler(sendMessageWithAttachment)
);



// Mint a short-lived, attachment-scoped token for <video>/<audio>
// elements to use in the `?token=` query string (see
// middleware/mediaAuth.js) — issued over a normal authenticated
// (Authorization header) request, so the long-lived session JWT
// itself never has to appear in a URL.
router.get(
  '/attachments/:messageId/media-token',
  authenticate,
  getAttachmentMediaToken
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