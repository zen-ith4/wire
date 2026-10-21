// public/js/crypto/messages/attachment-range.js
//
// Pure helpers for progressive encrypted DM media (Item 3, Phase 1).
//
// No DOM, no Service Worker, no server, no fetch. These functions map a
// plaintext byte range to STREAM chunks and decrypt exactly that range.
// They are the testable core that a future Service Worker will call.
//
// Cached chunks: this module does not cache. The future Service Worker
// cache will hold plaintext chunks only, in SW memory (a Map keyed by
// stream id + chunk index). It must never put plaintext or ciphertext in
// Cache Storage or IndexedDB. See docs/MEDIA_STREAMING_RFC.md Q4 and Q9.
//
// Read-ahead is 8 chunks (512 KiB): at a typical 4 Mbps 1080p bitrate
// (500 KiB/s) that is about 1.0 s of playback; at 128 kbps audio
// (16 KiB/s) it is about 32 s. This is small enough for phones and large
// enough to avoid stalls. The cache cap is 16 chunks (1 MiB) per stream.

import {
  STREAM_CHUNK_SIZE,
  STREAM_TAG_BYTES,
  STREAM_HEADER_BYTES,
  encryptedSizeFor,
  AttachmentDecryptError,
  HEADER,
  chunkNonce,
} from '../public/js/crypto/messages/attachment-stream.js';

export const ATTACHMENT_RANGE_READ_AHEAD_CHUNKS = 8;
export const ATTACHMENT_RANGE_CACHE_CHUNKS = 16;
export const ATTACHMENT_RANGE_MAX_RESPONSE_CHUNKS = 16;

const CHUNK_SIZE = STREAM_CHUNK_SIZE;
const TAG_BYTES = STREAM_TAG_BYTES;
const HEADER_BYTES = STREAM_HEADER_BYTES;
const CT_CHUNK = CHUNK_SIZE + TAG_BYTES;

export class RangeNotSatisfiableError extends Error {
  constructor(message = 'Range not satisfiable') {
    super(message);
    this.name = 'RangeNotSatisfiableError';
  }
}

function isInteger(value) {
  return Number.isInteger(value);
}

function toUint8Array(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (Array.isArray(source)) return new Uint8Array(source);
  if (source && typeof source.arrayBuffer === 'function') {
    return source.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  if (source && typeof source.getReader === 'function') {
    return (async () => {
      const reader = source.getReader();
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) parts.push(value);
      }
      try { reader.releaseLock(); } catch { /* already released */ }
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const part of parts) {
        out.set(part, off);
        off += part.length;
      }
      return out;
    })();
  }
  throw new RangeNotSatisfiableError('Unsupported ciphertext source');
}

function parseRange(range, totalSize) {
  let start;
  let end;
  let suffixLength = null;

  if (typeof range === 'string') {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) throw new RangeNotSatisfiableError('Invalid range');
    if (!match[1] && match[2]) {
      suffixLength = Number(match[2]);
    } else {
      start = match[1] === '' ? 0 : Number(match[1]);
      end = match[2] === '' ? null : Number(match[2]);
    }
  } else if (range && typeof range === 'object') {
    if (Object.prototype.hasOwnProperty.call(range, 'suffixLength')) {
      suffixLength = range.suffixLength;
    } else if (Object.prototype.hasOwnProperty.call(range, 'offset') && Object.prototype.hasOwnProperty.call(range, 'length')) {
      start = range.offset;
      end = range.length === 0 ? -1 : range.offset + range.length - 1;
    } else {
      start = range.start;
      end = range.end;
      if (range.totalSize != null && totalSize == null) totalSize = range.totalSize;
    }
  } else {
    throw new RangeNotSatisfiableError('Invalid range');
  }

  if (suffixLength != null) {
    if (!isInteger(suffixLength) || suffixLength < 0) throw new RangeNotSatisfiableError('Invalid suffix range');
    if (totalSize === 0) throw new RangeNotSatisfiableError('Range not satisfiable');
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  }

  if (start == null) start = 0;
  if (end == null) end = totalSize - 1;

  if (!isInteger(start) || !isInteger(end) || start < 0 || end < -1) {
    throw new RangeNotSatisfiableError('Invalid range');
  }

  // Empty range sentinel: only meaningful for an empty file.
  if (start === 0 && end === -1) {
    if (totalSize !== 0) throw new RangeNotSatisfiableError('Range not satisfiable');
    return { start, end };
  }

  if (start >= totalSize || end >= totalSize || start > end) {
    throw new RangeNotSatisfiableError('Range not satisfiable');
  }

  return { start, end };
}

export function rangeToChunks(range, totalSize, options = {}) {
  if (!isInteger(totalSize) || totalSize < 0) {
    throw new RangeNotSatisfiableError('Invalid total size');
  }

  const maxResponseChunks = options.maxResponseChunks ?? ATTACHMENT_RANGE_MAX_RESPONSE_CHUNKS;
  if (!isInteger(maxResponseChunks) || maxResponseChunks < 1) {
    throw new RangeNotSatisfiableError('Invalid maxResponseChunks');
  }

  const parsed = parseRange(range, totalSize);
  const maxResponseBytes = maxResponseChunks * CHUNK_SIZE;

  if (parsed.start === 0 && parsed.end === -1) {
    return {
      requested: { start: 0, end: -1 },
      served: { start: 0, end: -1 },
      byteLength: 0,
      chunkIndices: [0],
      firstChunk: 0,
      lastChunk: 0,
      maxResponseChunks,
    };
  }

  const servedStart = parsed.start;
  const servedEnd = Math.min(parsed.end, servedStart + maxResponseBytes - 1, totalSize - 1);
  const byteLength = servedEnd - servedStart + 1;
  const firstChunk = Math.floor(servedStart / CHUNK_SIZE);
  const lastChunk = Math.floor(servedEnd / CHUNK_SIZE);
  const chunkIndices = [];
  for (let i = firstChunk; i <= lastChunk; i++) chunkIndices.push(i);

  return {
    requested: { start: parsed.start, end: parsed.end },
    served: { start: servedStart, end: servedEnd },
    byteLength,
    chunkIndices,
    firstChunk,
    lastChunk,
    maxResponseChunks,
  };
}

export function inferPlainSizeFromCiphertext(ciphertextLength) {
  if (!isInteger(ciphertextLength) || ciphertextLength < HEADER_BYTES + TAG_BYTES) return null;
  const maxChunks = Math.ceil(ciphertextLength / (TAG_BYTES + 1));
  for (let chunks = 1; chunks <= maxChunks; chunks++) {
    const plainSize = ciphertextLength - HEADER_BYTES - chunks * TAG_BYTES;
    if (plainSize < 0) continue;
    const minPlain = chunks === 1 ? 0 : (chunks - 1) * CHUNK_SIZE + 1;
    const maxPlain = chunks * CHUNK_SIZE;
    if (plainSize >= minPlain && plainSize <= maxPlain) return plainSize;
  }
  return null;
}

// Deliberately NOT the stream module's importKey(): that one imports the key
// with ['encrypt','decrypt'] because the page also ENCRYPTS with it
// (public/js/crypto/messages/attachment-stream.js:108-113, used at :152 and
// :225). A Service Worker must hold a DECRYPT-ONLY key, so this copy keeps
// the same 32-byte check and the same AttachmentDecryptError type, and
// imports the key with ['decrypt'] only. Do not "unify" the two.
async function importKey(rawKey) {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) {
    throw new AttachmentDecryptError('Invalid attachment key');
  }
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
}

function ciphertextChunkSlice(ciphertext, plainSize, index) {
  const chunks = Math.max(1, Math.ceil(plainSize / CHUNK_SIZE));
  const offset = HEADER_BYTES + index * CT_CHUNK;
  const lastPlain = plainSize - (chunks - 1) * CHUNK_SIZE;
  const plainLen = index === chunks - 1 ? lastPlain : CHUNK_SIZE;
  const length = plainLen + TAG_BYTES;
  if (offset < 0 || offset + length > ciphertext.length) {
    throw new AttachmentDecryptError('Truncated attachment');
  }
  return ciphertext.subarray(offset, offset + length);
}

function parseDecryptArgs(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && Object.prototype.hasOwnProperty.call(args[0], 'ciphertext')) {
    const input = args[0];
    return {
      ciphertext: input.ciphertext,
      rawKey: input.rawKey,
      baseIv: input.baseIv,
      mimeType: input.mimeType ?? 'application/octet-stream',
      range: input.range,
      totalSize: input.totalSize,
      maxResponseChunks: input.maxResponseChunks,
    };
  }

  let [ciphertext, rawKey, baseIv, mimeType = 'application/octet-stream', range, totalSize, options = {}] = args;
  if (range && typeof range === 'object' && (range.totalSize != null || range.maxResponseChunks != null) && totalSize == null) {
    totalSize = range.totalSize;
    if (range.maxResponseChunks != null) options = { ...options, maxResponseChunks: range.maxResponseChunks };
    range = range.range ?? range;
    if (range && (range.totalSize != null || range.maxResponseChunks != null)) {
      const { totalSize: ts, maxResponseChunks: mr, ...rest } = range;
      if (ts != null) totalSize = ts;
      if (mr != null) options = { ...options, maxResponseChunks: mr };
      range = rest;
    }
  }
  if (options && typeof options === 'object') {
    if (options.totalSize != null) totalSize = options.totalSize;
    if (options.maxResponseChunks != null) options = options;
  }
  return { ciphertext, rawKey, baseIv, mimeType, range, totalSize, maxResponseChunks: options?.maxResponseChunks };
}

export async function decryptChunkRange(...args) {
  const { ciphertext: source, rawKey, baseIv, mimeType, range, totalSize: providedTotal, maxResponseChunks } = parseDecryptArgs(args);

  const ciphertext = await toUint8Array(source);
  if (!(baseIv instanceof Uint8Array) || baseIv.length !== 12) {
    throw new AttachmentDecryptError('Invalid attachment IV');
  }

  const totalSize = providedTotal == null ? inferPlainSizeFromCiphertext(ciphertext.length) : providedTotal;
  if (totalSize == null || !isInteger(totalSize) || totalSize < 0) {
    throw new AttachmentDecryptError('Invalid attachment size');
  }
  if (encryptedSizeFor(totalSize) !== ciphertext.length) {
    throw new AttachmentDecryptError('Truncated or oversized attachment');
  }

  const info = rangeToChunks(range, totalSize, { maxResponseChunks });
  const chunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
  const key = await importKey(rawKey);

  const first = info.chunkIndices[0];
  const last = info.chunkIndices[info.chunkIndices.length - 1];
  const decrypted = [];
  for (let i = first; i <= last; i++) {
    const ctChunk = ciphertextChunkSlice(ciphertext, totalSize, i);
    const isLast = i === chunks - 1;
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: chunkNonce(baseIv, i, isLast), additionalData: HEADER, tagLength: 128 },
        key,
        ctChunk
      );
    } catch {
      throw new AttachmentDecryptError();
    }
    decrypted.push({ index: i, bytes: new Uint8Array(plain) });
  }

  const out = new Uint8Array(info.byteLength);
  let pos = 0;
  for (const chunk of decrypted) {
    const chunkStart = chunk.index * CHUNK_SIZE;
    const sliceStart = Math.max(0, info.served.start - chunkStart);
    const sliceEnd = Math.min(chunk.bytes.length, info.served.end + 1 - chunkStart);
    if (sliceEnd > sliceStart) {
      out.set(chunk.bytes.subarray(sliceStart, sliceEnd), pos);
      pos += sliceEnd - sliceStart;
    }
  }
  if (pos !== info.byteLength) throw new AttachmentDecryptError('Range decrypt failed');

  return {
    bytes: out,
    served: info.served,
    requested: info.requested,
    chunkIndices: info.chunkIndices,
    mimeType,
  };
}