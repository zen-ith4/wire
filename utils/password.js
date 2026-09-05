const bcrypt = require('bcrypt');
const constants = require('../config/constants');

// Async on purpose: bcrypt's async API (unlike bcryptjs's *Sync
// variants, which this file used to call) offloads the actual
// hashing/comparison work to libuv's threadpool instead of running
// it on Node's single JS event-loop thread. A bcrypt compare at 12
// rounds costs a couple hundred ms of CPU either way, but the sync
// version stalls *every* other in-flight request (chat, downloads,
// sockets — anything sharing the event loop) for that whole window;
// the async version keeps the event loop free to keep serving other
// requests while the hash work happens off-thread. See the load-test
// report for the measured before/after difference.
async function hashPassword(password) {

  if (!password || password.length < 6) {
    throw new Error(
      'Password must be at least 6 characters'
    );
  }

  return bcrypt.hash(
    password,
    constants.BCRYPT_ROUNDS || 12
  );
}


async function comparePassword(password, hash) {

  if (!password || !hash) {
    return false;
  }

  // Native `bcrypt`'s compare() understands the standard bcrypt hash
  // format ($2a$/$2b$/$2y$ prefixes) the same way bcryptjs did, so
  // hashes created by the previous bcryptjs-based version of this
  // file (including any $2a$ hashes) still verify correctly here —
  // no migration or rehashing of existing passwords is needed.
  return bcrypt.compare(
    password,
    hash
  );
}


module.exports = {
  hashPassword,
  comparePassword
};
