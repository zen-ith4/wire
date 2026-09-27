const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { mediaAuth } = require('../middleware/mediaAuth');
const { dmUpload } = require('../config/multer');
const { chatWriteLimiter, uploadLimiter } = require('../middleware/rateLimiter');
const { asyncHandler } = require('../middleware/asyncHandler');

const {
  getConversations,
  getUnreadCount,
  getRecentMessages,
  getMessagesBefore,
  getMessagesSince,
  sendMessage,
  sendMessageWithAttachment,
  getAttachmentMediaToken,
  getAttachment,
  editMessage,
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
  chatWriteLimiter,
  sendMessage
);



// Send DM with file
router.post(
  '/upload',
  authenticate,
  uploadLimiter,
  dmUpload.single('file'),
  asyncHandler(sendMessageWithAttachment)
);



// Mint a short-lived, attachment-scoped token for <video>/<audio>
// elements — see the identical route in chat.routes.js.
router.get(
  '/attachments/:messageId/media-token',
  authenticate,
  getAttachmentMediaToken
);



// Download / stream DM attachment
//
// IMPORTANT:
// <video> and <audio> need mediaAuth because they cannot
// attach Authorization headers themselves.
router.get(
  '/attachments/:messageId',
  mediaAuth,
  getAttachment
);



// Edit a DM (text messages only — see dm.controller.js)
router.patch(
  '/messages/:messageId',
  authenticate,
  chatWriteLimiter,
  editMessage
);



// Delete a DM
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