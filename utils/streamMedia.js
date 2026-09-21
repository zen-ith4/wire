const { detectMimeFromBytes } = require('./detectFileType');
const { classifyMedia, encodeRfc5987 } = require('./mediaKind');

// Sniffs the file's REAL type from its bytes (never its extension) and
// returns { kind, mime } when it is one of the media types the Files
// viewer is allowed to stream, otherwise null.
async function describeMedia(target) {
  return classifyMedia(await detectMimeFromBytes(target.fullPath));
}

// Streams `target` inline with full HTTP Range support (Express'
// res.sendFile -> `send` answers 206/416, ETag and If-Range itself),
// so <video>/<audio> can seek without the file ever being buffered in
// Node or in the browser's JS heap.
//
// `media` MUST come from describeMedia(): only inert image/video/audio
// content is ever served with Content-Disposition: inline, and the
// Content-Type is the sniffed one, never one derived from the name.
function sendInlineMedia(res, target, media) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', media.mime);
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeRfc5987(target.name)}`
  );
  // Private data; the URL carries a per-request token so a shared or
  // browser cache would never be hit legitimately anyway.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

  res.sendFile(
    target.fullPath,
    {
      // Hidden segments were already refused by resolveRegularFile();
      // 'allow' only stops `send` from rejecting a deployment whose
      // own install path happens to contain a dot-directory.
      dotfiles: 'allow',
      cacheControl: false,
      acceptRanges: true,
    },
    (err) => {
      // Client hung up mid-stream (or the response is already
      // underway): nothing useful left to send.
      if (!err || res.headersSent) return;

      const status = Number.isInteger(err.status) ? err.status : 500;

      if (err.headers) res.set(err.headers);

      res.status(status).json({
        error:
          status === 416
            ? 'Range not satisfiable'
            : 'File not available',
      });
    }
  );
}

module.exports = {
  describeMedia,
  sendInlineMedia,
};
