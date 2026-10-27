// The real public/sw.js media route, executed in a VM (Item 3, phase 3C, C2).
//
// These tests exercise the worker's own fetch and message branches, not a
// second copy of the route logic:
//   - the media branch is before the Range early return, but only when the
//     compile-time flag is ON;
//   - registration binds the stream to event.source.id, not a page field;
//   - unknown streams, wrong clients, empty clientIds and non-media
//     destinations fail closed;
//   - a Range request returns 206 and the exact plaintext bytes;
//   - a token pull wakes the pending fetch, and a 5 s timeout returns 401;
//   - the 10-minute idle TTL and per-client purge drop only the right stream;
//   - a fresh worker has an empty registry and can be re-handshaken;
//   - the route never touches Cache Storage.
//
//   node --test tests/crypto/sw-media-fetch.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  encryptAttachmentStream,
  generateAttachmentKeyMaterial,
  streamBytesToBase64,
} from '../../public/js/crypto/messages/attachment-stream.js';
import {
  SW_MEDIA_ORIGIN,
  loadSwMediaHarness,
} from '../_sw-media-harness.mjs';

const CHUNK = 64 * 1024;
const TOKEN_TIMEOUT_MS = 5000;
const IDLE_TTL_MS = 10 * 60 * 1000;

function plaintext(size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 17 + 3) & 0xff;
  return out;
}

function streamMessage({
  streamId = 'stream-1',
  messageId = 42,
  scope = 'dm',
  groupId,
  plainSize,
  rawKey,
  baseIv,
  mime = 'video/mp4',
  clientId = 'client-b',
} = {}) {
  return {
    type: 'REGISTER_STREAM',
    streamId,
    messageId,
    scope,
    groupId,
    keyB64: streamBytesToBase64(rawKey),
    baseIvB64: streamBytesToBase64(baseIv),
    mime,
    plainSize,
    // Deliberately not the registering client: the SW must use event.source.id.
    clientId,
  };
}

async function makeStream({
  enabled = true,
  size = 2 * CHUNK + 123,
  streamId = 'stream-1',
  messageId = 42,
  clientId = 'client-a',
  path = '/api/dm/attachments/42',
} = {}) {
  const harness = loadSwMediaHarness({ enabled });
  harness.addClient('client-a');
  harness.addClient('client-b');

  const plain = plaintext(size);
  const material = generateAttachmentKeyMaterial();
  const { blob, rawKey, baseIv } = await encryptAttachmentStream(new Blob([plain]), material);
  const ciphertext = new Uint8Array(await blob.arrayBuffer());
  harness.setResource(path, ciphertext);

  harness.dispatchMessage(streamMessage({
    streamId,
    messageId,
    plainSize: plain.length,
    rawKey,
    baseIv,
    clientId: 'client-b',
  }), { clientId });

  return { harness, plain, ciphertext, rawKey, baseIv, streamId, messageId, clientId, path };
}

function authorize(harness, streamId, clientId = 'client-a', token = 'media-token') {
  harness.dispatchMessage({
    type: 'UPDATE_TOKEN',
    streamId,
    token,
    expiresAt: harness.now() + 90000,
  }, { clientId });
}

async function responseBytes(response) {
  return new Uint8Array(await response.arrayBuffer());
}

test('ranged request returns 206, never 200', async () => {
  const { harness, plain } = await makeStream();
  authorize(harness, 'stream-1');

  const pending = harness.dispatchFetch({
    range: 'bytes=100-199',
    destination: 'video',
    clientId: 'client-a',
  });

  assert.equal(pending.responded, true);
  const response = await pending.response;
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), `bytes 100-199/${plain.length}`);
  assert.equal(response.headers.get('Content-Length'), '100');
  assert.deepEqual([...await responseBytes(response)], [...plain.subarray(100, 200)]);
});

test('the media branch is before the Range early return, but only when the flag is ON', async () => {
  const off = loadSwMediaHarness({ enabled: false });
  off.addClient('client-a');
  const offResult = off.dispatchFetch({ range: 'bytes=0-1', clientId: 'client-a' });
  assert.equal(offResult.responded, false, 'flag OFF leaves Range requests to the network');

  const on = await makeStream({ enabled: true });
  authorize(on.harness, 'stream-1');
  const onResult = on.harness.dispatchFetch({ range: 'bytes=0-1', clientId: 'client-a' });
  assert.equal(onResult.responded, true);
  assert.equal((await onResult.response).status, 206);
});

test('MEDIA_STREAM_STATUS reports the compile-time flag and bounds', () => {
  for (const enabled of [false, true]) {
    const harness = loadSwMediaHarness({ enabled });
    harness.addClient('client-a');
    let reply = null;
    const port = { postMessage: (message) => { reply = message; } };

    harness.dispatchMessage(
      { type: 'MEDIA_STREAM_STATUS' },
      { clientId: 'client-a', ports: [port] }
    );

    assert.deepEqual({ ...reply }, {
      type: 'MEDIA_STREAM_STATUS',
      enabled,
      maxResponseChunks: 16,
      readAheadChunks: 8,
    });
  }
});

test('no Range returns 200 with the whole plaintext; HEAD returns no body and no ciphertext fetch', async () => {
  const { harness, plain } = await makeStream({ size: CHUNK + 23 });
  authorize(harness, 'stream-1');

  const full = harness.dispatchFetch({ clientId: 'client-a', destination: 'video' });
  const fullResponse = await full.response;
  assert.equal(fullResponse.status, 200);
  assert.equal(fullResponse.headers.get('Content-Length'), String(plain.length));
  assert.deepEqual([...await responseBytes(fullResponse)], [...plain]);

  const requestsBeforeHead = harness.requests.length;
  const head = harness.dispatchFetch({ method: 'HEAD', clientId: 'client-a', destination: 'video' });
  const headResponse = await head.response;
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('Content-Length'), String(plain.length));
  assert.equal((await responseBytes(headResponse)).length, 0);
  assert.equal(harness.requests.length, requestsBeforeHead, 'HEAD must not fetch ciphertext');
});

test('unknown stream, wrong client, empty client and wrong destination fail closed with 404', async () => {
  const { harness } = await makeStream();
  authorize(harness, 'stream-1');

  assert.equal((await harness.dispatchFetch({ url: '/__wire_media_stream/missing', clientId: 'client-a' }).response).status, 404);
  assert.equal((await harness.dispatchFetch({ clientId: 'client-b' }).response).status, 404);
  assert.equal((await harness.dispatchFetch({ clientId: '' }).response).status, 404);
  assert.equal((await harness.dispatchFetch({ clientId: 'client-a', destination: 'empty' }).response).status, 404);
});

test('the media route answers 405 for non-GET/HEAD methods', async () => {
  const { harness } = await makeStream();
  authorize(harness, 'stream-1');

  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await harness.dispatchFetch({ method, clientId: 'client-a' }).response;
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  }
});

test('registration binds the stream to event.source.id, not the page-supplied clientId', async () => {
  const { harness } = await makeStream();
  authorize(harness, 'stream-1', 'client-a');

  const fromA = await harness.dispatchFetch({ clientId: 'client-a' }).response;
  assert.equal(fromA.status, 200);

  const fromB = await harness.dispatchFetch({ clientId: 'client-b' }).response;
  assert.equal(fromB.status, 404);
});

test('a token pull wakes a pending fetch and the ciphertext request carries ?token=', async () => {
  const { harness } = await makeStream();
  const pending = harness.dispatchFetch({ range: 'bytes=0-99', clientId: 'client-a' });

  await harness.flush();
  const tokenNeeded = harness.posted.filter((entry) => entry.data.type === 'TOKEN_NEEDED');
  assert.equal(tokenNeeded.length, 1);
  assert.equal(tokenNeeded[0].clientId, 'client-a');
  assert.equal(tokenNeeded[0].data.streamId, 'stream-1');

  authorize(harness, 'stream-1', 'client-a', 'fresh-token');
  const response = await pending.response;
  assert.equal(response.status, 206);

  const last = harness.requests.at(-1);
  assert.match(last.url, /\?token=fresh-token/);
  assert.equal(last.rangeHeader, 'bytes=8-65559');
});

test('a missing token and no UPDATE_TOKEN within 5 s returns 401 and marks the stream dead', async () => {
  const { harness } = await makeStream();
  const pending = harness.dispatchFetch({ range: 'bytes=0-99', clientId: 'client-a' });

  await harness.flush();
  await harness.advance(TOKEN_TIMEOUT_MS);

  const response = await pending.response;
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');

  const dead = harness.posted.filter((entry) => entry.data.type === 'STREAM_DEAD');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].data.streamId, 'stream-1');

  const again = await harness.dispatchFetch({ range: 'bytes=0-1', clientId: 'client-a' }).response;
  assert.equal(again.status, 401);
});

test('UPDATE_TOKEN from another client is ignored', async () => {
  const { harness } = await makeStream();
  const pending = harness.dispatchFetch({ range: 'bytes=0-99', clientId: 'client-a' });
  await harness.flush();

  authorize(harness, 'stream-1', 'client-b', 'wrong-client-token');
  await harness.advance(TOKEN_TIMEOUT_MS);

  assert.equal((await pending.response).status, 401);
});

test('the 10-minute idle TTL removes a stream that is never touched', async () => {
  const { harness } = await makeStream();
  authorize(harness, 'stream-1');

  await harness.advance(IDLE_TTL_MS + 1);
  const response = await harness.dispatchFetch({ clientId: 'client-a' }).response;
  assert.equal(response.status, 404);
});

test('PURGE_CLIENT removes only the source client streams', async () => {
  const { harness } = await makeStream();
  const other = await makeStreamForHarness(harness, {
    streamId: 'stream-2',
    messageId: 43,
    path: '/api/dm/attachments/43',
    clientId: 'client-b',
    size: CHUNK + 11,
  });
  authorize(harness, 'stream-1', 'client-a');
  authorize(harness, 'stream-2', 'client-b');
  assert.equal((await harness.dispatchFetch({ url: '/__wire_media_stream/stream-2', clientId: 'client-b' }).response).status, 200);
  assert.equal((await harness.dispatchFetch({ url: '/__wire_media_stream/stream-1', clientId: 'client-a' }).response).status, 200);

  // A page cannot purge another client by naming it.
  harness.dispatchMessage(
    { type: 'PURGE_CLIENT', clientId: 'client-b' },
    { clientId: 'client-a' }
  );

  assert.equal((await harness.dispatchFetch({ url: '/__wire_media_stream/stream-2', clientId: 'client-b' }).response).status, 200);
  assert.equal((await harness.dispatchFetch({ url: '/__wire_media_stream/stream-1', clientId: 'client-a' }).response).status, 200);

  harness.dispatchMessage(
    { type: 'PURGE_CLIENT', clientId: 'client-a' },
    { clientId: 'client-a' }
  );
  assert.equal((await harness.dispatchFetch({ url: '/__wire_media_stream/stream-1', clientId: 'client-a' }).response).status, 404);
  assert.equal((await harness.dispatchFetch({ url: '/__wire_media_stream/stream-2', clientId: 'client-b' }).response).status, 200);
  assert.ok(other.plain.length > 0);
});

test('a fresh worker has an empty registry and can be re-handshaken', async () => {
  const first = await makeStream();
  authorize(first.harness, 'stream-1');
  assert.equal((await first.harness.dispatchFetch({ clientId: 'client-a' }).response).status, 200);

  const revived = loadSwMediaHarness({ enabled: true });
  revived.addClient('client-a');
  revived.setResource('/api/dm/attachments/42', first.ciphertext);
  assert.equal((await revived.dispatchFetch({ clientId: 'client-a' }).response).status, 404);

  revived.dispatchMessage(streamMessage({
    plainSize: first.plain.length,
    rawKey: first.rawKey,
    baseIv: first.baseIv,
  }), { clientId: 'client-a' });
  authorize(revived, 'stream-1');

  const response = await revived.dispatchFetch({ range: 'bytes=0-9', clientId: 'client-a' }).response;
  assert.equal(response.status, 206);
});

test('the route never writes to Cache Storage', async () => {
  const { harness } = await makeStream({ size: 100 });
  authorize(harness, 'stream-1');
  assert.equal((await harness.dispatchFetch({ clientId: 'client-a' }).response).status, 200);
  assert.equal(harness.cacheEntryCount(), 0);
  assert.deepEqual(harness.cacheOps, []);
});

test('a group scope is not a participant and is ignored', async () => {
  const harness = loadSwMediaHarness({ enabled: true });
  harness.addClient('client-a');
  const plain = plaintext(100);
  const material = generateAttachmentKeyMaterial();
  const { blob, rawKey, baseIv } = await encryptAttachmentStream(new Blob([plain]), material);
  harness.setResource('/api/groups/7/attachments/42', new Uint8Array(await blob.arrayBuffer()));

  harness.dispatchMessage(streamMessage({
    plainSize: plain.length,
    rawKey,
    baseIv,
    scope: 'group',
    groupId: 7,
  }), { clientId: 'client-a' });
  authorize(harness, 'stream-1');
  assert.equal((await harness.dispatchFetch({ clientId: 'client-a' }).response).status, 404);
});

test('a 401 from the origin pulls one fresh token, then a second 401 kills the stream', async () => {
  const { harness } = await makeStream({ size: 100 });
  authorize(harness, 'stream-1', 'client-a', 'stale-token');

  let originStatus = 401;
  const originalFetch = harness.sandbox.fetch;
  harness.sandbox.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (originStatus === 401) {
      originStatus = 206;
      return new Response(null, { status: 401 });
    }
    return response;
  };

  const pending = harness.dispatchFetch({ range: 'bytes=0-10', clientId: 'client-a' });
  await harness.flush();
  const needed = harness.posted.filter((entry) => entry.data.type === 'TOKEN_NEEDED');
  assert.equal(needed.length, 1);

  authorize(harness, 'stream-1', 'client-a', 'fresh-token');
  await harness.flush();
  const first = await pending.response;
  assert.equal(first.status, 206);

  originStatus = 401;
  const secondPending = harness.dispatchFetch({ range: 'bytes=0-10', clientId: 'client-a' });
  await harness.flush();
  await harness.advance(TOKEN_TIMEOUT_MS);
  const second = await secondPending.response;
  assert.equal(second.status, 401);

  const dead = harness.posted.filter((entry) => entry.data.type === 'STREAM_DEAD');
  assert.ok(dead.length >= 1);
});

test('a 403 from the origin is terminal and does not pull a token', async () => {
  const { harness } = await makeStream({ size: 100 });
  authorize(harness, 'stream-1', 'client-a', 'stale-token');

  const originalFetch = harness.sandbox.fetch;
  harness.sandbox.fetch = async () => new Response(null, { status: 403 });

  const response = await harness.dispatchFetch({ range: 'bytes=0-10', clientId: 'client-a' }).response;
  assert.equal(response.status, 403);
  assert.equal(harness.posted.filter((entry) => entry.data.type === 'TOKEN_NEEDED').length, 0);
});

test('a redirect from the origin is rejected', async () => {
  const { harness } = await makeStream({ size: 100 });
  authorize(harness, 'stream-1');

  const originalFetch = harness.sandbox.fetch;
  harness.sandbox.fetch = async () => {
    throw new TypeError('redirected');
  };

  const response = await harness.dispatchFetch({ range: 'bytes=0-10', clientId: 'client-a' }).response;
  assert.equal(response.status, 500);
});

test('the media branch contains no caches.put call', () => {
  const source = fs.readFileSync('public/sw.js', 'utf8');
  const start = source.lastIndexOf('MEDIA STREAM ROUTE (Item 3, phase 3C).');
  const end = source.indexOf('// =================================================================== fetch ==', start);
  const branch = source.slice(start, end);
  assert.doesNotMatch(branch, /caches\.put/);
});

test('the ciphertext fetch disables redirects', () => {
  const source = fs.readFileSync('public/sw.js', 'utf8');
  assert.match(source, /redirect: 'error'/);
});

async function makeStreamForHarness(harness, {
  streamId,
  messageId,
  path,
  clientId,
  size,
}) {
  const plain = plaintext(size);
  const material = generateAttachmentKeyMaterial();
  const { blob, rawKey, baseIv } = await encryptAttachmentStream(new Blob([plain]), material);
  harness.setResource(path, new Uint8Array(await blob.arrayBuffer()));
  harness.dispatchMessage(streamMessage({
    streamId,
    messageId,
    plainSize: plain.length,
    rawKey,
    baseIv,
    clientId: 'client-b',
  }), { clientId });
  return { plain };
}

test('a registration with an invalid key, IV, size or scope is ignored', async () => {
  const harness = loadSwMediaHarness({ enabled: true });
  harness.addClient('client-a');
  harness.setResource('/api/dm/attachments/42', new Uint8Array(100));

  for (const message of [
    { ...streamMessage({
      plainSize: 100,
      rawKey: new Uint8Array(31),
      baseIv: new Uint8Array(12),
    }) },
    { ...streamMessage({
      plainSize: 100,
      rawKey: new Uint8Array(32),
      baseIv: new Uint8Array(11),
    }) },
    { ...streamMessage({
      plainSize: -1,
      rawKey: new Uint8Array(32),
      baseIv: new Uint8Array(12),
    }) },
    { ...streamMessage({
      plainSize: 100,
      rawKey: new Uint8Array(32),
      baseIv: new Uint8Array(12),
      scope: 'unknown',
    }) },
  ]) {
    harness.dispatchMessage(message, { clientId: 'client-a' });
  }

  assert.equal((await harness.dispatchFetch({ clientId: 'client-a' }).response).status, 404);
});

test('a registration with a missing, legacy-named or non-decimal messageId is ignored', async () => {
  const bad = [undefined, '', 'abc', '42/../43', '42?x=1', '-1', '4.2', ' 42', '4'.repeat(21), null, {}, [42, 43]];
  async function setup() {
    const harness = loadSwMediaHarness({ enabled: true });
    harness.addClient('client-a');
    const plain = plaintext(CHUNK + 11);
    const material = generateAttachmentKeyMaterial();
    const { blob, rawKey, baseIv } = await encryptAttachmentStream(new Blob([plain]), material);
    harness.setResource('/api/dm/attachments/42', new Uint8Array(await blob.arrayBuffer()));
    return { harness, plain, rawKey, baseIv };
  }

  for (const value of bad) {
    const { harness, plain, rawKey, baseIv } = await setup();
    // streamMessage() applies a default id for undefined, so set the field after.
    const message = streamMessage({ plainSize: plain.length, rawKey, baseIv, clientId: 'client-a' });
    if (value === undefined) delete message.messageId;
    else message.messageId = value;
    harness.dispatchMessage(message, { clientId: 'client-a' });
    authorize(harness, 'stream-1', 'client-a');
    const response = await harness.dispatchFetch({ clientId: 'client-a' }).response;
    assert.equal(response.status, 404, `messageId ${JSON.stringify(value)} must not register a stream`);
  }

  // The pre-rename field name must not register a stream either.
  const { harness, plain, rawKey, baseIv } = await setup();
  const message = streamMessage({ plainSize: plain.length, rawKey, baseIv, clientId: 'client-a' });
  delete message.messageId;
  message.attachmentId = 42;
  harness.dispatchMessage(message, { clientId: 'client-a' });
  authorize(harness, 'stream-1', 'client-a');
  assert.equal((await harness.dispatchFetch({ clientId: 'client-a' }).response).status, 404);
});
