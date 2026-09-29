const path = require('path');
const fs = require('fs');

const constants = require('../config/constants');
const { CHAT_MIME_MAP } = require('../config/multer');
const { readImageDimensions } = require('../utils/imageDimensions');
const { detectMimeFromBytes } = require('../utils/detectFileType');
const { normalizeSniffedMime, resolveVoiceMime } = require('../utils/voiceMime');
const { isInlineSafeMime } = require('../utils/inlineSafeMime');
const { signMediaToken, MEDIA_TOKEN_TTL_SECONDS } = require('../utils/jwt');

const {
  getRecentMessages,
  getMessagesBefore,
  getMessagesSince,
  insertChatMessage,
  insertChatMessageWithAttachment,
  findChatMessageById,
  findChatMessageWithUser,
  deleteChatMessage,
} = require('../services/chat.service');

const {
  toggleReaction,
  getReactionsForMessage,
  getReactionsForMessages,
} = require('../services/reaction.service');

const {
  emitNewChatMessage,
  emitChatMessageDeleted,
  emitChatReactionUpdate,
} = require('../services/socket.service');

const {
  clampLimit,
  withAttachmentFlag,
  withReactions,
} = require('../utils/helpers');



function addAttachmentFlag(message) {

  if (!message) {
    return null;
  }

  message.has_attachment =
    !!message.attachment_name;

  // SQLite gives back 0/1 here — coerce to a real boolean, same as
  // withAttachmentFlag() (used by the list endpoints) does.
  message.is_voice_message =
    Boolean(message.is_voice_message);

  return message;
}

// A truthy `is_voice_message` form field only actually marks the
// message as a voice message when the resolved attachment mime type
// is audio — never trust the client-supplied flag on its own (a
// client could otherwise tag an arbitrary upload as a "voice
// message" and have it render in the compact voice UI instead of the
// generic attachment view).
function isVoiceMessageFlag(rawValue, mime) {
  const truthy =
    rawValue === '1' ||
    rawValue === 'true' ||
    rawValue === true;

  return truthy && typeof mime === 'string' && mime.startsWith('audio/');
}


// Accepts whatever the client sent for reply_to_id (string, number,
// missing, null, garbage) and normalizes it to either a positive
// integer or null. Deliberately does NOT require the id to currently
// exist — CHAT_SELECT's LEFT JOIN already degrades a dangling/unknown
// id to reply_to: null, which the frontend renders as "Original
// message deleted", the same graceful fallback a genuinely-deleted
// message gets. No extra existence-check query needed.
function normalizeReplyToId(value) {

  if (value === undefined || value === null || value === '') {
    return null;
  }

  const id = Number.parseInt(value, 10);

  return (Number.isInteger(id) && id > 0) ? id : null;
}



function getRecentMessagesHandler(req,res) {

  const limit =
    clampLimit(req.query.limit);

  const messages =
    getRecentMessages(limit);

  const reactions =
    getReactionsForMessages('chat', messages.map(m => m.id));

  res.json(
    withReactions(withAttachmentFlag(messages), reactions)
  );
}



function getMessagesBeforeHandler(req,res) {

  const before =
    typeof req.query.before === 'string'
      ? req.query.before
      : new Date().toISOString();


  const limit =
    clampLimit(req.query.limit);


  const messages =
    getMessagesBefore(
      before,
      limit
    );

  const reactions =
    getReactionsForMessages('chat', messages.map(m => m.id));


  res.json(
    withReactions(withAttachmentFlag(messages), reactions)
  );
}



function getMessagesSinceHandler(req,res) {

  const since =
    typeof req.query.since === 'string'
      ? req.query.since
      : '1970-01-01T00:00:00.000Z';


  const limit =
    clampLimit(
      req.query.limit,
      100,
      200
    );


  const messages =
    getMessagesSince(
      since,
      limit
    );

  const reactions =
    getReactionsForMessages('chat', messages.map(m => m.id));


  res.json(
    withReactions(withAttachmentFlag(messages), reactions)
  );
}



function sendMessage(req,res) {

  const content =
    req.body?.content;


  if(
    !content ||
    !content.trim()
  ){

    return res.status(400).json({
      error:'Message cannot be empty'
    });

  }


  const text =
    content
      .trim()
      .slice(0,2000);


  const replyToId =
    normalizeReplyToId(req.body?.reply_to_id);


  const timestamp =
    new Date().toISOString();


  const info =
    insertChatMessage(
      req.user.id,
      text,
      timestamp,
      replyToId
    );


  const message =
    addAttachmentFlag(
      findChatMessageWithUser(
        info.lastInsertRowid
      )
    );


  emitNewChatMessage(message);


  res.json(message);

}



async function sendMessageWithAttachment(req,res) {

  if(!req.file){

    return res.status(400).json({
      error:'No file uploaded'
    });

  }


  const originalName =
    path.basename(
      req.file.originalname
    );


  const ext =
    path.extname(originalName)
      .toLowerCase();


  const clientMime =
    req.file.mimetype || '';


  // SECURITY: the mime resolved here is what later decides, at serve
  // time (getAttachment below), whether this file is ever allowed to
  // be shown `inline` in a browser. Neither the client-supplied
  // Content-Type (clientMime) nor the filename extension can be
  // trusted for that decision — both are fully attacker-controlled,
  // and trusting either one is exactly how a file uploaded as
  // "photo.jpg" with Content-Type: text/html turned attachment
  // *viewing* into stored XSS. The only thing we trust here is what
  // detectMimeFromBytes() finds by sniffing the file's actual magic
  // bytes on disk.
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
    // Trust the sniffed, allowlisted type.
    mime = sniffedMime;
  } else {
    // Sniffing failed to recognize the format, or recognized it as
    // something not on the inline-safe allowlist. A cosmetic,
    // extension-based label is still useful for the UI (file icon,
    // "type" shown to the user) for genuinely non-renderable formats
    // (.zip, .docx, .txt, ...) — but it must NEVER be trusted if it
    // happens to land on an inline-safe-looking value (e.g. the
    // extension is ".jpg" but the sniff didn't confirm real JPEG
    // bytes, which is exactly the original exploit: upload
    // arbitrary content as "photo.jpg"). getAttachment() decides
    // inline-vs-attachment purely from isInlineSafeMime(storedMime),
    // so anything that would pass that check has to have been
    // verified above — an extension-derived guess never gets to.
    const extLabel = CHAT_MIME_MAP[ext];
    mime =
      extLabel && !isInlineSafeMime(extLabel)
        ? extLabel
        : 'application/octet-stream';
  }


  const caption =
    (req.body.content || '')
      .trim()
      .slice(0,2000);


  const replyToId =
    normalizeReplyToId(req.body?.reply_to_id);


  const isVoiceMessage =
    isVoiceMessageFlag(req.body?.is_voice_message, mime);


  // Read pixel dimensions up front (image attachments only) so the
  // frontend can reserve the right amount of layout space for the
  // placeholder before it ever fetches the actual image bytes — see
  // utils/imageDimensions.js.
  const dims =
    mime.startsWith('image/')
      ? readImageDimensions(req.file.path, mime)
      : null;


  const timestamp =
    new Date().toISOString();


  const info =
    insertChatMessageWithAttachment(
      req.user.id,
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


  const message =
    addAttachmentFlag(
      findChatMessageWithUser(
        info.lastInsertRowid
      )
    );


  emitNewChatMessage(message);


  res.json(message);

}



function getAttachmentMediaToken(req, res) {
  const messageId = Number(req.params.messageId);

  if (!Number.isInteger(messageId)) {
    return res.status(400).json({
      error: 'Invalid message id'
    });
  }

  const msg = findChatMessageById(messageId);

  if (!msg || !msg.attachment_path) {
    return res.status(404).json({
      error: 'Attachment not found'
    });
  }

  const token = signMediaToken(req.user, {
    type: 'chat',
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

  const msg = findChatMessageById(messageId);

  if (!msg || !msg.attachment_path) {
    return res.status(404).json({
      error: 'Attachment not found'
    });
  }

  const filePath = path.join(
    constants.CHAT_UPLOAD_DIR,
    msg.attachment_path
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'Attachment not found'
    });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // SECURITY: `inline` rendering is only ever allowed when the
  // stored mime (resolved from the file's actual magic bytes at
  // upload time — see sendMessageWithAttachment above) is on the
  // server-side allowlist. This is what actually closes the stored-
  // XSS hole: even if `?download=1` is absent, and regardless of
  // whatever mime a client tried to claim, anything not on the
  // allowlist is always sent as a forced attachment with a generic
  // Content-Type — a browser will offer it for download rather than
  // execute/render it.
  const storedMime =
    msg.attachment_mime ||
    'application/octet-stream';

  const safeToRenderInline = isInlineSafeMime(storedMime);

  const disposition =
    (safeToRenderInline && !req.query.download)
      ? 'inline'
      : 'attachment';

  const contentType =
    safeToRenderInline
      ? storedMime
      : 'application/octet-stream';

  // Belt-and-suspenders: even for the allowlisted types above, never
  // let the browser's own MIME-sniffing override the Content-Type we
  // explicitly vetted.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename*=UTF-8''${encodeURIComponent(msg.attachment_name)}`
  );

  // Download request: send the whole file
  if (req.query.download) {
    res.setHeader('Content-Length', fileSize);

    const downloadStream = fs.createReadStream(filePath);
    // If the client disconnects before the file finishes sending
    // (closed tab, cancelled download), piping into `res` alone
    // doesn't stop the source read — without this, the server keeps
    // reading the rest of the file off disk and holding its file
    // descriptor open until the read completes, for a client that's
    // no longer there to receive any of it.
    //
    // BUG FIX: `req`'s 'close' event fires whenever the underlying
    // connection closes — not only on a genuine client abort. Behind
    // a reverse proxy that doesn't hold origin connections open (e.g.
    // Cloudflare), it can fire right as a *normal* response finishes,
    // sometimes a moment before `res` has actually flushed the last
    // chunk to the socket. Destroying the stream unconditionally then
    // truncates an otherwise-successful response — the client sees a
    // 200/206 with correct headers but a cut-off body, which browsers
    // surface as MEDIA_ERR_NETWORK for <audio>/<video>. Checking
    // `res.writableEnded` first means we only ever cancel a download
    // that's genuinely still in flight.
    req.on('close', () => {
      if (res.writableEnded) return;
      if (!downloadStream.destroyed) downloadStream.destroy();
    });
    return downloadStream.pipe(res);
  }

  // Browser requested a specific byte range
  const range = req.headers.range;

  if (!range) {
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');

    const fullStream = fs.createReadStream(filePath);
    // Same reasoning as the download branch above.
    req.on('close', () => {
      if (res.writableEnded) return;
      if (!fullStream.destroyed) fullStream.destroy();
    });
    return fullStream.pipe(res);
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);

  if (!match) {
    return res.status(416).setHeader(
      'Content-Range',
      `bytes */${fileSize}`
    ).end();
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : fileSize - 1;

  // Handle suffix ranges: bytes=-500000
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);

    start = Math.max(
      fileSize - suffixLength,
      0
    );

    end = fileSize - 1;
  }

  // Invalid range
  if (
    start < 0 ||
    end >= fileSize ||
    start > end
  ) {
    return res.status(416)
      .setHeader(
        'Content-Range',
        `bytes */${fileSize}`
      )
      .end();
  }

  const chunkSize = end - start + 1;

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

  const stream = fs.createReadStream(filePath, {
    start,
    end
  });

  stream.on('error', (err) => {
    console.error(
      'Attachment stream error:',
      err.message
    );

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });

  // This range endpoint is what video/audio scrubbing hits — every
  // seek cancels the browser's previous in-flight range request and
  // starts a new one. Without this, each cancelled request's read
  // stream keeps reading its (now unwanted) byte range off disk to
  // completion instead of stopping the moment the client moves on,
  // so scrubbing repeatedly through a large file could have several
  // abandoned reads running at once.
  //
  // BUG FIX: see the identical comment on the download-branch
  // req.on('close') above — must not destroy a stream whose response
  // has already finished sending, or a normal request can get its
  // tail end truncated (MEDIA_ERR_NETWORK client-side) if 'close'
  // fires slightly before the last chunk is flushed.
  req.on('close', () => {
    if (res.writableEnded) return;
    if (!stream.destroyed) stream.destroy();
  });

  stream.pipe(res);
}



function deleteMessage(req, res) {

  const id = parseInt(req.params.messageId, 10);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      error: 'Invalid message id'
    });
  }


  const msg = findChatMessageById(id);

  if (!msg) {
    return res.status(404).json({
      error: 'Message not found'
    });
  }


  const isOwner = msg.user_id === req.user.id;
  const isAdmin = !!req.user.is_admin;

  if (!isOwner && !isAdmin) {
    return res.status(403).json({
      error: 'You can only delete your own messages'
    });
  }


  if (msg.attachment_path) {

    const filePath = path.join(
      constants.CHAT_UPLOAD_DIR,
      msg.attachment_path
    );

    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error('Failed to delete chat attachment:', err.message);
      }
    });

  }


  deleteChatMessage(id);

  emitChatMessageDeleted(id);

  res.json({ success: true, id });

}



function toggleReactionHandler(req, res) {

  const id = parseInt(req.params.messageId, 10);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      error: 'Invalid message id'
    });
  }


  const emoji = (req.body.emoji || '').trim();

  if (!emoji || emoji.length > 32) {
    return res.status(400).json({
      error: 'Invalid emoji'
    });
  }


  const msg = findChatMessageById(id);

  if (!msg) {
    return res.status(404).json({
      error: 'Message not found'
    });
  }


  const action = toggleReaction('chat', id, req.user.id, emoji);
  const reactions = getReactionsForMessage('chat', id);

  emitChatReactionUpdate({
    message_id: id,
    reactions
  });

  res.json({ success: true, action, reactions });

}



module.exports = {

  getRecentMessages:
    getRecentMessagesHandler,

  getMessagesBefore:
    getMessagesBeforeHandler,

  getMessagesSince:
    getMessagesSinceHandler,

  sendMessage,

  sendMessageWithAttachment,

  getAttachmentMediaToken,

  getAttachment,

  deleteMessage,

  toggleReaction: toggleReactionHandler,

};