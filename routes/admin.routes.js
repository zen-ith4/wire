const express = require('express');

const router = express.Router();

const {
  authenticate,
  adminOnly,
} = require('../middleware/authenticate');

const { asyncHandler } = require('../middleware/asyncHandler');

const {
  listUsers,
  createUser,
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

router.post(
  '/users',
  asyncHandler(createUser)
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