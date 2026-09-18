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

module.exports = {
  signToken,
  verifyToken,
  signMediaToken,
  verifyMediaToken,
  MEDIA_TOKEN_TTL_SECONDS,
};