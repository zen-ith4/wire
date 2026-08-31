const fs = require('fs');
const constants = require('../config/constants');

module.exports = function ensureDirectories() {
  [
    constants.USER_DATA_ROOT,
    constants.CHAT_UPLOAD_DIR,
    constants.DM_UPLOAD_DIR,
    constants.AVATAR_DIR,
  ].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });
};