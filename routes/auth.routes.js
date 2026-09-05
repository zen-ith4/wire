const express = require('express');
const router = express.Router();

const { login } = require('../controllers/auth.controller');
const { loginRateLimiter } = require('../middleware/rateLimiter');
const { asyncHandler } = require('../middleware/asyncHandler');


router.post(
  '/login',
  loginRateLimiter,
  asyncHandler(login)
);

module.exports = router;