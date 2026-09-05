const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { asyncHandler } = require('../middleware/asyncHandler');
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

router.get(
  '/avatar/:userId',
  authenticate,
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


// Generic single-segment pattern must stay last.
router.get(
  '/:userId',
  authenticate,
  getUserProfile
);


module.exports = router;