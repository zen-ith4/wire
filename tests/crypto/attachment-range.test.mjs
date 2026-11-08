// Pure range helpers for progressive encrypted DM media (Item 3, Phase 1).
// No DOM, no Service Worker, no server. Runs against the real client module.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_RANGE_READ_AHEAD_CHUNKS,
  ATTACHMENT_RANGE_CACHE_CHUNKS,
  ATTACHMENT_RANGE_MAX_RESPONSE_CHUNKS,
  rangeToChunks,
  decryptChunkRange,
  inferPlainSizeFromCiphertext,
} from '../../public/js/crypto/messages/attachment-range.js';
import {
  encryptAttachmentStream,
  decryptAttachmentStream,
  generateAttachmentKeyMaterial,
  encryptedSizeFor,
  STREAM_CHUNK_SIZE as CS,
  STREAM_TAG_BYTES as TAG,
  STREAM_HEADER_BYTES as HDR,
  AttachmentDecryptError,
} from '../../public/js/crypto/messages/attachment-stream.js';

const CT = CS + TAG;

function pattern(n, seed = 7) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >>> 16;
  }
  return out;
}

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

async function seal(plain) {
  const material = generateAttachmentKeyMaterial();
  const { blob } = await encryptAttachmentStream(new Blob([plain]), material);
  return { ct: await bytesOf(blob), ...material };
}

async function assertRejects(promise, label) {
  await assert.rejects(promise, (e) => e instanceof AttachmentDecryptError, label);
}

test('named constants are not magic numbers', () => {
  assert.equal(ATTACHMENT_RANGE_READ_AHEAD_CHUNKS, 8);
  assert.equal(ATTACHMENT_RANGE_CACHE_CHUNKS, 16);
  assert.equal(ATTACHMENT_RANGE_MAX_RESPONSE_CHUNKS, 16);
  assert.equal(ATTACHMENT_RANGE_READ_AHEAD_CHUNKS * CS, 512 * 1024);
});

test('rangeToChunks: empty file', () => {
  const info = rangeToChunks({ start: 0, end: -1 }, 0);
  assert.equal(info.byteLength, 0);
  assert.deepEqual(info.chunkIndices, [0]);
  assert.deepEqual(info.served, { start: 0, end: -1 });
});

test('rangeToChunks: single byte at the start', () => {
  const info = rangeToChunks({ start: 0, end: 0 }, 100);
  assert.equal(info.byteLength, 1);
  assert.deepEqual(info.chunkIndices, [0]);
  assert.deepEqual(info.served, { start: 0, end: 0 });
});

test('rangeToChunks: exact chunk boundary stays in chunk 0', () => {
  const info = rangeToChunks({ start: 0, end: CS - 1 }, 2 * CS);
  assert.equal(info.byteLength, CS);
  assert.deepEqual(info.chunkIndices, [0]);
});

test('rangeToChunks: one byte over the boundary enters chunk 1', () => {
  const info = rangeToChunks({ start: 0, end: CS }, 2 * CS);
  assert.equal(info.byteLength, CS + 1);
  assert.deepEqual(info.chunkIndices, [0, 1]);
});

test('rangeToChunks: open-ended range is clamped to maxResponseChunks', () => {
  const total = 100 * CS;
  const info = rangeToChunks({ start: 5 * CS, end: null }, total, { maxResponseChunks: 3 });
  assert.equal(info.byteLength, 3 * CS);
  assert.deepEqual(info.served, { start: 5 * CS, end: 5 * CS + 3 * CS - 1 });
  assert.deepEqual(info.chunkIndices, [5, 6, 7]);
});

test('rangeToChunks: suffix range', () => {
  const total = 10 * CS;
  const info = rangeToChunks({ suffixLength: 2 * CS + 5 }, total);
  assert.deepEqual(info.served, { start: 8 * CS - 5, end: total - 1 });
  assert.equal(info.byteLength, 2 * CS + 5);
});

test('rangeToChunks: suffix larger than the file clamps to the whole file', () => {
  const total = 3 * CS;
  const info = rangeToChunks({ suffixLength: 100 * CS }, total);
  assert.deepEqual(info.served, { start: 0, end: total - 1 });
});

test('rangeToChunks: invalid ranges throw', () => {
  assert.throws(() => rangeToChunks({ start: 5, end: 4 }, 10), /not satisfiable/i);
  assert.throws(() => rangeToChunks({ start: 10, end: 10 }, 10), /not satisfiable/i);
  assert.throws(() => rangeToChunks({ start: 0, end: 10 }, 10), /not satisfiable/i);
  assert.throws(() => rangeToChunks({ suffixLength: 0 }, 10), /not satisfiable/i);
});

test('rangeToChunks: string ranges', () => {
  const info = rangeToChunks('bytes=3-9', 100);
  assert.deepEqual(info.served, { start: 3, end: 9 });
  assert.equal(info.byteLength, 7);
});

test('decryptChunkRange: round trips every range against the full oracle', async () => {
  for (const n of [0, 1, 15, 16, CS - 1, CS, CS + 1, 2 * CS, 2 * CS + 5, 5 * CS + 123]) {
    const plain = pattern(n, n + 1);
    const { ct, rawKey, baseIv } = await seal(plain);
    const ranges = [
      { start: 0, end: Math.min(n - 1, 0) },
      { start: 0, end: Math.min(n - 1, CS - 1) },
      { start: Math.max(0, n - 5), end: Math.max(0, n - 1) },
      { start: Math.floor(n / 2), end: Math.min(n - 1, Math.floor(n / 2) + 100) },
    ];
    if (n === 0) ranges.length = 0;
    for (const range of ranges) {
      if (range.start > range.end) continue;
      const got = await decryptChunkRange(ct, rawKey, baseIv, 'image/png', range, n);
      const expected = plain.slice(range.start, range.end + 1);
      assert.deepEqual(got.bytes, expected, `range ${range.start}-${range.end} for n=${n}`);
      assert.deepEqual(got.served, { start: range.start, end: range.end });
    }
  }
});

test('decryptChunkRange: empty file returns empty bytes', async () => {
  const plain = new Uint8Array(0);
  const { ct, rawKey, baseIv } = await seal(plain);
  const got = await decryptChunkRange(ct, rawKey, baseIv, 'application/octet-stream', { start: 0, end: -1 }, 0);
  assert.equal(got.bytes.length, 0);
});

test('decryptChunkRange: final partial chunk', async () => {
  const n = 2 * CS + 50;
  const plain = pattern(n, 9);
  const { ct, rawKey, baseIv } = await seal(plain);
  const range = { start: n - 10, end: n - 1 };
  const got = await decryptChunkRange(ct, rawKey, baseIv, 'application/octet-stream', range, n);
  assert.deepEqual(got.bytes, plain.slice(range.start, range.end + 1));
  assert.deepEqual(got.chunkIndices, [2]);
});

test('decryptChunkRange: clamps an oversized range to maxResponseChunks', async () => {
  const n = 100 * CS;
  const plain = pattern(n, 11);
  const { ct, rawKey, baseIv } = await seal(plain);
  const got = await decryptChunkRange(ct, rawKey, baseIv, 'application/octet-stream', { start: 0, end: n - 1 }, n, { maxResponseChunks: 3 });
  assert.equal(got.bytes.length, 3 * CS);
  assert.deepEqual(got.served, { start: 0, end: 3 * CS - 1 });
});

test('decryptChunkRange: tampering in chunk k fails only ranges touching k', async () => {
  const n = 4 * CS;
  const plain = pattern(n, 13);
  const { ct, rawKey, baseIv } = await seal(plain);
  const bad = ct.slice();
  bad[HDR + 2 * CT + 10] ^= 0x01;

  await assertRejects(
    decryptChunkRange(bad, rawKey, baseIv, 'application/octet-stream', { start: 2 * CS, end: 2 * CS + 5 }, n),
    'range touching tampered chunk'
  );

  const ok = await decryptChunkRange(bad, rawKey, baseIv, 'application/octet-stream', { start: 0, end: CS - 1 }, n);
  assert.deepEqual(ok.bytes, plain.slice(0, CS));
});

test('decryptChunkRange: reordered chunks fail', async () => {
  const n = 3 * CS;
  const plain = pattern(n, 17);
  const { ct, rawKey, baseIv } = await seal(plain);
  const header = ct.slice(0, HDR);
  const c0 = ct.slice(HDR, HDR + CT);
  const c1 = ct.slice(HDR + CT, HDR + 2 * CT);
  const c2 = ct.slice(HDR + 2 * CT);
  const swapped = new Uint8Array(ct.length);
  swapped.set(header, 0);
  swapped.set(c1, HDR);
  swapped.set(c0, HDR + CT);
  swapped.set(c2, HDR + 2 * CT);

  await assertRejects(
    decryptChunkRange(swapped, rawKey, baseIv, 'application/octet-stream', { start: 0, end: CS - 1 }, n),
    'reordered chunk'
  );
});

test('decryptChunkRange: truncated ciphertext fails', async () => {
  const n = 3 * CS + 10;
  const plain = pattern(n, 19);
  const { ct, rawKey, baseIv } = await seal(plain);
  await assertRejects(
    decryptChunkRange(ct.slice(0, ct.length - 5), rawKey, baseIv, 'application/octet-stream', { start: 0, end: CS - 1 }, n),
    'truncated tail'
  );
});

test('decryptChunkRange: wrong key fails', async () => {
  const n = 2 * CS;
  const plain = pattern(n, 23);
  const { ct, rawKey, baseIv } = await seal(plain);
  const wrongKey = generateAttachmentKeyMaterial().rawKey;
  await assertRejects(
    decryptChunkRange(ct, wrongKey, baseIv, 'application/octet-stream', { start: 0, end: CS - 1 }, n),
    'wrong key'
  );
});

test('decryptChunkRange: object form and inferred total size', async () => {
  const n = 2 * CS + 7;
  const plain = pattern(n, 29);
  const { ct, rawKey, baseIv } = await seal(plain);
  const got = await decryptChunkRange({
    ciphertext: ct,
    rawKey,
    baseIv,
    mimeType: 'image/png',
    range: { start: CS, end: CS + 3 },
  });
  assert.deepEqual(got.bytes, plain.slice(CS, CS + 4));
  assert.equal(got.bytes.length, 4);
});

test('inferPlainSizeFromCiphertext matches encryptedSizeFor', () => {
  for (const n of [0, 1, CS - 1, CS, CS + 1, 2 * CS, 5 * CS + 123]) {
    const size = encryptedSizeFor(n);
    const buf = new Uint8Array(size);
    assert.equal(inferPlainSizeFromCiphertext(size), n);
  }
});
