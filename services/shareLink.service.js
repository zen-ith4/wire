const crypto = require('crypto');
const { getDb } = require('../config/database');

// ---------------------------------------------------------------
// Share links
//
// A share link is an OPAQUE capability: whoever presents the token
// (while logged into Wire — see controllers/shareLink.controller.js)
// can read exactly one file, until the link expires, is revoked, or
// the file/folder/owner behind it goes away.
//
// Token:  32 bytes from crypto.randomBytes (256 bits of entropy),
//         base64url encoded -> always 43 characters. Nothing about
//         the file, folder, user or time is encoded in it.
// Stored: only SHA-256(token). SHA-256 (not a slow password hash) is
//         the right tool here: the input is already 256 random bits,
//         so there is nothing to brute-force, and lookups stay O(1)
//         through the UNIQUE index. The raw token exists only in the
//         creation response and in the link the owner copies.
// ---------------------------------------------------------------

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Seconds. 0 = never expires. Anything else is rejected, so a client
// cannot mint a link that lives for an arbitrary/absurd duration.
const EXPIRY_PRESETS = Object.freeze([3600, 86400, 604800, 2592000, 0]);
const DEFAULT_EXPIRY_SECONDS = 604800; // 7 days

const MAX_ACTIVE_LINKS_PER_FILE = 10;
const MAX_ACTIVE_LINKS_PER_USER = 200;

class ShareLinkLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShareLinkLimitError';
    this.statusCode = 409;
  }
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function isWellFormedToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

function isExpired(row, now = Date.now()) {
  if (!row.expires_at) return false;

  const at = Date.parse(row.expires_at);
  // An unparseable expiry is treated as already expired (fail closed).
  return !Number.isFinite(at) || at <= now;
}

function publicView(row) {
  return {
    id: row.id,
    file_name: row.file_name,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

// Expired links are dead weight and can never be used again, so they
// are deleted rather than accumulated.
function purgeExpiredLinks(now = Date.now()) {
  return getDb()
    .prepare(`
      DELETE FROM share_links
      WHERE expires_at IS NOT NULL
      AND expires_at <= ?
    `)
    .run(new Date(now).toISOString());
}

function countActive(whereSql, ...params) {
  return getDb()
    .prepare(`SELECT COUNT(*) AS count FROM share_links WHERE ${whereSql}`)
    .get(...params).count;
}

function createLink({
  folderId,
  relPath,
  fileName,
  createdBy,
  expiresInSeconds = DEFAULT_EXPIRY_SECONDS,
}) {
  if (!EXPIRY_PRESETS.includes(expiresInSeconds)) {
    throw new RangeError('Unsupported expiry');
  }

  const now = Date.now();

  purgeExpiredLinks(now);

  if (
    countActive('folder_id = ? AND rel_path = ?', folderId, relPath) >=
    MAX_ACTIVE_LINKS_PER_FILE
  ) {
    throw new ShareLinkLimitError(
      'This file already has the maximum number of active links. Revoke one first.'
    );
  }

  if (countActive('created_by = ?', createdBy) >= MAX_ACTIVE_LINKS_PER_USER) {
    throw new ShareLinkLimitError(
      'You have reached the maximum number of active links. Revoke some first.'
    );
  }

  const token = generateToken();

  const createdAt = new Date(now).toISOString();
  const expiresAt =
    expiresInSeconds > 0
      ? new Date(now + expiresInSeconds * 1000).toISOString()
      : null;

  const info = getDb()
    .prepare(`
      INSERT INTO share_links
      (
        token_hash,
        folder_id,
        rel_path,
        file_name,
        created_by,
        created_at,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      hashToken(token),
      folderId,
      relPath,
      fileName,
      createdBy,
      createdAt,
      expiresAt
    );

  return {
    // The ONLY place the raw token exists server-side.
    token,
    link: {
      id: Number(info.lastInsertRowid),
      file_name: fileName,
      created_at: createdAt,
      expires_at: expiresAt,
    },
  };
}

// Returns the row for a live (existing, unexpired) link, or null.
// Malformed input is rejected before touching the database.
function findActiveLinkByToken(token) {
  if (!isWellFormedToken(token)) return null;

  const row = getDb()
    .prepare('SELECT * FROM share_links WHERE token_hash = ?')
    .get(hashToken(token));

  if (!row || isExpired(row)) return null;

  return row;
}

function findActiveLinkById(id) {
  if (!Number.isInteger(id)) return null;

  const row = getDb()
    .prepare('SELECT * FROM share_links WHERE id = ?')
    .get(id);

  if (!row || isExpired(row)) return null;

  return row;
}

function listActiveLinksForFile(folderId, relPath, createdBy) {
  purgeExpiredLinks();

  return getDb()
    .prepare(`
      SELECT *
      FROM share_links
      WHERE folder_id = ?
      AND rel_path = ?
      AND created_by = ?
      ORDER BY created_at DESC, id DESC
    `)
    .all(folderId, relPath, createdBy)
    .map(publicView);
}

// Hard delete: a revoked link and a link that never existed are
// indistinguishable to anyone who still holds the URL.
function deleteLink(id, createdBy) {
  return getDb()
    .prepare('DELETE FROM share_links WHERE id = ? AND created_by = ?')
    .run(id, createdBy).changes;
}

// Removes every link that pointed at a file that no longer exists:
// the file itself (relPath) or, when a whole directory was deleted,
// everything beneath it. The prefix test uses substr()/length() rather
// than LIKE so file names containing % or _ are never treated as
// wildcards and the match stays case-sensitive, like the filesystem.
function deleteLinksForPath(folderId, relPath, includeDescendants = false) {
  if (!includeDescendants) {
    return getDb()
      .prepare('DELETE FROM share_links WHERE folder_id = ? AND rel_path = ?')
      .run(folderId, relPath).changes;
  }

  const prefix = `${relPath}/`;

  return getDb()
    .prepare(`
      DELETE FROM share_links
      WHERE folder_id = ?
      AND (
        rel_path = ?
        OR substr(rel_path, 1, length(?)) = ?
      )
    `)
    .run(folderId, relPath, prefix, prefix).changes;
}

module.exports = {
  EXPIRY_PRESETS,
  DEFAULT_EXPIRY_SECONDS,
  MAX_ACTIVE_LINKS_PER_FILE,
  MAX_ACTIVE_LINKS_PER_USER,
  ShareLinkLimitError,
  generateToken,
  hashToken,
  isWellFormedToken,
  createLink,
  findActiveLinkByToken,
  findActiveLinkById,
  listActiveLinksForFile,
  deleteLink,
  deleteLinksForPath,
  purgeExpiredLinks,
};
