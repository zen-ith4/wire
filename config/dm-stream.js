// config/dm-stream.js
//
// SINGLE source of truth (server side) for the DM attachment container
// format. Used by config/multer.js (upload size cap) and
// controllers/dm.controller.js (shape check). The browser module
// public/js/crypto/messages/attachment-stream.js cannot require this
// file, so tests/dm-attachments/dm-stream-constants.test.mjs fails if the
// two ever disagree.

const CHUNK_SIZE_LOG2 = 16;
const CHUNK_SIZE = 1 << CHUNK_SIZE_LOG2; // 64 KiB of plaintext per chunk
const TAG_BYTES = 16; // AES-GCM tag per chunk
const NONCE_BASE_IV_BYTES = 12;

// 'W' 'A' 'T' '1', chunk-size log2, 3 reserved zero bytes
const HEADER = Buffer.from([0x57, 0x41, 0x54, 0x31, CHUNK_SIZE_LOG2, 0, 0, 0]);
const HEADER_BYTES = HEADER.length;

// Bytes the container adds to a plaintext of at most `maxPlainBytes`.
function ciphertextOverheadBytes(maxPlainBytes) {
  const chunks = Math.max(1, Math.ceil(maxPlainBytes / CHUNK_SIZE));
  return HEADER_BYTES + chunks * TAG_BYTES;
}

module.exports = {
  CHUNK_SIZE,
  CHUNK_SIZE_LOG2,
  TAG_BYTES,
  HEADER,
  HEADER_BYTES,
  NONCE_BASE_IV_BYTES,
  ciphertextOverheadBytes,
};
