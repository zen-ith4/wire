const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { avatarMediaAuth } = require('../middleware/mediaAuth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { pushTokenLimiter } = require('../middleware/rateLimiter');

const {
    getIdentityKey,
    saveIdentityKey
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

router.put('/', authenticate, updateBio);

router.put(
  '/accent-color',
  authenticate,
  updateAccentColor
);

router.put(
  '/password',
  authenticate,
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

// avatarMediaAuth accepts EITHER the normal session Bearer token
// (the logged-in WebView's usual path) OR a short-lived, single-user
// -scoped `?token=` (the native Android push path — see
// middleware/mediaAuth.js and utils/jwt.js's signPushAvatarToken).
// Strictly more permissive than the old `authenticate`-only guard in
// exactly one narrow, scoped way — it never grants access to
// anything beyond this one user's avatar.
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
    authenticate,
    getIdentityKey
);

router.put(
    '/identity-key',
    authenticate,
    saveIdentityKey
);

router.get(
    '/identity-key/:userId',
    authenticate,
    getUserIdentityPublicKey
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