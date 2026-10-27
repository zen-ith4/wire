// DM attachment HTTP Range behaviour on the DM download endpoint.
// Real Express + SQLite server, real ciphertext. No browser.
import { TEST_ROOT } from './_env.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startDmServer, createUser, prepareAsClient, postUpload, authGet, disposeActors } from './_harness.mjs';

const CS = 64 * 1024;
const TAG = 16;
const HDR = 8;

let server;
let alice;
let bob;
let carol;
let sent;
let full;

before(async () => {
  server = await startDmServer();
  alice = await createUser(server, 'alice');
  bob = await createUser(server, 'bob');
  carol = await createUser(server, 'carol');

  const prepared = await prepareAsClient(alice, bob, {
    bytes: new Uint8Array(CS * 2 + 100),
    name: 'range.mp4',
    mime: 'video/mp4',
  });
  const res = await postUpload(server, alice, bob.id, prepared);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  sent = res.body;

  const r = await authGet(server, bob, `/api/dm/attachments/${sent.id}`);
  assert.equal(r.status, 200);
  full = new Uint8Array(await r.arrayBuffer());
});

after(async () => {
  await disposeActors();
  await server.stop();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

function url(path, headers = {}) {
  return authGet(server, bob, path, headers);
}

test('no Authorization header returns 401', async () => {
  const res = await globalThis.__nodeFetch(`${server.origin}/api/dm/attachments/${sent.id}`, {
    headers: { Range: 'bytes=0-1' },
  });
  assert.equal(res.status, 401);
});

test('non-participant gets 403', async () => {
  const res = await authGet(server, carol, `/api/dm/attachments/${sent.id}`, { Range: 'bytes=0-1' });
  assert.ok([403, 404].includes(res.status), `carol got ${res.status}`);
});

test('valid participant gets 200 without Range', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('content-length'), String(full.length));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full);
});

test('closed Range: 206 with correct headers and exact body slice', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=10-99' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 10-99/${full.length}`);
  assert.equal(res.headers.get('content-length'), '90');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(10, 100));
});

test('Safari bytes=0-1 probe: 206 with exactly 2 bytes', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=0-1' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-1/${full.length}`);
  assert.equal(res.headers.get('content-length'), '2');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(0, 2));
});

test('open-ended Range: 206 to end of file', async () => {
  const start = CS + 5;
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: `bytes=${start}-` });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${start}-${full.length - 1}/${full.length}`);
  assert.equal(res.headers.get('content-length'), String(full.length - start));
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(start));
});

test('suffix Range: 206 for the last 50 bytes', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=-50' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${full.length - 50}-${full.length - 1}/${full.length}`);
  assert.equal(res.headers.get('content-length'), '50');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(full.length - 50));
});

test('start past end: 416 with Content-Range: bytes */total', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: `bytes=${full.length + 5}-` });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${full.length}`);
});

test('start greater than end: 416', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=5-3' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${full.length}`);
});

test('current behavior, RFC 9110 says ignore + 200: malformed Range currently returns 416', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=abc' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${full.length}`);
});

test.todo('RFC 9110 correct behavior for a malformed Range: ignore the Range header and return 200 with the full body (controllers/dm.controller.js:780-782).');

test('current behavior, RFC 9110 says ignore + 200: a unit other than bytes currently returns 416', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'items=0-1' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${full.length}`);
});

test.todo('RFC 9110 correct behavior for a non-bytes Range unit: ignore the Range header and return 200 with the full body (controllers/dm.controller.js:780-782).');

test('current behavior: the unanchored Range regex matches the first range (Found, not changed: controllers/dm.controller.js:780-782)', async () => {
  for (const range of ['bytes=0-1abc', 'xbytes=0-1']) {
    const res = await url(`/api/dm/attachments/${sent.id}`, { Range: range });
    assert.equal(res.status, 206, range);
    assert.equal(res.headers.get('content-range'), `bytes 0-1/${full.length}`, range);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(0, 2), range);
  }
});

test.todo('RFC-correct behavior for an unanchored or malformed Range header: ignore it and return 200 with the full body (controllers/dm.controller.js:780-782).');

test('current behavior: multi-range serves only the first range (Found, not changed: controllers/dm.controller.js:780-782)', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=0-1,5-6' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-1/${full.length}`);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(0, 2));
});

test.todo('RFC-correct multi-range behavior: a multipart 206 response or a full 200 response; the current controller ignores the second range (controllers/dm.controller.js:780-782).');

test('HEAD returns headers without a body', async () => {
  const res = await globalThis.__nodeFetch(`${server.origin}/api/dm/attachments/${sent.id}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(full.length));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test.todo('multi-range (bytes=0-1,5-6) is not supported by the current controller; it serves only the first range. Found, not changed: controllers/dm.controller.js:780-782.');

test.todo('416 responses currently omit Accept-Ranges. Found, not changed: controllers/dm.controller.js:784-792 and :820-832.');