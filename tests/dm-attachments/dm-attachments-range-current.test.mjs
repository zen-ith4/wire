// DM attachment Range behaviour on the DM download endpoint - the CURRENT
// behaviour, pinned.
//
// This file adds to tests/dm-attachments/dm-attachments-range.test.mjs (it
// does not change it): it pins the cases that file only marked as
// test.todo, and adds the cases it did not cover at all.
//
//   - HEAD (with and without a Range header)
//   - a suffix Range (bytes=-N), also larger than the file
//   - an open-ended Range (bytes=N-)
//   - 416 responses: they carry Content-Range but NO Accept-Ranges
//     (the 200 and 206 responses do carry Accept-Ranges)
//   - a multi-range request: only the FIRST range is served
//   - the unanchored Range regex: "bytes=" is matched anywhere in the header
//   - auth on EVERY ranged request (no token, bad token, media token for a
//     different attachment, non-participant)
//   - the ?download=1 path: it has no Range handling at all
//
// Real Express + SQLite server, real ciphertext. No browser.
// The controller is NOT changed by this file: everything below is the
// behaviour of controllers/dm.controller.js:723-895 as it is today.
import { TEST_ROOT } from './_env.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startDmServer, createUser, prepareAsClient, postUpload, authGet, disposeActors } from './_harness.mjs';

const CS = 64 * 1024;
// The plaintext size of the upload. What the SERVER stores is the encrypted
// STREAM container, which is longer (8 header bytes + one 16-byte tag per
// chunk), so every HTTP-level size below comes from the fetched file.
const PLAIN = CS * 2 + 100;
let SIZE;

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
    bytes: new Uint8Array(PLAIN),
    name: 'range-current.mp4',
    mime: 'video/mp4',
  });
  const res = await postUpload(server, alice, bob.id, prepared);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  sent = res.body;

  const r = await authGet(server, bob, `/api/dm/attachments/${sent.id}`);
  assert.equal(r.status, 200);
  full = new Uint8Array(await r.arrayBuffer());
  SIZE = full.length;
  assert.equal(SIZE, PLAIN + 56, '8 header bytes + 3 x 16 tag bytes');
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

function raw(path, headers = {}, method = 'GET') {
  return globalThis.__nodeFetch(`${server.origin}${path}`, { method, headers });
}

// ------------------------------------------------------------------ HEAD --

test('HEAD without a Range: 200, the full length, Accept-Ranges, no body', async () => {
  const res = await raw(`/api/dm/attachments/${sent.id}`, { Authorization: `Bearer ${bob.token}` }, 'HEAD');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(SIZE));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-range'), null);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('current behaviour: HEAD with a Range header answers 206 with the range headers and an empty body', async () => {
  const res = await raw(
    `/api/dm/attachments/${sent.id}`,
    { Authorization: `Bearer ${bob.token}`, Range: 'bytes=10-99' },
    'HEAD',
  );
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 10-99/${SIZE}`);
  assert.equal(res.headers.get('content-length'), '90');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test.todo('decide and document the correct behaviour for a HEAD request that carries a Range header (RFC 9110 section 9.3.2: a HEAD response SHOULD carry the same headers as the corresponding GET; the current answer is 206 with the range headers and an empty body).');

// ---------------------------------------------------------------- suffix --

test('suffix Range: 206 for the last 50 bytes', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=-50' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${SIZE - 50}-${SIZE - 1}/${SIZE}`);
  assert.equal(res.headers.get('content-length'), '50');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(SIZE - 50));
});

test('suffix Range larger than the file: 206 for the whole file', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: `bytes=-${SIZE + 1000}` });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-${SIZE - 1}/${SIZE}`);
  assert.equal(res.headers.get('content-length'), String(SIZE));
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full);
});

// ------------------------------------------------------------ open-ended --

test('open-ended Range: 206 from the offset to the end of the file', async () => {
  const start = CS + 5;
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: `bytes=${start}-` });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${start}-${SIZE - 1}/${SIZE}`);
  assert.equal(res.headers.get('content-length'), String(SIZE - start));
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(start));
});

// ------------------------------------------------------------------- 416 --

test('current behaviour: an unparsable Range answers 416 with Content-Range and without Accept-Ranges', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=abc' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SIZE}`);
  assert.equal(
    res.headers.get('accept-ranges'),
    null,
    'the 416 branch does not send Accept-Ranges (controllers/dm.controller.js:784-792)',
  );
});

test.todo('decide whether a 416 response should carry Accept-Ranges (RFC 9110 section 14.2 asks for it on 200 and 206 responses; the 416 branch sends Content-Range only).');

test('current behaviour: a start past the end answers 416 with Content-Range and without Accept-Ranges', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: `bytes=${SIZE + 5}-` });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SIZE}`);
  assert.equal(
    res.headers.get('accept-ranges'),
    null,
    'the 416 branch does not send Accept-Ranges (controllers/dm.controller.js:820-832)',
  );
});

test.todo('decide whether a 416 response should carry Accept-Ranges (RFC 9110 section 14.2 asks for it on 200 and 206 responses; the 416 branch sends Content-Range only).');

test('current behaviour: start > end answers 416 with Content-Range and without Accept-Ranges', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=5-3' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SIZE}`);
  assert.equal(res.headers.get('accept-ranges'), null);
});

test.todo('decide whether a 416 response should carry Accept-Ranges (RFC 9110 section 14.2 asks for it on 200 and 206 responses; the 416 branch sends Content-Range only).');

test('the successful responses DO send Accept-Ranges (200 and 206)', async () => {
  const whole = await url(`/api/dm/attachments/${sent.id}`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');

  const part = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=0-1' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('accept-ranges'), 'bytes');
});

// ----------------------------------------------------------- multi-range --

test('current behaviour: a multi-range request serves only the FIRST range', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=0-1,5-6' });
  assert.equal(res.status, 206);
  assert.equal(
    res.headers.get('content-range'),
    `bytes 0-1/${SIZE}`,
    'the second range is ignored (controllers/dm.controller.js:780-782)',
  );
  assert.equal(res.headers.get('content-length'), '2');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(0, 2));
  assert.equal(
    res.headers.get('content-type'),
    'application/octet-stream',
    'the response is NOT multipart/byteranges',
  );
});

test.todo('RFC-correct multi-range behaviour: a multipart/byteranges 206 response or a full 200 response; the current controller ignores every range after the first (controllers/dm.controller.js:780-782).');

// ------------------------------------------------------- unanchored regex --

test('current behaviour: the unanchored Range regex matches "bytes=" anywhere in the header', async () => {
  for (const range of ['bytes=0-1abc', 'xbytes=0-1', 'junk bytes=0-1 junk']) {
    const res = await url(`/api/dm/attachments/${sent.id}`, { Range: range });
    assert.equal(res.status, 206, range);
    assert.equal(res.headers.get('content-range'), `bytes 0-1/${SIZE}`, range);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(0, 2), range);
  }
});

test.todo('RFC-correct behaviour for an unanchored or malformed Range header: ignore it and answer 200 with the full body (controllers/dm.controller.js:780-782).');

test('current behaviour: a Range unit other than bytes answers 416', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}`, { Range: 'items=0-1' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SIZE}`);
  assert.equal(res.headers.get('accept-ranges'), null);
});

test.todo('RFC 9110 section 14.2: a Range header whose unit the origin does not understand MUST be ignored (200 with the full body); the current controller answers 416 (controllers/dm.controller.js:780-792).');

// ------------------------------------------------------------------ auth --

test('a ranged request without any token: 401', async () => {
  const res = await raw(`/api/dm/attachments/${sent.id}`, { Range: 'bytes=0-1' });
  assert.equal(res.status, 401);
  assert.equal((await res.text()).length > 0, true);
});

test('a ranged request with a broken Bearer token: 401', async () => {
  const res = await raw(`/api/dm/attachments/${sent.id}`, {
    Authorization: 'Bearer not-a-token',
    Range: 'bytes=0-1',
  });
  assert.equal(res.status, 401);
});

test('a ranged request with a broken ?token=: 401', async () => {
  const res = await raw(`/api/dm/attachments/${sent.id}?token=not-a-token`, { Range: 'bytes=0-1' });
  assert.equal(res.status, 401);
});

test('a ranged request from a non-participant: 403', async () => {
  const res = await authGet(server, carol, `/api/dm/attachments/${sent.id}`, { Range: 'bytes=0-1' });
  assert.equal(res.status, 403);
});

test('a ranged request with a media token for THIS attachment: 206', async () => {
  const mint = await authGet(server, bob, `/api/dm/attachments/${sent.id}/media-token`);
  assert.equal(mint.status, 200);
  const { token } = await mint.json();
  assert.ok(token, 'a media token must be minted');

  const res = await raw(`/api/dm/attachments/${sent.id}?token=${encodeURIComponent(token)}`, {
    Range: 'bytes=10-19',
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 10-19/${SIZE}`);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full.slice(10, 20));
});

test('a media token for a DIFFERENT attachment is refused on a ranged request', async () => {
  const other = await prepareAsClient(alice, bob, {
    bytes: new Uint8Array(1024),
    name: 'other.bin',
    mime: 'application/octet-stream',
  });
  const posted = await postUpload(server, alice, bob.id, other);
  assert.equal(posted.status, 200, JSON.stringify(posted.body));

  const mint = await authGet(server, bob, `/api/dm/attachments/${posted.body.id}/media-token`);
  assert.equal(mint.status, 200);
  const { token } = await mint.json();

  const res = await raw(`/api/dm/attachments/${sent.id}?token=${encodeURIComponent(token)}`, {
    Range: 'bytes=0-1',
  });
  assert.equal(res.status, 401);
});

// -------------------------------------------------------------- download --

test('the ?download=1 path has NO Range handling: a Range header is ignored', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}?download=1`, { Range: 'bytes=10-19' });
  assert.equal(res.status, 200, 'the download branch never answers 206');
  assert.equal(res.headers.get('content-range'), null);
  assert.equal(res.headers.get('content-length'), String(SIZE));
  assert.equal(res.headers.get('accept-ranges'), null);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full);
});

test('the ?download=1 path without a Range: 200 with the whole file', async () => {
  const res = await url(`/api/dm/attachments/${sent.id}?download=1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(SIZE));
  assert.equal(res.headers.get('content-range'), null);
  assert.match(res.headers.get('content-disposition') || '', /attachment/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), full);
});

test('the ?download=1 path needs auth too', async () => {
  const res = await raw(`/api/dm/attachments/${sent.id}?download=1`, { Range: 'bytes=0-1' });
  assert.equal(res.status, 401);
});
