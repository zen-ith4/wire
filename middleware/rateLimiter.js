const loginAttempts = new Map();

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 20;


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