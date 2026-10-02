// Which detected (magic-byte) MIME types the Files viewer may stream
// inline, and what kind of player each one gets.
//
// This is intentionally NARROWER than utils/inlineSafeMime.js: that
// list also allows PDFs and many container formats for chat/DM
// attachments. The Files viewer only ever renders the three media
// categories below, so the streaming endpoints refuse everything else
// (the client then falls back to a normal download).
//
// Everything here is inert media: nothing a browser parses as
// markup/script. Never add text/html, image/svg+xml, or any XML/PDF
// type.

const IMAGE = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const VIDEO = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

const AUDIO = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/opus',
]);

// file-type reports e.g. "audio/ogg; codecs=opus". Only the bare
// media type is trusted/served.
function baseMime(mime) {
  if (typeof mime !== 'string') return null;

  const base = mime.split(';')[0].trim().toLowerCase();
  return base || null;
}

// Returns { kind: 'image' | 'video' | 'audio', mime } or null.
function classifyMedia(detectedMime) {
  const mime = baseMime(detectedMime);
  if (!mime) return null;

  if (IMAGE.has(mime)) return { kind: 'image', mime };
  if (VIDEO.has(mime)) return { kind: 'video', mime };
  if (AUDIO.has(mime)) return { kind: 'audio', mime };

  return null;
}

// RFC 5987 encoding for Content-Disposition filename*. Also encodes
// the characters encodeURIComponent leaves alone (' ( ) *).
function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

module.exports = {
  classifyMedia,
  baseMime,
  encodeRfc5987,
};
