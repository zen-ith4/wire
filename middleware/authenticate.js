const { getDb } = require('../config/database');
const {
  verifySessionToken,
  verifySessionOrPasswordChangeToken
} = require('../utils/jwt');


function authenticate(req, res, next) {

  const header = req.headers.authorization;

  if (
    !header ||
    !header.startsWith('Bearer ')
  ) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }


  try {

    const token = header.split(' ')[1];

    // BUG FIX: this used to call verifyToken() directly, which only
    // checks the JWT signature/expiry. A short-lived, single-
    // attachment-scoped media token (see utils/jwt.js) is also a
    // validly signed JWT, so it passed straight through here and
    // worked as a full session token on every authenticate-protected
    // route (chat, DMs, settings, admin routes for an admin user) for
    // its ~90 second lifetime — not just the one attachment it was
    // minted for. verifySessionToken() additionally rejects any
    // token whose payload.typ === 'media'.
    const payload = verifySessionToken(token);


    const user = getDb()
      .prepare(`
        SELECT
          id,
          username,
          is_admin,
          is_active,
          bio,
          avatar_path
        FROM users
        WHERE id = ?
      `)
      .get(payload.sub || payload.id);


    if (!user || user.is_active === 0) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }


    req.user = {
      id: user.id,
      username: user.username,
      is_admin: Boolean(user.is_admin)
    };


    next();


  } catch (e) {

    return res.status(401).json({
      error: 'Invalid token'
    });

  }
}



// For the three routes a forced password change needs (GET /me/kdf-params,
// GET /me/identity-key, PUT /me/password): accepts a normal session token or the
// restricted password-change token. Every other route uses authenticate().
function authenticatePasswordChange(req, res, next) {

  const header = req.headers.authorization;

  if (
    !header ||
    !header.startsWith('Bearer ')
  ) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  try {

    const { payload, isPasswordChangeToken } =
      verifySessionOrPasswordChangeToken(
        header.split(' ')[1]
      );

    const user = getDb()
      .prepare(`
        SELECT id, username, is_admin, is_active, must_change_password
        FROM users
        WHERE id = ?
      `)
      .get(payload.sub || payload.id);

    if (!user || user.is_active === 0) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    // A password-change token is only meaningful while a change is pending.
    if (isPasswordChangeToken && !user.must_change_password) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    req.user = {
      id: user.id,
      username: user.username,
      is_admin: Boolean(user.is_admin)
    };

    req.viaPasswordChangeToken = isPasswordChangeToken;

    next();

  } catch (e) {

    return res.status(401).json({
      error: 'Invalid token'
    });

  }
}



function adminOnly(req, res, next) {

  if (
    !req.user ||
    !req.user.is_admin
  ) {
    return res.status(403).json({
      error: 'Admin access required'
    });
  }


  next();
}



module.exports = {
  authenticate,
  authenticatePasswordChange,
  adminOnly
};
