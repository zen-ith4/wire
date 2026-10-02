const { findFolderById } = require('../services/file.service');
const { getDb } = require('../config/database');

const {
  EXPIRY_PRESETS,
  DEFAULT_EXPIRY_SECONDS,
  ShareLinkLimitError,
  createLink,
  findActiveLinkByToken,
  findActiveLinkById,
  listActiveLinksForFile,
  deleteLink,
} = require('../services/shareLink.service');

const {
  resolveRegularFile,
  splitRelPath,
} = require('../utils/safePath');

const { describeMedia, sendInlineMedia } = require('../utils/streamMedia');
const { signFileMediaToken, FILE_MEDIA_TOKEN_TTL_SECONDS } = require('../utils/jwt');

// ---------------------------------------------------------------
// SECURITY MODEL (decision: option A — login required)
//
// A share link is NOT a public link. It works for any signed-in,
// active Wire user who holds the opaque token; nobody else. There is
// deliberately no unauthenticated file endpoint anywhere in this
// feature, so the normal session model, ipRestrict/VPN boundary and
// rate limiting all still apply, and the authenticated
// /api/files/download/... endpoint is never exposed to link holders.
//
// The token is never placed in a request URL path or query string:
// it travels in a JSON body (POST /links/resolve, /links/media-token)
// or an `X-Share-Token` header (GET /links/file), so it cannot end up
// in access logs, and the web link itself keeps it in the URL
// FRAGMENT (`#share/<token>`), which browsers never send to the
// server or in a Referer header. Media elements get a separate,
// 5-minute, link-scoped media token instead.
//
// Every failure a link holder can cause (malformed, unknown, revoked,
// expired, folder deleted, ownership changed, file deleted or moved,
// creator deactivated) returns the SAME 404 with the SAME message, so
// the endpoints can't be used to learn which of those it was.
// ---------------------------------------------------------------

const UNAVAILABLE_MESSAGE = 'This link is invalid or has expired';

function unavailable(res) {
  return res.status(404).json({
    error: UNAVAILABLE_MESSAGE,
    code: 'LINK_UNAVAILABLE',
  });
}

function toId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Re-validates everything a link depends on, at request time:
//   - the folder still exists
//   - the link's creator STILL owns it (deleting the owner nulls
//     folders.owner_id; a transferred folder must not keep old links)
//   - the creator's account is still active
//   - the file still exists, is a regular file, and still resolves
//     inside the folder root (symlink-safe)
async function resolveLinkTarget(link) {
  const folder = findFolderById(link.folder_id);

  if (!folder || folder.owner_id !== link.created_by) return null;

  const creator = getDb()
    .prepare('SELECT username, is_active FROM users WHERE id = ?')
    .get(link.created_by);

  if (!creator || creator.is_active === 0) return null;

  const { subpath, file } = splitRelPath(link.rel_path);
  const target = await resolveRegularFile(folder.path, subpath, file);

  if (!target.ok) return null;

  return { target, sharedBy: creator.username };
}

function noStore(res) {
  res.set('Cache-Control', 'private, no-store');
}

// ---------------- owner endpoints ----------------

// Only the folder OWNER may create/list/revoke links. Read-only or
// can-edit members can already open the file inside Wire, but must not
// be able to hand it to people the owner never granted access to —
// same rule as folder sharing itself (share.controller.js).
function requireOwnedFolder(req, res, folderIdRaw) {
  const folderId = toId(folderIdRaw);

  if (!folderId) {
    res.status(400).json({ error: 'Invalid request' });
    return null;
  }

  const folder = findFolderById(folderId);

  if (!folder || folder.owner_id !== req.user.id) {
    res.status(403).json({ error: 'Only the folder owner can share files by link' });
    return null;
  }

  return folder;
}

async function createLinkHandler(req, res) {
  const body = req.body || {};

  const folder = requireOwnedFolder(req, res, body.folder_id);
  if (!folder) return;

  const expiresIn =
    body.expires_in === undefined || body.expires_in === null
      ? DEFAULT_EXPIRY_SECONDS
      : Number(body.expires_in);

  if (!EXPIRY_PRESETS.includes(expiresIn)) {
    return res.status(400).json({ error: 'Invalid expiry' });
  }

  const target = await resolveRegularFile(
    folder.path,
    typeof body.subpath === 'string' ? body.subpath : '',
    typeof body.file === 'string' ? body.file : ''
  );

  if (!target.ok) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const { token, link } = createLink({
      folderId: folder.id,
      relPath: target.relPath,
      fileName: target.name,
      createdBy: req.user.id,
      expiresInSeconds: expiresIn,
    });

    noStore(res);
    return res.status(201).json({ ...link, token });

  } catch (err) {
    if (err instanceof ShareLinkLimitError) {
      return res.status(409).json({ error: err.message });
    }

    throw err;
  }
}

async function listLinksHandler(req, res) {
  const folder = requireOwnedFolder(req, res, req.query.folder_id);
  if (!folder) return;

  const target = await resolveRegularFile(
    folder.path,
    typeof req.query.subpath === 'string' ? req.query.subpath : '',
    typeof req.query.file === 'string' ? req.query.file : ''
  );

  if (!target.ok) {
    return res.status(404).json({ error: 'File not found' });
  }

  noStore(res);
  // Ids and dates only — the raw token is unrecoverable by design.
  return res.json(listActiveLinksForFile(folder.id, target.relPath, req.user.id));
}

function revokeLinkHandler(req, res) {
  const id = toId(req.params.id);

  if (!id) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  // deleteLink() is scoped to created_by, so someone else's link id
  // is indistinguishable from one that doesn't exist.
  const removed = deleteLink(id, req.user.id);

  if (!removed) {
    return res.status(404).json({ error: 'Link not found' });
  }

  return res.json({ success: true });
}

// ---------------- link-holder endpoints ----------------

// POST /api/share/links/resolve   { token }
async function resolveLinkHandler(req, res) {
  noStore(res);

  const link = findActiveLinkByToken(req.body?.token);
  if (!link) return unavailable(res);

  const resolved = await resolveLinkTarget(link);
  if (!resolved) return unavailable(res);

  const media = await describeMedia(resolved.target);

  return res.json({
    file_name: resolved.target.name,
    size: resolved.target.size,
    modified: resolved.target.modified,
    kind: media ? media.kind : null,
    mime: media ? media.mime : null,
    shared_by: resolved.sharedBy,
    created_at: link.created_at,
    expires_at: link.expires_at,
  });
}

// POST /api/share/links/media-token   { token }
// -> a 5-minute token that only opens GET /links/stream/:linkId for
//    THIS link (the URL then contains the link's numeric id and that
//    token, never the share token).
async function linkMediaTokenHandler(req, res) {
  noStore(res);

  const link = findActiveLinkByToken(req.body?.token);
  if (!link) return unavailable(res);

  const resolved = await resolveLinkTarget(link);
  if (!resolved) return unavailable(res);

  const media = await describeMedia(resolved.target);

  if (!media) {
    return res.status(415).json({
      error: "This file type can't be previewed",
    });
  }

  const token = signFileMediaToken(req.user, {
    type: 'sharelink',
    id: link.id,
  });

  return res.json({
    token,
    expiresIn: FILE_MEDIA_TOKEN_TTL_SECONDS,
    link_id: link.id,
    kind: media.kind,
    mime: media.mime,
  });
}

// GET /api/share/links/stream/:linkId?token=<media token>
async function streamLinkHandler(req, res) {
  const link = findActiveLinkById(toId(req.params.linkId));
  if (!link) return unavailable(res);

  const resolved = await resolveLinkTarget(link);
  if (!resolved) return unavailable(res);

  const media = await describeMedia(resolved.target);

  if (!media) {
    return res.status(415).json({
      error: "This file type can't be previewed",
    });
  }

  return sendInlineMedia(res, resolved.target, media);
}

// GET /api/share/links/file      (Authorization + X-Share-Token)
// Attachment download for the "Download" button. The token comes in a
// header so it never appears in a URL, and the client's existing
// native/web download code can send extra headers as-is.
async function downloadLinkHandler(req, res) {
  const link = findActiveLinkByToken(req.get('x-share-token'));
  if (!link) return unavailable(res);

  const resolved = await resolveLinkTarget(link);
  if (!resolved) return unavailable(res);

  noStore(res);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  return res.download(resolved.target.fullPath, resolved.target.name, {
    dotfiles: 'allow',
    cacheControl: false,
    headers: { 'Content-Type': 'application/octet-stream' },
  }, (err) => {
    if (!err || res.headersSent) return;

    // Don't let a JSON error body be saved as a "download".
    res.removeHeader('Content-Disposition');
    unavailable(res);
  });
}

module.exports = {
  UNAVAILABLE_MESSAGE,
  createLinkHandler,
  listLinksHandler,
  revokeLinkHandler,
  resolveLinkHandler,
  linkMediaTokenHandler,
  streamLinkHandler,
  downloadLinkHandler,
};
