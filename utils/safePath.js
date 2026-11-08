const fsp = require('fs/promises');
const path = require('path');

const { isStoredFolderAllowed } = require('./folderPolicy');

function safeSubPath(basePath, subPath = '') {
  const base = path.resolve(basePath);
  const target = path.resolve(base, subPath);

  if (target !== base && !target.startsWith(base + path.sep)) {
    return null;
  }

  return target;
}

// ---------------------------------------------------------------
// resolveRegularFile
//
// Strict resolver for the endpoints that hand file BYTES to a
// browser (media streaming, share links). safeSubPath() above is a
// purely lexical check; it says nothing about symlinks and it happily
// resolves dotfiles and nested "file" names. For endpoints that
// serve content without the user being able to see the path, all of
// the following are enforced:
//
//   - `file` is a single path segment (no separators, no NUL)
//   - no segment of `subpath` or `file` is hidden (starts with ".").
//     Listings already hide dotfiles; a link must not be able to
//     reach what the UI never shows.
//   - the lexical result stays inside the folder root
//   - the REAL path (symlinks resolved) stays inside the REAL root
//   - the target is a regular file, not a directory/device/socket
//
// Never throws for bad input: returns { ok: false } so callers can
// answer with one generic error instead of leaking which check failed.
// On success `relPath` is POSIX-style, relative to the folder root,
// and is what share links persist (never an absolute path).
// ---------------------------------------------------------------

function hasHiddenSegment(value) {
  return String(value)
    .split(/[\\/]+/)
    .some((segment) => segment.startsWith('.'));
}

const NOT_FOUND = Object.freeze({ ok: false });

async function resolveRegularFile(basePath, subpath, file) {
  try {
    if (typeof basePath !== 'string' || !basePath) return NOT_FOUND;
    // The folder itself must still pass the sharing policy on every read.
    if (!isStoredFolderAllowed(basePath)) return NOT_FOUND;

    const sub = typeof subpath === 'string' ? subpath : '';

    if (
      typeof file !== 'string' ||
      !file ||
      file.length > 255 ||
      file.includes('/') ||
      file.includes('\\') ||
      file.includes('\0') ||
      sub.includes('\0') ||
      hasHiddenSegment(file) ||
      hasHiddenSegment(sub)
    ) {
      return NOT_FOUND;
    }

    const base = path.resolve(basePath);
    const dir = safeSubPath(base, sub);
    if (!dir) return NOT_FOUND;

    const lexical = safeSubPath(dir, file);
    if (!lexical || path.dirname(lexical) !== dir) return NOT_FOUND;

    const [realBase, realTarget] = await Promise.all([
      fsp.realpath(base),
      fsp.realpath(lexical),
    ]);

    if (
      realTarget !== realBase &&
      !realTarget.startsWith(realBase + path.sep)
    ) {
      return NOT_FOUND;
    }

    const stat = await fsp.stat(realTarget);
    if (!stat.isFile()) return NOT_FOUND;

    return {
      ok: true,
      fullPath: realTarget,
      name: path.basename(lexical),
      relPath: path.relative(base, lexical).split(path.sep).join('/'),
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  } catch {
    // ENOENT, EACCES, ELOOP, ...: all the same answer to the caller.
    return NOT_FOUND;
  }
}

// ---------------------------------------------------------------
// resolveDeletableEntry
//
// Resolver for DELETING one entry (file, folder or symlink) that sits
// directly inside `subpath` of a folder root. It applies the same
// input rules as resolveRegularFile() — single-segment name, no NUL,
// no hidden (dot) segments, lexical containment — and differs where
// deletion needs it to:
//
//   - the target is inspected with lstat(), never followed: a symlink
//     is reported as type 'link' so that only the link itself is ever
//     removed, not whatever it points at (which may be outside the
//     root);
//   - it is the PARENT directory whose real path must stay inside the
//     real root (a symlinked sub-folder must not lead a delete out of
//     the user's storage area);
//   - directories are allowed (type 'dir'), the folder root itself can
//     never be returned.
//
// Never throws for bad input: returns { ok: false } so callers answer
// with one generic error. On success:
//   fullPath  — absolute path of the entry, built from the REAL parent
//   lexicalPath — the same entry as the DB / other folders spell it
//   relPath   — POSIX path relative to the folder root (what share
//               links persist)
//   type      — 'file' | 'dir' | 'link'
// ---------------------------------------------------------------

async function resolveDeletableEntry(basePath, subpath, name) {
  try {
    if (typeof basePath !== 'string' || !basePath) return NOT_FOUND;
    // The folder itself must still pass the sharing policy on every read.
    if (!isStoredFolderAllowed(basePath)) return NOT_FOUND;

    const sub = typeof subpath === 'string' ? subpath : '';

    if (
      typeof name !== 'string' ||
      !name ||
      name === '.' ||
      name === '..' ||
      name.length > 255 ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      sub.includes('\0') ||
      hasHiddenSegment(name) ||
      hasHiddenSegment(sub)
    ) {
      return NOT_FOUND;
    }

    const base = path.resolve(basePath);
    const dir = safeSubPath(base, sub);
    if (!dir) return NOT_FOUND;

    const lexical = safeSubPath(dir, name);
    if (!lexical || path.dirname(lexical) !== dir) return NOT_FOUND;

    const [realBase, realDir] = await Promise.all([
      fsp.realpath(base),
      fsp.realpath(dir),
    ]);

    if (
      realDir !== realBase &&
      !realDir.startsWith(realBase + path.sep)
    ) {
      return NOT_FOUND;
    }

    const fullPath = path.join(realDir, name);
    const stat = await fsp.lstat(fullPath);

    let type = 'file';
    if (stat.isSymbolicLink()) type = 'link';
    else if (stat.isDirectory()) type = 'dir';

    return {
      ok: true,
      fullPath,
      lexicalPath: lexical,
      name,
      type,
      relPath: path.relative(base, lexical).split(path.sep).join('/'),
    };
  } catch {
    // ENOENT, EACCES, ENOTDIR, ELOOP, ...: all the same answer.
    return NOT_FOUND;
  }
}

// ---------------------------------------------------------------
// resolveRegularDirectory
//
// The directory counterpart of resolveRegularFile(), for the endpoints
// that take a user-supplied `subpath` and then list or write inside it.
// Same contract, same generic answer on failure:
//
//   - no NUL anywhere, and no segment that is "." or ".."
//   - no hidden ("."-prefixed) segment: the UI never shows those, so a
//     crafted request must not be able to reach what the UI hides
//   - the lexical result stays inside the folder root
//   - the REAL path (symlinks resolved) stays inside the REAL root - this
//     is the part a lexical check cannot do, and the reason this function
//     exists at all: a symlink planted inside a folder would otherwise let
//     a listing enumerate, or an upload write to, a directory outside it
//   - the target really is a directory
//
// Never throws for bad input. On success `relPath` is POSIX-style and
// relative to the folder root.
// ---------------------------------------------------------------

function hasDotSegment(value) {
  return String(value)
    .split(/[\\/]+/)
    .some((segment) => segment === '.' || segment === '..');
}

async function resolveRegularDirectory(basePath, subpath) {
  try {
    if (typeof basePath !== 'string' || !basePath) return NOT_FOUND;
    // The folder itself must still pass the sharing policy on every read.
    if (!isStoredFolderAllowed(basePath)) return NOT_FOUND;

    const sub = typeof subpath === 'string' ? subpath : '';

    if (sub.includes('\0') || hasHiddenSegment(sub) || hasDotSegment(sub)) {
      return NOT_FOUND;
    }

    const base = path.resolve(basePath);
    const lexical = safeSubPath(base, sub);
    if (!lexical) return NOT_FOUND;

    const [realBase, realTarget] = await Promise.all([
      fsp.realpath(base),
      fsp.realpath(lexical),
    ]);

    if (
      realTarget !== realBase &&
      !realTarget.startsWith(realBase + path.sep)
    ) {
      return NOT_FOUND;
    }

    const stat = await fsp.stat(realTarget);
    if (!stat.isDirectory()) return NOT_FOUND;

    return {
      ok: true,
      fullPath: realTarget,
      relPath: path.relative(base, lexical).split(path.sep).join('/'),
    };
  } catch {
    // ENOENT, EACCES, ELOOP, ENOTDIR: all the same answer to the caller.
    return NOT_FOUND;
  }
}

// Splits a persisted POSIX relPath back into the (subpath, file) pair
// resolveRegularFile() expects.
function splitRelPath(relPath) {
  const parts = String(relPath).split('/');
  const file = parts.pop();

  return { subpath: parts.join('/'), file };
}

module.exports = {
  safeSubPath,
  resolveRegularFile,
  resolveRegularDirectory,
  resolveDeletableEntry,
  splitRelPath,
  hasHiddenSegment,
  hasDotSegment,
};
