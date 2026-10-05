const express = require('express');

const router = express.Router();

const {
  getKdfParams,
  login,
  register,
  verifyEmail,
  resendVerification,
  verifyTwoFactor
} = require('../controllers/auth.controller');

const {
  kdfParamsRateLimiter,
  loginRateLimiter,
  registerRateLimiter,
  verifyEmailRateLimiter,
  resendVerificationRateLimiter,
  verifyTwoFactorRateLimiter
} = require('../middleware/rateLimiter');

const {
  asyncHandler
} = require('../middleware/asyncHandler');


router.get(
  '/kdf-params',
  kdfParamsRateLimiter,
  getKdfParams
);


router.post(
  '/login',
  loginRateLimiter,
  asyncHandler(login)
);


router.post(
  '/register',
  registerRateLimiter,
  asyncHandler(register)
);


router.post(
  '/verify-email',
  verifyEmailRateLimiter,
  asyncHandler(verifyEmail)
);


router.post(
  '/resend-verification',
  resendVerificationRateLimiter,
  asyncHandler(resendVerification)
);


router.post(
  '/verify-2fa',
  verifyTwoFactorRateLimiter,
  asyncHandler(verifyTwoFactor)
);

module.exports = router;