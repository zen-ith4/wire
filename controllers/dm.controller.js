const path = require('path');
const fs = require('fs');
const constants = require('../config/constants');
const {
  CHAT_MIME_MAP,
  DM_STREAM_HEADER_BYTES,
  DM_STREAM_TAG_BYTES,
} = require('../config/multer');
const { readImageDimensions } = require('../utils/imageDimensions');
const { detectMimeFromBytes } = require('../utils/detectFileType');
const { normalizeSniffedMime, resolveVoiceMime } = require('../utils/voiceMime');
const { isInlineSafeMime } = require('../utils/inlineSafeMime');
const { signMediaToken, MEDIA_TOKEN_TTL_SECONDS } = require('../utils/jwt');
const {
  getConversationsSummary,
  getTotalUnread,
  markRead,
  getRecentDmMessages,
  getDmMessagesBefore,
  getDmMessagesSince,
  insertDmMessage,
  insertDmMessageWithAttachment,
  insertDmMessageWithEncryptedAttachment,
  findDmMessageById,
  findDmMessageWithUser,
  deleteDmMessage,
  updateDmMessageContent,
} = require('../services/dm.service');
const { findUserById } = require('../services/user.service');
const { toggleReaction, getReactionsForMessage, getReactionsForMessages } = require('../services/reaction.service');
const {
  emitNewDirectMessage,
  emitDirectMessageDeleted,
  emitDirectMessageEdited,
  emitDirectReactionUpdate,
  emitDmMessagesSeen,
} = require('../services/socket.service');
const { clampLimit, withDmFlags, withReactions } = require('../utils/helpers');

// Accepts whatever the client sent for reply_to_id and normalizes it
// to either a positive integer or null. For DMs we additionally
// require — beyond just being a well-formed id — that the referenced
// message actually belongs to *this* conversation (sender/recipient
// pair), otherwise a fabricated id could pull another conversation's
// message content into this thread's reply preview. An id that's a
// good match structurally but doesn't resolve (already deleted) is
// still allowed through: DM_SELECT's LEFT JOIN degrades that to
// reply_to: null, rendered as "Original message deleted".
function normalizeDmReplyToId(value, userId, peerId) {

  if (value === undefined || value === null || value === '') {
    return null;
  }

  const id = Number.parseInt(value, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const target = findDmMessageById(id);

  if (!target) {
    // Already gone — still a legitimate reply target (falls back to
    // "Original message deleted"), just can't be conversation-checked.
    return id;
  }

  const belongsToConversation =
    (target.sender_id === userId && target.recipient_id === peerId) ||
    (target.sender_id === peerId && target.recipient_id === userId);

  return belongsToConversation ? id : null;
}

// Same reasoning as chat.controller.js's isVoiceMessageFlag(): only
// honor the client's "this is a voice message" flag when the
// resolved attachment mime is actually audio, so a client can't tag
// an arbitrary upload to have it render in the compact voice UI.
function isVoiceMessageFlag(rawValue, mime) {
  const truthy =
    rawValue === '1' ||
    rawValue === 'true' ||
    rawValue === true;

  return truthy && typeof mime === 'string' && mime.startsWith('audio/');
}

// ---------------------------------------------------------------------
// End-to-end encrypted DM attachments
// ---------------------------------------------------------------------
//
// The client encrypts the file (STREAM AES-256-GCM, see
// public/js/crypto/messages/attachment-stream.js) BEFORE upload. The
// per-file key, name, real mime, size, dimensions and voice flag travel
// only inside `attachment_meta`, an opaque envelope encrypted under the
// DM session key. The server therefore never inspects, sniffs, labels
// or renders the file: it stores bytes and serves bytes.
//
// What the server DOES check is the *shape* of the upload, so an honest
// client bug or a downgrade attempt (plaintext upload) is rejected
// instead of silently stored. It cannot prove the bytes are ciphertext.
//
// DM_E2EE_ATTACHMENTS_ENFORCED (default ON; set to "false" to roll
// back): when ON, every DM upload must be an encrypted-shape upload.
// When OFF, an upload WITHOUT attachment_meta takes the legacy
// plaintext path unchanged. An upload that carries attachment_meta is
// always handled as encrypted, whatever the flag says.
const DM_STREAM_MAGIC = Buffer.from('WAT1', 'latin1');
const DM_STREAM_CHUNK_SIZE = 64 * 1024;
const DM_ATTACHMENT_META_MAX = 8 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function e2eeAttachmentsEnforced() {
  return String(process.env.DM_E2EE_ATTACHMENTS_ENFORCED ?? 'true')
    .trim()
    .toLowerCase() !== 'false';
}

function base64ByteLength(value) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    return -1;
  }
  return Buffer.from(value, 'base64').length;
}

// Shape-only check of the client's encrypted-envelope JSON (the same
// {encryption:{version,algorithm,iv,ciphertext}} object text DMs use).
function isEncryptedEnvelopeShape(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const enc = parsed && typeof parsed === 'object' ? parsed.encryption : null;
  return !!enc &&
    typeof enc === 'object' &&
    enc.version === 1 &&
    enc.algorithm === 'AES-GCM' &&
    base64ByteLength(enc.iv) === 12 &&
    base64ByteLength(enc.ciphertext) > 0;
}

// Ciphertext layout: 8-byte header, then chunks of (64 KiB + 16-byte
// tag), the last one shorter but never shorter than a bare tag.
function isValidStreamLength(size) {
  const minimum = DM_STREAM_HEADER_BYTES + DM_STREAM_TAG_BYTES;
  if (!Number.isInteger(size) || size < minimum) return false;
  const full = DM_STREAM_CHUNK_SIZE + DM_STREAM_TAG_BYTES;
  const body = size - DM_STREAM_HEADER_BYTES;
  const rem = body % full;
  return rem === 0 || rem >= DM_STREAM_TAG_BYTES;
}

async function hasStreamHeader(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(DM_STREAM_HEADER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, DM_STREAM_HEADER_BYTES, 0);
    return bytesRead === DM_STREAM_HEADER_BYTES &&
      buf.subarray(0, 4).equals(DM_STREAM_MAGIC) &&
      buf[4] === 16 && // chunk size = 2^16
      buf[5] === 0 && buf[6] === 0 && buf[7] === 0;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Returns an error string, or null when the upload has a valid
// encrypted shape. Never reads the file beyond its 8-byte container
// header, and never infers a mime type.
async function validateEncryptedUpload(req) {
  const body = req.body || {};
  const meta = body.attachment_meta;
  const iv = body.attachment_iv;

  if (typeof meta !== 'string' || !meta) {
    return 'Attachments must be end-to-end encrypted (attachment_meta required)';
  }
  if (meta.length > DM_ATTACHMENT_META_MAX || !isEncryptedEnvelopeShape(meta)) {
    return 'Invalid attachment_meta';
  }
  if (base64ByteLength(iv) !== 12) {
    return 'Invalid attachment_iv';
  }
  const caption = typeof body.content === 'string' ? body.content.trim() : '';
  if (caption && (caption.length > 2000 || !isEncryptedEnvelopeShape(caption))) {
    return 'Caption must be end-to-end encrypted';
  }
  if (!isValidStreamLength(req.file.size)) {
    return 'Invalid encrypted attachment size';
  }
  if (!(await hasStreamHeader(req.file.path))) {
    return 'Attachment is not an encrypted stream';
  }
  return null;
}

async function sendEncryptedAttachment(req, res, recipientId, cleanup) {
  const problem = await validateEncryptedUpload(req);
  if (problem) {
    cleanup();
    return res.status(400).json({ error: problem });
  }

  const caption = (req.body.content || '').trim();
  const replyToId = normalizeDmReplyToId(req.body?.reply_to_id, req.user.id, Number(recipientId));
  const timestamp = new Date().toISOString();

  const info = insertDmMessageWithEncryptedAttachment(
    req.user.id,
    recipientId,
    caption,
    timestamp,
    req.file.filename,
    req.file.size,
    replyToId,
    req.body.attachment_meta,
    req.body.attachment_iv
  );

  const fullMsg = findDmMessageWithUser(info.lastInsertRowid);
  fullMsg.has_attachment = !!fullMsg.attachment_name;
  fullMsg.is_voice_message = Boolean(fullMsg.is_voice_message);

  emitNewDirectMessage(fullMsg);
  return res.json(fullMsg);
}

function getConversationsHandler(req, res) {
  // getConversationsSummary() batches what used to be 1 + 3 queries
  // per conversation (peer lookup, last message, unread count) into
  // 3 fixed queries total — see the comment on it in dm.service.js.
  const conversations = getConversationsSummary(req.user.id);

  const result = conversations.map(({ peer_id, username, lastMessage, unreadCount }) => {
    return {
      peer_id,
      username: username || 'Deleted user',
      last_message: lastMessage
        ? (lastMessage.content || (lastMessage.attachment_name ? (lastMessage.is_voice_message ? '🎤 Voice message' : '📎 Attachment') : ''))
        : '',
      last_timestamp: lastMessage ? lastMessage.timestamp : null,
      unread_count: unreadCount,
    };
  }).sort((a, b) => (b.last_timestamp || '').localeCompare(a.last_timestamp || ''));

  res.json(result);
}

function getUnreadCountHandler(req, res) {
  const count = getTotalUnread(req.user.id);
  res.json({ count });
}

// Emits exactly one real-time event to the original sender covering
// every message this call just marked read — never one event per
// message, and never anything at all when the reader has read
// receipts turned off (see dm.service.js's markRead).
function emitSeenReceiptIfAny(peerId, myId, result) {
  if (result.receiptsEnabled && result.messageIds.length > 0) {
    emitDmMessagesSeen({
      sender_id: peerId,
      reader_id: myId,
      message_ids: result.messageIds,
      seen_at: result.timestamp,
    });
  }
}

function getRecentMessagesHandler(req, res) {
  const peerId = parseInt(req.params.peerId);
  const limit = clampLimit(req.query.limit);
  const messages = getRecentDmMessages(req.user.id, peerId, limit);
  emitSeenReceiptIfAny(peerId, req.user.id, markRead(peerId, req.user.id));
  const reactions = getReactionsForMessages('dm', messages.map(m => m.id));
  res.json(withReactions(withDmFlags(messages), reactions));
}

function getMessagesBeforeHandler(req, res) {
  const peerId = parseInt(req.params.peerId);
  const before = typeof req.query.before === 'string' ? req.query.before : new Date().toISOString();
  const limit = clampLimit(req.query.limit);
  const messages = getDmMessagesBefore(req.user.id, peerId, before, limit);
  const reactions = getReactionsForMessages('dm', messages.map(m => m.id));
  res.json(withReactions(withDmFlags(messages), reactions));
}

function getMessagesSinceHandler(req, res) {
  const peerId = parseInt(req.params.peerId);
  const since = typeof req.query.since === 'string' ? req.query.since : '1970-01-01T00:00:00.000Z';
  const limit = clampLimit(req.query.limit, 100, 200);
  const messages = getDmMessagesSince(req.user.id, peerId, since, limit);
  emitSeenReceiptIfAny(peerId, req.user.id, markRead(peerId, req.user.id));
  const reactions = getReactionsForMessages('dm', messages.map(m => m.id));
  res.json(withReactions(withDmFlags(messages), reactions));
}

function sendMessage(req, res) {
  const { recipient_id, content } = req.body || {};

  if (!recipient_id) {
    return res.status(400).json({ error: 'recipient_id required' });
  }

  if (Number(recipient_id) === req.user.id) {
    return res.status(400).json({ error: "You can't message yourself" });
  }

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  const target = findUserById(recipient_id);
  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  const trimmed = content.trim().slice(0, 2000);
  const replyToId = normalizeDmReplyToId(req.body?.reply_to_id, req.user.id, Number(recipient_id));
  const timestamp = new Date().toISOString();
  const info = insertDmMessage(req.user.id, recipient_id, trimmed, timestamp, replyToId);

  const fullMsg = findDmMessageWithUser(info.lastInsertRowid);
  fullMsg.has_attachment = !!fullMsg.attachment_name;
  fullMsg.is_voice_message = Boolean(fullMsg.is_voice_message);

  emitNewDirectMessage(fullMsg);
  res.json(fullMsg);
}

async function sendMessageWithAttachment(req, res) {
  const recipient_id = req.body.recipient_id;
  const cleanup = () => {
    if (req.file) fs.unlink(req.file.path, () => {});
  };

  if (!recipient_id) {
    cleanup();
    return res.status(400).json({ error: 'recipient_id required' });
  }

  if (Number(recipient_id) === req.user.id) {
    cleanup();
    return res.status(400).json({ error: "You can't message yourself" });
  }

  const target = findUserById(recipient_id);
  if (!target) {
    cleanup();
    return res.status(404).json({ error: 'User not found' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const wantsEncrypted =
    typeof req.body?.attachment_meta === 'string' &&
    req.body.attachment_meta.length > 0;

  if (wantsEncrypted || e2eeAttachmentsEnforced()) {
    return sendEncryptedAttachment(req, res, recipient_id, cleanup);
  }

  // Legacy plaintext path (DM_E2EE_ATTACHMENTS_ENFORCED=false only).
  const originalName = path.basename(req.file.originalname);
  const ext = path.extname(originalName).toLowerCase();
  const clientMime = req.file.mimetype || '';
  // SECURITY: same reasoning as chat.controller.js's
  // sendMessageWithAttachment — this resolved mime is what later
  // decides, at serve time (getAttachment below), whether the file
  // can ever be shown `inline` in a browser. Neither the client's
  // Content-Type nor the filename extension is trustworthy for that;
  // only detectMimeFromBytes()'s magic-byte sniff of the actual file
  // on disk is.
  const sniffedMime = normalizeSniffedMime(
    await detectMimeFromBytes(req.file.path)
  );

  const voiceMime = resolveVoiceMime(
    sniffedMime,
    clientMime,
    req.body?.is_voice_message
  );

  let mime;

  if (voiceMime) {
    // Voice recording (webm / ogg / mp4 container): see utils/voiceMime.js.
    mime = voiceMime;
  } else if (sniffedMime && isInlineSafeMime(sniffedMime)) {
    mime = sniffedMime;
  } else {
    // See the identical, corrected fallback in chat.controller.js:
    // an extension-derived label must never be trusted if it
    // happens to be an inline-safe-looking mime (e.g. ".jpg" without
    // sniff-verified JPEG bytes) — getAttachment() below trusts
    // isInlineSafeMime(storedMime) directly, so only a verified
    // sniff result (or the narrow voice-message case above) may ever
    // produce an inline-safe value here.
    const extLabel = CHAT_MIME_MAP[ext];
    mime =
      extLabel && !isInlineSafeMime(extLabel)
        ? extLabel
        : 'application/octet-stream';
  }
  const caption = (req.body.content || '').trim().slice(0, 2000);
  const replyToId = normalizeDmReplyToId(req.body?.reply_to_id, req.user.id, Number(recipient_id));
  const isVoiceMessage = isVoiceMessageFlag(req.body?.is_voice_message, mime);
  // Same reasoning as chat.controller.js's sendMessageWithAttachment:
  // reserve layout space for image attachments up front.
  const dims = mime.startsWith('image/') ? readImageDimensions(req.file.path, mime) : null;
  const timestamp = new Date().toISOString();

  const info = insertDmMessageWithAttachment(
    req.user.id,
    recipient_id,
    caption,
    timestamp,
    req.file.filename,
    originalName,
    req.file.size,
    mime,
    replyToId,
    isVoiceMessage,
    dims?.width ?? null,
    dims?.height ?? null
  );

  const fullMsg = findDmMessageWithUser(info.lastInsertRowid);
  fullMsg.has_attachment = !!fullMsg.attachment_name;
  fullMsg.is_voice_message = Boolean(fullMsg.is_voice_message);

  emitNewDirectMessage(fullMsg);
  res.json(fullMsg);
}

function getAttachmentMediaToken(req, res) {
  const messageId = Number(req.params.messageId);

  if (!Number.isInteger(messageId)) {
    return res.status(400).json({
      error: 'Invalid message id'
    });
  }

  const msg = findDmMessageById(messageId);

  if (!msg || !msg.attachment_path) {
    return res.status(404).json({
      error: 'Attachment not found'
    });
  }

  // Same access check as getAttachment below — only sender or
  // recipient may obtain a token for this attachment.
  if (
    msg.sender_id !== req.user.id &&
    msg.recipient_id !== req.user.id
  ) {
    return res.status(403).json({
      error: 'Access denied'
    });
  }

  const token = signMediaToken(req.user, {
    type: 'dm',
    id: messageId,
  });

  res.json({
    token,
    expiresIn: MEDIA_TOKEN_TTL_SECONDS,
  });
}

function getAttachment(req, res) {
  const messageId = Number(req.params.messageId);

  if (!Number.isInteger(messageId)) {
    return res.status(400).json({
      error: 'Invalid message id'
    });
  }

  const msg = findDmMessageById(messageId);

  if (!msg || !msg.attachment_path) {
    return res.status(404).json({
      error: 'Attachment not found'
    });
  }

  // Only sender or recipient can access the attachment
  if (
    msg.sender_id !== req.user.id &&
    msg.recipient_id !== req.user.id
  ) {
    return res.status(403).json({
      error: 'Access denied'
    });
  }

  const filePath = path.join(
    constants.DM_UPLOAD_DIR,
    msg.attachment_path
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'Attachment not found'
    });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // SECURITY: see the identical block in chat.controller.js's
  // getAttachment — `inline` is only ever allowed for a mime that's
  // actually on the allowlist (resolved from magic bytes at upload
  // time), regardless of the `?download` query param or whatever
  // mime the client originally claimed.
  const storedMime =
    msg.attachment_mime ||
    'application/octet-stream';

  // Encrypted rows (attachment_meta set) are opaque ciphertext: never
  // inline, never labelled with a mime, whatever the stored columns say.
  // The branch is chosen from the DB row, never from client input.
  const isEncryptedRow = !!msg.attachment_meta;

  const safeToRenderInline =
    !isEncryptedRow && isInlineSafeMime(storedMime);

  const disposition =
    (safeToRenderInline && !req.query.download)
      ? 'inline'
      : 'attachment';

  const contentType =
    safeToRenderInline
      ? storedMime
      : 'application/octet-stream';

  res.setHeader('X-Content-Type-Options', 'nosniff');

  res.setHeader(
    'Content-Type',
    contentType
  );

  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename*=UTF-8''${encodeURIComponent(
      isEncryptedRow ? 'attachment.bin' : msg.attachment_name
    )}`
  );

  // --------------------------------------------------
  // DOWNLOAD
  // --------------------------------------------------

  if (req.query.download) {
    res.setHeader(
      'Content-Length',
      fileSize
    );

    const downloadStream = fs.createReadStream(filePath);
    // See the identical comment in chat.controller.js's getAttachment
    // — without this, a client disconnecting mid-download leaves the
    // server still reading the rest of the file off disk for no one.
    //
    // BUG FIX: guard with res.writableEnded — see the matching fix
    // and comment in chat.controller.js's getAttachment. Without it,
    // a normally-finishing response can have its tail truncated when
    // 'close' fires (e.g. the reverse proxy closing the origin
    // connection right after a normal response) slightly before the
    // pipe has fully flushed, which surfaces client-side as
    // MEDIA_ERR_NETWORK even though status/headers looked fine.
    req.on('close', () => {
      if (res.writableEnded) return;
      if (!downloadStream.destroyed) downloadStream.destroy();
    });
    return downloadStream.pipe(res);
  }

  // --------------------------------------------------
  // VIDEO / AUDIO RANGE SUPPORT
  // --------------------------------------------------

  const range = req.headers.range;

  // Browser did not request a range
  if (!range) {
    res.setHeader(
      'Content-Length',
      fileSize
    );

    res.setHeader(
      'Accept-Ranges',
      'bytes'
    );

    const fullStream = fs.createReadStream(filePath);
    // BUG FIX: same res.writableEnded guard as the download branch
    // above — see that comment.
    req.on('close', () => {
      if (res.writableEnded) return;
      if (!fullStream.destroyed) fullStream.destroy();
    });
    return fullStream.pipe(res);
  }

  // --------------------------------------------------
  // PARSE RANGE
  // --------------------------------------------------

  const match = range.match(
    /bytes=(\d*)-(\d*)/
  );

  if (!match) {
    return res
      .status(416)
      .setHeader(
        'Content-Range',
        `bytes */${fileSize}`
      )
      .end();
  }

  let start = match[1]
    ? Number(match[1])
    : 0;

  let end = match[2]
    ? Number(match[2])
    : fileSize - 1;

  // Suffix range:
  // bytes=-500000
  if (!match[1] && match[2]) {
    const suffixLength =
      Number(match[2]);

    start = Math.max(
      fileSize - suffixLength,
      0
    );

    end = fileSize - 1;
  }

  // --------------------------------------------------
  // VALIDATE RANGE
  // --------------------------------------------------

  if (
    start < 0 ||
    end >= fileSize ||
    start > end
  ) {
    return res
      .status(416)
      .setHeader(
        'Content-Range',
        `bytes */${fileSize}`
      )
      .end();
  }

  const chunkSize =
    end - start + 1;

  // --------------------------------------------------
  // PARTIAL RESPONSE
  // --------------------------------------------------

  res.status(206);

  res.setHeader(
    'Content-Range',
    `bytes ${start}-${end}/${fileSize}`
  );

  res.setHeader(
    'Accept-Ranges',
    'bytes'
  );

  res.setHeader(
    'Content-Length',
    chunkSize
  );

  // --------------------------------------------------
  // STREAM REQUESTED CHUNK
  // --------------------------------------------------

  const stream =
    fs.createReadStream(filePath, {
      start,
      end
    });

  stream.on('error', (err) => {
    console.error(
      'DM attachment stream error:',
      err.message
    );

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });

  // Same reasoning as chat.controller.js's getAttachment — this is
  // the range endpoint video/audio scrubbing hits, and each seek
  // cancels the previous in-flight range request from the browser's
  // side. Destroying the stream when the request closes stops the
  // server from continuing to read an abandoned byte range off disk.
  //
  // BUG FIX: same res.writableEnded guard as the other branches —
  // see the download branch above for the full explanation.
  req.on('close', () => {
    if (res.writableEnded) return;
    if (!stream.destroyed) stream.destroy();
  });

  stream.pipe(res);
}

// Edit a DM's text content.
//
// SECURITY: ownership is decided entirely from req.user.id (set by
// the `authenticate` middleware from the verified session/JWT) and
// the message row looked up by id — never from anything the client
// puts in the request body. There is deliberately no client-supplied
// sender/owner field accepted here at all.
//
// `content` is expected to already be the same opaque, client-side
// encrypted payload shape (JSON-stringified { encryption, senderId,
// recipientId } — see public/js/crypto/messages/payload.js) that
// sendMessage() above stores. This handler never decrypts it, never
// generates its own encryption, and never accepts/produces plaintext
// — it only ever swaps one encrypted blob for another, exactly like
// sendMessage() already does for new messages. That also means it
// doesn't need to independently validate the encryption envelope any
// more than sendMessage() does: malformed content simply fails to
// decrypt for the reader, the same failure mode as a corrupted send.
function editMessage(req, res) {
  const id = parseInt(req.params.messageId, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  const { content } = req.body || {};
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  const msg = findDmMessageById(id);
  if (!msg) {
    return res.status(404).json({ error: 'Message not found' });
  }

  // Only the original sender may edit — unlike deleteMessage below,
  // there is no admin override: editing rewrites someone's own words,
  // which is a different thing from moderating/removing content.
  if (msg.sender_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only edit your own messages' });
  }

  // Editing is restricted to plain text messages. The attachment
  // itself has no edit UI/flow anywhere in this architecture, and
  // silently allowing the caption of an attachment message to be
  // "edited" here would let it slip into a state (edited_at set, but
  // no general attachment-edit support elsewhere) nothing else is
  // built to handle.
  if (msg.attachment_path) {
    return res.status(400).json({ error: 'Attachment messages cannot be edited' });
  }

  const trimmed = content.trim().slice(0, 2000);
  const editedAt = new Date().toISOString();

  updateDmMessageContent(id, trimmed, editedAt);

  const fullMsg = findDmMessageWithUser(id);
  fullMsg.has_attachment = !!fullMsg.attachment_name;
  fullMsg.is_voice_message = Boolean(fullMsg.is_voice_message);

  emitDirectMessageEdited(fullMsg);
  res.json(fullMsg);
}

function deleteMessage(req, res) {
  const id = parseInt(req.params.messageId, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  const msg = findDmMessageById(id);
  if (!msg) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const isOwner = msg.sender_id === req.user.id;
  const isAdmin = !!req.user.is_admin;

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'You can only delete your own messages' });
  }

  if (msg.attachment_path) {
    const filePath = path.join(constants.DM_UPLOAD_DIR, msg.attachment_path);
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error('Failed to delete DM attachment:', err.message);
      }
    });
  }

  deleteDmMessage(id);

  emitDirectMessageDeleted({
    id,
    sender_id: msg.sender_id,
    recipient_id: msg.recipient_id,
  });

  res.json({ success: true, id });
}

function toggleReactionHandler(req, res) {
  const id = parseInt(req.params.messageId, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  const emoji = (req.body.emoji || '').trim();
  if (!emoji || emoji.length > 32) {
    return res.status(400).json({ error: 'Invalid emoji' });
  }

  const msg = findDmMessageById(id);
  if (!msg) {
    return res.status(404).json({ error: 'Message not found' });
  }

  // Either side of the conversation can react — unlike delete
  // (sender/admin only), reacting doesn't modify someone else's
  // content, so the recipient is allowed too.
  const isParticipant = msg.sender_id === req.user.id || msg.recipient_id === req.user.id;
  if (!isParticipant) {
    return res.status(403).json({ error: 'You do not have access to this conversation' });
  }

  const action = toggleReaction('dm', id, req.user.id, emoji);
  const reactions = getReactionsForMessage('dm', id);

  emitDirectReactionUpdate({
    message_id: id,
    sender_id: msg.sender_id,
    recipient_id: msg.recipient_id,
    reactions,
  });

  res.json({ success: true, action, reactions });
}

module.exports = {
  getConversations: getConversationsHandler,
  getUnreadCount: getUnreadCountHandler,
  getRecentMessages: getRecentMessagesHandler,
  getMessagesBefore: getMessagesBeforeHandler,
  getMessagesSince: getMessagesSinceHandler,
  sendMessage,
  sendMessageWithAttachment,
  getAttachmentMediaToken,
  getAttachment,
  editMessage,
  deleteMessage,
  toggleReaction: toggleReactionHandler,
};