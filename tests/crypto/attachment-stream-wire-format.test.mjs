// Item 3 Phase 3A: the STREAM wire format is pinned here.
//
// The nonce is computed INDEPENDENTLY inside this test (plain WebCrypto, the
// format spelled out literally below) - never by calling the module's
// chunkNonce(). The module's exported helper is then compared against that
// independent computation, and data is encrypted/decrypted in BOTH
// directions, so a change to the nonce layout, the header bytes, the index
// endianness or the final-chunk flag is caught here.
//
// Container (from public/js/crypto/messages/attachment-stream.js):
//   header 8 bytes  : 57 41 54 31 10 00 00 00   ('WAT1', chunk size 2^16)
//   chunk i          : AES-256-GCM(plaintext || 16-byte tag)
//   per-chunk nonce  : prefix(7) || chunk index(4, BIG-ENDIAN) || final(1)
//   per-chunk AAD    : the 8 header bytes
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptAttachmentStream,
  decryptAttachmentStream,
  generateAttachmentKeyMaterial,
  STREAM_CHUNK_SIZE as CS,
  STREAM_TAG_BYTES as TAG,
  STREAM_HEADER_BYTES as HDR,
  STREAM_BASE_IV_BYTES as IVB,
  STREAM_NONCE_PREFIX_BYTES as PREFIX,
  HEADER,
  chunkNonce,
} from '../../public/js/crypto/messages/attachment-stream.js';
import { decryptChunkRange } from '../../public/js/crypto/messages/attachment-range.js';

// ---------------------------------------------------------------------------
// The format, written out literally in this test (NOT imported).
// ---------------------------------------------------------------------------
const FORMAT_HEADER = new Uint8Array([0x57, 0x41, 0x54, 0x31, 0x10, 0x00, 0x00, 0x00]);
const FORMAT_CHUNK_SIZE = 64 * 1024;
const FORMAT_TAG_BYTES = 16;
const FORMAT_NONCE_PREFIX = 7;
const FORMAT_NONCE_BYTES = 12;

/** 7-byte prefix || 4-byte BIG-ENDIAN index || 1-byte final flag. */
function independentNonce(baseIv, index, isLast) {
  const nonce = new Uint8Array(FORMAT_NONCE_BYTES);
  nonce.set(baseIv.subarray(0, FORMAT_NONCE_PREFIX), 0);
  new DataView(nonce.buffer).setUint32(FORMAT_NONCE_PREFIX, index, false);
  nonce[FORMAT_NONCE_BYTES - 1] = isLast ? 1 : 0;
  return nonce;
}

async function importAesKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt ONE chunk exactly as the format says, with an independent nonce. */
async function sealChunk(key, baseIv, index, isLast, plain) {
  const ct = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: independentNonce(baseIv, index, isLast),
      additionalData: FORMAT_HEADER,
      tagLength: 128,
    },
    key,
    plain
  );
  return new Uint8Array(ct);
}

/** Decrypt ONE chunk exactly as the format says, with an independent nonce. */
async function openChunk(key, baseIv, index, isLast, ct) {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: independentNonce(baseIv, index, isLast),
      additionalData: FORMAT_HEADER,
      tagLength: 128,
    },
    key,
    ct
  );
  return new Uint8Array(plain);
}

/** Build a whole container from independently sealed chunks. */
function buildContainer(chunkBytes, plainSize) {
  const chunks = Math.max(1, Math.ceil(plainSize / FORMAT_CHUNK_SIZE));
  const parts = [FORMAT_HEADER.slice()];
  for (let i = 0; i < chunks; i++) parts.push(chunkBytes[i]);
  let total = FORMAT_HEADER.length;
  for (const c of chunkBytes) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function pattern(n, seed = 5) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >>> 16;
  }
  return out;
}

/**
 * Byte comparison without building a multi-megabyte assert diff: a failing
 * 17 MB deepEqual makes node's differ allocate and abort the whole process.
 */
function assertBytesEqual(actual, expected, label) {
  const a = Buffer.isBuffer(actual) ? actual : Buffer.from(actual.buffer, actual.byteOffset, actual.length);
  const b = Buffer.isBuffer(expected) ? expected : Buffer.from(expected.buffer, expected.byteOffset, expected.length);
  assert.equal(a.length, b.length, `${label}: byte length`);
  if (Buffer.compare(a, b) !== 0) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    assert.fail(`${label}: first difference at byte ${i} (${a[i]} != ${b[i]})`);
  }
}

async function seal(plain) {
  const material = generateAttachmentKeyMaterial();
  const { blob } = await encryptAttachmentStream(new Blob([plain]), material);
  return { ct: new Uint8Array(await blob.arrayBuffer()), ...material };
}

// ---------------------------------------------------------------------------

test('the container header is exactly the 8 bytes the format says', () => {
  assert.deepEqual([...HEADER], [0x57, 0x41, 0x54, 0x31, 0x10, 0x00, 0x00, 0x00]);
  assert.deepEqual([...FORMAT_HEADER], [0x57, 0x41, 0x54, 0x31, 0x10, 0x00, 0x00, 0x00]);
  assert.equal(HDR, 8);
  assert.equal(CS, FORMAT_CHUNK_SIZE);
  assert.equal(TAG, FORMAT_TAG_BYTES);
  assert.equal(PREFIX, FORMAT_NONCE_PREFIX);
  assert.equal(IVB, FORMAT_NONCE_BYTES);
});

test('the module chunkNonce is byte-identical to the independently computed nonce', async () => {
  const { baseIv } = generateAttachmentKeyMaterial();
  for (const index of [0, 1, 2, 255, 256, 257, 1000, 65535, 0xffffffff]) {
    for (const isLast of [false, true]) {
      assert.deepEqual(
        [...chunkNonce(baseIv, index, isLast)],
        [...independentNonce(baseIv, index, isLast)],
        `index ${index} final ${isLast}`
      );
    }
  }
});

test('the nonce bytes are prefix(7) || index(BIG-ENDIAN) || final flag', async () => {
  const { baseIv } = generateAttachmentKeyMaterial();

  // index 1 -> bytes 7..10 = 00 00 00 01
  assert.deepEqual([...independentNonce(baseIv, 1, false)].slice(7, 11), [0, 0, 0, 1]);
  // index 256 -> bytes 7..10 = 00 00 01 00 (this is what pins the endianness:
  // little-endian would give 00 01 00 00)
  assert.deepEqual([...independentNonce(baseIv, 256, false)].slice(7, 11), [0, 0, 1, 0]);
  // index 65535 -> 00 00 FF FF
  assert.deepEqual([...independentNonce(baseIv, 65535, false)].slice(7, 11), [0, 0, 0xff, 0xff]);
  // the final flag is the last byte, and only the LAST chunk sets it
  assert.equal(independentNonce(baseIv, 0, true)[11], 1);
  assert.equal(independentNonce(baseIv, 0, false)[11], 0);
  // the prefix is copied verbatim
  assert.deepEqual([...independentNonce(baseIv, 0, false)].slice(0, 7), [...baseIv.subarray(0, 7)]);
});

test('direction 1: module ciphertext is opened by the independent nonce', async () => {
  const cases = [
    { name: 'one chunk', plain: pattern(FORMAT_CHUNK_SIZE, 1) },
    { name: 'two chunks + partial last chunk', plain: pattern(2 * FORMAT_CHUNK_SIZE + 50, 2) },
    { name: 'index above 255', plain: pattern(260 * FORMAT_CHUNK_SIZE, 3) },
  ];

  for (const { name, plain } of cases) {
    const { ct, rawKey, baseIv } = await seal(plain);
    const key = await importAesKey(rawKey);
    const chunks = Math.max(1, Math.ceil(plain.length / FORMAT_CHUNK_SIZE));

    let off = FORMAT_HEADER.length;
    const recovered = [];
    for (let i = 0; i < chunks; i++) {
      const plainLen = Math.min(FORMAT_CHUNK_SIZE, plain.length - i * FORMAT_CHUNK_SIZE);
      const ctLen = plainLen + FORMAT_TAG_BYTES;
      const chunkCt = ct.slice(off, off + ctLen);
      off += ctLen;
      const opened = await openChunk(key, baseIv, i, i === chunks - 1, chunkCt);
      recovered.push(Buffer.from(opened));
    }

    assertBytesEqual(Buffer.concat(recovered), plain, name);
    assert.equal(off, ct.length, `${name}: every ciphertext byte accounted for`);
  }
});

test('direction 2: a container built with the independent nonce opens in the module', async () => {
  const cases = [
    { name: 'one chunk', plain: pattern(FORMAT_CHUNK_SIZE, 4) },
    { name: 'two chunks + partial last chunk', plain: pattern(2 * FORMAT_CHUNK_SIZE + 50, 5) },
    { name: 'index above 255', plain: pattern(260 * FORMAT_CHUNK_SIZE, 6) },
  ];

  for (const { name, plain } of cases) {
    const { rawKey, baseIv } = generateAttachmentKeyMaterial();
    const key = await importAesKey(rawKey);
    const chunks = Math.max(1, Math.ceil(plain.length / FORMAT_CHUNK_SIZE));

    const chunkBytes = [];
    for (let i = 0; i < chunks; i++) {
      const start = i * FORMAT_CHUNK_SIZE;
      const slice = plain.subarray(start, Math.min(start + FORMAT_CHUNK_SIZE, plain.length));
      chunkBytes.push(await sealChunk(key, baseIv, i, i === chunks - 1, slice));
    }
    const container = buildContainer(chunkBytes, plain.length);

    // the module's own whole-file decrypt path
    const out = await decryptAttachmentStream(new Blob([container]), rawKey, baseIv, 'video/mp4');
    assertBytesEqual(new Uint8Array(await out.arrayBuffer()), plain, `${name}: decryptAttachmentStream`);

    // and the ranged decrypt path
    const range = { start: Math.max(0, plain.length - 100), end: plain.length - 1 };
    const ranged = await decryptChunkRange(container, rawKey, baseIv, 'video/mp4', range, plain.length);
    assertBytesEqual(ranged.bytes, plain.subarray(range.start, range.end + 1), `${name}: decryptChunkRange`);

    // and a range that starts in the chunk above 255
    if (chunks > 256) {
      const far = { start: 256 * FORMAT_CHUNK_SIZE, end: 256 * FORMAT_CHUNK_SIZE + 9 };
      const farOut = await decryptChunkRange(container, rawKey, baseIv, 'video/mp4', far, plain.length);
      assertBytesEqual(farOut.bytes, plain.subarray(far.start, far.end + 1), `${name}: chunk 256`);
    }
  }
});

test('direction 2: the module and the test build byte-identical containers', async () => {
  const plain = pattern(2 * FORMAT_CHUNK_SIZE + 50, 7);
  // ONE material for both sides: same key, same nonce prefix.
  const material = generateAttachmentKeyMaterial();
  const { rawKey, baseIv } = material;
  const key = await importAesKey(rawKey);
  const chunks = Math.max(1, Math.ceil(plain.length / FORMAT_CHUNK_SIZE));

  const chunkBytes = [];
  for (let i = 0; i < chunks; i++) {
    const start = i * FORMAT_CHUNK_SIZE;
    const slice = plain.subarray(start, Math.min(start + FORMAT_CHUNK_SIZE, plain.length));
    chunkBytes.push(await sealChunk(key, baseIv, i, i === chunks - 1, slice));
  }
  const mine = buildContainer(chunkBytes, plain.length);

  const { blob } = await encryptAttachmentStream(new Blob([plain]), material);
  const theirs = new Uint8Array(await blob.arrayBuffer());

  assert.equal(mine.length, theirs.length);
  assert.ok(mine.every((byte, i) => byte === theirs[i]), 'the two containers must be byte-identical');
});
