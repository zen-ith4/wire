// C4: page-side purge for this client only.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIA_STREAM_MIN_PLAIN_BYTES,
  createSwStreamClient,
} from '../../public/js/media/sw-stream-client.js';
import {
  FakeMessageChannel,
  fakeTimer,
  makeServiceWorker,
} from './_sw-fakes.mjs';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const NOW = 1_000_000;

function makeClient({ postError = null, observeRemoval = null } = {}) {
  const { serviceWorker, controller } = makeServiceWorker({ enabled: true, postError });
  const timers = fakeTimer();
  const client = createSwStreamClient({
    serviceWorker,
    MessageChannelImpl: FakeMessageChannel,
    randomUUID: () => UUID,
    now: () => NOW,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    mintMediaToken: async () => ({ token: 'media-token', expiresAt: NOW + 60_000 }),
    observeRemoval: observeRemoval || (() => () => {}),
  });
  return { client, controller, serviceWorker, timers };
}

function startArgs(overrides = {}) {
  return {
    messageId: 42,
    keyB64: 'key-key-key',
    baseIvB64: 'iv-iv-iv',
    mime: 'video/mp4',
    plainSize: MEDIA_STREAM_MIN_PLAIN_BYTES + 1,
    element: { dataset: {}, src: 'stream-url', removeAttribute() { this.removed = 'src'; } },
    onFallback: () => {},
    ...overrides,
  };
}

test('purge posts PURGE_CLIENT exactly once and closes streams without fallback', () => {
  const fallbacks = [];
  const cleanups = [];
  const stops = [];
  const { client, controller } = makeClient({
    observeRemoval: () => {
      const stop = () => stops.push('stop');
      return stop;
    },
  });

  const element = {
    dataset: {},
    src: 'stream-url',
    removeAttribute(value) { this.removed = value; },
  };
  const handle = client.start(startArgs({ element, onFallback: (reason) => fallbacks.push(reason) }));
  handle.setCleanup(() => cleanups.push('clean'));

  const before = controller.posted.length;
  const posted = client.purge();

  assert.equal(posted, true);
  assert.equal(controller.posted.length, before + 1);
  assert.deepEqual(controller.posted[before].data, { type: 'PURGE_CLIENT' });
  assert.equal(handle.active, false);
  assert.equal(element.src, '');
  assert.equal(element.removed, 'src');
  assert.deepEqual(fallbacks, []);
  assert.deepEqual(cleanups, ['clean']);
  assert.ok(stops.length >= 1);
});

test('purge is safe with no controller and leaves secrets clearing to the caller', () => {
  const { client, controller, serviceWorker } = makeClient();
  serviceWorker.controller = null;

  const result = client.purge();

  assert.equal(result, false);
  assert.equal(controller.posted.filter((p) => p.data.type === 'PURGE_CLIENT').length, 0);
  assert.equal(client.purge(), false);
});

test('purge posts to the current controller when it changed', () => {
  const { client, serviceWorker } = makeClient();
  const next = { posted: [], postMessage(data) { this.posted.push({ data }); } };
  serviceWorker.controller = next;

  const result = client.purge();

  assert.equal(result, true);
  assert.equal(next.posted.length, 1);
  assert.deepEqual(next.posted[0].data, { type: 'PURGE_CLIENT' });
});

test('purge does not throw when postMessage throws', () => {
  const controller = {
    posted: [],
    postMessage(data) {
      this.posted.push({ data });
      if (data.type === 'PURGE_CLIENT') throw new Error('worker gone');
    },
  };
  const serviceWorker = {
    controller,
    addEventListener() {},
    removeEventListener() {},
  };
  const client = createSwStreamClient({
    serviceWorker,
    MessageChannelImpl: FakeMessageChannel,
    randomUUID: () => UUID,
    now: () => NOW,
    setTimeoutFn: fakeTimer().setTimeoutFn,
    clearTimeoutFn: fakeTimer().clearTimeoutFn,
    mintMediaToken: async () => ({ token: 't', expiresAt: NOW + 1000 }),
    observeRemoval: () => () => {},
  });

  assert.doesNotThrow(() => client.purge());
  assert.equal(client.purge(), false);
});

test('purge removes service-worker listeners', () => {
  const { client, serviceWorker } = makeClient();
  // Force listener registration.
  client.probe().catch(() => {});

  const removed = [];
  const originalRemove = serviceWorker.removeEventListener.bind(serviceWorker);
  serviceWorker.removeEventListener = (type, fn) => {
    removed.push(type);
    return originalRemove(type, fn);
  };

  client.purge();

  assert.ok(removed.includes('controllerchange'));
  assert.ok(removed.includes('message'));
});

test('purge posts only PURGE_CLIENT with no clientId or global purge', () => {
  const { client, controller } = makeClient();
  client.start(startArgs());

  client.purge();

  const purges = controller.posted.filter((p) => p.data && p.data.type === 'PURGE_CLIENT');
  assert.equal(purges.length, 1);
  assert.deepEqual(purges[0].data, { type: 'PURGE_CLIENT' });
  assert.equal(Object.prototype.hasOwnProperty.call(purges[0].data, 'clientId'), false);

  assert.equal(
    controller.posted.some((p) => p.data && (p.data.type === 'PURGE_ALL' || p.data.type === 'PURGE_CLIENT' && p.data.clientId)),
    false
  );
});

test('purging one client leaves another client stream registered and active', () => {
  const a = makeClient();
  const b = makeClient();

  const handleA = a.client.start(startArgs({ element: { dataset: {}, src: 'a', removeAttribute() {} } }));
  const handleB = b.client.start(startArgs({ element: { dataset: {}, src: 'b', removeAttribute() {} } }));

  assert.equal(a.client.purge(), true);
  assert.equal(handleA.active, false);
  assert.equal(handleB.active, true);

  assert.equal(
    a.controller.posted.filter((p) => p.data.type === 'PURGE_CLIENT').length,
    1
  );
  assert.equal(
    b.controller.posted.filter((p) => p.data.type === 'PURGE_CLIENT').length,
    0
  );
});

test('re-arm: after purge, the next start() re-adds the listeners exactly once', () => {
  const { client, serviceWorker } = makeClient();

  // First session: start a stream (this attaches the worker listeners).
  const first = client.start(startArgs());
  assert.equal(first.active, true);

  // Logout / pagehide: purge detaches the stream and removes the listeners.
  assert.equal(client.purge(), true);

  // Count how many times the client re-attaches each listener on re-arm.
  const added = [];
  const originalAdd = serviceWorker.addEventListener.bind(serviceWorker);
  serviceWorker.addEventListener = (type, fn) => {
    added.push(type);
    return originalAdd(type, fn);
  };

  // Login again on the SAME page without a reload: a new stream registers and
  // plays again. purge() reset listening=false, so the next start() must
  // re-add each listener exactly once (not zero, not twice).
  const second = client.start(startArgs());

  assert.equal(added.filter((t) => t === 'message').length, 1);
  assert.equal(added.filter((t) => t === 'controllerchange').length, 1);
  assert.equal(second.active, true);
});

test('no controller: nothing posted, local state cleared, secrets cleared', () => {
  const { client, serviceWorker } = makeClient();
  const cleanups = [];
  const element = { dataset: {}, src: 'stream-url', removeAttribute() { this.removed = 'src'; } };
  const handle = client.start(startArgs({ element, onFallback: () => {} }));
  handle.setCleanup(() => cleanups.push('clean'));
  assert.equal(handle.active, true);

  // The worker is gone (never registered, or deactivated): there is no
  // controller to post to.
  serviceWorker.controller = null;

  const posted = client.purge();

  assert.equal(posted, false); // nothing posted
  assert.equal(handle.active, false); // local stream state cleared
  assert.equal(element.src, ''); // element detached
  assert.equal(element.removed, 'src');
  assert.deepEqual(cleanups, ['clean']); // per-stream secrets/cleanup cleared
});

test('controller changed between registration and purge: no throw, secrets cleared', () => {
  const { client, serviceWorker } = makeClient();
  const cleanups = [];
  const element = { dataset: {}, src: 'stream-url', removeAttribute() { this.removed = 'src'; } };
  const handle = client.start(startArgs({ element, onFallback: () => {} }));
  handle.setCleanup(() => cleanups.push('clean'));

  // Between registration and purge the controller changed (the worker
  // re-registered, or the page navigated): the stream is bound to a stale
  // controller.
  const staleController = serviceWorker.controller;
  const nextController = {
    posted: [],
    postMessage(data) { this.posted.push({ data }); },
  };
  serviceWorker.controller = nextController;

  // Purging must not throw even though the stream's controller is stale.
  assert.doesNotThrow(() => client.purge());

  assert.equal(handle.active, false); // local stream state cleared
  assert.equal(element.src, '');
  assert.deepEqual(cleanups, ['clean']); // per-stream secrets/cleanup cleared
  // The purge went to the CURRENT controller, not the stale one.
  assert.equal(
    nextController.posted.filter((p) => p.data.type === 'PURGE_CLIENT').length,
    1
  );
  assert.equal(
    staleController.posted.filter((p) => p.data.type === 'PURGE_CLIENT').length,
    0
  );
});
