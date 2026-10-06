// The server (config/dm-stream.js) and the browser module
// (attachment-stream.js) each need the container constants; this fails
// the moment they disagree, and checks the server really uses them.
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import {
  STREAM_CHUNK_SIZE, STREAM_TAG_BYTES, STREAM_HEADER_BYTES, STREAM_BASE_IV_BYTES,
  encryptAttachmentStream, encryptedSizeFor,
} from '../../public/js/crypto/messages/attachment-stream.js';

const require = createRequire(import.meta.url);
const server = require('../../config/dm-stream.js');

test('server and browser agree on every container constant', () => {
  assert.equal(server.CHUNK_SIZE, STREAM_CHUNK_SIZE);
  assert.equal(server.TAG_BYTES, STREAM_TAG_BYTES);
  assert.equal(server.HEADER_BYTES, STREAM_HEADER_BYTES);
  assert.equal(server.NONCE_BASE_IV_BYTES, STREAM_BASE_IV_BYTES);
});

test('the header the browser actually writes equals the server header', async () => {
  const { blob } = await encryptAttachmentStream(new Blob([new Uint8Array(3)]));
  const head = Buffer.from(await blob.slice(0, STREAM_HEADER_BYTES).arrayBuffer());
  assert.deepEqual(head, server.HEADER);
});

test('server overhead arithmetic equals the browser size function', () => {
  for (const n of [0, 1, 65535, 65536, 65537, 50 * 1024 * 1024]) {
    assert.equal(n + server.ciphertextOverheadBytes(n), encryptedSizeFor(n));
  }
});

test('multer and the controller use the shared module, with no private copies', () => {
  const root = new URL('../../', import.meta.url);
  const multer = fs.readFileSync(new URL('config/multer.js', root), 'utf8');
  const controller = fs.readFileSync(new URL('controllers/dm.controller.js', root), 'utf8');
  assert.match(multer, /require\('\.\/dm-stream'\)/);
  assert.match(controller, /require\('\.\.\/config\/dm-stream'\)/);
  assert.match(multer, /[cC]iphertextOverheadBytes\s*=\s*dmStream\.ciphertextOverheadBytes/, 'multer must take the overhead function from the shared module');
  assert.match(controller, /dmStream\.HEADER\b/, 'controller must compare against the shared header');
  assert.match(controller, /dmStream\.CHUNK_SIZE\b/);
  for (const src of [multer, controller]) {
    assert.doesNotMatch(src, /\b65536\b|\b0x10000\b/, 'no hand-copied chunk size');
    assert.doesNotMatch(src, /(?:=|\()\s*64\s*\*\s*1024\b/, 'no hand-copied 64 KiB');
    assert.doesNotMatch(src, /DM_STREAM_(?:HEADER_BYTES|TAG_BYTES)\s*=\s*\d/, 'no hand-copied sizes');
    assert.doesNotMatch(src, /Buffer\.from\('WAT1'/, 'no hand-copied magic');
  }
});
