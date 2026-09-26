// routes/apk.routes.js
//
// Android-only update endpoints. Separate from routes/version.routes.js
// on purpose — that endpoint is already relied on by Electron and is
// left completely unchanged; see controllers/apk.controller.js for
// why. Mounted at /api/apk in server.js, so it already sits behind
// the app's general `apiLimiter` (applied to the whole /api prefix)
// without needing its own rate limiter here.

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { getApkInfo, downloadApk } = require('../controllers/apk.controller');

const router = express.Router();

router.get('/info', asyncHandler(getApkInfo));
router.get('/download', asyncHandler(downloadApk));

module.exports = router;
