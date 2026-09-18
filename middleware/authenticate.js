const { getDb } = require('../config/database');
const { verifyToken } = require('../utils/jwt');


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

    const payload = verifyToken(token);


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
  adminOnly
};
