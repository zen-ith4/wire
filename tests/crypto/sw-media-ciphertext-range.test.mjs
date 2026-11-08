// Partial-ciphertext decryptor for the Service Worker media route (C2).
//
// The worker cannot use decryptChunkRange() for a Range request: that helper
// verifies that the supplied buffer is the WHOLE container. A media request
// fetches only the ciphertext chunks that contain the served plaintext range,
// so this helper authenticates exactly those chunks with the same container
// header, nonce layout and AAD.
//
//   node --test tests/crypto/sw-media-ciphertext-range.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AttachmentDecryptError,
  encryptAttachmentStream,
  generateAttachmentKeyMaterial,
  streamBytesToBase64,
} from '../../public/js/crypto/messages/attachment-stream.js';
import { ciphertextRangeFor, planMediaResponse } from '../../public/js/sw-media/handler-core.js';
import { decryptMediaCiphertextRange } from '../../public/js/sw-media/media-ciphertext.js';

const CHUNK = 64 * 1024;

function plaintext(size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

async function encrypted(size) {
  const plain = plaintext(size);
  const material = generateAttachmentKeyMaterial();
  const { blob, rawKey, baseIv } = await encryptAttachmentStream(new Blob([plain]), material);
  return {
    plain,
    rawKey,
    baseIv,
    ciphertext: new Uint8Array(await blob.arrayBuffer()),
  };
}

async function decryptSlice({ plain, rawKey, baseIv, ciphertext }, rangeHeader) {
  const totalSize = plain.length;
  const plan = planMediaResponse({
    method: 'GET',
    destination: 'video',
    streamKnown: true,
    clientMatches: true,
    authorized: true,
    mimeType: 'video/mp4',
    totalSize,
    rangeHeader,
  });
  assert.ok(plan.ciphertextRange, 'the plan must have a ciphertext range');
  const slice = ciphertext.subarray(
    plan.ciphertextRange.start,
    plan.ciphertextRange.end + 1
  );
  const bytes = await decryptMediaCiphertextRange({
    ciphertext: slice,
    ciphertextRange: plan.ciphertextRange,
    served: plan.served,
    totalSize,
    rawKey,
    baseIv,
  });
  return { plan, bytes };
}

test('a head range, an interior range and a tail range decrypt to the exact plaintext', async () => {
  const input = await encrypted(3 * CHUNK + 123);

  for (const rangeHeader of [
    'bytes=0-99',
    'bytes=65500-65600',
    `bytes=${3 * CHUNK - 50}-`,
    `bytes=${3 * CHUNK + 100}-${3 * CHUNK + 122}`,
  ]) {
    const { plan, bytes } = await decryptSlice(input, rangeHeader);
    assert.deepEqual(
      [...bytes],
      [...input.plain.subarray(plan.served.start, plan.served.end + 1)],
      rangeHeader
    );
  }
});

test('a one-byte range at the last byte works', async () => {
  const input = await encrypted(CHUNK + 7);
  const { plan, bytes } = await decryptSlice(input, `bytes=${input.plain.length - 1}-`);
  assert.deepEqual([...bytes], [input.plain[input.plain.length - 1]]);
  assert.deepEqual(plan.served, { start: input.plain.length - 1, end: input.plain.length - 1 });
});

test('the whole container can be decrypted through the partial helper', async () => {
  const input = await encrypted(2 * CHUNK + 5);
  const rangeHeader = `bytes=0-${input.plain.length - 1}`;
  const { plan, bytes } = await decryptSlice(input, rangeHeader);
  assert.equal(plan.status, 206);
  assert.deepEqual([...bytes], [...input.plain]);
});

test('tampered ciphertext fails authentication and returns no partial plaintext', async () => {
  const input = await encrypted(2 * CHUNK + 5);
  const totalSize = input.plain.length;
  const plan = planMediaResponse({
    method: 'GET',
    destination: 'video',
    streamKnown: true,
    clientMatches: true,
    authorized: true,
    mimeType: 'video/mp4',
    totalSize,
    rangeHeader: 'bytes=0-99',
  });
  const slice = input.ciphertext.slice(
    plan.ciphertextRange.start,
    plan.ciphertextRange.end + 1
  );
  slice[slice.length - 1] ^= 0x80;

  await assert.rejects(
    decryptMediaCiphertextRange({
      ciphertext: slice,
      ciphertextRange: plan.ciphertextRange,
      served: plan.served,
      totalSize,
      rawKey: input.rawKey,
      baseIv: input.baseIv,
    }),
    (error) => error instanceof AttachmentDecryptError || error.name === 'AttachmentDecryptError'
  );
});

test('a truncated ciphertext slice and the wrong key are rejected', async () => {
  const input = await encrypted(2 * CHUNK + 5);
  const totalSize = input.plain.length;
  const plan = planMediaResponse({
    method: 'GET',
    destination: 'video',
    streamKnown: true,
    clientMatches: true,
    authorized: true,
    mimeType: 'video/mp4',
    totalSize,
    rangeHeader: 'bytes=100-199',
  });
  const slice = input.ciphertext.subarray(
    plan.ciphertextRange.start,
    plan.ciphertextRange.end + 1
  );

  await assert.rejects(
    decryptMediaCiphertextRange({
      ciphertext: slice.subarray(0, slice.length - 1),
      ciphertextRange: plan.ciphertextRange,
      served: plan.served,
      totalSize,
      rawKey: input.rawKey,
      baseIv: input.baseIv,
    }),
    (error) => error.name === 'AttachmentDecryptError'
  );

  await assert.rejects(
    decryptMediaCiphertextRange({
      ciphertext: slice,
      ciphertextRange: plan.ciphertextRange,
      served: plan.served,
      totalSize,
      rawKey: new Uint8Array(32).fill(1),
      baseIv: input.baseIv,
    }),
    (error) => error.name === 'AttachmentDecryptError'
  );
});

test('an incorrect ciphertext range or plaintext size is rejected before decrypting', async () => {
  const input = await encrypted(2 * CHUNK + 5);
  const totalSize = input.plain.length;
  const plan = planMediaResponse({
    method: 'GET',
    destination: 'video',
    streamKnown: true,
    clientMatches: true,
    authorized: true,
    mimeType: 'video/mp4',
    totalSize,
    rangeHeader: 'bytes=100-199',
  });
  const slice = input.ciphertext.subarray(
    plan.ciphertextRange.start,
    plan.ciphertextRange.end + 1
  );

  for (const ciphertextRange of [
    { start: plan.ciphertextRange.start + 1, end: plan.ciphertextRange.end },
    { start: plan.ciphertextRange.start, end: plan.ciphertextRange.end - 1 },
  ]) {
    await assert.rejects(
      decryptMediaCiphertextRange({
        ciphertext: slice,
        ciphertextRange,
        served: plan.served,
        totalSize,
        rawKey: input.rawKey,
        baseIv: input.baseIv,
      }),
      (error) => error.name === 'AttachmentDecryptError'
    );
  }

  assert.deepEqual(
    ciphertextRangeFor({ totalSize, served: plan.served }),
    plan.ciphertextRange
  );
  assert.equal(streamBytesToBase64(input.rawKey).length, 44);
});

test('an empty file decrypts to an empty byte array', async () => {
  const material = generateAttachmentKeyMaterial();
  const out = await decryptMediaCiphertextRange({
    ciphertext: new Uint8Array(0),
    ciphertextRange: null,
    served: { start: 0, end: -1 },
    totalSize: 0,
    rawKey: material.rawKey,
    baseIv: material.baseIv,
  });
  assert.equal(out.length, 0);
});

test('tampering chunk k fails only ranges that touch chunk k', async () => {
  // 5 chunks: 0..3 full, 4 is a 5-byte final chunk.
  const input = await encrypted(4 * CHUNK + 5);
  const K = 2;
  const CT_CHUNK = CHUNK + 16;
  const tampered = new Uint8Array(input.ciphertext);
  tampered[8 + K * CT_CHUNK + 10] ^= 0x01; // one bit inside chunk K
  const bad = { ...input, ciphertext: tampered };

  const lo = (chunk, add = 0) => chunk * CHUNK + add;
  const range = (a, b) => `bytes=${a}-${b}`;

  // Ranges that do NOT touch chunk K still decrypt to the exact plaintext.
  const untouched = [
    range(0, 99),                                  // chunk 0
    range(lo(1), lo(1, 99)),                       // chunk 1
    range(lo(0, 10), lo(1, 99)),                   // chunks 0-1 (spans a boundary)
    range(lo(3), lo(3, 99)),                       // chunk 3
    range(lo(4), lo(4, 4)),                        // final chunk
    range(lo(3, 10), lo(4, 4)),                    // chunks 3-4
  ];
  for (const header of untouched) {
    const { plan, bytes } = await decryptSlice(bad, header);
    assert.deepEqual(
      bytes,
      input.plain.subarray(plan.served.start, plan.served.end + 1),
      `range ${header} does not touch chunk ${K} and must decrypt`
    );
  }

  // Ranges that touch chunk K fail authentication and return nothing.
  const touching = [
    range(lo(K), lo(K, 99)),                       // inside chunk K
    range(lo(K, CHUNK - 1), lo(K, CHUNK - 1)),     // last byte of chunk K
    range(lo(1, 10), lo(K, 10)),                   // chunks 1-2
    range(lo(K, 10), lo(3, 10)),                   // chunks 2-3
    range(lo(0), lo(4, 4)),                        // the whole file
  ];
  for (const header of touching) {
    await assert.rejects(
      decryptSlice(bad, header),
      (error) => error instanceof AttachmentDecryptError || error.name === 'AttachmentDecryptError',
      `range ${header} touches chunk ${K} and must fail`
    );
  }
});
