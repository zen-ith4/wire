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

const sweepTimer = setInterval(sweepExpiredAttempts, SWEEP_INTERVAL_MS);
// Don't let this background sweep keep the process alive by itself
// (e.g. during tests, or a graceful-shutdown path that just stops
// accepting connections and waits for the event loop to drain).
sweepTimer.unref?.();

function loginRateLimiter(req, res, next) {

  const ip = req.ip;
  const username =
    (req.body.username || '')
      .trim()
      .toLowerCase();


  const key = `${ip}:${username}`;

  const now = Date.now();

  const entry = loginAttempts.get(key);


  if (!entry || now > entry.resetAt) {

    loginAttempts.set(key, {
      count: 1,
      resetAt: now + WINDOW_MS
    });

    return next();
  }


  entry.count++;


  if (entry.count > MAX_ATTEMPTS) {

    return res.status(429).json({
      error: 'Too many login attempts'
    });

  }


  next();
}


function clearLoginAttempts(ip, username) {

  const key =
    `${ip}:${username.trim().toLowerCase()}`;

  loginAttempts.delete(key);
}


// ---------------------------------------------------------------
// General-purpose rate limiter factory
// ---------------------------------------------------------------
//
// Used for two things the app had no protection for before:
//
//   1. A general limiter on all of /api (generous — its job is to
//      catch runaway/abusive clients, not to throttle normal usage
//      like periodic chat/DM polling).
//   2. Tighter, per-endpoint limiters on the specific write-heavy
//      operations called out in the load-test report: chat sends,
//      DM sends, and file uploads.
//
// Same fixed-window-per-key shape as loginRateLimiter above (a Map
// of key -> {count, resetAt}, with its own periodic sweep so keys
// for inactive users/IPs don't accumulate forever), just
// parameterized so we're not hand-rolling a near-identical limiter
// for every route that needs one.
function createRateLimiter({ windowMs, max, keyFn, message }) {

  const hits = new Map();

  const sweep = () => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) {
        hits.delete(key);
      }
    }
  };

  const timer = setInterval(sweep, Math.max(windowMs * 6, 5 * 60 * 1000));
  timer.unref?.();

  return function rateLimiter(req, res, next) {

    const key = keyFn(req);
    const now = Date.now();

    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      return next();
    }

    entry.count++;

    if (entry.count > max) {

      // Test-only escape hatch — NOT a production configuration
      // knob. It exists solely so the load-test harness can measure
      // raw endpoint capacity (e.g. isolating the bcrypt-async fix's
      // impact from this rate limiter's own effect) without every
      // metric being dominated by the fact that a load-test harness
      // necessarily hammers the server from a single source IP/user
      // set — exactly the pattern this limiter exists to catch.
      // Rate limiting is ON by default and stays on in any real
      // deployment; this only flips off when a human/CI process
      // explicitly sets the env var (see the startup warning below).
      if (process.env.LOADTEST_DISABLE_RATE_LIMITS === 'true') {
        return next();
      }

      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({
        error: message || 'Too many requests, please slow down'
      });
    }

    next();
  };
}

if (process.env.LOADTEST_DISABLE_RATE_LIMITS === 'true') {
  console.warn('⚠️  LOADTEST_DISABLE_RATE_LIMITS=true — general/write rate limiting (apiLimiter/chatWriteLimiter/uploadLimiter) is DISABLED. Load-test use only, never set this in production.');
}

// Prefer the authenticated user's id when we can determine one,
// falling back to IP. `apiLimiter` below is mounted globally, ahead
// of each route's own `authenticate` middleware, specifically so it
// also catches pre-auth abuse (garbage/missing tokens hammering the
// API) — but that means `req.user` isn't set yet at that point. To
// still key fairly per-user (rather than accidentally bucketing
// every user behind the same IP together — plausible here, since
// this app's whole access model is a shared WireGuard subnet), this
// does its own best-effort, side-effect-free JWT decode purely for
// bucketing. It never enforces anything and any failure just falls
// back to IP — the real auth decision is still made solely by
// `authenticate` in each route, unchanged.
function userOrIpKey(req) {
  if (req.user?.id) {
    return `u:${req.user.id}`;
  }

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(header.slice(7));
      const id = payload.sub || payload.id;
      if (id) return `u:${id}`;
    } catch {
      // not a valid token — fall through to IP-keying below
    }
  }

  return `ip:${req.ip}`;
}

// General API limiter: generous on purpose. It exists to stop a
// runaway loop or scripted abuse, not to interfere with normal
// polling (chat "since" polling, presence, notification checks,
// etc). 300 requests/minute per user (or IP) is ~5 req/s sustained —
// far above what a real client needs but well short of what a tight
// request loop would produce.
const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 300,
  keyFn: userOrIpKey,
  message: 'Too many requests, please slow down'
});

// Chat / DM message sends: expensive relative to a read (DB write +
// WAL flush + Socket.IO broadcast fan-out to every connected
// client). 30/minute per user is one message every two seconds on
// average with room for a burst of fast replies — comfortable for a
// human typing, tight enough to blunt a spam/broadcast-flood script.
const chatWriteLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: userOrIpKey,
  message: 'You are sending messages too quickly'
});

// File uploads: disk I/O + multer parsing make these the heaviest
// per-request cost in the app. 20/minute per user still comfortably
// covers dragging in a batch of files.
const uploadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: userOrIpKey,
  message: 'Too many uploads, please slow down'
});


module.exports = {
  loginRateLimiter,
  clearLoginAttempts,
  apiLimiter,
  chatWriteLimiter,
  uploadLimiter
};