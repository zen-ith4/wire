const path = require('path');
const fs = require('fs');

const constants = require('../config/constants');
const { CHAT_MIME_MAP } = require('../config/multer');

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

  return message;
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


  const timestamp =
    new Date().toISOString();


  const info =
    insertChatMessage(
      req.user.id,
      text,
      timestamp
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



function sendMessageWithAttachment(req,res) {

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


  const mime =
    CHAT_MIME_MAP[ext]
    ||
    req.file.mimetype
    ||
    'application/octet-stream';


  const caption =
    (req.body.content || '')
      .trim()
      .slice(0,2000);


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
      mime
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



function getAttachment(req,res) {

  const messageId =
    Number(req.params.messageId);


  if(!Number.isInteger(messageId)){

    return res.status(400).json({
      error:'Invalid message id'
    });

  }


  const msg =
    findChatMessageById(
      messageId
    );


  if(
    !msg ||
    !msg.attachment_path
  ){

    return res.status(404).json({
      error:'Attachment not found'
    });

  }


  const filePath =
    path.join(
      constants.CHAT_UPLOAD_DIR,
      msg.attachment_path
    );


  if(!fs.existsSync(filePath)){

    return res.status(404).json({
      error:'Attachment not found'
    });

  }


  const disposition =
    req.query.download
      ? 'attachment'
      : 'inline';


  res.setHeader(
    'Content-Type',
    msg.attachment_mime ||
    'application/octet-stream'
  );


  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename*=UTF-8''${encodeURIComponent(msg.attachment_name)}`
  );


  fs.createReadStream(filePath)
    .pipe(res);

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

  getAttachment,

  deleteMessage,

  toggleReaction: toggleReactionHandler,

};