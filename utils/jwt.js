const jwt = require('jsonwebtoken');
const constants = require('../config/constants');

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      is_admin: !!user.is_admin,
    },
    constants.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, constants.JWT_SECRET);
}

// ======================================================
// SESSION-TOKEN-ONLY VERIFICATION
//
// verifyToken() above only checks the JWT signature/expiry — it says
// nothing about *what kind* of token was presented. Media tokens
// (see signMediaToken/verifyMediaToken below) are also valid,
// correctly-signed JWTs, just narrowly scoped (one attachment,
// ~90 seconds). Any call site that grants general account access —
// the `authenticate` middleware, and the Authorization-header path
// in `mediaAuth` — must reject a media token the same way it would
// reject a garbage token, or a token minted for one 90-second,
// one-attachment download would silently work as a full session
// token everywhere else (chat, DMs, settings, even admin routes for
// an admin user) for as long as it stays valid.
//
// This wraps verifyToken() and adds exactly that check, so every
// "give me the logged-in user" call site enforces it the same way
// instead of each one remembering to check `payload.typ` itself.
function verifySessionToken(token) {
  const payload = verifyToken(token);

  if (payload.typ === 'media') {
    const err = new Error(
      'Media token cannot be used as a session token'
    );
    err.code = 'MEDIA_TOKEN_NOT_ALLOWED';
    throw err;
  }

  return payload;
}

// ======================================================
// MEDIA TOKENS
//
// <video>/<audio>/<img> elements can't send a custom Authorization
// header, so media requests authenticate via a `?token=` query
// param instead (see middleware/mediaAuth.js). Putting the normal
// 24h session JWT there means it can leak via browser history or a
// Referer header for as long as the session lives.
//
// Media tokens fix that by being both short-lived (expire in
// MEDIA_TOKEN_TTL_SECONDS) and narrowly scoped to one specific
// attachment (`resType`/`resId`) — even if one leaks, it's useless
// after ~90 seconds and useless for anything except the one
// attachment it was minted for.
// ======================================================

const MEDIA_TOKEN_TTL_SECONDS = 90;

function signMediaToken(user, resource) {
  return jwt.sign(
    {
      sub: user.id,
      typ: 'media',
      resType: resource.type,
      resId: resource.id,
    },
    constants.JWT_SECRET,
    { expiresIn: MEDIA_TOKEN_TTL_SECONDS }
  );
}

// Verifies both the JWT signature/expiry AND that the token was
// minted for this exact resource — a valid, unexpired media token
// for attachment 5 must not authorize a request for attachment 6.
function verifyMediaToken(token, resource) {
  const payload = jwt.verify(token, constants.JWT_SECRET);

  if (
    payload.typ !== 'media' ||
    payload.resType !== resource.type ||
    Number(payload.resId) !== Number(resource.id)
  ) {
    const err = new Error('Media token scope mismatch');
    err.code = 'MEDIA_SCOPE_MISMATCH';
    throw err;
  }

  return payload;
}

// ======================================================
// FILE MEDIA TOKENS (My Files preview + share links)
//
// Same idea and same guarantees as the media tokens above (short-lived,
// `typ: 'media'` so they are rejected as session tokens by
// verifySessionToken()), but scoped to a FILE rather than a numeric
// chat/DM message id:
//
//   type 'file'       -> id = folderId, sp = subpath, f = file name
//   type 'sharelink'  -> id = share_links.id
//
// The token is bound to every one of those values, so a token minted
// for one file cannot be replayed against another file, another folder
// or a chat/DM attachment (their resType is 'chat'/'dm').
//
// TTL is longer than the 90 s chat tokens because a <video> element
// issues new Range requests (with the same URL) every time the user
// seeks; the client re-mints on a 401 and resumes (see files/viewer.js).
// ======================================================

const FILE_MEDIA_TOKEN_TTL_SECONDS = 300;

function signFileMediaToken(user, resource) {
  return jwt.sign(
    {
      sub: user.id,
      typ: 'media',
      resType: resource.type,
      resId: resource.id,
      sp: resource.sp || '',
      f: resource.f || '',
    },
    constants.JWT_SECRET,
    { expiresIn: FILE_MEDIA_TOKEN_TTL_SECONDS }
  );
}

function verifyFileMediaToken(token, resource) {
  const payload = jwt.verify(token, constants.JWT_SECRET);

  if (
    payload.typ !== 'media' ||
    payload.resType !== resource.type ||
    Number(payload.resId) !== Number(resource.id) ||
    (payload.sp || '') !== (resource.sp || '') ||
    (payload.f || '') !== (resource.f || '')
  ) {
    const err = new Error('Media token scope mismatch');
    err.code = 'MEDIA_SCOPE_MISMATCH';
    throw err;
  }

  return payload;
}

module.exports = {
  signToken,
  verifyToken,
  verifySessionToken,
  signMediaToken,
  verifyMediaToken,
  MEDIA_TOKEN_TTL_SECONDS,
  signFileMediaToken,
  verifyFileMediaToken,
  FILE_MEDIA_TOKEN_TTL_SECONDS,
};