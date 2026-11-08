// C3: the page-side half of the encrypted DM media stream. Every dependency
// is injected, so these tests run in Node with no browser and no server.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIA_STREAM_MIN_PLAIN_BYTES,
  MEDIA_STREAM_STATUS_TIMEOUT_MS,
  MEDIA_STREAM_TOKEN_MAX_TTL_MS,
  createSwStreamClient,
  isMediaStreamCandidate,
  shouldUseMediaStream,
} from '../../public/js/media/sw-stream-client.js';
import {
  FakeMessageChannel,
  fakeTimer,
  flush,
  makeServiceWorker,
} from './_sw-fakes.mjs';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const NOW = 1_000_000;

const ELIGIBLE = {
  encrypted: true,
  scope: 'dm',
  mime: 'video/mp4',
  plainSize: MEDIA_STREAM_MIN_PLAIN_BYTES + 1,
  isVoice: false,
  download: false,
};

function makeClient({
  enabled = true,
  reply = true,
  postError = null,
  now = NOW,
  randomUUID = () => UUID,
  mintMediaToken = async () => ({ token: 'media-token', expiresAt: now + 90_000 }),
  observeRemoval = null,
  timers = fakeTimer(),
} = {}) {
  const { serviceWorker, controller } = makeServiceWorker({ enabled, reply, postError });

  const client = createSwStreamClient({
    serviceWorker,
    MessageChannelImpl: FakeMessageChannel,
    randomUUID,
    now: () => now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    mintMediaToken,
    observeRemoval: observeRemoval || (() => () => {}),
  });

  return { client, controller, serviceWorker, timers, now };
}

function startArgs(overrides = {}) {
  return {
    messageId: 42,
    keyB64: 'key-key-key',
    baseIvB64: 'iv-iv-iv',
    mime: 'video/mp4',
    plainSize: MEDIA_STREAM_MIN_PLAIN_BYTES + 1,
    element: { dataset: {} },
    onFallback: () => {},
    ...overrides,
  };
}

test('8 MiB exactly stays on the Blob path; 8 MiB + 1 streams', () => {
  assert.equal(MEDIA_STREAM_MIN_PLAIN_BYTES, 8 * 1024 * 1024);
  assert.equal(
    isMediaStreamCandidate({ ...ELIGIBLE, plainSize: MEDIA_STREAM_MIN_PLAIN_BYTES }),
    false
  );
  assert.equal(
    isMediaStreamCandidate({ ...ELIGIBLE, plainSize: MEDIA_STREAM_MIN_PLAIN_BYTES + 1 }),
    true
  );
  assert.equal(isMediaStreamCandidate(ELIGIBLE), true);
});

test('voice notes never stream', () => {
  assert.equal(isMediaStreamCandidate({ ...ELIGIBLE, isVoice: true }), false);
  assert.equal(
    shouldUseMediaStream({ enabled: true, controlled: true, ...ELIGIBLE, isVoice: true }),
    false
  );
});

test('images and downloads never stream', () => {
  assert.equal(isMediaStreamCandidate({ ...ELIGIBLE, mime: 'image/png' }), false);
  assert.equal(isMediaStreamCandidate({ ...ELIGIBLE, download: true }), false);
});

test('group scope never streams', () => {
  assert.equal(isMediaStreamCandidate({ ...ELIGIBLE, scope: 'group' }), false);
});

test('legacy non-E2EE media never streams', () => {
  assert.equal(isMediaStreamCandidate({ ...ELIGIBLE, encrypted: false }), false);
});

test('the flag and the controller are both required', () => {
  assert.equal(
    shouldUseMediaStream({ enabled: true, controlled: true, ...ELIGIBLE }),
    true
  );
  assert.equal(
    shouldUseMediaStream({ enabled: false, controlled: true, ...ELIGIBLE }),
    false
  );
  assert.equal(
    shouldUseMediaStream({ enabled: true, controlled: false, ...ELIGIBLE }),
    false
  );
});

test('the status timeout is 1000 ms and a timeout is OFF', async () => {
  assert.equal(MEDIA_STREAM_STATUS_TIMEOUT_MS, 1000);

  const { client, controller, timers } = makeClient({ reply: false });
  const pending = client.probe();

  assert.equal(controller.posted.length, 1);
  assert.equal(controller.posted[0].data.type, 'MEDIA_STREAM_STATUS');
  assert.deepEqual(timers.timers.map((t) => t.ms), [1000]);

  timers.fire();
  assert.equal(await pending, false);
});

test('a false or malformed status reply, no controller, or a postMessage error is OFF', async () => {
  const off = makeClient({ enabled: false });
  assert.equal(await off.client.probe(), false);

  const malformed = makeClient({ enabled: 'true' });
  assert.equal(await malformed.client.probe(), false);

  const noController = makeClient();
  noController.serviceWorker.controller = null;
  assert.equal(await noController.client.probe(), false);
  assert.equal(noController.controller.posted.length, 0);

  const broken = makeClient({ postError: new Error('worker is gone') });
  assert.equal(await broken.client.probe(), false);
});

test('the status answer is cached per controller and cleared on controllerchange', async () => {
  const { client, controller, serviceWorker } = makeClient({ enabled: true });

  assert.equal(await client.probe(), true);
  assert.equal(await client.probe(), true);
  assert.equal(controller.posted.length, 1, 'a second probe reuses the cached answer');

  const next = {
    posted: [],
    postMessage(data, transfer) {
      this.posted.push({ data, transfer });
      if (data.type === 'MEDIA_STREAM_STATUS') {
        const port = transfer && transfer[0];
        queueMicrotask(() => port.postMessage({
          type: 'MEDIA_STREAM_STATUS',
          enabled: false,
        }));
      }
    },
  };
  serviceWorker.controller = next;
  serviceWorker.emit('controllerchange');

  assert.equal(await client.probe(), false);
  assert.equal(next.posted.length, 1, 'controllerchange forced a new probe');
});

test('REGISTER_STREAM has exactly the specified fields, a UUID streamId, and no clientId', () => {
  const { client, controller } = makeClient();
  const element = { dataset: {} };
  const events = [];
  const originalPost = controller.postMessage.bind(controller);
  controller.postMessage = (data, transfer) => {
    events.push('post');
    originalPost(data, transfer);
  };

  const handle = client.start(startArgs({ element }));
  events.push('returned');

  assert.deepEqual(events, ['post', 'returned'], 'src is only available after the post');
  const registration = controller.posted[0].data;

  assert.deepEqual(registration, {
    type: 'REGISTER_STREAM',
    streamId: UUID,
    messageId: 42,
    scope: 'dm',
    keyB64: 'key-key-key',
    baseIvB64: 'iv-iv-iv',
    mime: 'video/mp4',
    plainSize: MEDIA_STREAM_MIN_PLAIN_BYTES + 1,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(registration, 'clientId'), false);
  assert.match(
    handle.streamId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  assert.equal(handle.src, `/__wire_media_stream/${UUID}`);
});

test('the stream URL and element dataset contain no key or IV', () => {
  const { client } = makeClient();
  const element = { dataset: {} };
  const handle = client.start(startArgs({ element }));

  assert.equal(handle.src.includes('key-key-key'), false);
  assert.equal(handle.src.includes('iv-iv-iv'), false);
  assert.deepEqual(Object.values(element.dataset), []);
});

test('TOKEN_NEEDED mints once and sends one UPDATE_TOKEN with a 60 s expiry ceiling', async () => {
  let mintCalls = 0;
  let releaseMint;
  const minted = new Promise((resolve) => {
    releaseMint = resolve;
  });

  const { client, controller, serviceWorker } = makeClient({
    mintMediaToken: async () => {
      mintCalls += 1;
      return minted;
    },
  });
  const handle = client.start(startArgs());

  serviceWorker.emit('message', { data: { type: 'TOKEN_NEEDED', streamId: handle.streamId } });
  serviceWorker.emit('message', { data: { type: 'TOKEN_NEEDED', streamId: handle.streamId } });

  assert.equal(mintCalls, 1, 'concurrent TOKEN_NEEDED messages share one mint');

  releaseMint({ token: 'media-token', expiresIn: 90 });
  await flush();

  const updates = controller.posted.filter((p) => p.data.type === 'UPDATE_TOKEN');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data, {
    type: 'UPDATE_TOKEN',
    streamId: handle.streamId,
    token: 'media-token',
    expiresAt: NOW + MEDIA_STREAM_TOKEN_MAX_TTL_MS,
  });
  assert.equal(MEDIA_STREAM_TOKEN_MAX_TTL_MS, 60_000);
});

test('a failed token mint falls back exactly once and unregisters', async () => {
  const fallbacks = [];
  const { client, controller, serviceWorker } = makeClient({
    mintMediaToken: async () => {
      throw new Error('mint failed');
    },
  });
  const handle = client.start(startArgs({ onFallback: (reason) => fallbacks.push(reason) }));

  serviceWorker.emit('message', { data: { type: 'TOKEN_NEEDED', streamId: handle.streamId } });
  await flush();

  assert.deepEqual(fallbacks, ['token-mint-failed']);
  assert.equal(handle.active, false);
  assert.equal(
    controller.posted.filter((p) => p.data.type === 'UNREGISTER_STREAM').length,
    1
  );
});

test('STREAM_DEAD sends UNREGISTER_STREAM and falls back once', () => {
  const events = [];
  const fallbacks = [];
  const { client, controller, serviceWorker } = makeClient();

  const originalPost = controller.postMessage.bind(controller);
  controller.postMessage = (data, transfer) => {
    if (data.type === 'UNREGISTER_STREAM') events.push('unregister');
    originalPost(data, transfer);
  };

  const handle = client.start(
    startArgs({
      onFallback: (reason) => {
        events.push('fallback');
        fallbacks.push(reason);
      },
    })
  );

  serviceWorker.emit('message', {
    data: { type: 'STREAM_DEAD', streamId: handle.streamId, reason: 'token-timeout' },
  });

  assert.deepEqual(fallbacks, ['token-timeout']);
  assert.deepEqual(events, ['unregister', 'fallback']);
  assert.equal(handle.active, false);
});

test('a second STREAM_DEAD or a MediaError does not fall back again', () => {
  const fallbacks = [];
  const { client, controller, serviceWorker } = makeClient();
  const handle = client.start(startArgs({ onFallback: (reason) => fallbacks.push(reason) }));

  serviceWorker.emit('message', {
    data: { type: 'STREAM_DEAD', streamId: handle.streamId, reason: 'token-timeout' },
  });
  serviceWorker.emit('message', {
    data: { type: 'STREAM_DEAD', streamId: handle.streamId, reason: 'again' },
  });
  handle.fallback('media-error');

  assert.deepEqual(fallbacks, ['token-timeout']);
  assert.equal(
    controller.posted.filter((p) => p.data.type === 'UNREGISTER_STREAM').length,
    1
  );
  assert.equal(handle.active, false);
});

test('messages for a stream this page did not register are ignored', async () => {
  let mintCalls = 0;
  const fallbacks = [];
  const { client, controller, serviceWorker } = makeClient({
    mintMediaToken: async () => {
      mintCalls += 1;
      return { token: 'media-token', expiresAt: NOW + 60_000 };
    },
  });

  serviceWorker.emit('message', { data: { type: 'TOKEN_NEEDED', streamId: 'not-mine' } });
  serviceWorker.emit('message', {
    data: { type: 'STREAM_DEAD', streamId: 'not-mine', reason: 'token-timeout' },
  });
  await flush();

  assert.equal(mintCalls, 0);
  assert.deepEqual(fallbacks, []);
  assert.equal(controller.posted.length, 0);
});

test('removing the element unregisters without falling back', () => {
  let removed;
  let stopped = false;
  const fallbacks = [];

  const { client, controller } = makeClient({
    observeRemoval: (element, callback) => {
      removed = callback;
      return () => {
        stopped = true;
      };
    },
  });

  const handle = client.start(
    startArgs({ element: { dataset: {} }, onFallback: (reason) => fallbacks.push(reason) })
  );

  removed();
  removed();

  assert.equal(handle.active, false);
  assert.deepEqual(fallbacks, []);
  assert.equal(stopped, true);
  assert.equal(
    controller.posted.filter((p) => p.data.type === 'UNREGISTER_STREAM').length,
    1
  );
});
