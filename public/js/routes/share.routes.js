const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');

const {
  getUsers,
  getMyShares,
  createFolder,
  deleteFolder,
  getAccessList,
  grantAccess,
  revokeAccess,
} = require('../controllers/share.controller');


// Users
router.get(
  '/users',
  authenticate,
  getUsers
);


// My shared folders
router.get(
  '/mine',
  authenticate,
  getMyShares
);


// Folder management
router.post(
  '/folders',
  authenticate,
  createFolder
);

router.delete(
  '/folders/:id',
  authenticate,
  deleteFolder
);


// Permissions
router.get(
  '/access/:folderId',
  authenticate,
  getAccessList
);

router.post(
  '/access',
  authenticate,
  grantAccess
);

router.delete(
  '/access',
  authenticate,
  revokeAccess
);


module.exports = router;