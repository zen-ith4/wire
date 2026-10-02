// file-type 22 is ESM-only. Keep this utility CommonJS-compatible by
// loading it lazily when the first file needs inspection.
let fileTypeModulePromise;

function getFileTypeModule() {
  if (!fileTypeModulePromise) {
    fileTypeModulePromise = import('file-type');
  }

  return fileTypeModulePromise;
}

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
    const { fileTypeFromFile } = await getFileTypeModule();
    const result = await fileTypeFromFile(filePath);
    return result ? result.mime : null;
  } catch (err) {
    console.error('File type detection failed:', err.message);
    return null;
  }
}

module.exports = {
  detectMimeFromBytes,
};
