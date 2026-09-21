const fsp = require('fs/promises');
const path = require('path');

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
  splitRelPath,
  hasHiddenSegment,
};
