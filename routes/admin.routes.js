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
  createUser,
  setUserAdmin,
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

// Change a user's admin flag. PUT (not PATCH) with a single-property
// sub-path mirrors the project's existing convention, e.g.
// PUT /api/me/accent-color.
router.put(
  '/users/:id/is-admin',
  setUserAdmin
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