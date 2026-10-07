# End-to-end encrypted DM attachments

Scope: direct-message attachments (images, audio, video, voice notes, files).
Group attachments are out of scope and unchanged.

## What the server sees

| Server sees | Server does NOT see |
|---|---|
| who sent it, to whom, when | file content |
| that a message has an attachment | file name, real type, voice flag |
| ciphertext size (file size + ~0.025%) | image width/height |
| a random on-disk name (UUID, no extension) | the per-file key, the caption |

The DB row stores constants: `attachment_name = 'encrypted-attachment'`,
`attachment_mime = 'application/octet-stream'`, no dimensions, voice flag 0.
The real values live in `attachment_meta`, an envelope encrypted with the
existing DM session key (same trust model as DM text: no forward secrecy,
and a server that swaps a user's public key is not covered).

## Format (STREAM AES-256-GCM)

Client code: `public/js/crypto/messages/attachment-stream.js`.

- Random 256-bit key per file; random 7-byte nonce prefix per file.
- 8-byte header `WAT1 0x10 0 0 0`, then 64 KiB plaintext chunks, each
  `ciphertext || 16-byte tag`. The last chunk holds 0..64 KiB.
- Chunk nonce = prefix(7) || chunk index (4, big-endian) || final flag (1).
  AAD = the header. Index and final flag are therefore authenticated:
  reordered, truncated, appended or modified chunks fail.
- A file that fails authentication yields no plaintext; the UI shows
  "Attachment unavailable".
- Limit: `DM_UPLOAD_MAX_MB` (default 50) of plaintext, exact: a file of
  exactly that size is accepted (the multer cap is overhead + 1 because
  multer's limit is exclusive; this was a bug in the first version).
  Container constants live in one server file, `config/dm-stream.js`, and a
  test fails if the browser module `attachment-stream.js` disagrees. The
  32-bit chunk counter would allow 256 TiB.

## Size pre-check (client)

`prepareDmAttachmentUpload` asks `GET /api/dm/limits` (authenticated) for the
configured maximum and rejects a larger file BEFORE reading or encrypting it,
with "File is larger than N MB" (shown as a toast). Only `File.size` is
touched, so there is no memory spike. File input, drag/drop, paste and voice
recordings all reach upload through the composer's `prepareUpload` hook, so
they share the check. If the limits request fails, 50 MB is assumed and the
server still enforces its own limit. There is no maximum voice-recording
duration; a very long recording is simply refused by the same check.

## Playback: lazy decrypt

Encrypted audio and video are rendered as a player WITHOUT a source: nothing
is downloaded, decrypted or turned into a Blob until the first play. Pressing
play (button, click on the video, or keyboard) downloads the ciphertext with
the session Authorization header (never a token in the URL), decrypts it into
a Blob, sets the element's `src` and plays. The Blob URL is stamped as
`data-blob-url` and revoked when the message is removed or the chat is left;
a Blob that finishes decrypting after its player is gone is revoked at once.
Images (small) and voice notes (small; the waveform needs the data) are still
decrypted when rendered. Decrypted Blobs are cached (64 MB cap) so pressing
play twice does not download twice. Seeking works once the file has been
decrypted; seeking before that would need a Service Worker or MSE and is not
implemented. Peak memory while decrypting a file is roughly twice its size
(not measured on a phone). Browsers that require `play()` inside the user
gesture (notably Safari/iOS) may refuse the automatic play after a long
download; the player is then loaded and a second tap plays it (not tested).


## Server behaviour

- `DM_E2EE_ATTACHMENTS_ENFORCED` (default ON). ON: every DM upload must have
  an encrypted shape (12-byte `attachment_iv`, `attachment_meta` <= 8 KB shaped
  like an encrypted envelope, encrypted-shaped caption, valid container length
  and header). The server cannot prove the bytes are ciphertext; this guards
  against client bugs and downgrade. OFF (rollback): uploads without
  `attachment_meta` take the old plaintext path.
- Encrypted rows are always served as `application/octet-stream`,
  `Content-Disposition: attachment; filename=attachment.bin`, `nosniff`,
  chosen from the DB row, never from client input. Range requests work on
  the ciphertext.
- The receiver uses the IV inside the encrypted envelope, never the
  server-stored `attachment_iv`.

## Notifications

- Server push (FCM): every new attachment shows the generic "📎 File".
- Conversation list: the (decrypted) caption, or "📎 Attachment".
- In-app/web notifications are built from the already-decrypted message, so
  they keep "📷 Photo", "🎞️ Video" and "🎤 Voice message" (checked in real
  Chromium with a stubbed Notification). They never include the file name or
  caption, and nothing is sent to the server.

## Legacy plaintext attachments

Attachments sent before this change (or while the flag is OFF) stay on disk
as plaintext, are marked only by having no `attachment_meta`, and are served
by the unchanged legacy path. There is no re-encryption migration: the server
holds no keys, so only the sender's client could re-upload them. Delete the
messages (which unlinks the files) or remove `DM_UPLOAD_DIR` contents to get
rid of them.

## Dead code on the DM path

`detectMimeFromBytes`, `normalizeSniffedMime`, `isInlineSafeMime` and
`readImageDimensions` are no longer used for new encrypted uploads. They are
kept (not owned by this task) and only run on the legacy/flag-off path.

## Not tested

Real push notifications (every new attachment shows the generic "File"
label), the APK / Capacitor (the native download of an encrypted file is
decrypted in the client and saved from a blob; untested on a device), and
real multi-device use.
