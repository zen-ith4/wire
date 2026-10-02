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

const TMP_UPLOAD_DIR = path.join(os.tmpdir(), 'wire-uploads');

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

// ======================================================
// UNICODE FILENAME FIX
// ======================================================
//
// Root cause of non-English (Persian/Arabic/CJK/emoji/etc.) filenames
// getting mangled: browsers put the file's name as *raw UTF-8 bytes*
// in the multipart Content-Disposition header of the file part (not
// percent-encoded, not RFC 2231 encoded — just the literal UTF-8
// bytes). busboy (which multer uses internally to parse multipart
// bodies) decodes that header value using 'latin1'/'binary', which is
// correct for plain HTTP header *field* semantics but wrong for this
// particular value, since it was never latin1 to begin with. The
// result is that `file.originalname` arrives already corrupted
// (mojibake) by the time multer hands it to us — e.g. "عکس.jpg"
// becomes "Ø¹Ú©Ø³.jpg" — well before any of our own code touches it.
//
// The fix is to reverse that mis-decode: take the mojibake string,
// re-encode it as latin1 to get back the original raw bytes, then
// decode *those* bytes as UTF-8. This is a lossless no-op for
// pure-ASCII names (English filenames), and correctly recovers any
// valid UTF-8 filename (Persian, Arabic, CJK, accented Latin,
// emoji, ...).
//
// This must run exactly once, as early as possible — before the
// extension is ever read off `file.originalname` (both here in
// storage.filename and in fileFilter) and before it's persisted
// anywhere. fileFilter is the earliest hook multer offers and runs
// for every upload regardless of whether a mimeMap/type restriction
// is configured, so we fix the encoding there for every uploader,
// mutating the shared `file` object in place — multer carries that
// same object through to `req.file`, so every later read (in
// storage.filename here, and in the controllers) sees the corrected
// name.
function fixFilenameEncoding(name) {
  if (typeof name !== 'string' || name === '') return name;

  const reDecoded = Buffer.from(name, 'latin1').toString('utf8');

  // Buffer's utf8 decoder swaps invalid byte sequences for U+FFFD
  // ("replacement character"). If re-decoding introduced *new*
  // replacement characters that weren't already in the original
  // string, then `name` wasn't actually latin1-mis-decoded UTF-8 in
  // the first place (e.g. a client that — unlike browsers — already
  // sent a correctly-decoded name some other way), and "fixing" it
  // would just corrupt it differently. In that case, keep the
  // original rather than risk making things worse.
  if (reDecoded.includes('\uFFFD') && !name.includes('\uFFFD')) {
    return name;
  }

  return reDecoded;
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
    // Fix the Unicode mojibake first — see fixFilenameEncoding above.
    // Everything below (and everything downstream, since `file` is
    // the same object multer attaches as `req.file`) now sees the
    // real original filename.
    file.originalname = fixFilenameEncoding(file.originalname);

    if (allowedTypes) {
      const ext = path.extname(file.originalname).toLowerCase();

      if (!allowedTypes[ext]) {
        return cb(new Error('Unsupported file type'));
      }
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
    // Always attach the filter: even when there's no mimeMap to
    // restrict against (chatUpload/dmUpload), it still needs to run
    // to fix Unicode filename encoding on every upload — see
    // fixFilenameEncoding above.
    fileFilter: createFileFilter(mimeMap),
  };

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
  // No mimeMap here on purpose: chat attachments accept any
  // reasonable file type (same as the general "My Files" uploader
  // below), not just the small predefined list in CHAT_MIME_MAP.
  // CHAT_MIME_MAP is still used elsewhere (see chat.controller.js) to
  // *label* a known extension's mime type when the browser-supplied
  // one is missing/generic — it's just no longer used to *reject*
  // uploads here. createUploader() still attaches a fileFilter
  // unconditionally for the Unicode-filename fix (see
  // fixFilenameEncoding above); with no mimeMap it just fixes the
  // encoding and never rejects on type.
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
  // Same Unicode-filename fix as the other uploaders above — this is
  // the uploader behind the "My Files" / Drive upload endpoint,
  // which stores req.file.originalname as the actual on-disk display
  // name (see controllers/files.controller.js's uploadFile), so it
  // needs this even more directly than chat/DM do.
  fileFilter: createFileFilter(),
});

// ======================================================

const groupAvatarUpload = createUploader({
  dir: constants.AVATAR_DIR,
  maxSizeMB: constants.AVATAR_MAX_MB,
  mimeMap: AVATAR_MIME_MAP,
  // No userPrefix: this is a group's avatar, not a user's.
});

const groupUpload = createUploader({
  dir: constants.GROUP_UPLOAD_DIR,
  maxSizeMB: constants.GROUP_UPLOAD_MAX_MB,
  // Group attachment bodies are AES-GCM ciphertext (opaque bytes), so
  // there is no file type to sniff or restrict at the multer layer.
});

module.exports = {
  AVATAR_MIME_MAP,
  CHAT_MIME_MAP,
  VIDEO_MIME_MAP, // Added this in case you need to export it directly elsewhere

  avatarUpload,
  bannerUpload,
  chatUpload,
  dmUpload,
  fileUpload,
  groupAvatarUpload,
  groupUpload,
};