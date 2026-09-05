const fs = require('fs');
const path = require('path');

const { getDb } = require('../config/database');

const {
  listUsers,
  findUserById,
  createUser: createUserService,
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

const { createUserDrive } = require('../services/drive.service');
const { isValidUsername, isValidPassword } = require('../utils/validator');

function listUsersHandler(req, res) {
  res.json(listUsers());
}

async function createUser(req, res) {

  const { username, password, is_admin } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      error: 'Username and password required',
    });
  }

  if (!isValidUsername(username.trim())) {
    return res.status(400).json({
      error: 'Username must be 3-20 characters (letters, numbers, underscore only)',
    });
  }

  if (!isValidPassword(password)) {
    return res.status(400).json({
      error: 'Password must be 6-128 characters',
    });
  }

  try {

    const info = await createUserService(
      username.trim(),
      password,
      !!is_admin
    );

    createUserDrive(getDb(), {
      id: info.lastInsertRowid,
      username,
    });

    res.json({
      id: info.lastInsertRowid,
      username,
      is_admin: !!is_admin,
    });

  } catch (err) {

    if (
      err.code === 'SQLITE_CONSTRAINT' ||
      err.code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      return res.status(409).json({
        error: 'Username already exists',
      });
    }

    console.error(err);

    res.status(500).json({
      error: 'Failed to create user',
    });

  }

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
  deleteUser,
  listFolders,
  createFolder,
  deleteFolder,
  listPermissions,
  grantPermission: grantPermissionHandler,
  revokePermission: revokePermissionHandler,
};