// ============================================================
// Native (Capacitor Android) download destination.
//
// On Android, Wire no longer drops downloads into the shared
// Download/ folder. Instead, like Telegram, it keeps its own tree
// under external storage:
//
//   Wire/Images/
//   Wire/Videos/
//   Wire/Audio/
//   Wire/Files/
//
// This is the ONE place that decides which category a file belongs
// in and picks a safe, non-colliding path for it. Every native
// download path — Drive/Files-tab downloads and shared links
// (files/download.js), plus chat/DM attachments including voice
// messages (media/attachments.js) — calls into this module so there
// is a single categorization/storage implementation, not one per
// caller.
//
// Web and Electron never call this module: they keep the existing
// blob/<a download> behavior untouched.
// ============================================================

import { Filesystem, Directory } from '../vendor/capacitor.js';

export const WIRE_ROOT = 'Wire';

// MIME type is checked first; this table is only the fallback for
// when a caller doesn't know (or the server didn't send) a MIME
// type, keyed by extension.
const EXTENSION_CATEGORY = {
  // Images
  jpg: 'Images', jpeg: 'Images', png: 'Images', gif: 'Images',
  webp: 'Images', bmp: 'Images', svg: 'Images', heic: 'Images', heif: 'Images',

  // Videos
  mp4: 'Videos', webm: 'Videos', mkv: 'Videos', mov: 'Videos',
  avi: 'Videos', '3gp': 'Videos',

  // Audio (also covers Wire voice messages, which download as ogg/opus/m4a)
  mp3: 'Audio', wav: 'Audio', ogg: 'Audio', oga: 'Audio',
  opus: 'Audio', m4a: 'Audio', aac: 'Audio', flac: 'Audio',
};

/** Same rules the rest of the download pipeline already used. Keeps
 * Unicode (Persian, Arabic, Cyrillic, emoji, spaces) intact and only
 * strips characters that are unsafe as an Android filename. */
export function sanitizeFilename(name) {
  const original = typeof name === 'string' ? name.trim() : '';

  const cleaned = original
    .replace(/[\/\\?%*:|"<>]/g, '_')
    .replace(/[\u0000-\u001F\u007F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || 'download';
}

function extensionOf(filename) {
  const value = String(filename || '');
  const dot = value.lastIndexOf('.');

  if (dot <= 0 || dot === value.length - 1) return '';
  return value.slice(dot + 1).toLowerCase();
}

/** Splits "photo.jpg" into { base: "photo", ext: "jpg" }. No extension
 * (or a dotfile like ".gitignore") keeps the whole name as `base`. */
function splitExtension(filename) {
  const ext = extensionOf(filename);
  if (!ext) return { base: filename, ext: '' };

  return { base: filename.slice(0, -(ext.length + 1)), ext };
}

/** 'Images' | 'Videos' | 'Audio' | 'Files'. MIME type first, filename
 * extension as a fallback when the MIME type is missing or generic
 * (e.g. application/octet-stream). */
export function categoryFor(mimeType, filename) {
  const mime = String(mimeType || '').toLowerCase().trim();

  if (mime.startsWith('image/')) return 'Images';
  if (mime.startsWith('video/')) return 'Videos';
  if (mime.startsWith('audio/')) return 'Audio';

  const byExtension = EXTENSION_CATEGORY[extensionOf(filename)];
  return byExtension || 'Files';
}

async function pathExists(path) {
  try {
    await Filesystem.stat({ path, directory: Directory.ExternalStorage });
    return true;
  } catch {
    // Filesystem.stat rejects when nothing exists at `path`.
    return false;
  }
}

/** Creates Wire/<category> the first time it's needed. A concurrent
 * or earlier "already exists" failure is expected and fine; anything
 * else (permission denied, no space, ...) is a real error and is
 * re-thrown for the caller to report. */
async function ensureCategoryFolder(category) {
  const path = `${WIRE_ROOT}/${category}`;

  try {
    await Filesystem.mkdir({
      path,
      directory: Directory.ExternalStorage,
      recursive: true,
    });
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    if (!message.includes('exist')) throw error;
  }

  return path;
}

/** "photo.jpg" -> "photo.jpg" if free, else "photo (1).jpg", "photo (2).jpg" ... */
async function uniqueFilename(folder, filename) {
  const { base, ext } = splitExtension(filename);
  let candidate = filename;
  let attempt = 0;

  // Bounded so a pathological/looping filesystem state can't hang a
  // download forever — falls through to a timestamped name instead.
  while (attempt < 1000 && (await pathExists(`${folder}/${candidate}`))) {
    attempt += 1;
    candidate = ext ? `${base} (${attempt}).${ext}` : `${base} (${attempt})`;
  }

  if (attempt >= 1000) {
    candidate = ext ? `${base}-${Date.now()}.${ext}` : `${base}-${Date.now()}`;
  }

  return candidate;
}

/**
 * Resolves where a native (Capacitor Android) download should be
 * written: creates the Wire/<Category> folder on first use, and picks
 * a filename that won't silently overwrite an existing file.
 *
 * Returns the destination as a `file://...` URI (what
 * FileTransfer.downloadFile expects for `path`), plus the category
 * and final filename for logging/UI use.
 */
export async function resolveNativeDestination(mimeType, rawFilename) {
  const safeName = sanitizeFilename(rawFilename);
  const category = categoryFor(mimeType, safeName);
  const folder = await ensureCategoryFolder(category);
  const filename = await uniqueFilename(folder, safeName);
  const path = `${folder}/${filename}`;

  const { uri } = await Filesystem.getUri({
    path,
    directory: Directory.ExternalStorage,
  });

  return { category, filename, path, uri };
}
