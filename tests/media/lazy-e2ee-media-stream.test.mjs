// C3 wiring: the lazy encrypted audio/video path chooses the stream only when
// every condition holds; otherwise the old Blob path runs unchanged.
import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { streamBytesToBase64 } from '../../public/js/crypto/messages/attachment-stream.js';
import {
  MEDIA_STREAM_MIN_PLAIN_BYTES,
  createSwStreamClient,
} from '../../public/js/media/sw-stream-client.js';
import {
  FakeMessageChannel,
  fakeTimer,
  flush,
  makeServiceWorker,
} from './_sw-fakes.mjs';

const js = (rel) => new URL(`../../public/js/${rel}`, import.meta.url).href;
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const NOW = 1_000_000;

const secrets = new Map();
let resolveSrcCalls = [];
let resolveSrcImpl = async () => ({ src: 'blob:old', isBlob: true });
let mintImpl = async () => ({ token: 'media-token', expiresAt: NOW + 60_000 });

mock.module(js('media/attachment-e2ee.js'), {
  namedExports: {
    getAttachmentSecret: (scope, id) => secrets.get(`${scope}:${id}`) || null,
    fetchDecryptedAttachment: async () => {
      throw new Error('fetchDecryptedAttachment is not used by this test');
    },
  },
});

mock.module(js('media/mediaToken.js'), {
  namedExports: {
    resolveMediaSrc: (...args) => {
      resolveSrcCalls.push(args);
      return resolveSrcImpl(...args);
    },
    getMediaToken: (...args) => mintImpl(...args),
    getMediaSrcUrl: async () => '/api/dm/attachments/1',
    refreshMediaSrcUrl: async () => '/api/dm/attachments/1',
    clearMediaTokenCache: () => {},
  },
});

const { installLazySource } = await import(js('media/lazy-e2ee-media.js'));

function makeSecret({
  mime = 'video/mp4',
  size = MEDIA_STREAM_MIN_PLAIN_BYTES + 1,
  isVoice = false,
} = {}) {
  return {
    mime,
    size,
    isVoice,
    rawKey: new Uint8Array(32).fill(1),
    baseIv: new Uint8Array(12).fill(2),
  };
}

function makeMediaEl() {
  const listeners = new Map();
  let src = '';

  const el = {
    dataset: {},
    paused: true,
    currentTime: 0,
    readyState: 0,
    playCalls: 0,

    get src() {
      return src;
    },
    set src(value) {
      src = value;
      // A real element reloads from position 0 when src is replaced. The
      // fallback must restore currentTime after loadedmetadata.
      this.currentTime = 0;
      this.readyState = 0;
    },

    addEventListener(type, fn, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, once: !!options.once });
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const at = list.findIndex((entry) => entry.fn === fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatch(type, event = {}) {
      const list = [...(listeners.get(type) || [])];
      for (const entry of list) {
        entry.fn(event);
        if (entry.once) el.removeEventListener(type, entry.fn);
      }
    },

    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
  };

  return el;
}

function makeRealClient({ enabled = true, mint = mintImpl } = {}) {
  const { serviceWorker, controller } = makeServiceWorker({ enabled });
  const timers = fakeTimer();
  let removal = null;

  const client = createSwStreamClient({
    serviceWorker,
    MessageChannelImpl: FakeMessageChannel,
    randomUUID: () => UUID,
    now: () => NOW,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    mintMediaToken: (...args) => mint(...args),
    observeRemoval: (element, callback) => {
      removal = callback;
      return () => {};
    },
  });

  return {
    client,
    controller,
    serviceWorker,
    timers,
    removeElement: () => removal && removal(),
  };
}

function install(mediaEl, {
  msg = { id: 1 },
  scope = 'dm',
  streamClient,
  isAlive = () => true,
  onLoading = () => {},
  onError = () => {},
} = {}) {
  return installLazySource(mediaEl, {
    msg,
    scope,
    isAlive,
    onLoading,
    onError,
    streamClient,
    resolveSrc: (...args) => {
      resolveSrcCalls.push(args);
      return resolveSrcImpl(...args);
    },
    getSecret: (s, id) => secrets.get(`${s}:${id}`) || null,
  });
}

beforeEach(() => {
  secrets.clear();
  resolveSrcCalls = [];
  resolveSrcImpl = async () => ({ src: 'blob:old', isBlob: true });
  mintImpl = async () => ({ token: 'media-token', expiresAt: NOW + 60_000 });
});

test('with the stream flag OFF the wiring runs the old Blob call sequence', async () => {
  secrets.set('dm:1', makeSecret());

  const fake = {
    probeCalls: 0,
    startCalls: 0,
    async probe() {
      this.probeCalls += 1;
      return false;
    },
    start() {
      this.startCalls += 1;
      throw new Error('start must not be called when the flag is OFF');
    },
  };

  const el = makeMediaEl();
  await install(el, { streamClient: fake })();

  assert.equal(fake.probeCalls, 1);
  assert.equal(fake.startCalls, 0);
  assert.equal(resolveSrcCalls.length, 1);
  assert.equal(resolveSrcCalls[0][0].id, 1);
  assert.equal(resolveSrcCalls[0][1], 'dm');
  assert.equal(el.src, 'blob:old');
  assert.equal(el.dataset.blobUrl, 'blob:old');

  // Differential reference: the old ensureSource body, run on a second element.
  const legacyEl = makeMediaEl();
  const legacyCalls = [];
  const legacyResolve = async (msg, scope) => {
    legacyCalls.push([msg, scope]);
    return { src: 'blob:old', isBlob: true };
  };
  const resolved = await legacyResolve({ id: 1 }, 'dm');
  legacyEl.dataset.blobUrl = resolved.src;
  legacyEl.src = resolved.src;

  assert.deepEqual(
    resolveSrcCalls.map(([msg, scopeArg]) => [msg, scopeArg]),
    legacyCalls
  );
  assert.equal(el.src, legacyEl.src);
  assert.deepEqual(el.dataset, legacyEl.dataset);
});

test('below the threshold, and for legacy media, the worker is never probed', async () => {
  secrets.set('dm:1', makeSecret({ size: MEDIA_STREAM_MIN_PLAIN_BYTES }));

  const small = {
    probeCalls: 0,
    startCalls: 0,
    async probe() {
      this.probeCalls += 1;
      return true;
    },
    start() {
      this.startCalls += 1;
      throw new Error('must not stream below the threshold');
    },
  };
  const smallEl = makeMediaEl();
  await install(smallEl, { streamClient: small })();

  assert.equal(small.probeCalls, 0);
  assert.equal(small.startCalls, 0);
  assert.equal(smallEl.src, 'blob:old');
  assert.equal(resolveSrcCalls.length, 1);

  const legacy = {
    probeCalls: 0,
    startCalls: 0,
    async probe() {
      this.probeCalls += 1;
      return true;
    },
    start() {
      this.startCalls += 1;
      throw new Error('legacy media must not stream');
    },
  };
  secrets.clear();
  const legacyEl = makeMediaEl();
  await install(legacyEl, { streamClient: legacy })();

  assert.equal(legacy.probeCalls, 0);
  assert.equal(legacy.startCalls, 0);
  assert.equal(legacyEl.src, 'blob:old');
});

test('group attachments stay on the Blob path even when the flag is ON', async () => {
  secrets.set('group:1', makeSecret());

  const fake = {
    probeCalls: 0,
    startCalls: 0,
    async probe() {
      this.probeCalls += 1;
      return true;
    },
    start() {
      this.startCalls += 1;
      throw new Error('group attachments must not stream');
    },
  };

  const el = makeMediaEl();
  await install(el, { scope: 'group', streamClient: fake })();

  assert.equal(fake.probeCalls, 0);
  assert.equal(fake.startCalls, 0);
  assert.equal(el.src, 'blob:old');
  assert.equal(resolveSrcCalls.length, 1);
});

test('with the flag ON the wiring registers first and then sets the stream URL', async () => {
  const secret = makeSecret();
  secrets.set('dm:1', secret);
  const { client, controller } = makeRealClient({ enabled: true });

  const el = makeMediaEl();
  await install(el, { streamClient: client })();

  assert.equal(resolveSrcCalls.length, 0, 'the Blob download is not started');
  const registration = controller.posted.find((p) => p.data.type === 'REGISTER_STREAM');
  assert.ok(registration, 'REGISTER_STREAM was posted');

  const keyB64 = streamBytesToBase64(secret.rawKey);
  const baseIvB64 = streamBytesToBase64(secret.baseIv);
  assert.deepEqual(registration.data, {
    type: 'REGISTER_STREAM',
    streamId: UUID,
    messageId: 1,
    scope: 'dm',
    keyB64,
    baseIvB64,
    mime: 'video/mp4',
    plainSize: MEDIA_STREAM_MIN_PLAIN_BYTES + 1,
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(registration.data, 'clientId'),
    false
  );

  assert.equal(el.src, `/__wire_media_stream/${UUID}`);
  assert.equal(el.dataset.blobUrl, undefined);
  assert.equal(el.src.includes(keyB64), false);
  assert.equal(el.src.includes(baseIvB64), false);
  assert.deepEqual(Object.values(el.dataset), []);
});

test('a MediaError falls back once, keeps position/playing state, and unregisters', async () => {
  secrets.set('dm:1', makeSecret());
  const { client, controller } = makeRealClient({ enabled: true });

  let releaseBlob;
  resolveSrcImpl = () => new Promise((resolve) => {
    releaseBlob = resolve;
  });

  const loading = [];
  const el = makeMediaEl();
  await install(el, {
    streamClient: client,
    onLoading: (value) => loading.push(value),
  })();

  el.paused = false;
  el.currentTime = 12.5;
  el.dispatch('error');
  await flush();
  await flush();

  assert.equal(resolveSrcCalls.length, 1, 'the Blob fallback started');
  releaseBlob({ src: 'blob:fallback', isBlob: true });
  await flush();
  await flush();

  assert.equal(el.dataset.blobUrl, 'blob:fallback');
  assert.equal(el.src, 'blob:fallback');
  assert.equal(el.currentTime, 0, 'the new src starts at zero');

  el.dispatch('loadedmetadata');
  assert.equal(el.currentTime, 12.5, 'the old position is restored');
  assert.equal(el.playCalls, 1, 'playback resumes because the element was playing');
  assert.equal(
    controller.posted.filter((p) => p.data.type === 'UNREGISTER_STREAM').length,
    1
  );
  assert.equal(loading.at(-1), false, 'the loading state is cleared');

  el.dispatch('error');
  await flush();
  assert.equal(resolveSrcCalls.length, 1, 'no second fallback');
});

test('STREAM_DEAD falls back once and unregisters', async () => {
  secrets.set('dm:1', makeSecret());
  const { client, controller, serviceWorker } = makeRealClient({ enabled: true });

  let releaseBlob;
  resolveSrcImpl = () => new Promise((resolve) => {
    releaseBlob = resolve;
  });

  const el = makeMediaEl();
  await install(el, { streamClient: client })();

  const streamId = controller.posted.find((p) => p.data.type === 'REGISTER_STREAM')
    .data.streamId;

  el.paused = false;
  el.currentTime = 7;
  serviceWorker.emit('message', {
    data: { type: 'STREAM_DEAD', streamId, reason: 'token-timeout' },
  });
  serviceWorker.emit('message', {
    data: { type: 'STREAM_DEAD', streamId, reason: 'again' },
  });
  await flush();
  await flush();

  assert.equal(resolveSrcCalls.length, 1);
  releaseBlob({ src: 'blob:dead', isBlob: true });
  await flush();
  await flush();

  assert.equal(el.src, 'blob:dead');
  el.dispatch('loadedmetadata');
  assert.equal(el.currentTime, 7);
  assert.equal(el.playCalls, 1);
  assert.equal(
    controller.posted.filter((p) => p.data.type === 'UNREGISTER_STREAM').length,
    1
  );
});

test('a failed token mint falls back to the Blob path', async () => {
  secrets.set('dm:1', makeSecret());
  mintImpl = async () => {
    throw new Error('mint failed');
  };
  const { client, controller, serviceWorker } = makeRealClient({ enabled: true });

  let releaseBlob;
  resolveSrcImpl = () => new Promise((resolve) => {
    releaseBlob = resolve;
  });

  const el = makeMediaEl();
  await install(el, { streamClient: client })();

  const streamId = controller.posted.find((p) => p.data.type === 'REGISTER_STREAM')
    .data.streamId;

  serviceWorker.emit('message', { data: { type: 'TOKEN_NEEDED', streamId } });
  await flush();
  await flush();

  assert.equal(resolveSrcCalls.length, 1);
  releaseBlob({ src: 'blob:mint-fallback', isBlob: true });
  await flush();
  await flush();

  assert.equal(el.src, 'blob:mint-fallback');
  assert.equal(
    controller.posted.filter((p) => p.data.type === 'UNREGISTER_STREAM').length,
    1
  );
});

test('losing the controller between a successful status probe and start() fails closed to the Blob path', async () => {
  secrets.set('dm:1', makeSecret());

  const fake = {
    probeCalls: 0,
    startCalls: 0,
    async probe() {
      this.probeCalls += 1;
      return true;
    },
    start() {
      this.startCalls += 1;
      throw new Error('controller lost between probe and start');
    },
  };

  const el = makeMediaEl();
  await install(el, { streamClient: fake })();

  assert.equal(fake.probeCalls, 1);
  assert.equal(fake.startCalls, 1);
  assert.equal(resolveSrcCalls.length, 1, 'the Blob fallback runs');
  assert.equal(el.src, 'blob:old');
  assert.equal(el.dataset.blobUrl, 'blob:old');
});

