import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const js = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};

const dom = new EventTarget();
globalThis.window = {
  addEventListener: (...args) => dom.addEventListener(...args),
  removeEventListener: (...args) => dom.removeEventListener(...args),
  dispatchEvent: (event) => dom.dispatchEvent(event),
};

const { serviceWorker, controller } = (await import('../tests/media/_sw-fakes.mjs')).makeServiceWorker({ enabled: true });
Object.defineProperty(globalThis, 'navigator', {
  value: { serviceWorker },
  writable: true,
  configurable: true,
});

const clearAllCalls = [];
let purgeSeenAtClearAll = false;
const clearMediaTokenCalls = [];
const lockCalls = { n: 0 };
const clearSessionCalls = { n: 0 };
const callOrder = [];

mock.module(js('crypto/identity-service.js'), {
  namedExports: {
    createIdentity: async () => ({}),
    restoreIdentity: async () => ({}),
    restoreIdentityWithUnlockKey: async () => ({}),
    migrateLegacyAccount: async () => ({ migrated: true }),
    prepareCredentialChange: async () => ({}),
    lockIdentity: () => { lockCalls.n++; },
  },
});

mock.module(js('crypto/keys/session.js'), {
  namedExports: {
    clearSessionKeys: () => { clearSessionCalls.n++; },
  },
});

mock.module(js('crypto/keys/unlock-key-store.js'), {
  namedExports: {
    idbStoreUnlockKey: async () => {},
    idbGetUnlockKey: async () => null,
    idbClearUnlockKey: async () => {},
  },
});

mock.module(js('core/server.js'), {
  namedExports: {
    getServerEndpoint: () => 'http://localhost',
    setServerEndpoint: () => {},
    resolveServerUrl: (url) => url,
    isNativeApp: () => false,
  },
});

mock.module(js('media/attachment-e2ee.js'), {
  namedExports: {
    getAttachmentSecret: () => null,
    clearAllAttachmentSecrets: () => {
      clearAllCalls.push('clearAll');
      callOrder.push('clearAll');
      purgeSeenAtClearAll = controller.posted.some((p) => p.data && p.data.type === 'PURGE_CLIENT');
    },
  },
});

mock.module(js('media/mediaToken.js'), {
  namedExports: {
    clearMediaTokenCache: () => { clearMediaTokenCalls.push('clearMediaToken'); callOrder.push('clearMediaToken'); },
  },
});

const auth = await import(js('core/auth.js'));
const { purgeMediaStreams } = await import(js('media/lazy-e2ee-media.js'));

function signIn() {
  auth.setToken('test-token');
  auth.setCurrentUser({ id: 1, username: 'alice', groups_enabled: true });
}

test('logout posts PURGE_CLIENT before clearing secrets and in order', () => {
  signIn();
  const beforePurge = controller.posted.length;
  // purgeSeenAtClearAll is module-scoped; reset here.
  purgeSeenAtClearAll = false;

  // redefine spies? They are already defined with push; need inject check.
  // Instead check after: purge must be in posted before clearAll spy ran.
  // We'll monkeypatch by reading a flag set below is not possible; use controller posted count.
  auth.logout();

  const purgePosts = controller.posted.filter((p) => p.data && p.data.type === 'PURGE_CLIENT');
  assert.equal(purgePosts.length, 1);
  assert.deepEqual(purgePosts[0].data, { type: 'PURGE_CLIENT' });

  assert.equal(clearAllCalls.length, 1);
  assert.equal(clearMediaTokenCalls.length, 1);
  assert.deepEqual(callOrder, ['clearAll', 'clearMediaToken']);
  assert.equal(purgeSeenAtClearAll, true, 'PURGE_CLIENT must be posted before clearAllAttachmentSecrets');

  const purgeIndex = controller.posted.findIndex((p) => p.data && p.data.type === 'PURGE_CLIENT');
  assert.ok(purgeIndex >= beforePurge);

  // No stream registration after logout.
  assert.equal(controller.posted.filter((p) => p.data && p.data.type === 'REGISTER_STREAM').length, 0);
});

test('logout with no controller still clears secrets and does not throw', () => {
  signIn();
  const saved = navigator.serviceWorker.controller;
  navigator.serviceWorker.controller = null;

  assert.doesNotThrow(() => auth.logout());
  assert.equal(clearAllCalls.length, 2);
  assert.equal(clearMediaTokenCalls.length, 2);

  navigator.serviceWorker.controller = saved;
});

test('logout with a throwing postMessage still clears secrets', () => {
  signIn();
  const throwingController = {
    posted: [],
    postMessage() { throw new Error('worker gone'); },
  };
  const saved = navigator.serviceWorker.controller;
  navigator.serviceWorker.controller = throwingController;

  assert.doesNotThrow(() => auth.logout());
  assert.equal(clearAllCalls.length, 3);
  assert.equal(clearMediaTokenCalls.length, 3);

  navigator.serviceWorker.controller = saved;
});

test('pagehide with persisted false purges; persisted true does not', () => {
  signIn();
  const before = controller.posted.filter((p) => p.data && p.data.type === 'PURGE_CLIENT').length;

  const evtFalse = new Event('pagehide');
  evtFalse.persisted = false;
  window.dispatchEvent(evtFalse);

  const afterFalse = controller.posted.filter((p) => p.data && p.data.type === 'PURGE_CLIENT').length;
  assert.equal(afterFalse, before + 1);

  const evtTrue = new Event('pagehide');
  evtTrue.persisted = true;
  window.dispatchEvent(evtTrue);

  const afterTrue = controller.posted.filter((p) => p.data && p.data.type === 'PURGE_CLIENT').length;
  assert.equal(afterTrue, afterFalse);
});

test('purgeMediaStreams is exported and callable', () => {
  assert.equal(typeof purgeMediaStreams, 'function');
  assert.doesNotThrow(() => purgeMediaStreams());
});
