const { verifySessionToken, verifyMediaToken } = require('../utils/jwt');
const { getDb } = require('../config/database');

/*
 * Media authentication
 *
 * Normal API requests use:
 *   Authorization: Bearer TOKEN
 *
 * Browser media elements (<video>, <audio>, <img>) cannot easily
 * send custom Authorization headers when using src, so media
 * requests may also authenticate using:
 *   ?token=TOKEN
 *
 * SECURITY: the query-string path deliberately does NOT accept the
 * normal 24h session JWT — a token that lives in the URL can end up
 * in browser history or leak via a Referer header for as long as
 * it's valid. Instead it only accepts a short-lived, single-
 * attachment-scoped "media token" (see utils/jwt.js's
 * signMediaToken/verifyMediaToken and the
 * GET .../attachments/:messageId/media-token endpoints), minted just
 * before the <video>/<audio> element is created and useless for
 * anything else within ~90 seconds.
 *
 * The Authorization-header path is unaffected and still accepts the
 * normal session JWT exactly as before — headers are never exposed
 * in the URL, so there's nothing to fix there.
 */

function resourceTypeFromBaseUrl(baseUrl) {
  if (baseUrl.startsWith('/api/dm')) return 'dm';
  if (baseUrl.startsWith('/api/chat')) return 'chat';
  return null;
}

function loadUserAndContinue(userId, req, res, next) {
  const user = getDb()
    .prepare(`
      SELECT
        id,
        username,
        is_admin
      FROM users
      WHERE id = ?
    `)
    .get(userId);

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
}

function mediaAuth(req, res, next) {
  const header = req.headers.authorization;

  try {
    if (header && header.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      // BUG FIX: was verifyToken() here, which doesn't check
      // payload.typ — a leaked media token could be replayed as a
      // full Bearer session token on this path too. Same fix as
      // middleware/authenticate.js: verifySessionToken() rejects
      // typ === 'media'.
      const payload = verifySessionToken(token);
      return loadUserAndContinue(payload.sub || payload.id, req, res, next);
    }

    if (typeof req.query.token === 'string' && req.query.token) {
      const resourceType = resourceTypeFromBaseUrl(req.baseUrl);
      const resourceId = Number(req.params.messageId);

      const payload = verifyMediaToken(req.query.token.trim(), {
        type: resourceType,
        id: resourceId,
      });

      return loadUserAndContinue(payload.sub, req, res, next);
    }
  } catch (err) {
    return res.status(401).json({
      error: 'Invalid token'
    });
  }

  return res.status(401).json({
    error: 'Unauthorized'
  });
}

module.exports = {
  mediaAuth
};
