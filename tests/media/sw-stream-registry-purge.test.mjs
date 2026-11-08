// C4: worker-side two-client isolation, exercised against the REAL stream
// registry (public/js/sw-media/stream-registry.js) — the same in-memory Map the
// Service Worker keeps.
//
// The page never sends a clientId: the worker binds each stream to
// event.source.id at registration time and answers a bare PURGE_CLIENT by
// dropping only that client's streams. This test proves that dropping client
// A leaves client B's stream registered AND still servable (its key/IV intact),
// i.e. one tab logging out can never cut off another tab's stream.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMediaStreamRegistry,
} from '../../public/js/sw-media/stream-registry.js';

const NOW = 1_000_000;

function register(registry, { streamId, clientId, messageId, keyFill, ivFill }) {
  const rawKey = new Uint8Array(32).fill(keyFill);
  const baseIv = new Uint8Array(12).fill(ivFill);
  registry.register({
    streamId,
    clientId,
    messageId,
    scope: 'dm',
    path: `/api/dm/attachments/${messageId}`,
    rawKey,
    baseIv,
    plainSize: 9 * 1024 * 1024,
  });
  return { rawKey, baseIv };
}

test('purging client A leaves client B stream registered and still served', () => {
  const registry = createMediaStreamRegistry({ now: () => NOW });

  const a = register(registry, {
    streamId: 'stream-a',
    clientId: 'client-a',
    messageId: 1,
    keyFill: 1,
    ivFill: 9,
  });
  const b = register(registry, {
    streamId: 'stream-b',
    clientId: 'client-b',
    messageId: 2,
    keyFill: 2,
    ivFill: 10,
  });

  assert.equal(registry.size, 2);

  // Client A logs out: the worker purges ONLY client A's streams.
  const removed = registry.purgeClient('client-a');

  assert.deepEqual(removed, ['stream-a']);
  assert.equal(registry.size, 1);
  assert.equal(registry.get('stream-a'), null);

  // Client B's stream is still registered AND still served: the worker can
  // still hand out the entry with B's own key/IV (not A's, not clobbered).
  const entryB = registry.get('stream-b');
  assert.ok(entryB);
  assert.equal(entryB.clientId, 'client-b');
  assert.equal(entryB.streamId, 'stream-b');
  assert.equal(entryB.plainSize, 9 * 1024 * 1024);
  assert.equal(entryB.rawKey, b.rawKey);
  assert.equal(entryB.baseIv, b.baseIv);
  assert.notEqual(entryB.rawKey, a.rawKey);

  // B can still be token-updated and served after A's purge.
  assert.equal(registry.updateToken('stream-b', 'client-b', 'tok-b', NOW + 60_000), true);
  assert.equal(registry.get('stream-b').token, 'tok-b');
});

test('purging a client that has no streams is a no-op for everyone else', () => {
  const registry = createMediaStreamRegistry({ now: () => NOW });
  const b = register(registry, {
    streamId: 'stream-b',
    clientId: 'client-b',
    messageId: 2,
    keyFill: 2,
    ivFill: 10,
  });

  const removed = registry.purgeClient('client-z');

  assert.deepEqual(removed, []);
  assert.equal(registry.size, 1);
  const entryB = registry.get('stream-b');
  assert.ok(entryB);
  assert.equal(entryB.rawKey, b.rawKey);
});
