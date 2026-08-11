const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { fileUpload } = require('../config/multer');

const {
  getFolders,
  listFiles,
  downloadFile,
  previewFile,
  uploadFile,
} = require('../controllers/files.controller');


// Get user's accessible folders
router.get(
  '/folders',
  authenticate,
  getFolders
);


// List files inside a folder
router.get(
  '/list/:folderId',
  authenticate,
  listFiles
);


// Download file from folder
router.get(
  '/download/:folderId',
  authenticate,
  downloadFile
);


// Preview file from folder
router.get(
  '/preview/:folderId',
  authenticate,
  previewFile
);


// Upload file to folder
router.post(
  '/upload/:folderId',
  authenticate,
  fileUpload.single('file'),
  uploadFile
);


module.exports = router;