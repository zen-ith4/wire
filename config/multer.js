const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const constants = require('./constants');

// ======================================================
// MIME TYPES
// ======================================================

const AVATAR_MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const VIDEO_MIME_MAP = {
  // Common
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.f4v': 'video/x-f4v',

  // MPEG / Transport streams
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mpe': 'video/mpeg',
  '.m2v': 'video/mpeg',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.ts': 'video/mp2t',

  // 3GP / Mobile
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',

  // OGG / Matroska family
  '.ogv': 'video/ogg',
  '.ogm': 'video/ogg',

  // Flash
  '.swf': 'application/x-shockwave-flash',

  // MPEG-4 variants
  '.f4p': 'video/mp4',
};

const CHAT_MIME_MAP = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',

  // Videos
  ...VIDEO_MIME_MAP,

  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',

  // Documents
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
};

// ======================================================
// DIRECTORIES
// ======================================================

const TMP_UPLOAD_DIR = path.join(os.tmpdir(), 'filehub-uploads');

[
  constants.AVATAR_DIR,
  constants.BANNER_DIR,
  constants.CHAT_UPLOAD_DIR,
  constants.DM_UPLOAD_DIR,
  constants.USER_DATA_ROOT,
  TMP_UPLOAD_DIR,
].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ======================================================
// HELPERS
// ======================================================

function randomFilename(ext) {
  return `${crypto.randomUUID()}${ext}`;
}

function createStorage(uploadDir, useUserPrefix = false) {
  return multer.diskStorage({
    destination(req, file, cb) {
      cb(null, uploadDir);
    },

    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();

      if (useUserPrefix) {
        return cb(
          null,
          `${req.user.id}-${crypto.randomUUID()}${ext}`
        );
      }

      cb(null, randomFilename(ext));
    },
  });
}

function createFileFilter(allowedTypes) {
  return (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedTypes[ext]) {
      return cb(new Error('Unsupported file type'));
    }

    cb(null, true);
  };
}

function createUploader({
  dir,
  maxSizeMB,
  mimeMap,
  userPrefix = false,
}) {
  const options = {
    storage: createStorage(dir, userPrefix),
    limits: {
      fileSize: maxSizeMB * 1024 * 1024,
    },
  };

  if (mimeMap) {
    options.fileFilter = createFileFilter(mimeMap);
  }

  return multer(options);
}

// ======================================================
// UPLOADERS
// ======================================================

const avatarUpload = createUploader({
  dir: constants.AVATAR_DIR,
  maxSizeMB: constants.AVATAR_MAX_MB,
  mimeMap: AVATAR_MIME_MAP,
  userPrefix: true,
});

const bannerUpload = createUploader({
  dir: constants.BANNER_DIR,
  maxSizeMB: constants.BANNER_MAX_MB,
  mimeMap: AVATAR_MIME_MAP, // same image types as avatars
  userPrefix: true,
});

const chatUpload = createUploader({
  dir: constants.CHAT_UPLOAD_DIR,
  maxSizeMB: constants.CHAT_UPLOAD_MAX_MB,
  // No mimeMap/fileFilter here on purpose: chat attachments accept
  // any reasonable file type (same as the general "My Files" uploader
  // below), not just the small predefined list in CHAT_MIME_MAP.
  // CHAT_MIME_MAP is still used elsewhere (see chat.controller.js) to
  // *label* a known extension's mime type when the browser-supplied
  // one is missing/generic — it's just no longer used to *reject*
  // uploads here.
});

const dmUpload = createUploader({
  dir: constants.DM_UPLOAD_DIR,
  maxSizeMB: constants.DM_UPLOAD_MAX_MB,
  // Same relaxed policy as chatUpload above — see comment there.
});

const fileUpload = multer({
  dest: TMP_UPLOAD_DIR,
  limits: {
    fileSize: constants.UPLOAD_MAX_MB * 1024 * 1024,
  },
});

// ======================================================

module.exports = {
  AVATAR_MIME_MAP,
  CHAT_MIME_MAP,
  VIDEO_MIME_MAP, // Added this in case you need to export it directly elsewhere

  avatarUpload,
  bannerUpload,
  chatUpload,
  dmUpload,
  fileUpload,
};