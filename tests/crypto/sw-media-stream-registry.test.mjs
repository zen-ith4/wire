// The Service Worker's in-memory media stream registry (Item 3, phase 3C, C2).
//
// The registry is the only place that holds a stream's key material. It is a
// plain Map in worker memory: no Cache Storage, IndexedDB, localStorage,
// timers or network calls. The worker owns registration, token updates and
// per-client purge; this module owns the state transitions and the idle TTL.
//
//   node --test tests/crypto/sw-media-stream-registry.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEDIA_STREAM_IDLE_TTL_MS,
  createMediaStreamRegistry,
} from '../../public/js/sw-media/stream-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(ROOT, 'public', 'js', 'sw-media', 'stream-registry.js');

function key(byte = 7) {
  return new Uint8Array(32).fill(byte);
}

function iv(byte = 9) {
  return new Uint8Array(12).fill(byte);
}

function registration(overrides = {}) {
  return {
    streamId: 'stream-a',
    clientId: 'client-a',
    messageId: 42,
    scope: 'dm',
    path: '/api/dm/attachments/42',
    rawKey: key(),
    baseIv: iv(),
    mime: 'video/mp4',
    plainSize: 3 * 64 * 1024 + 123,
    ...overrides,
  };
}

function makeRegistry(overrides = {}) {
  let now = 1000;
  const registry = createMediaStreamRegistry({
    now: () => now,
    idleTtlMs: 100,
    ...overrides,
  });
  return {
    registry,
    tick(ms) {
      now += ms;
    },
    now: () => now,
  };
}

test('the idle TTL is ten minutes and stream state is worker memory only', () => {
  assert.equal(MEDIA_STREAM_IDLE_TTL_MS, 10 * 60 * 1000);

  const source = fs.readFileSync(REGISTRY, 'utf8');
  assert.doesNotMatch(source, /localStorage\.|sessionStorage\.|indexedDB\.|CacheStorage|caches\./);
  assert.doesNotMatch(source, /PURGE_ALL|purgeAll/);
});

test('registration stores the stream and exposes it by stream id', () => {
  const { registry } = makeRegistry();
  const input = registration();
  const entry = registry.register(input);

  assert.equal(entry.streamId, 'stream-a');
  assert.equal(entry.clientId, 'client-a');
  assert.equal(entry.messageId, 42);
  assert.equal(entry.scope, 'dm');
  assert.equal(entry.path, '/api/dm/attachments/42');
  assert.equal(entry.plainSize, input.plainSize);
  assert.equal(entry.mime, 'video/mp4');
  assert.deepEqual([...entry.rawKey], [...key()]);
  assert.deepEqual([...entry.baseIv], [...iv()]);
  assert.equal(entry.token, null);
  assert.equal(entry.expiresAt, 0);
  assert.equal(registry.size, 1);
  assert.equal(registry.get('stream-a'), entry);
  assert.equal(registry.get('missing'), null);
});

test('registration is idempotent by stream id and replaces the old entry', () => {
  const { registry } = makeRegistry();
  const first = registry.register(registration());
  first.token = 'old-token';
  first.deadStatus = 401;

  const second = registry.register(registration({
    messageId: 43,
    path: '/api/dm/attachments/43',
    rawKey: key(11),
    plainSize: 5,
  }));

  assert.notEqual(second, first);
  assert.equal(registry.size, 1);
  assert.equal(registry.get('stream-a'), second);
  assert.equal(second.messageId, 43);
  assert.equal(second.token, null);
  assert.equal(second.deadStatus, null);
});

test('registration rejects a different client taking over an existing stream id', () => {
  const { registry } = makeRegistry();
  registry.register(registration());

  assert.throws(() => {
    registry.register(registration({ clientId: 'client-b' }));
  }, /another client/i);
  assert.equal(registry.get('stream-a').clientId, 'client-a');
  assert.equal(registry.size, 1);
});

test('registration rejects malformed ids, keys, IVs, sizes and paths', () => {
  const { registry } = makeRegistry();

  const bad = [
    { streamId: '' },
    { streamId: 'a/b' },
    { streamId: 'a'.repeat(129) },
    { clientId: '' },
    { clientId: null },
    { rawKey: new Uint8Array(31) },
    { rawKey: null },
    { baseIv: new Uint8Array(11) },
    { baseIv: null },
    { plainSize: -1 },
    { plainSize: 1.5 },
    { plainSize: '12' },
    { path: '' },
    { path: 'https://evil.test/api/dm/attachments/42' },
    { path: '/api/../secret' },
    { path: '/api/dm/attachments/42?x=1' },
  ];

  for (const overrides of bad) {
    assert.throws(
      () => registry.register(registration(overrides)),
      undefined,
      JSON.stringify(overrides)
    );
  }
  assert.equal(registry.size, 0);
});

test('updateToken only accepts the registering client', () => {
  const { registry } = makeRegistry();
  registry.register(registration());

  assert.equal(registry.updateToken('stream-a', 'client-b', 'wrong', 2000), false);
  assert.equal(registry.get('stream-a').token, null);
  assert.equal(registry.updateToken('missing', 'client-a', 'token', 2000), false);
  assert.equal(registry.updateToken('stream-a', 'client-a', '', 2000), false);
  assert.equal(registry.updateToken('stream-a', 'client-a', 'token', Number.NaN), false);

  assert.equal(registry.updateToken('stream-a', 'client-a', 'token', 2000), true);
  const entry = registry.get('stream-a');
  assert.equal(entry.token, 'token');
  assert.equal(entry.expiresAt, 2000);
});

test('unregister removes only the matching client stream', () => {
  const { registry } = makeRegistry();
  registry.register(registration());
  registry.register(registration({ streamId: 'stream-b', clientId: 'client-b', messageId: 43, path: '/api/dm/attachments/43' }));

  assert.equal(registry.unregister('stream-a', 'client-b'), false);
  assert.equal(registry.size, 2);
  assert.equal(registry.unregister('stream-a', 'client-a'), true);
  assert.equal(registry.size, 1);
  assert.equal(registry.get('stream-a'), null);
  assert.ok(registry.get('stream-b'));
  assert.equal(registry.unregister('stream-a', 'client-a'), false);
});

test('per-client purge deletes only that client and never a global purge', () => {
  const { registry } = makeRegistry();
  registry.register(registration());
  registry.register(registration({ streamId: 'stream-b', messageId: 43, path: '/api/dm/attachments/43' }));
  registry.register(registration({ streamId: 'stream-c', clientId: 'client-b', messageId: 44, path: '/api/dm/attachments/44' }));

  assert.deepEqual(registry.purgeClient('client-a').sort(), ['stream-a', 'stream-b']);
  assert.equal(registry.size, 1);
  assert.ok(registry.get('stream-c'));
  assert.deepEqual(registry.purgeClient('missing'), []);
  assert.equal(typeof registry.purgeAll, 'undefined');
});

test('the idle TTL removes an untouched stream and a fetch touch refreshes it', () => {
  const { registry, tick } = makeRegistry();
  registry.register(registration());

  tick(99);
  assert.ok(registry.peek('stream-a'), 'still inside the TTL');

  tick(1);
  assert.equal(registry.get('stream-a'), null, 'the TTL is inclusive at the boundary');

  registry.register(registration());
  tick(60);
  assert.ok(registry.get('stream-a'));
  tick(60);
  assert.ok(registry.peek('stream-a'), 'the touch reset the idle clock');
  tick(40);
  assert.equal(registry.get('stream-a'), null);
});

test('a dead stream keeps its status until it is replaced or removed', () => {
  const { registry } = makeRegistry();
  registry.register(registration());

  assert.equal(registry.markDead('stream-a', 401), true);
  assert.equal(registry.get('stream-a').deadStatus, 401);
  assert.equal(registry.markDead('missing', 401), false);
  assert.throws(() => registry.markDead('stream-a', 200));

  registry.register(registration({ messageId: 43, path: '/api/dm/attachments/43' }));
  assert.equal(registry.get('stream-a').deadStatus, null);
  assert.equal(registry.unregister('stream-a', 'client-a'), true);
});

test('the registry can abort an in-flight fetch when a stream is dropped', () => {
  const { registry } = makeRegistry();
  const controller = new AbortController();
  registry.register(registration({ abortController: controller }));

  registry.purgeClient('client-a');
  assert.equal(controller.signal.aborted, true);

  const second = new AbortController();
  registry.register(registration({ abortController: second }));
  registry.unregister('stream-a', 'client-a');
  assert.equal(second.signal.aborted, true);
});
