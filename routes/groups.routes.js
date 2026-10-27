const express = require('express');
const { requireGroupProtocol } = require('../middleware/groupProtocol');
const router = express.Router();

const constants = require('../config/constants');
const { authenticate } = require('../middleware/authenticate');
const { mediaAuth } = require('../middleware/mediaAuth');
const { groupAvatarUpload, groupUpload } = require('../config/multer');
const { chatWriteLimiter, uploadLimiter } = require('../middleware/rateLimiter');
const { asyncHandler } = require('../middleware/asyncHandler');

const {
  createGroupHandler,
  listGroupsHandler,
  getUploadLimitsHandler,
  getMembersHandler,
  addMemberHandler,
  removeMemberHandler,
  leaveGroupHandler,
  renameGroupHandler,
  setAvatarHandler,
  getRecentMessagesHandler,
  getMessagesBeforeHandler,
  getMessagesSinceHandler,
  sendMessageHandler,
  deleteMessageHandler,
  toggleGroupReactionHandler,
  submitKdmBatchHandler,
  drainKdmsHandler,
  ackKdmsHandler,
  sendMessageWithAttachmentHandler,
  getAttachmentMediaTokenHandler,
  getAttachmentHandler,
} = require('../controllers/groups.controller');

// Phase 1 ships this entire router behind a feature flag: the
// schema, services and these endpoints exist and are fully
// authorized, but there is nothing user-facing yet (no UI, no nav
// entry, no client-side group crypto) until later phases land. See
// plan_prompt.md Phase 1 and config/constants.js's GROUPS_ENABLED.
// This check stays global (it's a flag gate, not an auth mode) —
// unlike `authenticate` below, it doesn't need to vary per route.
router.use((req, res, next) => {
  if (!constants.GROUPS_ENABLED) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

// authenticate is applied PER ROUTE, not via router.use(authenticate)
// — same reasoning as dm.routes.js: the attachment-download route
// below needs mediaAuth instead (it accepts a short-lived ?token=
// for <video>/<audio>/<img> elements, which can't send Authorization
// headers), and a global router.use(authenticate) would reject that
// request before mediaAuth ever got a chance to run.

// ----- Group management -----

router.post('/', authenticate, createGroupHandler);
router.get('/', authenticate, listGroupsHandler);

// STEP 3E item 1: the configured upload cap, so the client can refuse an
// oversized file before encrypting it (the DM equivalent is
// routes/dm.routes.js:31). It does not depend on a group, so it needs no
// membership; it does take the group protocol gate, like the other group
// message routes, because the client always sends that header for
// /api/groups (public/js/core/api.js:55).
router.get('/limits', authenticate, requireGroupProtocol, getUploadLimitsHandler);

router.get('/:groupId/members', authenticate, getMembersHandler);
router.post('/:groupId/members', authenticate, addMemberHandler);
router.delete('/:groupId/members/:userId', authenticate, removeMemberHandler);
router.post('/:groupId/leave', authenticate, leaveGroupHandler);

router.patch('/:groupId', authenticate, renameGroupHandler);
router.post('/:groupId/avatar', authenticate, uploadLimiter, groupAvatarUpload.single('avatar'), asyncHandler(setAvatarHandler));

// ----- Messages (ciphertext relay only) -----

router.get('/:groupId/messages/recent', authenticate, requireGroupProtocol, getRecentMessagesHandler);
router.get('/:groupId/messages/before', authenticate, requireGroupProtocol, getMessagesBeforeHandler);
router.get('/:groupId/messages/since', authenticate, requireGroupProtocol, getMessagesSinceHandler);

router.post('/:groupId/messages', authenticate, requireGroupProtocol, chatWriteLimiter, sendMessageHandler);
router.delete('/:groupId/messages/:messageId', authenticate, deleteMessageHandler);
router.post('/:groupId/messages/:messageId/reactions', authenticate, toggleGroupReactionHandler);

// ----- Attachments (Phase 4 — always encrypted, see groups.controller.js) -----

router.post(
  '/:groupId/upload',
  authenticate,
  requireGroupProtocol,
  uploadLimiter,
  groupUpload.single('file'),
  asyncHandler(sendMessageWithAttachmentHandler)
);

// Mint a short-lived, attachment-scoped token for <video>/<audio>/
// <img> elements — same pattern as chat/dm's identical route.
router.get(
  '/:groupId/attachments/:messageId/media-token',
  authenticate,
  requireGroupProtocol,
  getAttachmentMediaTokenHandler
);

// IMPORTANT: mediaAuth, not authenticate — <video>/<audio>/<img>
// cannot attach Authorization headers, so this also accepts the
// short-lived ?token= media token minted above.
router.get(
  '/:groupId/attachments/:messageId',
  mediaAuth,
  getAttachmentHandler
);

// ----- Key Distribution Message mailbox -----

router.post('/:groupId/kdms', authenticate, requireGroupProtocol, submitKdmBatchHandler);
router.get('/kdms', authenticate, requireGroupProtocol, drainKdmsHandler);
router.post('/kdms/ack', authenticate, requireGroupProtocol, ackKdmsHandler);

module.exports = router;
