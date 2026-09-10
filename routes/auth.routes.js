const express = require('express');

const router = express.Router();

const {
  login,
  register,
  verifyEmail,
  resendVerification,
  verifyTwoFactor
} = require('../controllers/auth.controller');

const {
  loginRateLimiter,
  registerRateLimiter,
  verifyEmailRateLimiter,
  resendVerificationRateLimiter,
  verifyTwoFactorRateLimiter
} = require('../middleware/rateLimiter');

const {
  asyncHandler
} = require('../middleware/asyncHandler');


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