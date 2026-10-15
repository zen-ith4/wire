const express = require('express');
const router = express.Router();

const { authenticate, authenticatePasswordChange } = require('../middleware/authenticate');
const { avatarMediaAuth } = require('../middleware/mediaAuth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { pushTokenLimiter, identityRotateRateLimiter, identityHistoryRateLimiter } = require('../middleware/rateLimiter');

const {
    getIdentityKey,
    saveIdentityKey,
    rotateIdentityKey,
    getIdentityKeyHistory
} = require('../controllers/me.controller');

const {
  avatarUpload,
  bannerUpload
} = require('../config/multer');

const {
  getMe,
  updateBio,
  updateAccentColor,
  changePassword,
  getOwnKdfParams,
  uploadAvatar,
  removeAvatar,
  getAvatar,
  uploadBanner,
  removeBanner,
  getBanner,
  getUserProfile,
  getUserIdentityPublicKey,
  registerPushToken,
  deregisterPushToken,
} = require('../controllers/me.controller');


router.get('/', authenticate, getMe);

router.get('/kdf-params', authenticatePasswordChange, getOwnKdfParams);

router.put('/', authenticate, updateBio);

router.put(
  '/accent-color',
  authenticate,
  updateAccentColor
);

router.put(
  '/password',
  authenticatePasswordChange,
  asyncHandler(changePassword)
);

router.post(
  '/avatar',
  authenticate,
  avatarUpload.single('file'),
  uploadAvatar
);

router.delete(
  '/avatar',
  authenticate,
  removeAvatar
);

// avatarMediaAuth accepts EITHER the normal session Bearer token (the
// logged-in WebView's usual path, unchanged) OR a short-lived,
// single-user-scoped `?token=` (Android's FCM notification image path
// — see middleware/mediaAuth.js and utils/jwt.js's
// signPushAvatarToken). Strictly more permissive than the old
// `authenticate`-only guard in exactly that one narrow, scoped way.
router.get(
  '/avatar/:userId',
  avatarMediaAuth,
  getAvatar
);

router.post(
  '/banner',
  authenticate,
  bannerUpload.single('file'),
  uploadBanner
);

router.delete(
  '/banner',
  authenticate,
  removeBanner
);

router.get(
  '/banner/:userId',
  authenticate,
  getBanner
);

router.get(
    '/identity-key',
    authenticatePasswordChange,
    getIdentityKey
);

router.put(
    '/identity-key',
    authenticate,
    saveIdentityKey
);

router.post(
    '/identity-key/rotate',
    authenticate,
    identityRotateRateLimiter,
    asyncHandler(rotateIdentityKey)
);

router.get(
    '/identity-key/:userId',
    authenticate,
    getUserIdentityPublicKey
);

// The peer's RETIRED identity keys, so a client can still decrypt history that
// predates their last rotation. Deliberately its own literal segment rather than
// a sub-path of identity-key/:userId, so Express cannot fold the two together.
//
// Returns the same 404 for "not your contact", "no such user" and "that user has
// no identity key" - see getIdentityKeyHistory in me.controller.js.
router.get(
    '/identity-key-history/:userId',
    authenticate,
    identityHistoryRateLimiter,
    getIdentityKeyHistory
);

router.post(
    '/push-token',
    authenticate,
    pushTokenLimiter,
    registerPushToken
);

router.delete(
    '/push-token',
    authenticate,
    pushTokenLimiter,
    deregisterPushToken
);

// Generic single-segment pattern must stay last.
router.get(
  '/:userId',
  authenticate,
  getUserProfile
);

module.exports = router;