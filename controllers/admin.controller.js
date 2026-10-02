const fs = require('fs');
const path = require('path');

const {
  listUsers,
  findUserById,
  createUser: createUserService,
  setUserAdmin: setUserAdminService,
  deleteUser: deleteUserService,
} = require('../services/user.service');

const {
  listAllFolders,
  findFolderById,
  createFolder: createFolderService,
  deleteFolder: deleteFolderService,
} = require('../services/file.service');

const {
  listAllPermissions,
  grantPermission,
  revokePermission,
} = require('../services/share.service');

function listUsersHandler(req, res) {
  res.json(listUsers());
}

// Maps the `code` of an error thrown by createUser() (user.service.js)
// to an HTTP status, the same way auth.controller.js does for register.
// Their messages are written for the client, so they are returned as-is.
const CREATE_USER_ERROR_STATUS = new Map([
  ['INVALID_USERNAME', 400],
  ['INVALID_EMAIL', 400],
  ['INVALID_PASSWORD', 400],
  ['INVALID_IS_ADMIN', 400],
  ['USERNAME_EXISTS', 409],
  ['EMAIL_EXISTS', 409],
]);

async function createUser(req, res) {

  // Field validation and normalization live in createUser() itself.
  const {
    username,
    email,
    password,
    is_admin,
  } = req.body || {};

  try {

    const user =
      await createUserService(
        username,
        email,
        password,
        is_admin
      );

    return res.status(201).json(user);

  } catch (err) {

    const status =
      CREATE_USER_ERROR_STATUS.get(err.code);

    if (status) {
      return res.status(status).json({
        error: err.message,
      });
    }

    console.error(err);

    res.status(500).json({
      error: 'Failed to create user',
    });

  }

}

function setUserAdmin(req, res) {

  // Strict positive-integer id: Number() alone would also accept
  // things like "0x10", "1e2" or " 5 ".
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({
      error: 'Invalid user id',
    });
  }

  const userId = Number(req.params.id);

  if (!Number.isSafeInteger(userId)) {
    return res.status(400).json({
      error: 'Invalid user id',
    });
  }

  const { is_admin } = req.body || {};

  // Strictly a boolean: "true", 1, "yes", null, etc. are rejected
  // so a malformed client can never flip a role by accident.
  if (typeof is_admin !== 'boolean') {
    return res.status(400).json({
      error: 'is_admin must be a boolean',
    });
  }

  // An admin can never remove their own admin rights. Combined with
  // the fact that this route is only reachable by an admin, this
  // guarantees at least one admin (the caller) always remains.
  if (userId === req.user.id && !is_admin) {
    return res.status(400).json({
      error: "You can't remove your own admin privileges",
    });
  }

  const user = findUserById(userId);

  if (!user) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  setUserAdminService(userId, is_admin);

  res.json({
    success: true,
    id: userId,
    is_admin,
  });

}

function deleteUser(req, res) {

  const userId = Number(req.params.id);

  if (!Number.isInteger(userId)) {
    return res.status(400).json({
      error: 'Invalid user id',
    });
  }

  if (userId === req.user.id) {
    return res.status(400).json({
      error: "You can't delete your own account",
    });
  }

  const user = findUserById(userId);

  if (!user) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  deleteUserService(userId);

  res.json({
    success: true,
  });

}

function listFolders(req, res) {
  res.json(listAllFolders());
}

function createFolder(req, res) {

  const {
    path: folderPath,
    display_name,
  } = req.body || {};

  if (!folderPath) {
    return res.status(400).json({
      error: 'Path required',
    });
  }

  const absolutePath =
    path.resolve(folderPath);

  if (!fs.existsSync(absolutePath)) {
    return res.status(400).json({
      error: 'Folder does not exist',
    });
  }

  if (!fs.statSync(absolutePath).isDirectory()) {
    return res.status(400).json({
      error: 'Not a directory',
    });
  }

  try {

    const info =
      createFolderService(
        absolutePath,
        display_name || path.basename(absolutePath)
      );

    res.json({
      id: info.lastInsertRowid,
      path: absolutePath,
      display_name:
        display_name || path.basename(absolutePath),
    });

  } catch (err) {

    if (
      err.code === 'SQLITE_CONSTRAINT' ||
      err.code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      return res.status(409).json({
        error: 'Folder already exists',
      });
    }

    console.error(err);

    res.status(500).json({
      error: 'Failed to create folder',
    });

  }

}

function deleteFolder(req, res) {

  const folderId =
    Number(req.params.id);

  if (!Number.isInteger(folderId)) {
    return res.status(400).json({
      error: 'Invalid folder id',
    });
  }

  const folder =
    findFolderById(folderId);

  if (!folder) {
    return res.status(404).json({
      error: 'Folder not found',
    });
  }

  deleteFolderService(folderId);

  res.json({
    success: true,
  });

}

function listPermissions(req, res) {
  res.json(
    listAllPermissions()
  );
}

function grantPermissionHandler(req, res) {

  const userId =
    Number(req.body.user_id);

  const folderId =
    Number(req.body.folder_id);

  const canWrite =
    !!req.body.can_write;

  if (
    !Number.isInteger(userId) ||
    !Number.isInteger(folderId)
  ) {
    return res.status(400).json({
      error: 'Invalid request',
    });
  }

  if (!findUserById(userId)) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  if (!findFolderById(folderId)) {
    return res.status(404).json({
      error: 'Folder not found',
    });
  }

  grantPermission(
    userId,
    folderId,
    canWrite
  );

  res.json({
    success: true,
  });

}

function revokePermissionHandler(req, res) {

  const userId =
    Number(req.body.user_id);

  const folderId =
    Number(req.body.folder_id);

  if (
    !Number.isInteger(userId) ||
    !Number.isInteger(folderId)
  ) {
    return res.status(400).json({
      error: 'Invalid request',
    });
  }

  revokePermission(
    userId,
    folderId
  );

  res.json({
    success: true,
  });

}

module.exports = {
  listUsers: listUsersHandler,
  createUser,
  setUserAdmin,
  deleteUser,
  listFolders,
  createFolder,
  deleteFolder,
  listPermissions,
  grantPermission: grantPermissionHandler,
  revokePermission: revokePermissionHandler,
};