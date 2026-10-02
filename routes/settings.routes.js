const express = require('express');

const router = express.Router();

const {
  authenticate
} = require('../middleware/authenticate');

const {
  asyncHandler
} = require('../middleware/asyncHandler');

const {
  getSecurity,
  enableEmail2FA,
  verifyEmail2FA,
  disableEmail2FA,
  getPrivacy,
  updatePrivacy
} = require('../controllers/settings.controller');


router.get(
  '/security',
  authenticate,
  asyncHandler(getSecurity)
);


router.get(
  '/privacy',
  authenticate,
  asyncHandler(getPrivacy)
);


router.put(
  '/privacy',
  authenticate,
  asyncHandler(updatePrivacy)
);


router.post(
  '/2fa/email/enable',
  authenticate,
  asyncHandler(enableEmail2FA)
);


router.post(
  '/2fa/email/verify',
  authenticate,
  asyncHandler(verifyEmail2FA)
);


router.post(
  '/2fa/email/disable',
  authenticate,
  asyncHandler(disableEmail2FA)
);


module.exports = router;