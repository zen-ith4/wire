// public/js/crypto/messages/attachment-stream.js
//
// End-to-end encryption of DM attachments: a random per-file key and
// STREAM-style chunked AES-256-GCM (Hoang/Reyhanitabar/Rogaway/Vizar,
// the same construction age and Tink use).
//
// Container layout (this file's output, what the server stores):
//
//   header (8 bytes): 'W' 'A' 'T' '1', 0x10 (chunk size = 2^16), 0, 0, 0
//   chunk 0 .. chunk N-1, each: AES-GCM(ciphertext || 16-byte tag)
//
// Every chunk holds 64 KiB of plaintext except the last, which holds
// 0..64 KiB (an empty file is one empty final chunk = a bare tag).
//
// Per-chunk nonce (12 bytes) = prefix(7, random per file)
//                             || chunk index (4, big-endian)
//                             || final-chunk flag (1: 0x00 / 0x01)
// Per-chunk AAD            = the 8 header bytes.
//
// So the chunk index AND the final-chunk flag are authenticated twice
// over (they are part of the GCM nonce, and the nonce is what the tag
// binds). A reordered chunk, a truncated file, an appended chunk or a
// flipped bit anywhere fails authentication, and nothing is ever
// returned to the caller for a failed file.
//
// The key and the 7-byte nonce prefix are random per file, so there is
// no nonce-reuse risk across tabs, devices or retries (a new file is a
// new key). They are delivered ONLY inside the E2EE message envelope
// (`attachment_meta`); the server never sees them. The prefix is padded
// to the 12-byte `baseIv` carried in the envelope; bytes 7..11 of
// `baseIv` are zero and ignored.
//
// Limits: chunk counter is 32 bits (2^32 chunks = 256 TiB), so the real
// ceiling is the server's DM_UPLOAD_MAX_MB (default 50 MB of plaintext;
// ciphertext is larger by 8 bytes + 16 bytes per 64 KiB, about 0.025%).
// 64 KiB matches age/Tink: small enough that tampering is detected
// within one chunk and memory stays flat while streaming, large enough
// that a 50 MB file is ~800 WebCrypto calls rather than tens of
// thousands.
//
// Keep CHUNK_SIZE / HEADER / TAG in sync with config/multer.js.

export const STREAM_CHUNK_SIZE = 64 * 1024;
export const STREAM_TAG_BYTES = 16;
export const STREAM_HEADER_BYTES = 8;
export const STREAM_BASE_IV_BYTES = 12;
export const STREAM_NONCE_PREFIX_BYTES = 7;

const MAX_CHUNKS = 0xffffffff;
const CT_CHUNK = STREAM_CHUNK_SIZE + STREAM_TAG_BYTES;

const HEADER = new Uint8Array([0x57, 0x41, 0x54, 0x31, 0x10, 0x00, 0x00, 0x00]);

export class AttachmentDecryptError extends Error {
  constructor(message = 'Attachment could not be decrypted') {
    super(message);
    this.name = 'AttachmentDecryptError';
  }
}

function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('WebCrypto is unavailable');
  return s;
}

/* ---------- base64 (standalone: no dependency on the groups codec) ---------- */

export function streamBytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function streamBase64ToBytes(b64) {
  if (typeof b64 !== 'string') throw new AttachmentDecryptError('Invalid base64');
  let binary;
  try {
    binary = atob(b64);
  } catch {
    throw new AttachmentDecryptError('Invalid base64');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* ---------- key / nonce ---------- */

export function generateAttachmentKeyMaterial() {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const baseIv = new Uint8Array(STREAM_BASE_IV_BYTES);
  baseIv.set(crypto.getRandomValues(new Uint8Array(STREAM_NONCE_PREFIX_BYTES)), 0);
  return { rawKey, baseIv };
}

function chunkNonce(baseIv, index, isLast) {
  const nonce = new Uint8Array(12);
  nonce.set(baseIv.subarray(0, STREAM_NONCE_PREFIX_BYTES), 0);
  new DataView(nonce.buffer).setUint32(STREAM_NONCE_PREFIX_BYTES, index, false);
  nonce[11] = isLast ? 1 : 0;
  return nonce;
}

async function importKey(rawKey) {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) {
    throw new AttachmentDecryptError('Invalid attachment key');
  }
  return subtle().importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function checkBaseIv(baseIv) {
  if (!(baseIv instanceof Uint8Array) || baseIv.length !== STREAM_BASE_IV_BYTES) {
    throw new AttachmentDecryptError('Invalid attachment IV');
  }
}

/* ---------- sizes ---------- */

export function encryptedSizeFor(plainSize) {
  const chunks = Math.max(1, Math.ceil(plainSize / STREAM_CHUNK_SIZE));
  return STREAM_HEADER_BYTES + plainSize + chunks * STREAM_TAG_BYTES;
}

export function maxPlainSizeFor(maxCiphertextBytes) {
  // Largest plaintext whose ciphertext still fits.
  let lo = 0;
  let hi = maxCiphertextBytes;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (encryptedSizeFor(mid) <= maxCiphertextBytes) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/* ---------- encrypt ---------- */

/**
 * Encrypts a Blob/File. Returns { blob, rawKey, baseIv } where `blob` is
 * the container to upload (type application/octet-stream).
 */
export async function encryptAttachmentStream(file, material = generateAttachmentKeyMaterial()) {
  if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function') {
    throw new Error('encryptAttachmentStream needs a Blob or File');
  }
  const { rawKey, baseIv } = material;
  checkBaseIv(baseIv);
  const key = await importKey(rawKey);

  const total = file.size;
  const chunks = Math.max(1, Math.ceil(total / STREAM_CHUNK_SIZE));
  if (chunks > MAX_CHUNKS) throw new Error('File is too large to encrypt');

  const parts = [HEADER.slice()];
  for (let i = 0; i < chunks; i++) {
    const start = i * STREAM_CHUNK_SIZE;
    const plain = new Uint8Array(await file.slice(start, Math.min(start + STREAM_CHUNK_SIZE, total)).arrayBuffer());
    const isLast = i === chunks - 1;
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv: chunkNonce(baseIv, i, isLast), additionalData: HEADER, tagLength: 128 },
      key,
      plain
    );
    parts.push(new Uint8Array(ct));
  }

  return {
    blob: new Blob(parts, { type: 'application/octet-stream' }),
    rawKey,
    baseIv,
  };
}

/* ---------- decrypt ---------- */

async function* toAsyncChunks(source) {
  if (source && typeof source.arrayBuffer === 'function' && typeof source.slice === 'function') {
    // Blob: slice so memory stays bounded.
    const step = CT_CHUNK * 16;
    for (let off = 0; off < source.size; off += step) {
      yield new Uint8Array(await source.slice(off, Math.min(off + step, source.size)).arrayBuffer());
    }
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (source instanceof ArrayBuffer) {
    yield new Uint8Array(source);
    return;
  }
  if (source && typeof source.getReader === 'function') {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.length) yield value;
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
  if (source && source[Symbol.asyncIterator]) {
    for await (const piece of source) yield piece;
    return;
  }
  throw new AttachmentDecryptError('Unsupported ciphertext source');
}

/**
 * Decrypts a container into a Blob of the given mime type.
 * `source` may be a Blob, Uint8Array, ArrayBuffer, a ReadableStream
 * (e.g. fetch's response.body) or an async iterable of Uint8Array.
 * Throws AttachmentDecryptError on ANY authentication/format failure;
 * no partial plaintext is ever returned.
 */
export async function decryptAttachmentStream(source, rawKey, baseIv, mimeType = 'application/octet-stream') {
  checkBaseIv(baseIv);
  const key = await importKey(rawKey);

  const out = [];
  let buffer = new Uint8Array(0);
  let headerChecked = false;
  let index = 0;
  let sawAny = false;

  const append = (piece) => {
    if (!buffer.length) {
      buffer = piece;
      return;
    }
    const merged = new Uint8Array(buffer.length + piece.length);
    merged.set(buffer, 0);
    merged.set(piece, buffer.length);
    buffer = merged;
  };

  const decryptOne = async (ct, isLast) => {
    if (index > MAX_CHUNKS) throw new AttachmentDecryptError();
    try {
      const plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: chunkNonce(baseIv, index, isLast), additionalData: HEADER, tagLength: 128 },
        key,
        ct
      );
      out.push(new Uint8Array(plain));
    } catch {
      throw new AttachmentDecryptError();
    }
    index += 1;
  };

  for await (const piece of toAsyncChunks(source)) {
    sawAny = true;
    append(piece);

    if (!headerChecked) {
      if (buffer.length < STREAM_HEADER_BYTES) continue;
      for (let i = 0; i < STREAM_HEADER_BYTES; i++) {
        if (buffer[i] !== HEADER[i]) throw new AttachmentDecryptError('Bad attachment header');
      }
      buffer = buffer.subarray(STREAM_HEADER_BYTES);
      headerChecked = true;
    }

    // Only a chunk that is followed by more data can be non-final, so
    // keep one full chunk buffered until we know whether it is the last.
    while (buffer.length > CT_CHUNK) {
      await decryptOne(buffer.subarray(0, CT_CHUNK), false);
      buffer = buffer.subarray(CT_CHUNK);
    }
  }

  if (!sawAny || !headerChecked) throw new AttachmentDecryptError('Truncated attachment');
  if (buffer.length < STREAM_TAG_BYTES) throw new AttachmentDecryptError('Truncated attachment');

  await decryptOne(buffer, true);
  return new Blob(out, { type: mimeType });
}

/* ---------- metadata envelope (plaintext form, encrypted by the caller) ---------- */

const MAX_NAME_LEN = 255;
const MAX_MIME_LEN = 127;
const MAX_DIMENSION = 16384;

function clampDimension(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), MAX_DIMENSION);
}

export function buildAttachmentMeta({ rawKey, baseIv, name, mime, size, isVoice, width, height }) {
  return JSON.stringify({
    v: 1,
    k: streamBytesToBase64(rawKey),
    iv: streamBytesToBase64(baseIv),
    cs: STREAM_CHUNK_SIZE,
    name: String(name || 'file').slice(0, MAX_NAME_LEN),
    mime: String(mime || 'application/octet-stream').slice(0, MAX_MIME_LEN),
    size: Number.isFinite(Number(size)) ? Number(size) : 0,
    voice: !!isVoice,
    w: clampDimension(width),
    h: clampDimension(height),
  });
}

/**
 * Parses and sanity-checks decrypted metadata. Returns null on anything
 * malformed (the caller shows a safe placeholder). The sender controls
 * this data, so everything is clamped/validated here.
 */
export function parseAttachmentMeta(plaintext) {
  let meta;
  try {
    meta = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object' || meta.v !== 1 || meta.cs !== STREAM_CHUNK_SIZE) return null;

  let rawKey;
  let baseIv;
  try {
    rawKey = streamBase64ToBytes(meta.k);
    baseIv = streamBase64ToBytes(meta.iv);
  } catch {
    return null;
  }
  if (rawKey.length !== 32 || baseIv.length !== STREAM_BASE_IV_BYTES) return null;

  const mime = typeof meta.mime === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(meta.mime)
    ? meta.mime.toLowerCase().slice(0, MAX_MIME_LEN)
    : 'application/octet-stream';

  return {
    rawKey,
    baseIv,
    name: typeof meta.name === 'string' && meta.name ? meta.name.slice(0, MAX_NAME_LEN) : 'file',
    mime,
    size: Number.isFinite(meta.size) && meta.size >= 0 ? meta.size : 0,
    isVoice: meta.voice === true && mime.startsWith('audio/'),
    width: clampDimension(meta.w),
    height: clampDimension(meta.h),
  };
}

// Item 3 Phase 3A: re-exported so attachment-range.js (and a future Service
// Worker) use the SAME header bytes and the SAME per-chunk nonce layout
// instead of re-implementing them. Pure re-export: no new logic, no
// import-time side effects.
export { HEADER, chunkNonce };
