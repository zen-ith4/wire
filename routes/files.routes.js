const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const { fileUpload } = require('../config/multer');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { asyncHandler } = require('../middleware/asyncHandler');
const { folderFileMediaAuth } = require('../middleware/mediaAuth');

const {
  getFolders,
  listFiles,
  downloadFile,
  previewFile,
  uploadFile,
  deleteEntry,
  getFileMediaToken,
  streamFile,
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
  asyncHandler(listFiles)
);


// Download file from folder
router.get(
  '/download/:folderId',
  authenticate,
  asyncHandler(downloadFile)
);


// Preview file from folder
router.get(
  '/preview/:folderId',
  authenticate,
  asyncHandler(previewFile)
);


// Mint a short-lived token for previewing ONE media file (the
// <video>/<audio>/<img> elements can't send an Authorization header)
router.get(
  '/media-token/:folderId',
  authenticate,
  asyncHandler(getFileMediaToken)
);


// Stream a media file inline with Range support (seekable playback)
router.get(
  '/stream/:folderId',
  folderFileMediaAuth,
  asyncHandler(streamFile)
);


// Upload file to folder
router.post(
  '/upload/:folderId',
  authenticate,
  uploadLimiter,
  fileUpload.single('file'),
  asyncHandler(uploadFile)
);


// Delete a file or folder (with everything inside it) from a folder
// the caller owns. Target is given as ?subpath=&file=, like the other
// per-file endpoints.
router.delete(
  '/item/:folderId',
  authenticate,
  asyncHandler(deleteEntry)
);


module.exports = router;