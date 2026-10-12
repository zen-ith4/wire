// Client-side size pre-check: an oversized file is rejected BEFORE any
// read or encryption; a file exactly at the limit still goes through the
// real server end to end. The limit is set to 1 MB so the test is fast.
import './_limit-1mb.mjs';
import { TEST_ROOT } from './_env.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startDmServer, createUser, prepareAsClient, postUpload, authGet } from './_harness.mjs';

const MB = 1024 * 1024;
let server; let alice; let bob;

before(async () => {
  server = await startDmServer();
  alice = await createUser(server, 'alice');
  bob = await createUser(server, 'bob');
});
after(async () => {
  await server.stop();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

// A File stand-in that reports a size but would count any read attempt.
function fakeBigFile(size) {
  const reads = { slice: 0, arrayBuffer: 0, stream: 0, text: 0 };
  const file = {
    name: 'huge.bin', type: 'application/octet-stream', size,
    slice() { reads.slice++; return new Blob([]); },
    arrayBuffer() { reads.arrayBuffer++; return Promise.resolve(new ArrayBuffer(0)); },
    stream() { reads.stream++; return new Blob([]).stream(); },
    text() { reads.text++; return Promise.resolve(''); },
  };
  return { file, reads };
}

async function client(user) {
  user.actor.use();
  return user.actor.importModule('media/attachment-e2ee.js');
}

test('the server exposes the configured limit to authenticated clients only', async () => {
  const ok = await authGet(server, alice, '/api/dm/limits');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { upload_max_mb: 1 });
  const anon = await globalThis.__nodeFetch(`${server.origin}/api/dm/limits`);
  assert.equal(anon.status, 401);
});

test('over the limit: rejected with a clear message, before any read or encryption', async () => {
  const mod = await client(alice);
  mod.resetUploadLimitCache();

  // Count every real AES-GCM encrypt call made while preparing.
  const subtle = globalThis.crypto.subtle;
  const realEncrypt = subtle.encrypt.bind(subtle);
  let encryptCalls = 0;
  subtle.encrypt = (...args) => { encryptCalls++; return realEncrypt(...args); };

  try {
    for (const size of [MB + 1, 5 * MB, 4 * 1024 * MB]) {
      const { file, reads } = fakeBigFile(size);
      await assert.rejects(
        mod.prepareDmAttachmentUpload({ file, caption: 'c', isVoice: false, senderId: alice.id, recipientId: bob.id }),
        (e) => e.name === 'AttachmentTooLargeError' && e.message === 'File is larger than 1 MB' && e.maxMb === 1,
        `size ${size}`
      );
      assert.deepEqual(reads, { slice: 0, arrayBuffer: 0, stream: 0, text: 0 }, 'file must not be read');
    }
    assert.equal(encryptCalls, 0, 'no encryption call for an oversized file');

    // Voice recordings go through the same gate.
    const voice = fakeBigFile(2 * MB);
    await assert.rejects(
      mod.prepareDmAttachmentUpload({ file: voice.file, caption: '', isVoice: true, senderId: alice.id, recipientId: bob.id }),
      (e) => e.name === 'AttachmentTooLargeError'
    );
  } finally {
    subtle.encrypt = realEncrypt;
  }
});

test('exactly at the limit: encrypted, uploaded and round-tripped through the real server', async () => {
  const bytes = new Uint8Array(MB);
  for (let i = 0; i < bytes.length; i += 4099) bytes[i] = (i / 4099) & 255;
  const prepared = await prepareAsClient(alice, bob, { bytes, name: 'exact.bin' });
  const res = await postUpload(server, alice, bob.id, prepared);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // One byte over is refused by the client, never reaching the server.
  const mod = await client(alice);
  await assert.rejects(
    mod.prepareDmAttachmentUpload({ file: new File([new Uint8Array(MB + 1)], 'x.bin'), caption: '', isVoice: false, senderId: alice.id, recipientId: bob.id }),
    (e) => e.name === 'AttachmentTooLargeError'
  );
});
