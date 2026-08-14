const { verifyToken } = require('../utils/jwt');
const { getDb } = require('../config/database');

/*
 * Media authentication
 *
 * Normal API requests use:
 *   Authorization: Bearer TOKEN
 *
 * Browser media elements (<video>, <audio>, <img>) cannot
 * easily send custom Authorization headers when using src.
 *
 * Therefore media requests may also authenticate using:
 *   ?token=TOKEN
 *
 * The token is still verified using the exact same JWT system.
 */

function mediaAuth(req, res, next) {
  let token = null;

  // Normal Authorization header
  const header = req.headers.authorization;

  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7).trim();
  }

  // Media element fallback:
  // /api/chat/attachments/11?token=...
  if (!token && typeof req.query.token === 'string') {
    token = req.query.token.trim();
  }

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  try {
    const payload = verifyToken(token);

    const user = getDb()
      .prepare(`
        SELECT
          id,
          username,
          is_admin
        FROM users
        WHERE id = ?
      `)
      .get(payload.sub || payload.id);

    if (!user) {
      return res.status(401).json({
        error: 'User not found'
      });
    }

    req.user = {
      id: user.id,
      username: user.username,
      is_admin: Boolean(user.is_admin)
    };

    next();

  } catch (err) {
    return res.status(401).json({
      error: 'Invalid token'
    });
  }
}

module.exports = {
  mediaAuth
};