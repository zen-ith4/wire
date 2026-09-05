const { getDb } = require('../config/database');
const { comparePassword } = require('../utils/password');
const { signToken } = require('../utils/jwt');

async function authenticateUser(username, password) {

  const db = getDb();

  username = username.trim().toLowerCase();

  const user = db.prepare(`
    SELECT
      id,
      username,
      password_hash,
      is_admin,
      is_active
    FROM users
    WHERE username = ?
  `).get(username);


  if (!user) {
    return null;
  }


  if (user.is_active === 0) {
    return null;
  }


  if (!(await comparePassword(password, user.password_hash))) {
    return null;
  }


  return {
    id: user.id,
    username: user.username,
    is_admin: Boolean(user.is_admin),
    token: signToken({
      id: user.id,
      username: user.username,
      is_admin: Boolean(user.is_admin)
    })
  };
}


module.exports = {
  authenticateUser
};