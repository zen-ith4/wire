// Server upload cap vs. the client format: a file of EXACTLY the
// configured maximum must be accepted (multer's limit is exclusive, so
// the cap needs +1), and one plaintext byte more must be refused.
// Built directly with the stream module, independent of any client gate.
import './_limit-1mb.mjs';
import { TEST_ROOT } from './_env.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startDmServer, createUser, prepareAsClient, postUpload } from './_harness.mjs';
import { encryptAttachmentStream, encryptedSizeFor } from '../../public/js/crypto/messages/attachment-stream.js';
import { dmCiphertextOverheadBytes } from '../../config/multer.js';

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

async function uploadSized(plainSize) {
  // valid envelope fields from a tiny real file; body of the wanted size
  const small = await prepareAsClient(alice, bob, { bytes: new Uint8Array(10), name: 's.bin' });
  const { blob } = await encryptAttachmentStream(new Blob([new Uint8Array(plainSize)]));
  return postUpload(server, alice, bob.id, { file: new File([blob], 'attachment.bin'), fields: small.fields });
}

test('ciphertext size arithmetic matches the multer cap', () => {
  assert.equal(encryptedSizeFor(MB), MB + dmCiphertextOverheadBytes(MB));
});

test('a file of exactly the maximum plaintext size is accepted', async () => {
  const res = await uploadSized(MB);
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('one plaintext byte over the maximum is refused and leaves no file behind', async () => {
  const before = fs.readdirSync(process.env.DM_UPLOAD_DIR).length;
  const res = await uploadSized(MB + 1);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Upload failed');
  assert.equal(fs.readdirSync(process.env.DM_UPLOAD_DIR).length, before);
});
