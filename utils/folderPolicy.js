// utils/folderPolicy.js
//
// Decides which directories may be shared as folders. The admin can add a
// folder by path, so without a policy the admin could expose /etc, the app's
// own source and secrets, or the database. Rules:
//
//   1. The REAL path (symlinks resolved) must be inside an allowed root
//      (constants.ALLOWED_FOLDER_ROOTS, default USER_DATA_ROOT).
//   2. It must not be inside a system directory (/etc, /proc, /sys, /root,
//      /boot, /dev).
//   3. It must not contain the app directory or the database directory
//      (a folder above them would expose source, .env and data.db).
//   4. No segment of the real path may start with ".env" (any env file).
//
// The check runs when a folder is created AND on every later read of a
// stored folder (safePath.js and share deletion call isStoredFolderAllowed),
// so a folder row written before a policy change, or a symlink swapped in
// later, cannot be used.

const fs = require('fs');
const path = require('path');

const constants = require('../config/constants');

const APP_DIR = path.resolve(__dirname, '..');
const SYSTEM_DIRS = ['/etc', '/proc', '/sys', '/root', '/boot', '/dev'];

// realpath, or null when the path does not exist.
function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// True when child equals parent or lies below it (both real paths).
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

function allowedRealRoots() {
  return constants.ALLOWED_FOLDER_ROOTS
    .map(realpathOrNull)
    .filter(Boolean);
}

function deniedRealPaths() {
  const denied = [];

  for (const dir of SYSTEM_DIRS) {
    const real = realpathOrNull(dir);
    if (real) denied.push({ path: real, reason: 'system' });
  }

  const realApp = realpathOrNull(APP_DIR);
  if (realApp) denied.push({ path: realApp, reason: 'app' });

  const dbDir = realpathOrNull(path.dirname(path.resolve(constants.DB_PATH)));
  if (dbDir) denied.push({ path: dbDir, reason: 'database' });

  return denied;
}

// Validates a real (symlink-resolved) directory path.
// Returns { ok: true } or { ok: false, reason }.
function checkRealPath(realPath) {
  for (const { path: deny, reason } of deniedRealPaths()) {
    if (reason === 'system') {
      if (isInside(realPath, deny)) return { ok: false, reason };
    } else {
      // The folder must not CONTAIN the app or database directory.
      if (isInside(deny, realPath)) return { ok: false, reason };
    }
  }

  if (realPath.split(path.sep).some(seg => seg.startsWith('.env'))) {
    return { ok: false, reason: 'env' };
  }

  const roots = allowedRealRoots();

  if (!roots.some(root => isInside(realPath, root))) {
    return { ok: false, reason: 'outside_allowed_roots' };
  }

  return { ok: true };
}

// Used when an admin adds a folder. Returns { ok: true, realPath } or
// { ok: false, code, message }. `code` is 'missing', 'not_dir' or 'forbidden'.
function validateNewFolderPath(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath || inputPath.includes('\0')) {
    return { ok: false, code: 'forbidden', message: 'Invalid folder path' };
  }

  const resolved = path.resolve(inputPath);
  const real = realpathOrNull(resolved);

  if (!real) {
    return { ok: false, code: 'missing', message: 'Folder does not exist' };
  }

  if (!fs.statSync(real).isDirectory()) {
    return { ok: false, code: 'not_dir', message: 'Not a directory' };
  }

  const check = checkRealPath(real);

  if (!check.ok) {
    return {
      ok: false,
      code: 'forbidden',
      message: 'This folder is outside the allowed locations',
    };
  }

  return { ok: true, realPath: real };
}

// Used on every read of a stored folder. True only if the folder still
// passes the policy right now (the symlink, if any, is resolved again).
function isStoredFolderAllowed(storedPath) {
  if (typeof storedPath !== 'string' || !storedPath) return false;

  const real = realpathOrNull(path.resolve(storedPath));
  if (!real) return false;

  return checkRealPath(real).ok;
}

module.exports = {
  validateNewFolderPath,
  isStoredFolderAllowed,
};
