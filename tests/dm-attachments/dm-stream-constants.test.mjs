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

test('server and browser agree on the DM content cap', () => {
  const root = new URL('../../', import.meta.url);
  const wire = fs.readFileSync(new URL('public/js/crypto/messages/dm-v2-wire.js', root), 'utf8');
  const match = wire.match(/export const DM_V2_MAX_CONTENT_CHARS\s*=\s*(\d+)\s*;/);
  assert.ok(match, 'the browser cap must stay a single exported constant');
  assert.equal(server.DM_MAX_CONTENT_CHARS, Number(match[1]));
});

test('the controller uses the shared content cap, rejects with 413, and never slices', () => {
  const root = new URL('../../', import.meta.url);
  const controller = fs.readFileSync(new URL('controllers/dm.controller.js', root), 'utf8');
  assert.match(controller, /dmStream\.DM_MAX_CONTENT_CHARS/);
  assert.match(controller, /status\(413\)/);
  assert.match(controller, /DM_CONTENT_TOO_LONG/);
  assert.doesNotMatch(controller, /\b2000\b/, 'no private copy of the content cap');
  assert.doesNotMatch(controller, /\.slice\(\s*0\s*,\s*dmStream\.DM_MAX_CONTENT_CHARS\s*\)/, 'the server must reject, never truncate');
});

test('both the v1 and v2 send paths measure the serialised envelope', () => {
  const root = new URL('../../', import.meta.url);
  const source = fs.readFileSync(new URL('public/js/crypto/messages/message-crypto.js', root), 'utf8');
  assert.match(source, /const content\s*=\s*JSON\.stringify\(payload\)/);
  assert.match(source, /assertDmV2ContentFits\(\s*content\.length\s*\)/, 'v1 must check the exact stored value too');
});
