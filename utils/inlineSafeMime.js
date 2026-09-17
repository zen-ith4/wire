// Server-side allowlist of MIME types that may be served to the
// browser with `Content-Disposition: inline`.
//
// This list is the enforcement point for the stored-XSS fixes in
// chat/DM attachments and the "My Files" preview endpoint: no matter
// what a client claims (Content-Type header, filename extension, or
// a form field), a file only ever gets served inline if its *actual*
// content (verified via magic bytes — see utils/detectFileType.js)
// resolves to one of these types.
//
// NEVER add text/html, image/svg+xml, application/xhtml+xml,
// text/xml, or any other type a browser can parse as active
// content/markup to this list — that is exactly the class of MIME
// type that turned an "view attachment" click into script execution
// in our own origin (and, via localStorage, a stolen session token).
const INLINE_SAFE_MIME_TYPES = new Set([
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',

  // Video
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/mpeg',
  'video/3gpp',
  'video/3gpp2',
  'video/ogg',

  // Audio
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/mp4',
  'audio/webm',
  'audio/aac',

  // Documents
  'application/pdf',
]);

function isInlineSafeMime(mime) {
  return typeof mime === 'string' && INLINE_SAFE_MIME_TYPES.has(mime.toLowerCase());
}

module.exports = {
  INLINE_SAFE_MIME_TYPES,
  isInlineSafeMime,
};
