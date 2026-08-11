const fs = require('fs');
const path = require('path');

const constants = require('../config/constants');

const {
  findUserById,
  listUsersExcept,
} = require('../services/user.service');

const {
  findFolderById,
  deleteFolder,
  listOwnedFolders,
  createFolder,
} = require('../services/file.service');

const {
  grantPermission,
  revokePermission,
  getFolderPermissions,
  getSharedCount,
} = require('../services/share.service');

const { isValidFolderName } = require('../utils/validator');

function getUsers(req, res) {
  res.json(listUsersExcept(req.user.id));
}

function getMyShares(req, res) {
  const folders = listOwnedFolders(req.user.id);

  res.json(
    folders.map(folder => ({
      ...folder,
      shared_with_count: getSharedCount(folder.id, req.user.id),
    }))
  );
}

function createFolderHandler(req, res) {
  const { name } = req.body || {};

  if (!name || !isValidFolderName(name)) {
    return res.status(400).json({
      error: 'Invalid folder name',
    });
  }

  const folderName = name.trim().replace(/\s+/g, ' ');

  const baseDir = path.resolve(
    constants.USER_DATA_ROOT,
    String(req.user.id)
  );

  const folderPath = path.resolve(
    baseDir,
    folderName
  );

  if (!folderPath.startsWith(baseDir + path.sep)) {
    return res.status(400).json({
      error: 'Invalid folder path',
    });
  }

  if (fs.existsSync(folderPath)) {
    return res.status(409).json({
      error: 'Folder already exists',
    });
  }

  try {
    fs.mkdirSync(folderPath, {
      recursive: true,
    });

    const info = createFolder(
      folderPath,
      folderName,
      req.user.id
    );

    grantPermission(
      req.user.id,
      info.lastInsertRowid,
      true
    );

    res.json({
      id: info.lastInsertRowid,
      display_name: folderName,
      path: folderPath,
    });

  } catch (err) {

    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, {
        recursive: true,
        force: true,
      });
    }

    console.error(err);

    res.status(500).json({
      error: 'Failed to create folder',
    });
  }
}

function deleteFolderHandler(req, res) {

  const folderId = Number(req.params.id);

  if (!Number.isInteger(folderId)) {
    return res.status(400).json({
      error: 'Invalid folder id',
    });
  }

  const folder = findFolderById(folderId);

  if (!folder || folder.owner_id !== req.user.id) {
    return res.status(403).json({
      error: 'Not your folder',
    });
  }

  if (fs.existsSync(folder.path)) {
    fs.rmSync(folder.path, {
      recursive: true,
      force: true,
    });
  }

  deleteFolder(folderId);

  res.json({
    success: true,
  });
}

function getAccessList(req, res) {

  const folderId = Number(req.params.folderId);

  if (!Number.isInteger(folderId)) {
    return res.status(400).json({
      error: 'Invalid folder id',
    });
  }

  const folder = findFolderById(folderId);

  if (!folder || folder.owner_id !== req.user.id) {
    return res.status(403).json({
      error: 'Not your folder',
    });
  }

  res.json(
    getFolderPermissions(
      folderId,
      req.user.id
    )
  );
}

function grantAccess(req, res) {

  const folderId = Number(req.body.folder_id);
  const targetUserId = Number(req.body.target_user_id);
  const canWrite = !!req.body.can_write;

  if (
    !Number.isInteger(folderId) ||
    !Number.isInteger(targetUserId)
  ) {
    return res.status(400).json({
      error: 'Invalid request',
    });
  }

  const folder = findFolderById(folderId);

  if (!folder || folder.owner_id !== req.user.id) {
    return res.status(403).json({
      error: 'Not your folder',
    });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({
      error: 'Owner already has access',
    });
  }

  const target = findUserById(targetUserId);

  if (!target) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  grantPermission(
    targetUserId,
    folderId,
    canWrite
  );

  res.json({
    success: true,
  });
}

function revokeAccess(req, res) {

  const folderId = Number(req.body.folder_id);
  const targetUserId = Number(req.body.target_user_id);

  if (
    !Number.isInteger(folderId) ||
    !Number.isInteger(targetUserId)
  ) {
    return res.status(400).json({
      error: 'Invalid request',
    });
  }

  const folder = findFolderById(folderId);

  if (!folder || folder.owner_id !== req.user.id) {
    return res.status(403).json({
      error: 'Not your folder',
    });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({
      error: 'Owner access cannot be removed',
    });
  }

  revokePermission(
    targetUserId,
    folderId
  );

  res.json({
    success: true,
  });
}

module.exports = {
  getUsers,
  getMyShares,
  createFolder: createFolderHandler,
  deleteFolder: deleteFolderHandler,
  getAccessList,
  grantAccess,
  revokeAccess,
};