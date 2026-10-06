// DM attachment E2EE: STREAM chunked AES-256-GCM container.
// Pure WebCrypto, runs against the real client module.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptAttachmentStream,
  decryptAttachmentStream,
  generateAttachmentKeyMaterial,
  encryptedSizeFor,
  maxPlainSizeFor,
  buildAttachmentMeta,
  parseAttachmentMeta,
  AttachmentDecryptError,
  STREAM_CHUNK_SIZE as CS,
  STREAM_TAG_BYTES as TAG,
  STREAM_HEADER_BYTES as HDR,
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

test('round trip: empty, tiny, chunk boundaries and multi-chunk files', async () => {
  for (const n of [0, 1, 15, 16, CS - 1, CS, CS + 1, 2 * CS, 2 * CS + 5, 5 * CS + 123]) {
    const plain = pattern(n, n + 1);
    const { ct, rawKey, baseIv } = await seal(plain);
    assert.equal(ct.length, encryptedSizeFor(n), `ciphertext size for ${n}`);
    const out = await decryptAttachmentStream(new Blob([ct]), rawKey, baseIv, 'image/png');
    assert.equal(out.type, 'image/png');
    assert.deepEqual(await bytesOf(out), plain, `plaintext for ${n}`);
  }
});

test('ciphertext does not contain the plaintext marker', async () => {
  const marker = new TextEncoder().encode('UNIQUE-MARKER-9f3c1b7a-PLAINTEXT-LEAK');
  const plain = new Uint8Array(CS * 2);
  plain.set(marker, 100);
  plain.set(marker, CS + 5);
  const { ct } = await seal(plain);
  const hay = Buffer.from(ct);
  assert.equal(hay.indexOf(Buffer.from(marker)), -1);
});

test('two encryptions of the same file differ (fresh key + nonce prefix)', async () => {
  const plain = pattern(1000);
  const a = await seal(plain);
  const b = await seal(plain);
  assert.notDeepEqual(a.ct, b.ct);
  assert.notDeepEqual(a.rawKey, b.rawKey);
});

test('streams from a ReadableStream with awkward piece sizes', async () => {
  const plain = pattern(3 * CS + 777, 99);
  const { ct, rawKey, baseIv } = await seal(plain);
  for (const piece of [1, 7, 4096, CT - 1, CT, CT + 1, ct.length]) {
    let off = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (off >= ct.length) return controller.close();
        controller.enqueue(ct.slice(off, off + piece));
        off += piece;
      },
    });
    const out = await decryptAttachmentStream(stream, rawKey, baseIv);
    assert.deepEqual(await bytesOf(out), plain, `piece size ${piece}`);
  }
});

test('tampered chunk fails (first, middle, last, tag byte, header byte)', async () => {
  const plain = pattern(3 * CS + 50, 3);
  const { ct, rawKey, baseIv } = await seal(plain);
  const positions = [HDR + 10, HDR + CT + 10, HDR + 3 * CT + 5, HDR + CT - 1, 2];
  for (const pos of positions) {
    const bad = ct.slice();
    bad[pos] ^= 0x01;
    await assertRejects(decryptAttachmentStream(new Blob([bad]), rawKey, baseIv), `flip @${pos}`);
  }
});

test('reordered chunks fail', async () => {
  const plain = pattern(3 * CS, 11);
  const { ct, rawKey, baseIv } = await seal(plain);
  const header = ct.slice(0, HDR);
  const c0 = ct.slice(HDR, HDR + CT);
  const c1 = ct.slice(HDR + CT, HDR + 2 * CT);
  const c2 = ct.slice(HDR + 2 * CT);
  const swapped = new Blob([header, c1, c0, c2]);
  await assertRejects(decryptAttachmentStream(swapped, rawKey, baseIv), 'swap 0/1');
  const swappedLast = new Blob([header, c0, c2, c1]);
  await assertRejects(decryptAttachmentStream(swappedLast, rawKey, baseIv), 'swap 1/2');
});

test('truncated file fails: at a chunk boundary, mid-chunk, header only, empty', async () => {
  const plain = pattern(3 * CS + 10, 5);
  const { ct, rawKey, baseIv } = await seal(plain);
  const cuts = [HDR + 3 * CT, HDR + 2 * CT, HDR + CT, HDR + CT + 100, HDR + 5, HDR, 0, ct.length - 1];
  for (const cut of cuts) {
    await assertRejects(decryptAttachmentStream(new Blob([ct.slice(0, cut)]), rawKey, baseIv), `cut @${cut}`);
  }
});

test('truncating an exact-multiple file at a boundary fails (final flag authenticated)', async () => {
  const plain = pattern(2 * CS, 8);
  const { ct, rawKey, baseIv } = await seal(plain);
  await assertRejects(decryptAttachmentStream(new Blob([ct.slice(0, HDR + CT)]), rawKey, baseIv));
});

test('appending a chunk fails (previous final chunk no longer final)', async () => {
  const plain = pattern(CS + 5, 4);
  const a = await seal(plain);
  const extra = (await seal(pattern(CS, 6))).ct.slice(HDR);
  const appended = new Blob([a.ct, extra]);
  await assertRejects(decryptAttachmentStream(appended, a.rawKey, a.baseIv));
  const junk = new Blob([a.ct, new Uint8Array(TAG)]);
  await assertRejects(decryptAttachmentStream(junk, a.rawKey, a.baseIv));
});

test('wrong key, wrong IV prefix, and IV tampering fail', async () => {
  const plain = pattern(CS + 1, 21);
  const { ct, rawKey, baseIv } = await seal(plain);
  await assertRejects(decryptAttachmentStream(new Blob([ct]), pattern(32, 1), baseIv), 'wrong key');
  const badIv = baseIv.slice();
  badIv[0] ^= 1;
  await assertRejects(decryptAttachmentStream(new Blob([ct]), rawKey, badIv), 'wrong iv');
  await assertRejects(decryptAttachmentStream(new Blob([ct]), rawKey, new Uint8Array(11)), 'short iv');
  await assertRejects(decryptAttachmentStream(new Blob([ct]), new Uint8Array(31), baseIv), 'short key');
});

test('chunks from another file cannot be spliced in', async () => {
  const a = await seal(pattern(2 * CS, 1));
  const b = await seal(pattern(2 * CS, 2));
  const spliced = new Blob([a.ct.slice(0, HDR + CT), b.ct.slice(HDR + CT)]);
  await assertRejects(decryptAttachmentStream(spliced, a.rawKey, a.baseIv));
});

test('no plaintext is returned for a failed file (rejects, never partial)', async () => {
  const { ct, rawKey, baseIv } = await seal(pattern(3 * CS, 2));
  const bad = ct.slice();
  bad[bad.length - 1] ^= 1;
  let result = 'unset';
  try {
    result = await decryptAttachmentStream(new Blob([bad]), rawKey, baseIv);
  } catch (e) {
    result = e;
  }
  assert.ok(result instanceof AttachmentDecryptError);
});

test('size helpers agree with the real container', async () => {
  assert.equal(encryptedSizeFor(0), HDR + TAG);
  assert.equal(encryptedSizeFor(CS), HDR + CS + TAG);
  assert.equal(encryptedSizeFor(CS + 1), HDR + CS + 1 + 2 * TAG);
  const cap = 50 * 1024 * 1024 + HDR + Math.ceil((50 * 1024 * 1024) / CS) * TAG;
  assert.equal(maxPlainSizeFor(cap), 50 * 1024 * 1024);
  assert.ok(encryptedSizeFor(maxPlainSizeFor(cap)) <= cap);
  assert.ok(encryptedSizeFor(maxPlainSizeFor(cap) + 1) > cap);
});

test('metadata envelope: round trip, clamps and rejects malformed data', () => {
  const material = generateAttachmentKeyMaterial();
  const text = buildAttachmentMeta({
    ...material, name: 'x'.repeat(400), mime: 'audio/webm', size: 123, isVoice: true, width: 999999, height: -4,
  });
  const meta = parseAttachmentMeta(text);
  assert.equal(meta.name.length, 255);
  assert.equal(meta.mime, 'audio/webm');
  assert.equal(meta.isVoice, true);
  assert.equal(meta.width, 16384);
  assert.equal(meta.height, null);
  assert.deepEqual(meta.rawKey, material.rawKey);

  // the voice flag is ignored for a non-audio mime
  const notAudio = parseAttachmentMeta(buildAttachmentMeta({ ...material, name: 'a', mime: 'image/png', size: 1, isVoice: true }));
  assert.equal(notAudio.isVoice, false);

  for (const bad of ['not json', '{}', JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, cs: 1, k: 'AA==', iv: 'AA==' }),
    JSON.stringify({ ...JSON.parse(text), k: 'AAAA' }), JSON.stringify({ ...JSON.parse(text), mime: 'text/html;<script>' })]) {
    const parsed = parseAttachmentMeta(bad);
    if (bad.includes('script')) assert.equal(parsed.mime, 'application/octet-stream');
    else assert.equal(parsed, null, bad);
  }
});
