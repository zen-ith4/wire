const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { findFolderById, listAllFolders } = require('../services/file.service');
const { deleteLinksForPath } = require('../services/shareLink.service');
const { getUserFolders, getFolderAccess } = require('../services/share.service');
const {
  resolveRegularFile,
  resolveRegularDirectory,
  resolveDeletableEntry,
} = require('../utils/safePath');
const { moveFileSafe } = require('../utils/file');
const { detectMimeFromBytes } = require('../utils/detectFileType');
const { isInlineSafeMime } = require('../utils/inlineSafeMime');
const { describeMedia, sendInlineMedia } = require('../utils/streamMedia');
const {
  signFileMediaToken,
  FILE_MEDIA_TOKEN_TTL_SECONDS,
} = require('../utils/jwt');

function validateFolderId(value) {
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

function getFolders(req, res) {
  const folders = getUserFolders(req.user.id);
  res.json(
    folders.map(folder => ({
      id: folder.id,
      display_name: folder.display_name,
      can_write: !!folder.can_write,
    }))
  );
}

function getFolderAndAccess(userId, folderId) {
  const folder = findFolderById(folderId);
  if (!folder) return { error: 'Folder not found' };

  const access = getFolderAccess(userId, folderId);
  if (!access) return { error: 'Access denied' };

  return { folder, access };
}

// listFiles used to be built entirely on the *Sync fs APIs
// (readdirSync + one statSync per entry). Each of those blocks
// Node's single event loop thread for the syscall's duration, and
// the statSync loop in particular scales with the number of entries
// in the folder — a big "Drive"-style folder with thousands of
// files could stall every other in-flight request (chat, other
// downloads, everything) for as long as it takes to stat all of
// them, one at a time.
//
// This does the same two syscalls (readdir, stat) but through
// fs/promises, so each individual call yields to the event loop
// instead of blocking it. Per-entry stats are resolved with bounded
// concurrency (STAT_CONCURRENCY at a time) rather than either fully
// serial (slow) or fully parallel (a folder with 10,000 files would
// otherwise fire 10,000 simultaneous stat() syscalls / open file
// descriptors at once). The response shape, sorting, dotfile
// filtering, and error behavior are unchanged from the sync version.
const STAT_CONCURRENCY = 32;

async function statEntriesLimited(dirents, dirPath) {
  const results = new Array(dirents.length);
  let cursor = 0;

  async function worker() {
    while (cursor < dirents.length) {
      const i = cursor++;
      const dirent = dirents[i];
      const full = path.join(dirPath, dirent.name);
      let stat;
      try { stat = await fsp.stat(full); }
      catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      results[i] = {
        name: dirent.name,
        type: dirent.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    }
  }

  const workers = Array.from(
    { length: Math.min(STAT_CONCURRENCY, dirents.length) },
    worker
  );
  await Promise.all(workers);

  // Entries removed between readdir and stat leave holes; drop them so
  // the response never contains null. Order of the rest is preserved.
  return results.filter(Boolean);
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(req, res) {
  const folderId = validateFolderId(req.params.folderId);
  if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });

  const result = getFolderAndAccess(req.user.id, folderId);
  if (result.error) return res.status(403).json({ error: result.error });

  const subpath = req.query.subpath || '';
  // resolveRegularDirectory, not safeSubPath: `subpath` is entirely caller
  // supplied and can contain several segments, so it needs the realpath check
  // (a symlink inside the folder must not lead the listing outside it), the NUL
  // rejection and the "no dot segment" rule. Every failure is one generic 404
  // - never a 500, never a hint about which check failed.
  const dir = await resolveRegularDirectory(result.folder.path, subpath);

  try {
    if (!dir.ok) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const target = dir.fullPath;
    const dirents = (await fsp.readdir(target, { withFileTypes: true }))
      .filter(x => !x.name.startsWith('.'));

    // A symlink whose target sits outside the real root is not listed at all.
    // Listing it and then 404-ing on fetch would still tell the caller the name
    // exists; omitting it keeps the listing honest about what is reachable.
    const visible = [];
    for (const d of dirents) {
      if (!d.isSymbolicLink()) { visible.push(d); continue; }
      try {
        const real = await fsp.realpath(path.join(target, d.name));
        if (real === target || real.startsWith(target + path.sep)) visible.push(d);
      } catch { /* dangling link: nothing to list */ }
    }

    const entries = await statEntriesLimited(visible, target);

    res.json({ subpath, entries, can_write: !!result.access.can_write });

  } catch (err) {
    console.error('listFiles failed:', err.message);
    res.status(500).json({ error: 'Failed to list folder contents' });
  }
}

async function uploadFile(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const cleanupTemp = () => fs.unlink(req.file.path, () => {});

  const folderId = validateFolderId(req.params.folderId);
  if (!folderId) {
    cleanupTemp();
    return res.status(400).json({ error: 'Invalid folder id' });
  }

  const result = getFolderAndAccess(req.user.id, folderId);
  if (result.error || !result.access.can_write) {
    cleanupTemp();
    return res.status(403).json({ error: 'Write access denied' });
  }

  const subpath = req.body.subpath || '';
  // Same strict resolver as the read paths: the destination directory must not
  // be reachable through a symlink that leaves the folder root, and a NUL in
  // `subpath` must not reach fs.statSync (which threw, turning a bad request
  // into a 500).
  const dir = await resolveRegularDirectory(result.folder.path, subpath);
  if (!dir.ok) {
    cleanupTemp();
    return res.status(404).json({ error: 'Destination folder not found' });
  }

  // basename() already strips any directory part the client may have sent, but
  // the resulting name still has to be a plain, visible file name.
  let name = path.basename(req.file.originalname);
  if (!name || name.includes('\0') || name.startsWith('.')) {
    cleanupTemp();
    return res.status(400).json({ error: 'Invalid file name' });
  }

  let finalPath = path.join(dir.fullPath, name);
  let count = 1;
  while (fs.existsSync(finalPath)) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    name = `${base} (${count})${ext}`;
    finalPath = path.join(dir.fullPath, name);
    count++;
  }

  try {
    moveFileSafe(req.file.path, finalPath);
  } catch (err) {
    console.error('File upload failed to move into place:', err.message);
    cleanupTemp();
    return res.status(500).json({ error: 'Failed to save the uploaded file' });
  }

  res.json({ success: true, name });
}

// ============ اضافه شده: downloadFile ============
async function downloadFile(req, res) {
  const folderId = validateFolderId(req.params.folderId);
  if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });

  const result = getFolderAndAccess(req.user.id, folderId);
  if (result.error) return res.status(403).json({ error: result.error });

  const subpath = req.query.subpath || '';
  const file = req.query.file; // نام فایل
  if (!file) return res.status(400).json({ error: 'File parameter missing' });

  // resolveRegularFile, not safeSubPath: it rejects a NUL byte, a "."
  // subpath, a hidden segment and a "file" containing a separator, and it
  // compares the REAL path against the REAL root, so a symlink inside the
  // folder cannot be used to read a file outside it. One generic 404 for all of
  // those, which is also why there is no statSync() here any more: a NUL made
  // it throw and turn a bad request into a 500.
  const resolved = await resolveRegularFile(result.folder.path, subpath, file);
  if (!resolved.ok) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(resolved.fullPath, file);
}

// ============ اضافه شده: previewFile ============
//
// SECURITY: this used to trust getMimeType(resolved) — a lookup based
// purely on the file's *extension* on disk, which the uploader fully
// controls (fileUpload has no extension/type filtering, same as the
// chat/DM uploaders). Combined with res.sendFile() never setting
// Content-Disposition, that meant an attacker with write access to a
// shared folder could upload e.g. "evil.html" and have it served as
// `Content-Type: text/html` inline — stored XSS in this app's own
// origin the moment a victim clicked "Preview" (not even "Download").
//
// The fix mirrors chat/DM attachments: the *actual* file content is
// sniffed via magic bytes, and inline rendering is only ever allowed
// when that sniffed type is on the shared inline-safe allowlist.
// Anything else is served as a forced attachment with a generic
// Content-Type, so "Preview" can never execute attacker content —
// it just falls back to a download for file types we can't safely
// render.
async function previewFile(req, res) {
  const folderId = validateFolderId(req.params.folderId);
  if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });

  const result = getFolderAndAccess(req.user.id, folderId);
  if (result.error) return res.status(403).json({ error: result.error });

  const subpath = req.query.subpath || '';
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'File parameter missing' });

  // Same strict resolver as downloadFile - see the note there. The success path
  // below is untouched: the bytes are still sniffed with magic bytes and still
  // only rendered inline when that sniffed type is on the allowlist.
  const resolved = await resolveRegularFile(result.folder.path, subpath, file);
  if (!resolved.ok) {
    return res.status(404).json({ error: 'File not found' });
  }

  const sniffedMime = await detectMimeFromBytes(resolved.fullPath);
  const safeToRenderInline = isInlineSafeMime(sniffedMime);

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (safeToRenderInline) {
    res.setHeader('Content-Type', sniffedMime);
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`
    );
    return res.sendFile(resolved.fullPath);
  }

  // Not a type we've verified is safe to render inline — fall back
  // to a forced download instead of ever letting the browser render
  // it, regardless of the file's extension or the caller's intent to
  // "preview" it.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`
  );
  return res.sendFile(resolved.fullPath);
}

// ============ Delete a file / folder ============
//
// DELETE /api/files/item/:folderId?subpath=<dir>&file=<name>
//
// Only the OWNER of the folder may delete inside it. "Can edit" members
// may upload (see share.js: "Can edit lets someone upload files"), but
// deleting is not part of what they were granted, and it mirrors the
// other owner-only actions (share links, sharing, deleting the folder).
//
// Storage model: only the top-level folder has database rows (folders /
// user_folders). Files and sub-folders exist only on disk, so removing
// them is a filesystem operation; the one table that points INTO a
// folder is share_links (folder_id + rel_path), and those rows are
// removed with the file so no dead link is left behind.
//
// A directory is removed together with everything in it (recursive).
// It is refused while another registered folder lives inside it,
// because removing it would strand that folder's database row.
function isSameOrInside(candidate, target) {
  const a = path.resolve(candidate);
  const b = path.resolve(target);

  return a === b || a.startsWith(b + path.sep);
}

async function deleteEntry(req, res) {
  const folderId = validateFolderId(req.params.folderId);
  if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });

  const folder = findFolderById(folderId);

  if (!folder || folder.owner_id !== req.user.id) {
    return res.status(403).json({
      error: 'Only the folder owner can delete files',
    });
  }

  const subpath = typeof req.query.subpath === 'string' ? req.query.subpath : '';
  const name = typeof req.query.file === 'string' ? req.query.file : '';

  const target = await resolveDeletableEntry(folder.path, subpath, name);

  if (!target.ok) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (target.type === 'dir') {
    const strandsFolder = listAllFolders().some(
      (other) =>
        other.id !== folder.id &&
        (isSameOrInside(other.path, target.fullPath) ||
          isSameOrInside(other.path, target.lexicalPath))
    );

    if (strandsFolder) {
      return res.status(409).json({
        error: 'This folder contains another shared folder. Delete that one from the Folders list first.',
      });
    }
  }

  try {
    if (target.type === 'dir') {
      // Recursive, but never follows symlinks: a link inside the tree
      // is unlinked, its destination is left alone.
      await fsp.rm(target.fullPath, { recursive: true });
    } else {
      await fsp.unlink(target.fullPath);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }

    console.error('deleteEntry failed:', err.message);
    return res.status(500).json({ error: 'Failed to delete' });
  }

  // The bytes are gone; now drop the rows that pointed at them. A
  // failure here is logged, not surfaced: the delete DID happen, and a
  // leftover link already answers "invalid or expired" because its
  // target no longer resolves (shareLink.controller.js).
  try {
    deleteLinksForPath(folder.id, target.relPath, target.type === 'dir');
  } catch (err) {
    console.error('deleteEntry: failed to remove share links:', err.message);
  }

  res.json({
    success: true,
    name: target.name,
    type: target.type === 'dir' ? 'dir' : 'file',
  });
}

// ============ Media preview (image / video / audio) ============
//
// <video>/<audio>/<img> can't send an Authorization header, so the My
// Files viewer works in two steps:
//
//   1. GET /api/files/media-token/:folderId?subpath&file   (normal
//      Bearer auth) -> a short-lived token bound to exactly this
//      file, plus the file's sniffed type/size for the viewer's UI.
//   2. GET /api/files/stream/:folderId?subpath&file&token=...
//      (folderFileMediaAuth) -> the bytes, inline, with Range support.
//
// Nothing is downloaded into JS memory to preview; the browser streams
// it natively. Folder access is re-checked on both steps, so removing
// someone's access stops streaming immediately.

async function resolveFolderFile(req, res) {
  const folderId = validateFolderId(req.params.folderId);
  if (!folderId) {
    res.status(400).json({ error: 'Invalid folder id' });
    return null;
  }

  const result = getFolderAndAccess(req.user.id, folderId);
  if (result.error) {
    res.status(403).json({ error: result.error });
    return null;
  }

  const subpath = typeof req.query.subpath === 'string' ? req.query.subpath : '';
  const file = typeof req.query.file === 'string' ? req.query.file : '';

  const target = await resolveRegularFile(result.folder.path, subpath, file);
  if (!target.ok) {
    res.status(404).json({ error: 'File not found' });
    return null;
  }

  return { folderId, subpath, file, target };
}

async function getFileMediaToken(req, res) {
  const resolved = await resolveFolderFile(req, res);
  if (!resolved) return;

  const media = await describeMedia(resolved.target);
  if (!media) {
    return res.status(415).json({
      error: "This file type can't be previewed",
    });
  }

  const token = signFileMediaToken(req.user, {
    type: 'file',
    id: resolved.folderId,
    sp: resolved.subpath,
    f: resolved.file,
  });

  res.set('Cache-Control', 'private, no-store');
  res.json({
    token,
    expiresIn: FILE_MEDIA_TOKEN_TTL_SECONDS,
    kind: media.kind,
    mime: media.mime,
    size: resolved.target.size,
    modified: resolved.target.modified,
  });
}

async function streamFile(req, res) {
  const resolved = await resolveFolderFile(req, res);
  if (!resolved) return;

  const media = await describeMedia(resolved.target);
  if (!media) {
    return res.status(415).json({
      error: "This file type can't be previewed",
    });
  }

  sendInlineMedia(res, resolved.target, media);
}

module.exports = {
  statEntriesLimited,
  getFolders,
  listFiles,
  downloadFile,
  previewFile,
  uploadFile,
  deleteEntry,
  getFileMediaToken,
  streamFile,
};