const jwt = require('jsonwebtoken');
const constants = require('../config/constants');

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      is_admin: !!user.is_admin,
    },
    constants.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, constants.JWT_SECRET);
}

module.exports = { signToken, verifyToken };