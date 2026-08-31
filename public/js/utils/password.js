const bcrypt = require('bcryptjs');
const constants = require('../config/constants');

function hashPassword(password) {

  if (!password || password.length < 6) {
    throw new Error(
      'Password must be at least 6 characters'
    );
  }

  return bcrypt.hashSync(
    password,
    constants.BCRYPT_ROUNDS || 12
  );
}


function comparePassword(password, hash) {

  if (!password || !hash) {
    return false;
  }

  return bcrypt.compareSync(
    password,
    hash
  );
}


module.exports = {
  hashPassword,
  comparePassword
};