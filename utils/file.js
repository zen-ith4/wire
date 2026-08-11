const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

function getMimeType(filePath) {
  return mime.lookup(filePath) || 'application/octet-stream';
}

/**
 * Moves a file the safe way: fs.rename()/renameSync() only works
 * when source and destination are on the same filesystem/mount —
 * across mounts it throws EXDEV instead of doing the copy for you.
 * Uploads land in the OS temp dir first (see config/multer.js's
 * `fileUpload`), and the Drive folder they're moved into can be any
 * admin/user-configured path — very possibly a different mount
 * (a separate volume, a NAS mount, a Docker bind mount, etc.), so
 * this can't be assumed away. Falls back to copy+delete in that case.
 */
function moveFileSafe(sourcePath, destPath) {
  try {
    fs.renameSync(sourcePath, destPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(sourcePath, destPath);
      fs.unlinkSync(sourcePath);
      return;
    }
    throw err;
  }
}

module.exports = {
  getMimeType,
  moveFileSafe
};