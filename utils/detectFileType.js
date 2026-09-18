'use strict';

/*
 * file-type@22 is ESM-only (no require() support), so it's loaded
 * via a cached dynamic import instead of a top-level require(). The
 * upgrade from 16.5.4 was needed to pick up the fix for
 * CVE-2026-31808 (a moderate-severity infinite loop in the ASF/WMV
 * parser, fixed in 21.3.1+) without disabling audit checks.
 * Caching the promise (rather than importing on every call) avoids
 * repeated module-resolution overhead; if the import ever rejects
 * (e.g. a broken install), every call after that will also reject
 * with the same error until the process restarts, which is the
 * correct fail-closed behavior here.
 */
const fileTypePromise = import('file-type');

/**
 * Sniffs a file's real type from its magic bytes on disk.
 *
 * This is deliberately the ONLY thing we trust to decide whether an
 * uploaded file may later be served `inline` to a browser. Both the
 * filename extension and the client-supplied Content-Type header
 * (req.file.mimetype from multer) are fully attacker-controlled — a
 * request can claim any extension/mimetype it likes regardless of
 * the bytes actually uploaded. Magic-byte sniffing looks at what the
 * file actually is.
 *
 * Returns the detected MIME string, or null when file-type doesn't
 * recognize the format (plain text, JSON, many source/archive/office
 * formats aren't detected by signature). Callers MUST treat a null
 * result as "unknown / not verified safe", never as "assume safe to
 * serve inline" — see utils/inlineSafeMime.js.
 */
async function detectMimeFromBytes(filePath) {
  try {
    const { fromFile } = await fileTypePromise;
    const result = await fromFile(filePath);
    return result ? result.mime : null;
  } catch (err) {
    console.error('File type detection failed:', err.message);
    return null;
  }
}

module.exports = {
  detectMimeFromBytes,
};
