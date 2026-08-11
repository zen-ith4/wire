const fs = require('fs');
const path = require('path');

const { findFolderById } = require('../services/file.service');
const { getUserFolders, getFolderAccess } = require('../services/share.service');
const { safeSubPath } = require('../utils/safePath');
const { getMimeType, moveFileSafe } = require('../utils/file');

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

function listFiles(req, res) {
  const folderId = validateFolderId(req.params.folderId);
  if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });

  const result = getFolderAndAccess(req.user.id, folderId);
  if (result.error) return res.status(403).json({ error: result.error });

  const subpath = req.query.subpath || '';
  const target = safeSubPath(result.folder.path, subpath);
  if (!target || !fs.existsSync(target)) {
    return res.status(404).json({ error: 'Path not found' });
  }
  if (!fs.statSync(target).isDirectory()) {
    return res.status(400).json({ error: 'Not a directory' });
  }

  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter(x => !x.name.startsWith('.'))
    .map(x => {
      const full = path.join(target, x.name);
      const stat = fs.statSync(full);
      return {
        name: x.name,
        type: x.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    });

  res.json({ subpath, entries, can_write: !!result.access.can_write });
}

function uploadFile(req, res) {
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
  const dir = safeSubPath(result.folder.path, subpath);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    cleanupTemp();
    return res.status(404).json({ error: 'Destination folder not found' });
  }

  let name = path.basename(req.file.originalname);
  let finalPath = path.join(dir, name);
  let count = 1;
  while (fs.existsSync(finalPath)) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    name = `${base} (${count})${ext}`;
    finalPath = path.join(dir, name);
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
function downloadFile(req, res) {
  const folderId = validateFolderId(req.params.folderId);
  if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });

  const result = getFolderAndAccess(req.user.id, folderId);
  if (result.error) return res.status(403).json({ error: result.error });

  const subpath = req.query.subpath || '';
  const file = req.query.file; // نام فایل
  if (!file) return res.status(400).json({ error: 'File parameter missing' });

  const target = safeSubPath(result.folder.path, subpath);
  if (!target || !fs.existsSync(target)) {
    return res.status(404).json({ error: 'Path not found' });
  }
  if (!fs.statSync(target).isDirectory()) {
    return res.status(400).json({ error: 'Not a directory' });
  }

  const resolved = safeSubPath(target, file);
  if (!resolved || !fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(resolved, file);
}

// ============ اضافه شده: previewFile ============
function previewFile(req, res) {
  const folderId = validateFolderId(req.params.folderId);
  if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });

  const result = getFolderAndAccess(req.user.id, folderId);
  if (result.error) return res.status(403).json({ error: result.error });

  const subpath = req.query.subpath || '';
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'File parameter missing' });

  const target = safeSubPath(result.folder.path, subpath);
  if (!target || !fs.existsSync(target)) {
    return res.status(404).json({ error: 'Path not found' });
  }
  if (!fs.statSync(target).isDirectory()) {
    return res.status(400).json({ error: 'Not a directory' });
  }

  const resolved = safeSubPath(target, file);
  if (!resolved || !fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const mime = getMimeType(resolved); // تابع تشخیص mime که از utils/file گرفته می‌شود
  res.setHeader('Content-Type', mime);
  res.sendFile(resolved);
}

module.exports = {
  getFolders,
  listFiles,
  downloadFile,
  previewFile,
  uploadFile,
};