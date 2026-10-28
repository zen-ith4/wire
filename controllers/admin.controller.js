const path = require('path');

const { validateNewFolderPath } = require('../utils/folderPolicy');

const {
  listUsers,
  findUserById,
  findActiveUserById,
  findUserWithPassword,
  createUser: createUserService,
  transferAdmin,
  deleteUser: deleteUserService,
} = require('../services/user.service');

const { comparePassword } = require('../utils/password');
const { recordAdminAction, listAdminAudit } = require('../services/adminAudit.service');
const { isValidAuthKey } = require('../utils/credentials');
const asyncHandler = require('../middleware/asyncHandler').asyncHandler;

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

const { emitGroupChangesAfterUserDeletion } = require('../services/socket.service');

const credentialAdmin = require('../services/credentialAdmin.service');
const { auditUsernames } = require('../services/usernameAudit.service');
const { getDb } = require('../config/database');

// GET /api/admin/usernames/audit  (read-only)
function usernameAudit(req, res) {
  return res.json(auditUsernames(getDb()));
}

function credentialStatus(req, res) {
  return res.json(credentialAdmin.listCredentialStatus());
}

function sendCredentialAdminError(res, err) {
  switch (err.code) {
    case 'INVALID_DAYS':
      return res.status(400).json({ error: err.message, code: 'invalid_days' });
    case 'NOT_FOUND':
      return res.status(404).json({ error: err.message });
    case 'NOT_LEGACY':
      return res.status(409).json({ error: err.message, code: 'not_legacy' });
    case 'COUNT_MISMATCH':
      return res.status(409).json({ error: err.message, code: 'count_mismatch', count: err.count });
    default:
      throw err;
  }
}

// GET /api/admin/credentials/legacy-login/inactive?days=90  (preview, changes nothing)
function previewInactiveLegacy(req, res) {
  try {
    return res.json(
      credentialAdmin.inactiveLegacyCandidates(req.query?.days, req.user.id)
    );
  } catch (err) {
    return sendCredentialAdminError(res, err);
  }
}

// POST /api/admin/credentials/legacy-login/close-inactive  { days, confirm_count }
function closeInactiveLegacy(req, res) {
  try {
    const result =
      credentialAdmin.closeInactiveLegacy(
        req.body?.days,
        req.body?.confirm_count,
        req.user.id
      );

    console.log(
      `[admin] ${req.user.username} closed legacy login for ${result.closed} inactive unmigrated account(s) (>${result.days} days)`
    );

    return res.json({ success: true, ...result });
  } catch (err) {
    return sendCredentialAdminError(res, err);
  }
}

// PUT /api/admin/users/:id/legacy-login  { closed: boolean }
function setLegacyLogin(req, res) {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0 || typeof req.body?.closed !== 'boolean') {
    return res.status(400).json({ error: 'closed must be a boolean' });
  }

  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own legacy login' });
  }

  try {
    const result = credentialAdmin.setLegacyLoginClosed(id, req.body.closed);

    console.log(
      `[admin] ${req.user.username} ${req.body.closed ? 'closed' : 'reopened'} legacy login for ${result.username}`
    );

    return res.json({ success: true, ...result });
  } catch (err) {
    return sendCredentialAdminError(res, err);
  }
}


// GET /api/admin/audit?limit=50&before=<id>   (read-only)
function auditLog(req, res) {
  const limit = Number(req.query?.limit) || 50;
  const beforeId = Number(req.query?.before) || null;
  return res.json(listAdminAudit({ limit, beforeId }));
}

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
  ['INVALID_CREDENTIALS', 400],
  ['INVALID_IS_ADMIN', 400],
  ['USERNAME_EXISTS', 409],
  ['EMAIL_EXISTS', 409],
]);

async function createUser(req, res) {

  // Field validation and normalization live in createUser() itself.
  // is_admin is not read: every account created here is a normal user.
  // The admin role changes hands only through POST /admin/transfer or the CLI.
  const {
    username,
    email,
    auth_key,
    kdf_salt,
    kdf_iterations,
  } = req.body || {};

  // F12: the temporary password is turned into credentials in the admin's
  // browser; a raw password is never accepted.
  if (
    'password' in (req.body || {})
  ) {
    return res.status(400).json({
      error: 'Raw passwords are not accepted. Update the app.',
      code: 'raw_password_rejected',
    });
  }

  try {

    const user =
      await createUserService(
        username,
        email,
        {
          authKey: auth_key,
          kdfSalt: kdf_salt,
          kdfIterations: kdf_iterations,
        },
        false
      );

    recordAdminAction({
      adminId: req.user.id,
      action: 'create_user',
      targetType: 'user',
      targetId: user.id,
      details: { username: user.username },
    });

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

// Proves the caller knows their password, the same way the account settings
// do. The browser derives current_auth_key from the password (the server never
// sees it), and the server checks it against the stored hash. A stolen session
// token alone cannot do dangerous admin actions.
// Returns true when the password matches; otherwise it has already sent a response.
async function callerPasswordMatches(req, res) {

  const { current_auth_key } = req.body || {};

  if (!isValidAuthKey(current_auth_key)) {
    res.status(400).json({
      error: 'Password is required to confirm this action',
      code: 'password_required',
    });
    return false;
  }

  const caller = findUserWithPassword(req.user.id);

  if (!caller) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  if (caller.auth_scheme !== 2) {
    res.status(409).json({
      error: 'Log in again to upgrade this account first',
      code: 'migrate_first',
    });
    return false;
  }

  const valid = await comparePassword(current_auth_key, caller.password_hash);

  if (!valid) {
    res.status(403).json({ error: 'Password is incorrect' });
    return false;
  }

  return true;
}

// POST /api/admin/transfer  { userId, current_auth_key }
// Hands the admin role to another active user. The caller becomes a normal user.
async function transferAdminHandler(req, res) {

  const userId = Number(req.body?.userId);

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(400).json({
      error: 'Invalid user id',
    });
  }

  if (userId === req.user.id) {
    return res.status(400).json({
      error: 'You are already the admin',
    });
  }

  if (!(await callerPasswordMatches(req, res))) {
    return;
  }

  const target = findActiveUserById(userId);

  if (!target) {
    return res.status(404).json({
      error: 'User not found or inactive',
    });
  }

  const targetUsername = findUserById(userId)?.username ?? null;

  try {

    getDb().transaction(() => {
      transferAdmin(req.user.id, userId);
      recordAdminAction({
        adminId: req.user.id,
        action: 'transfer_admin',
        targetType: 'user',
        targetId: userId,
        details: { from: req.user.username, to: targetUsername },
      });
    })();

  } catch (err) {

    if (err.code === 'NOT_ADMIN') {
      return res.status(409).json({ error: err.message });
    }

    if (err.code === 'INVALID_TARGET') {
      return res.status(400).json({ error: err.message });
    }

    throw err;
  }

  console.log(
    `[admin] ${req.user.username} transferred the admin role to user id ${userId}`
  );

  res.json({
    success: true,
    from: req.user.id,
    to: userId,
  });

}

// DELETE /api/admin/users/:id  { current_auth_key }
async function deleteUser(req, res) {

  const userId = Number(req.params.id);

  if (!Number.isInteger(userId)) {
    return res.status(400).json({
      error: 'Invalid user id',
    });
  }

  if (userId === req.user.id) {
    return res.status(400).json({
      error: "You can't delete your own account. Transfer the admin role first.",
    });
  }

  const user = findUserById(userId);

  if (!user) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  // Defense in depth. The caller is the only admin, so this can't match
  // while the caller is an admin, but it keeps the rule explicit.
  if (user.is_admin) {
    return res.status(400).json({
      error: 'Transfer the admin role before deleting this account',
    });
  }

  if (!(await callerPasswordMatches(req, res))) {
    return;
  }

  const { groupChanges } = getDb().transaction(() => {
    const result = deleteUserService(userId);
    recordAdminAction({
      adminId: req.user.id,
      action: 'delete_user',
      targetType: 'user',
      targetId: userId,
      details: {
        username: user.username,
        groups_changed: result.groupChanges.map(g => ({
          group_id: g.groupId,
          group_deleted: g.groupDeleted,
          successor_id: g.successorId,
        })),
      },
    });
    return result;
  })();

  // The account is already gone; a socket hiccup must not turn that into a 500.
  try {
    emitGroupChangesAfterUserDeletion(groupChanges, userId, req.user.id);
  } catch (err) {
    console.error('Failed to notify groups after user deletion:', err.message);
  }

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

  // Resolves symlinks and enforces the allowed-roots policy
  // (utils/folderPolicy.js). The stored path is the REAL path.
  const checked =
    validateNewFolderPath(folderPath);

  if (!checked.ok) {
    return res.status(400).json({
      error: checked.message,
    });
  }

  const absolutePath =
    checked.realPath;

  try {

    const info = getDb().transaction(() => {
      const created = createFolderService(
        absolutePath,
        display_name || path.basename(absolutePath)
      );
      recordAdminAction({
        adminId: req.user.id,
        action: 'create_folder',
        targetType: 'folder',
        targetId: Number(created.lastInsertRowid),
        details: { path: absolutePath, display_name: display_name || path.basename(absolutePath) },
      });
      return created;
    })();

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

  getDb().transaction(() => {
    deleteFolderService(folderId);
    recordAdminAction({
      adminId: req.user.id,
      action: 'delete_folder',
      targetType: 'folder',
      targetId: folderId,
      details: { path: folder.path },
    });
  })();

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

  getDb().transaction(() => {
    grantPermission(userId, folderId, canWrite);
    recordAdminAction({
      adminId: req.user.id,
      action: 'grant_permission',
      targetType: 'user',
      targetId: userId,
      details: { folder_id: folderId, can_write: canWrite },
    });
  })();

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

  getDb().transaction(() => {
    revokePermission(userId, folderId);
    recordAdminAction({
      adminId: req.user.id,
      action: 'revoke_permission',
      targetType: 'user',
      targetId: userId,
      details: { folder_id: folderId },
    });
  })();

  res.json({
    success: true,
  });

}

module.exports = {
  listUsers: listUsersHandler,
  transferAdmin: asyncHandler(transferAdminHandler),
  usernameAudit,
  auditLog,
  credentialStatus,
  previewInactiveLegacy,
  closeInactiveLegacy,
  setLegacyLogin,
  createUser,
  deleteUser: asyncHandler(deleteUser),
  listFolders,
  createFolder,
  deleteFolder,
  listPermissions,
  grantPermission: grantPermissionHandler,
  revokePermission: revokePermissionHandler,
};