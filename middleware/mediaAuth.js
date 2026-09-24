const {
  verifySessionToken,
  verifyMediaToken,
  verifyFileMediaToken,
} = require('../utils/jwt');
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

/*
 * ------------------------------------------------------------------
 * Avatar media (GET /api/me/avatar/:userId)
 * ------------------------------------------------------------------
 *
 * Two legitimate callers:
 *
 *   1. The logged-in WebView (public/js/ui/avatar.js's getAvatarUrl())
 *      — sends the normal Authorization: Bearer <session token>,
 *      exactly like every other authenticated request. Unaffected by
 *      this change.
 *
 *   2. Android's FCM notification image (services/push.service.js) —
 *      the image is fetched by Google's/Android's own infrastructure,
 *      not by app code, so there is no way to attach an Authorization
 *      header, and the user's session token must never be put in an
 *      FCM payload. Instead it uses a short-lived, single-user-scoped
 *      `?token=` minted server-side by signPushAvatarToken()
 *      (utils/jwt.js) at DM-send time.
 *
 * Same shape as mediaAuth() below, just scoped to resType 'avatar'
 * with id = the requested :userId instead of a chat/DM message id.
 */
function avatarMediaAuth(req, res, next) {
  const header = req.headers.authorization;

  try {
    if (header && header.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      const payload = verifySessionToken(token);
      return loadUserAndContinue(payload.sub || payload.id, req, res, next);
    }

    if (typeof req.query.token === 'string' && req.query.token) {
      const payload = verifyMediaToken(req.query.token.trim(), {
        type: 'avatar',
        id: Number(req.params.userId),
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

/*
 * ------------------------------------------------------------------
 * My Files media (image/video/audio preview) and share-link media
 * ------------------------------------------------------------------
 *
 * Same model as above — a <video>/<audio>/<img> can't send an
 * Authorization header, so it authenticates with a short-lived,
 * single-resource `?token=` — but scoped to a file instead of a
 * chat/DM message id (see signFileMediaToken in utils/jwt.js):
 *
 *   folderFileMediaAuth   /api/files/stream/:folderId?subpath&file&token
 *                         token bound to (folderId, subpath, file)
 *   shareLinkMediaAuth    /api/share/links/stream/:linkId?token
 *                         token bound to the link id
 *
 * Unlike loadUserAndContinue() above these also refuse deactivated
 * accounts, matching middleware/authenticate.js. Neither middleware
 * grants any access by itself: controllers still check folder
 * permissions / link validity on EVERY request, so revoking access
 * takes effect immediately, not when the token expires.
 */

function loadActiveUser(userId) {
  const user = getDb()
    .prepare(`
      SELECT
        id,
        username,
        is_admin,
        is_active
      FROM users
      WHERE id = ?
    `)
    .get(userId);

  if (!user || user.is_active === 0) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    is_admin: Boolean(user.is_admin)
  };
}

function queryString(value) {
  return typeof value === 'string' ? value : '';
}

function folderFileMediaAuth(req, res, next) {
  const header = req.headers.authorization;

  try {
    let user = null;

    if (header && header.startsWith('Bearer ')) {
      const payload = verifySessionToken(header.slice(7).trim());
      user = loadActiveUser(payload.sub || payload.id);

    } else if (typeof req.query.token === 'string' && req.query.token) {
      const payload = verifyFileMediaToken(req.query.token.trim(), {
        type: 'file',
        id: Number(req.params.folderId),
        sp: queryString(req.query.subpath),
        f: queryString(req.query.file),
      });

      user = loadActiveUser(payload.sub);

    } else {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    req.user = user;
    return next();

  } catch (err) {
    return res.status(401).json({
      error: 'Invalid token'
    });
  }
}

function shareLinkMediaAuth(req, res, next) {
  try {
    if (typeof req.query.token !== 'string' || !req.query.token) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    const payload = verifyFileMediaToken(req.query.token.trim(), {
      type: 'sharelink',
      id: Number(req.params.linkId),
    });

    const user = loadActiveUser(payload.sub);

    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    req.user = user;
    return next();

  } catch (err) {
    return res.status(401).json({
      error: 'Invalid token'
    });
  }
}

module.exports = {
  mediaAuth,
  avatarMediaAuth,
  folderFileMediaAuth,
  shareLinkMediaAuth
};

