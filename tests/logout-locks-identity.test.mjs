// tests/logout-locks-identity.test.mjs
//
// R3: logout() must lock the in-memory identity and drop every derived session
// key SYNCHRONOUSLY, before any view receives wire:logout. This covers both
// entry points that end a session:
//   - a real 401 from core/api.js;
//   - the sign-out button / any other direct logout() caller.
//
// identity-service.js and keys/session.js are replaced by spies: the lock and
// cache-clear implementations are already covered by
// tests/groups/lock-identity-clears-group-keys.test.mjs and
// tests/groups/group-kdm-key-pinning.test.mjs. This file pins the wiring.

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

let locked = false;
let lockCalls = 0;
let clearCalls = 0;

mock.module(js('crypto/identity-service.js'), {
    namedExports: {
        createIdentity: async () => ({}),
        restoreIdentity: async () => ({}),
        restoreIdentityWithUnlockKey: async () => ({}),
        migrateLegacyAccount: async () => ({ migrated: true }),
        prepareCredentialChange: async () => ({}),
        lockIdentity: () => {
            locked = true;
            lockCalls++;
        },
    },
});

mock.module(js('crypto/keys/session.js'), {
    namedExports: {
        clearSessionKeys: () => {
            clearCalls++;
        },
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

const auth = await import(js('core/auth.js'));
const { api } = await import(js('core/api.js'));

function signIn() {
    auth.setToken('test-token');
    auth.setCurrentUser({ id: 1, username: 'alice', groups_enabled: true });
}

test('a 401 from api() locks the identity and clears session keys synchronously', async () => {
    signIn();

    const beforeLock = lockCalls;
    const beforeClear = clearCalls;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        status: 401,
        text: async () => JSON.stringify({
            code: 'TOKEN_EXPIRED',
            error: 'Session expired',
        }),
    });

    try {
        await assert.rejects(
            () => api('/api/me'),
            /Session expired/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(auth.getToken(), null);
    assert.equal(auth.getCurrentUser(), null);
    assert.equal(locked, true);
    assert.equal(lockCalls, beforeLock + 1);
    assert.equal(clearCalls, beforeClear + 1);
});

test('a 401 from fetchBlob() locks the identity and clears session keys synchronously', async () => {
    signIn();

    const beforeLock = lockCalls;
    const beforeClear = clearCalls;

    // api.js has a second 401 handler in fetchBlob(); it has its own
    // isHandlingUnauthorized flag, so import a fresh module instance rather
    // than inheriting the state the api() test above leaves set.
    const freshApi = await import(`${js('core/api.js')}?fetch-blob-401=1`);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        status: 401,
        text: async () => JSON.stringify({
            code: 'TOKEN_EXPIRED',
            error: 'Session expired',
        }),
    });

    try {
        await assert.rejects(
            () => freshApi.fetchBlob('/api/files/1'),
            /Session expired/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(auth.getToken(), null);
    assert.equal(auth.getCurrentUser(), null);
    assert.equal(locked, true);
    assert.equal(lockCalls, beforeLock + 1);
    assert.equal(clearCalls, beforeClear + 1);
});

test('a direct logout() (the sign-out button path) locks before wire:logout', () => {
    signIn();

    let stateSeenByView = null;
    const listener = () => {
        stateSeenByView = {
            locked,
            token: auth.getToken(),
            user: auth.getCurrentUser(),
        };
    };

    dom.addEventListener('wire:logout', listener);

    try {
        auth.logout();
    } finally {
        dom.removeEventListener('wire:logout', listener);
    }

    assert.deepEqual(stateSeenByView, {
        locked: true,
        token: null,
        user: null,
    });
});
