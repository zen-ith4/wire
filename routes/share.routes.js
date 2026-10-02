const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/asyncHandler');
const { shareLinkMediaAuth } = require('../middleware/mediaAuth');
const { shareLinkLimiter } = require('../middleware/rateLimiter');

const {
  getUsers,
  getMyShares,
  createFolder,
  deleteFolder,
  getAccessList,
  grantAccess,
  revokeAccess,
} = require('../controllers/share.controller');

const {
  createLinkHandler,
  listLinksHandler,
  revokeLinkHandler,
  resolveLinkHandler,
  linkMediaTokenHandler,
  streamLinkHandler,
  downloadLinkHandler,
} = require('../controllers/shareLink.controller');


// Users
router.get(
  '/users',
  authenticate,
  getUsers
);


// My shared folders
router.get(
  '/mine',
  authenticate,
  getMyShares
);


// Folder management
router.post(
  '/folders',
  authenticate,
  createFolder
);

router.delete(
  '/folders/:id',
  authenticate,
  deleteFolder
);


// Permissions
router.get(
  '/access/:folderId',
  authenticate,
  getAccessList
);

router.post(
  '/access',
  authenticate,
  grantAccess
);

router.delete(
  '/access',
  authenticate,
  revokeAccess
);


// ---------------------------------------------------------------
// File share links (opaque token, login required — see the security
// note at the top of controllers/shareLink.controller.js)
// ---------------------------------------------------------------

// Owner: create / list / revoke links for one file
router.post(
  '/links',
  authenticate,
  asyncHandler(createLinkHandler)
);

router.get(
  '/links',
  authenticate,
  asyncHandler(listLinksHandler)
);

// Link holder (any signed-in user with the token). The token is sent
// in a JSON body / X-Share-Token header, never in the URL.
router.post(
  '/links/resolve',
  authenticate,
  shareLinkLimiter,
  asyncHandler(resolveLinkHandler)
);

router.post(
  '/links/media-token',
  authenticate,
  shareLinkLimiter,
  asyncHandler(linkMediaTokenHandler)
);

router.get(
  '/links/file',
  authenticate,
  shareLinkLimiter,
  asyncHandler(downloadLinkHandler)
);

router.get(
  '/links/stream/:linkId',
  shareLinkMediaAuth,
  asyncHandler(streamLinkHandler)
);

router.delete(
  '/links/:id',
  authenticate,
  revokeLinkHandler
);


module.exports = router;