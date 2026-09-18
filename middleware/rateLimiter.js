const { verifyToken } = require('../utils/jwt');

const loginAttempts = new Map();

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 20;

// Every entry here naturally expires after WINDOW_MS (see the
// `now > entry.resetAt` check below), but expiry alone was never
// enough to bound this Map's size: an entry is only ever *deleted*
// by clearLoginAttempts(), called solely on a *successful* login.
// A failed/abandoned attempt (typo, forgotten password, a scan
// against a username that never logs in) left its entry sitting in
// memory forever — expired and functionally inert, but never
// reclaimed. Over a long-running server this grows without bound,
// one entry per distinct ip:username pair ever attempted.
//
// This sweep runs independently of any individual request and just
// clears out anything whose window has already closed, so the Map's
// size stays bounded by "recently active" attempts rather than "all
// attempts ever". SWEEP_INTERVAL_MS is deliberately coarser than
// WINDOW_MS — there's no correctness requirement to reclaim memory
// the instant an entry expires, only to reclaim it eventually.
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

function sweepExpiredAttempts() {
  const now = Date.now();

  for (const [key, entry] of loginAttempts) {
    if (now > entry.resetAt) {
      loginAttempts.delete(key);
    }
  }
}

const sweepTimer =
  setInterval(
    sweepExpiredAttempts,
    SWEEP_INTERVAL_MS
  );

// Don't let this background sweep keep the process alive by itself
// (e.g. during tests, or a graceful-shutdown path that just stops
// accepting connections and waits for the event loop to drain).
sweepTimer.unref?.();


const registerAttempts = new Map();

const REGISTER_WINDOW_MS =
  15 * 60 * 1000;

const REGISTER_MAX_ATTEMPTS = 5;

function registerRateLimiter(req, res, next) {

  const ip = req.ip;

  const key =
    `register:${ip}`;

  const now =
    Date.now();

  const entry =
    registerAttempts.get(key);


  if (
    !entry ||
    now > entry.resetAt
  ) {

    registerAttempts.set(key, {
      count: 1,
      resetAt:
        now + REGISTER_WINDOW_MS
    });

    return next();
  }


  entry.count++;


  if (
    entry.count >
    REGISTER_MAX_ATTEMPTS
  ) {

    res.set(
      'Retry-After',
      String(
        Math.ceil(
          (entry.resetAt - now) /
            1000
        )
      )
    );

    return res.status(429).json({
      error:
        'Too many registration attempts, please try again later'
    });
  }


  next();
}


const registerSweepTimer =
  setInterval(() => {

    const now =
      Date.now();

    for (
      const [key, entry]
      of registerAttempts
    ) {

      if (
        now > entry.resetAt
      ) {
        registerAttempts.delete(key);
      }
    }

  }, 30 * 60 * 1000);

registerSweepTimer.unref?.();


function loginRateLimiter(
  req,
  res,
  next
) {

  const ip =
    req.ip;

  const username =
    (req.body.username || '')
      .trim()
      .toLowerCase();


  const key =
    `${ip}:${username}`;

  const now =
    Date.now();

  const entry =
    loginAttempts.get(key);


  if (
    !entry ||
    now > entry.resetAt
  ) {

    loginAttempts.set(key, {
      count: 1,
      resetAt:
        now + WINDOW_MS
    });

    return next();
  }


  entry.count++;


  if (
    entry.count >
    MAX_ATTEMPTS
  ) {

    return res.status(429).json({
      error:
        'Too many login attempts'
    });
  }


  next();
}


function clearLoginAttempts(
  ip,
  username
) {

  const key =
    `${ip}:${username.trim().toLowerCase()}`;

  loginAttempts.delete(key);
}


// ---------------------------------------------------------------
// General-purpose rate limiter factory
// ---------------------------------------------------------------
//
// Used for:
//
//   1. A general limiter on all of /api.
//   2. Tighter per-endpoint limiters for expensive writes.
//
// Same fixed-window-per-key shape as loginRateLimiter above.
function createRateLimiter({
  windowMs,
  max,
  keyFn,
  message
}) {

  const hits =
    new Map();


  const sweep = () => {

    const now =
      Date.now();

    for (
      const [key, entry]
      of hits
    ) {

      if (
        now > entry.resetAt
      ) {
        hits.delete(key);
      }
    }
  };


  const timer =
    setInterval(
      sweep,
      Math.max(
        windowMs * 6,
        5 * 60 * 1000
      )
    );

  timer.unref?.();


  return function rateLimiter(
    req,
    res,
    next
  ) {

    const key =
      keyFn(req);

    const now =
      Date.now();

    const entry =
      hits.get(key);


    if (
      !entry ||
      now > entry.resetAt
    ) {

      hits.set(key, {
        count: 1,
        resetAt:
          now + windowMs
      });

      return next();
    }


    entry.count++;


    if (
      entry.count >
      max
    ) {

      // Test-only escape hatch.
      if (
        process.env.LOADTEST_DISABLE_RATE_LIMITS ===
        'true'
      ) {
        return next();
      }


      res.set(
        'Retry-After',
        String(
          Math.ceil(
            (entry.resetAt - now) /
              1000
          )
        )
      );


      return res.status(429).json({
        error:
          message ||
          'Too many requests, please slow down'
      });
    }


    next();
  };
}


if (
  process.env.LOADTEST_DISABLE_RATE_LIMITS ===
  'true'
) {

  console.warn(
    '⚠️  LOADTEST_DISABLE_RATE_LIMITS=true — general/write rate limiting (apiLimiter/chatWriteLimiter/uploadLimiter) is DISABLED. Load-test use only, never set this in production.'
  );
}


// Prefer the authenticated user's id when available,
// falling back to IP.
function userOrIpKey(req) {

  if (req.user?.id) {
    return `u:${req.user.id}`;
  }


  const header =
    req.headers.authorization;


  if (
    header?.startsWith('Bearer ')
  ) {

    try {

      const payload =
        verifyToken(
          header.slice(7)
        );

      const id =
        payload.sub ||
        payload.id;

      if (id) {
        return `u:${id}`;
      }

    } catch {
      // Invalid token: fall through to IP.
    }
  }


  return `ip:${req.ip}`;
}


// General API limiter.
const apiLimiter =
  createRateLimiter({
    windowMs:
      60 * 1000,

    max:
      300,

    keyFn:
      userOrIpKey,

    message:
      'Too many requests, please slow down'
  });


// Chat / DM message sends.
const chatWriteLimiter =
  createRateLimiter({
    windowMs:
      60 * 1000,

    max:
      30,

    keyFn:
      userOrIpKey,

    message:
      'You are sending messages too quickly'
  });


// File uploads.
const uploadLimiter =
  createRateLimiter({
    windowMs:
      60 * 1000,

    max:
      20,

    keyFn:
      userOrIpKey,

    message:
      'Too many uploads, please slow down'
  });


// ---------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------

const verifyEmailRateLimiter =
  createRateLimiter({

    windowMs:
      10 * 60 * 1000,

    max:
      10,

    keyFn: req => {

      const userId =
        String(
          req.body?.userId || ''
        );

      return (
        `verify:${req.ip}:${userId}`
      );
    },

    message:
      'Too many verification attempts, please try again later'
  });


const resendVerificationRateLimiter =
  createRateLimiter({

    windowMs:
      15 * 60 * 1000,

    max:
      3,

    keyFn: req => {

      const userId =
        String(
          req.body?.userId || ''
        );

      return (
        `resend-verification:${req.ip}:${userId}`
      );
    },

    message:
      'Too many verification code requests, please try again later'
  });


// ---------------------------------------------------------------
// Email 2FA verification
// ---------------------------------------------------------------
//
// This is intentionally separate from loginRateLimiter.
//
// loginRateLimiter protects the password-authentication step,
// while this limiter protects the OTP verification endpoint.
//
// The email2fa service itself also enforces a maximum number of
// incorrect OTP attempts per challenge. This limiter adds another
// independent layer against request flooding.
const verifyTwoFactorRateLimiter =
  createRateLimiter({

    windowMs:
      10 * 60 * 1000,

    max:
      10,

    keyFn: req => {

      const userId =
        String(
          req.body?.userId || ''
        );

      return (
        `verify-2fa:${req.ip}:${userId}`
      );
    },

    message:
      'Too many two-factor authentication attempts, please try again later'
  });


module.exports = {
  loginRateLimiter,
  registerRateLimiter,
  verifyEmailRateLimiter,
  resendVerificationRateLimiter,
  verifyTwoFactorRateLimiter,
  clearLoginAttempts,
  apiLimiter,
  chatWriteLimiter,
  uploadLimiter
};