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


module.exports = {
  loginRateLimiter,
  clearLoginAttempts
};