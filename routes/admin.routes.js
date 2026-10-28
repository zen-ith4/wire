const express = require('express');

const router = express.Router();

const {
  authenticate,
  adminOnly,
} = require('../middleware/authenticate');

const {
  asyncHandler,
} = require('../middleware/asyncHandler');

const {
  listUsers,
  usernameAudit,
  auditLog,
  credentialStatus,
  previewInactiveLegacy,
  closeInactiveLegacy,
  setLegacyLogin,
  createUser,
  transferAdmin,
  deleteUser,
  listFolders,
  createFolder,
  deleteFolder,
  listPermissions,
  grantPermission,
  revokePermission,
} = require('../controllers/admin.controller');


// Every route below requires authentication + admin access.
router.use(
  authenticate,
  adminOnly
);


// Users
router.get(
  '/users',
  listUsers
);

// createUser is async (bcrypt), so it goes through asyncHandler the
// same way the async auth routes do.
router.post(
  '/users',
  asyncHandler(createUser)
);

// Hand the admin role to another user (the caller becomes a normal user).
// Replaces the old PUT /users/:id/is-admin: there is exactly one admin, so
// the role can only move, never be added or removed on its own.
router.post(
  '/transfer',
  transferAdmin
);

// Read-only audit trail of admin actions.
router.get(
  '/audit',
  auditLog
);

// F12 migration tools
router.get(
  '/usernames/audit',
  usernameAudit
);

router.get(
  '/credentials/status',
  credentialStatus
);

router.get(
  '/credentials/legacy-login/inactive',
  previewInactiveLegacy
);

router.post(
  '/credentials/legacy-login/close-inactive',
  closeInactiveLegacy
);

router.put(
  '/users/:id/legacy-login',
  setLegacyLogin
);

router.delete(
  '/users/:id',
  deleteUser
);


// Folders
router.get(
  '/folders',
  listFolders
);

router.post(
  '/folders',
  createFolder
);

router.delete(
  '/folders/:id',
  deleteFolder
);


// Permissions
router.get(
  '/permissions',
  listPermissions
);

router.post(
  '/permissions',
  grantPermission
);

router.delete(
  '/permissions',
  revokePermission
);


module.exports = router;