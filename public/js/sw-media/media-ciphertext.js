// public/js/sw-media/media-ciphertext.js
//
// Decrypt the ciphertext Range that covers a served plaintext Range (Item 3,
// phase 3C, C2).
//
// attachment-range.js's decryptChunkRange() expects the WHOLE container. The
// Service Worker only fetches the chunks that contain the requested bytes, so
// this helper:
//   - verifies the supplied ciphertext Range is exactly the one the plan asked
//     for (no attacker-chosen offsets);
//   - verifies the slice length;
//   - decrypts each authenticated chunk with the same header, nonce and AAD as
//     attachment-stream.js;
//   - trims the plaintext to the requested bytes.
//
// It does not cache, log, or persist key material or plaintext.

import {
  STREAM_CHUNK_SIZE,
  STREAM_TAG_BYTES,
  STREAM_HEADER_BYTES,
  encryptedSizeFor,
  AttachmentDecryptError,
  HEADER,
  chunkNonce,
} from '../crypto/messages/attachment-stream.js';

const CT_CHUNK = STREAM_CHUNK_SIZE + STREAM_TAG_BYTES;

function fail() {
  throw new AttachmentDecryptError();
}

function isByteRange(value) {
  return (
    value &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    value.start >= 0 &&
    value.end >= value.start
  );
}

/**
 * @param {{
 *   ciphertext: Uint8Array,
 *   ciphertextRange: { start: number, end: number },
 *   served: { start: number, end: number },
 *   totalSize: number,
 *   rawKey: Uint8Array,
 *   baseIv: Uint8Array,
 * }} input
 * @returns {Promise<Uint8Array>}
 */
export async function decryptMediaCiphertextRange({
  ciphertext,
  ciphertextRange,
  served,
  totalSize,
  rawKey,
  baseIv,
} = {}) {
  try {
    if (!(ciphertext instanceof Uint8Array)) fail();
    if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) fail();
    if (!(baseIv instanceof Uint8Array) || baseIv.length !== 12) fail();
    if (!Number.isInteger(totalSize) || totalSize < 0) fail();

    if (totalSize === 0) {
      if (!served || served.start !== 0 || served.end !== -1) fail();
      if (ciphertextRange != null) fail();
      if (ciphertext.length !== 0) fail();
      return new Uint8Array(0);
    }

    if (!isByteRange(served)) fail();
    if (!isByteRange(ciphertextRange)) fail();

    if (served.start > served.end || served.end >= totalSize) fail();

    const chunks = Math.max(1, Math.ceil(totalSize / STREAM_CHUNK_SIZE));
    const firstChunk = Math.floor(served.start / STREAM_CHUNK_SIZE);
    const lastChunk = Math.floor(served.end / STREAM_CHUNK_SIZE);

    if (firstChunk < 0 || lastChunk >= chunks) fail();

    const expectedStart = STREAM_HEADER_BYTES + firstChunk * CT_CHUNK;
    const expectedEnd = lastChunk === chunks - 1
      ? encryptedSizeFor(totalSize) - 1
      : STREAM_HEADER_BYTES + (lastChunk + 1) * CT_CHUNK - 1;

    if (ciphertextRange.start !== expectedStart || ciphertextRange.end !== expectedEnd) {
      fail();
    }
    if (ciphertext.length !== expectedEnd - expectedStart + 1) fail();

    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const output = new Uint8Array(served.end - served.start + 1);

    for (let index = firstChunk; index <= lastChunk; index += 1) {
      const isLast = index === chunks - 1;
      const plainInChunk = isLast
        ? totalSize - index * STREAM_CHUNK_SIZE
        : STREAM_CHUNK_SIZE;
      const cipherInChunk = plainInChunk + STREAM_TAG_BYTES;
      const offset = STREAM_HEADER_BYTES + index * CT_CHUNK - expectedStart;

      if (offset < 0 || offset + cipherInChunk > ciphertext.length) fail();

      let plain;
      try {
        plain = new Uint8Array(await globalThis.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: chunkNonce(baseIv, index, isLast),
            additionalData: HEADER,
            tagLength: 128,
          },
          key,
          ciphertext.subarray(offset, offset + cipherInChunk)
        ));
      } catch {
        fail();
      }

      if (plain.length !== plainInChunk) fail();

      const chunkStart = index * STREAM_CHUNK_SIZE;
      const copyStart = Math.max(served.start, chunkStart);
      const copyEnd = Math.min(served.end + 1, chunkStart + plainInChunk);
      if (copyEnd > copyStart) {
        output.set(
          plain.subarray(copyStart - chunkStart, copyEnd - chunkStart),
          copyStart - served.start
        );
      }
    }

    if (output.length !== served.end - served.start + 1) fail();
    return output;
  } catch (error) {
    if (error instanceof AttachmentDecryptError) throw error;
    throw new AttachmentDecryptError();
  }
}
