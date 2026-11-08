// The pure Service Worker media handler core (Item 3, phase 3C, C1).
//
// No DOM, no Service Worker, no fetch, no Response: every function here maps
// an already-authenticated request description to a status + headers + byte
// range plan. public/sw.js (C2) owns the registry, the token pull and the
// actual ciphertext fetch/decrypt; this module stays testable in plain Node.
//
// What is pinned here:
//   - the route shape /__wire_media_stream/<streamId>
//   - 200 only for a request without a Range header, 206 for every Range
//   - 401 unknown/expired token after the stream/client checks
//   - 404 unknown stream, wrong client, wrong destination
//   - 405 for anything other than GET/HEAD
//   - 416 with Content-Range over the PLAINTEXT total
//   - the 16-chunk (1 MiB) response cap, including a partial 206
//   - the MIME allowlist through utils/inlineSafeMime.js, never a copy
//   - nosniff, sandbox, no-store on every media response
//   - request.destination, not Sec-Fetch-Dest
//   - the ciphertext Range the worker has to fetch for the served bytes
//   - the feature flag in public/sw.js stays OFF
//
//   node --test tests/crypto/sw-media-handler.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEDIA_STREAM_FALLBACK_MIME,
  MEDIA_STREAM_MAX_RESPONSE_CHUNKS,
  MEDIA_STREAM_PATH_PREFIX,
  ciphertextRangeFor,
  isMediaDestinationAllowed,
  isMediaMethodAllowed,
  isMediaMimeAllowed,
  isMediaStreamPath,
  mediaContentType,
  parseMediaStreamPath,
  planMediaResponse,
} from '../../public/js/sw-media/handler-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW = path.join(ROOT, 'public', 'sw.js');
const BUNDLE = path.join(ROOT, 'public', 'sw-media-bundle.js');
const HANDLER = path.join(ROOT, 'public', 'js', 'sw-media', 'handler-core.js');

const CHUNK = 64 * 1024;
const TAG = 16;
const HEADER = 8;
const CAP_BYTES = 16 * CHUNK;

/** A complete plan input that would serve a 20-chunk 206 by default. */
function request(overrides = {}) {
  return {
    method: 'GET',
    destination: 'video',
    streamKnown: true,
    clientMatches: true,
    authorized: true,
    mimeType: 'video/mp4',
    totalSize: 20 * CHUNK,
    rangeHeader: 'bytes=0-',
    ...overrides,
  };
}

// ---------------------------------------------------------------- routing --

test('the media route is /__wire_media_stream/<id>', () => {
  assert.equal(MEDIA_STREAM_PATH_PREFIX, '/__wire_media_stream/');
  assert.equal(parseMediaStreamPath('/__wire_media_stream/abc123'), 'abc123');
  assert.equal(parseMediaStreamPath('/__wire_media_stream/a-b_c'), 'a-b_c');
  assert.equal(parseMediaStreamPath('/__wire_media_stream/' + 'a'.repeat(128)), 'a'.repeat(128));
  assert.equal(parseMediaStreamPath('/__wire_media_stream/'), null);
  assert.equal(parseMediaStreamPath('/__wire_media_stream/a/b'), null);
  assert.equal(parseMediaStreamPath('/__wire_media_stream/a?x=1'), null);
  assert.equal(parseMediaStreamPath('/__wire_media_stream/a%2Fb'), null);
  assert.equal(parseMediaStreamPath('/__wire_media_stream/' + 'a'.repeat(129)), null);
  assert.equal(parseMediaStreamPath('/other/abc123'), null);
  assert.equal(parseMediaStreamPath(''), null);
  assert.equal(parseMediaStreamPath(null), null);
  assert.equal(isMediaStreamPath('/__wire_media_stream/abc123'), true);
  assert.equal(isMediaStreamPath('/__wire_media_stream/'), false);
});

// ---------------------------------------------------------- coarse guards --

test('only GET and HEAD are media methods', () => {
  assert.equal(isMediaMethodAllowed('GET'), true);
  assert.equal(isMediaMethodAllowed('HEAD'), true);
  assert.equal(isMediaMethodAllowed('POST'), false);
  assert.equal(isMediaMethodAllowed('PUT'), false);
  assert.equal(isMediaMethodAllowed('DELETE'), false);
  assert.equal(isMediaMethodAllowed('OPTIONS'), false);
  assert.equal(isMediaMethodAllowed('get'), false);
});

test('only video/audio destinations are accepted', () => {
  assert.equal(isMediaDestinationAllowed('video'), true);
  assert.equal(isMediaDestinationAllowed('audio'), true);
  assert.equal(isMediaDestinationAllowed('empty'), false);
  assert.equal(isMediaDestinationAllowed('document'), false);
  assert.equal(isMediaDestinationAllowed('image'), false);
  assert.equal(isMediaDestinationAllowed('worker'), false);
  assert.equal(isMediaDestinationAllowed(''), false);
  assert.equal(isMediaDestinationAllowed(undefined), false);
});

test('Sec-Fetch-Dest cannot substitute for request.destination', () => {
  const scriptFetch = planMediaResponse(request({
    destination: 'empty',
    secFetchDest: 'video',
  }));
  assert.equal(scriptFetch.status, 404);

  const media = planMediaResponse(request({
    destination: 'video',
    secFetchDest: 'empty',
  }));
  assert.equal(media.status, 206);
});

test('the MIME allowlist is the video/audio subset of isInlineSafeMime', () => {
  assert.equal(isMediaMimeAllowed('video/mp4'), true);
  assert.equal(isMediaMimeAllowed('video/webm'), true);
  assert.equal(isMediaMimeAllowed('video/x-matroska'), true);
  assert.equal(isMediaMimeAllowed('audio/mpeg'), true);
  assert.equal(isMediaMimeAllowed('audio/webm'), true);
  assert.equal(isMediaMimeAllowed('VIDEO/MP4'), true);
  assert.equal(isMediaMimeAllowed('image/png'), false);
  assert.equal(isMediaMimeAllowed('application/pdf'), false);
  assert.equal(isMediaMimeAllowed('text/html'), false);
  assert.equal(isMediaMimeAllowed('video/not-a-real-type'), false);
  assert.equal(isMediaMimeAllowed('video/mp4; codecs=avc1'), false);
  assert.equal(isMediaMimeAllowed(''), false);
  assert.equal(isMediaMimeAllowed(null), false);

  assert.equal(mediaContentType('video/mp4'), 'video/mp4');
  assert.equal(mediaContentType('audio/ogg'), 'audio/ogg');
  assert.equal(mediaContentType('image/png'), MEDIA_STREAM_FALLBACK_MIME);
  assert.equal(mediaContentType('text/html'), MEDIA_STREAM_FALLBACK_MIME);
  assert.equal(mediaContentType(''), MEDIA_STREAM_FALLBACK_MIME);
  assert.equal(MEDIA_STREAM_FALLBACK_MIME, 'application/octet-stream');
});

// ------------------------------------------------------------ status codes --

test('200 only when the request has no Range header', () => {
  const noRange = planMediaResponse(request({ rangeHeader: null }));
  assert.equal(noRange.status, 200);
  assert.equal(noRange.bodyMode, 'full');
  assert.deepEqual(noRange.served, { start: 0, end: 20 * CHUNK - 1 });
  assert.equal(noRange.headers['Content-Length'], String(20 * CHUNK));
  assert.equal(noRange.headers['Content-Range'], undefined);

  const fullRange = planMediaResponse(request({
    totalSize: 1000,
    rangeHeader: 'bytes=0-999',
  }));
  assert.equal(fullRange.status, 206);
  assert.equal(fullRange.bodyMode, 'range');
  assert.equal(fullRange.headers['Content-Range'], 'bytes 0-999/1000');
});

test('206 for every satisfiable Range', () => {
  const plan = planMediaResponse(request({ rangeHeader: 'bytes=100-199' }));
  assert.equal(plan.status, 206);
  assert.deepEqual(plan.served, { start: 100, end: 199 });
  assert.equal(plan.headers['Content-Range'], `bytes 100-199/${20 * CHUNK}`);
  assert.equal(plan.headers['Content-Length'], '100');
});

test('401 when the stream token is missing or expired', () => {
  const plan = planMediaResponse(request({ authorized: false }));
  assert.equal(plan.status, 401);
  assert.equal(plan.bodyMode, 'none');
  assert.equal(plan.headers['Cache-Control'], 'no-store');
  assert.equal(plan.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(plan.headers['Content-Security-Policy'], 'sandbox');
  assert.equal(plan.headers['Content-Length'], '0');
});

test('404 for an unknown stream, wrong client, or wrong destination', () => {
  assert.equal(planMediaResponse(request({ streamKnown: false })).status, 404);
  assert.equal(planMediaResponse(request({ clientMatches: false })).status, 404);
  assert.equal(planMediaResponse(request({ destination: 'empty' })).status, 404);
  assert.equal(planMediaResponse(request({ destination: 'document' })).status, 404);
});

test('404 wins over 401 for an unknown stream', () => {
  const plan = planMediaResponse(request({
    streamKnown: false,
    authorized: false,
  }));
  assert.equal(plan.status, 404);
});

test('405 for methods other than GET and HEAD', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const plan = planMediaResponse(request({ method }));
    assert.equal(plan.status, 405, method);
    assert.equal(plan.headers.Allow, 'GET, HEAD');
    assert.equal(plan.bodyMode, 'none');
  }
});

test('416 for an invalid or unsatisfiable Range', () => {
  for (const rangeHeader of [
    'bytes=abc',
    'bytes=',
    `bytes=${20 * CHUNK}-`,
    `bytes=0-${20 * CHUNK}`,
    '',
  ]) {
    const plan = planMediaResponse(request({ rangeHeader }));
    assert.equal(plan.status, 416, rangeHeader);
    assert.equal(plan.headers['Content-Range'], `bytes */${20 * CHUNK}`, rangeHeader);
    assert.equal(plan.headers['Accept-Ranges'], 'bytes', rangeHeader);
    assert.equal(plan.headers['Content-Length'], '0', rangeHeader);
    assert.equal(plan.bodyMode, 'none', rangeHeader);
  }
});

test('416 for a Range on an empty file, 200 for no Range', () => {
  const ranged = planMediaResponse(request({ totalSize: 0, rangeHeader: 'bytes=0-' }));
  assert.equal(ranged.status, 416);
  assert.equal(ranged.headers['Content-Range'], 'bytes */0');

  const plain = planMediaResponse(request({ totalSize: 0, rangeHeader: null }));
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.served, { start: 0, end: -1 });
  assert.equal(plain.headers['Content-Length'], '0');
});

// ------------------------------------------------------------------- HEAD --

test('HEAD answers the same status and headers without a body', () => {
  const plain = planMediaResponse(request({ method: 'HEAD', rangeHeader: null }));
  assert.equal(plain.status, 200);
  assert.equal(plain.bodyMode, 'none');
  assert.equal(plain.headers['Content-Length'], String(20 * CHUNK));

  const ranged = planMediaResponse(request({ method: 'HEAD', rangeHeader: 'bytes=0-99' }));
  assert.equal(ranged.status, 206);
  assert.equal(ranged.bodyMode, 'none');
  assert.equal(ranged.headers['Content-Range'], `bytes 0-99/${20 * CHUNK}`);
  assert.equal(ranged.headers['Content-Length'], '100');
});

// -------------------------------------------------------- response policy --

test('every media response is nosniff, sandboxed and no-store', () => {
  for (const overrides of [
    {},
    { rangeHeader: null },
    { method: 'HEAD' },
    { authorized: false },
    { streamKnown: false },
    { clientMatches: false },
    { destination: 'empty' },
    { method: 'POST' },
    { rangeHeader: 'bytes=abc' },
  ]) {
    const plan = planMediaResponse(request(overrides));
    assert.equal(plan.headers['X-Content-Type-Options'], 'nosniff', JSON.stringify(overrides));
    assert.equal(plan.headers['Content-Security-Policy'], 'sandbox', JSON.stringify(overrides));
    assert.equal(plan.headers['Cache-Control'], 'no-store', JSON.stringify(overrides));
  }
});

test('Content-Range and the cap use the plaintext size, not the ciphertext size', () => {
  const totalSize = 20 * CHUNK + 123;
  const plan = planMediaResponse(request({ totalSize, rangeHeader: 'bytes=0-' }));

  assert.equal(plan.status, 206);
  assert.equal(plan.headers['Content-Range'], `bytes 0-${CAP_BYTES - 1}/${totalSize}`);
  assert.equal(plan.headers['Content-Length'], String(CAP_BYTES));
  assert.equal(plan.totalSize, totalSize);
  assert.ok(
    plan.ciphertextRange.end < totalSize + 8 + 20 * TAG,
    `ciphertext end ${plan.ciphertextRange.end} must stay inside the ciphertext size`
  );
});

test('the 16-chunk response cap produces a partial 206', () => {
  assert.equal(MEDIA_STREAM_MAX_RESPONSE_CHUNKS, 16);

  const totalSize = 20 * CHUNK;
  const plan = planMediaResponse(request({ totalSize, rangeHeader: 'bytes=0-' }));

  assert.equal(plan.status, 206);
  assert.deepEqual(plan.served, { start: 0, end: CAP_BYTES - 1 });
  assert.deepEqual(plan.requested, { start: 0, end: totalSize - 1 });
  assert.equal(plan.contentLength, CAP_BYTES);
  assert.equal(plan.headers['Content-Length'], String(CAP_BYTES));
  assert.equal(plan.headers['Content-Range'], `bytes 0-${CAP_BYTES - 1}/${totalSize}`);
  assert.equal(plan.chunkIndices.length, 16);
});

test('a partial 206 starts at the requested offset and still caps at 1 MiB', () => {
  const totalSize = 20 * CHUNK;
  const start = CHUNK;
  const plan = planMediaResponse(request({
    totalSize,
    rangeHeader: `bytes=${start}-`,
  }));

  assert.equal(plan.status, 206);
  assert.deepEqual(plan.served, { start, end: start + CAP_BYTES - 1 });
  assert.equal(plan.contentLength, CAP_BYTES);
  assert.equal(plan.headers['Content-Range'], `bytes ${start}-${start + CAP_BYTES - 1}/${totalSize}`);
  assert.equal(plan.chunkIndices.length, 16);
});

test('a smaller cap is honoured and reported', () => {
  const plan = planMediaResponse(request({
    totalSize: 20 * CHUNK,
    rangeHeader: 'bytes=0-',
    maxResponseChunks: 2,
  }));

  assert.equal(plan.status, 206);
  assert.deepEqual(plan.served, { start: 0, end: 2 * CHUNK - 1 });
  assert.equal(plan.headers['Content-Range'], `bytes 0-${2 * CHUNK - 1}/${20 * CHUNK}`);
  assert.equal(plan.chunkIndices.length, 2);
});

test('the ciphertext Range covers exactly the chunks needed for the served bytes', () => {
  const totalSize = 20 * CHUNK + 123;
  const encryptedSize = HEADER + totalSize + Math.ceil(totalSize / CHUNK) * TAG;

  const head = ciphertextRangeFor({ totalSize, served: { start: 0, end: CAP_BYTES - 1 } });
  assert.deepEqual(head, { start: HEADER, end: HEADER + 16 * (CHUNK + TAG) - 1 });

  const tailStart = 20 * CHUNK - 1;
  const tail = ciphertextRangeFor({
    totalSize,
    served: { start: tailStart, end: totalSize - 1 },
  });
  assert.equal(tail.start, HEADER + 19 * (CHUNK + TAG));
  assert.equal(tail.end, encryptedSize - 1);

  assert.equal(ciphertextRangeFor({ totalSize, served: null }), null);
  assert.equal(ciphertextRangeFor({ totalSize: 0, served: { start: 0, end: -1 } }), null);
});

test('the plan and the standalone ciphertext helper agree', () => {
  const totalSize = 20 * CHUNK + 123;
  const plan = planMediaResponse(request({ totalSize, rangeHeader: 'bytes=100-199' }));
  assert.deepEqual(
    plan.ciphertextRange,
    ciphertextRangeFor({ totalSize, served: plan.served })
  );
});

test('error responses carry no body and no Content-Range except 416', () => {
  for (const overrides of [
    { authorized: false },
    { streamKnown: false },
    { clientMatches: false },
    { destination: 'empty' },
    { method: 'POST' },
  ]) {
    const plan = planMediaResponse(request(overrides));
    assert.equal(plan.bodyMode, 'none', JSON.stringify(overrides));
    assert.equal(plan.headers['Content-Range'], undefined, JSON.stringify(overrides));
  }

  const unsatisfiable = planMediaResponse(request({ rangeHeader: 'bytes=abc' }));
  assert.equal(unsatisfiable.headers['Content-Range'], `bytes */${20 * CHUNK}`);
});

// -------------------------------------------------------- source pinning --

test('public/sw.js keeps the media flag OFF at top level', () => {
  const source = fs.readFileSync(SW, 'utf8');
  assert.match(
    source,
    /^const MEDIA_STREAM_ENABLED = false;$/m,
    'public/sw.js must declare MEDIA_STREAM_ENABLED = false at top level'
  );
  assert.doesNotMatch(
    source,
    /MEDIA_STREAM_ENABLED\s*=\s*true/,
    'the media stream flag must stay OFF in the repository'
  );
});

test('the media flag is not baked into the bundle', () => {
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(
    !bundle.includes('MEDIA_STREAM_ENABLED'),
    'the feature flag belongs in public/sw.js, not in the generated bundle'
  );
});

test('the handler reuses isInlineSafeMime instead of copying the allowlist', () => {
  const source = fs.readFileSync(HANDLER, 'utf8');
  assert.match(
    source,
    /import\s*\{[^}]*\bisInlineSafeMime\b[^}]*\}\s*from\s*'[^']*utils\/inlineSafeMime\.js'/s,
    'handler-core.js must import isInlineSafeMime from utils/inlineSafeMime.js'
  );
  assert.ok(
    !source.includes("'video/mp4'") && !source.includes('INLINE_SAFE_MIME_TYPES'),
    'handler-core.js must not keep a second MIME allowlist'
  );
  assert.ok(
    !/sec-fetch-dest/i.test(source),
    'handler-core.js must use request.destination, not Sec-Fetch-Dest'
  );
});
