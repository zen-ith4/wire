const express = require('express');

const router = express.Router();

const {
  login,
  register,
  verifyEmail,
  resendVerification,
  verifyTwoFactor,
  getKdfParams,
  migrateCredentials
} = require('../controllers/auth.controller');

const {
  loginRateLimiter,
  registerRateLimiter,
  verifyEmailRateLimiter,
  resendVerificationRateLimiter,
  verifyTwoFactorRateLimiter,
  kdfParamsRateLimiter,
  migrateCredentialsRateLimiter
} = require('../middleware/rateLimiter');

const {
  authenticate
} = require('../middleware/authenticate');

const {
  asyncHandler
} = require('../middleware/asyncHandler');


router.get(
  '/kdf-params',
  kdfParamsRateLimiter,
  getKdfParams
);


router.post(
  '/migrate-credentials',
  migrateCredentialsRateLimiter,
  authenticate,
  asyncHandler(migrateCredentials)
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