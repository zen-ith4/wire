// B2 (part 3): when getPeerTrustContext() returns null (not logged in, no server
// endpoint, or storage unavailable), peer trust fails closed for retired keys:
// getTrustedPeerKeys() throws, so createSessionKey()/getOrCreateSessionKey()
// cannot create an encrypt key; buildArchivedSessionKeys() skips all retired
// keys, so getSessionKeyCandidates() returns only the current key (when it
// exists) with no archived additions.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

/* ---------------------------------------------------------------- IndexedDB stand-in */
function installFakeIndexedDb() {
    const stores = new Map();
    const store = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const request = (result) => {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result };
        queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
        return req;
    };
    const fakeDb = () => ({
        objectStoreNames: { contains: (n) => n === 'peer-pins' },
        transaction(storeName, mode) {
            const data = store(storeName);
            const tx = {
                oncomplete: null,
                onerror: null,
                objectStore() {
                    return {
                        put(value, key) { if (mode === 'readwrite') data.set(key, value); return request(undefined); },
                        get(key) { return request(data.get(key)); },
                        delete(key) { if (mode === 'readwrite') data.delete(key); return request(undefined); },
                    };
                },
            };
            queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); })));
            return tx;
        },
    });
    globalThis.indexedDB = {
        open() {
            const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null };
            queueMicrotask(() => {
                req.result = fakeDb();
                if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
                if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
        },
    };
}
installFakeIndexedDb();

/* ---------------------------------------------------------------- localStorage stand-in */
const ls = new Map();
globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(k, String(v)); },
    removeItem: (k) => { ls.delete(k); },
    clear: () => { ls.clear(); },
};

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function person() {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { priv: pair.privateKey, pub: pair.publicKey, raw, b64: b64(raw) };
}

const ALICE = 1;
const ORIGIN = 'https://wire.test';

const alice = await person();

// No logged-in user → getOwnUserId() → null → getPeerTrustContext() → null
let currentUser = null;
let currentIdentity = { privateKey: alice.priv, publicKey: alice.b64 };

mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => currentUser,
        getToken: () => null,
        logout: () => {},
    },
});

mock.module(js('core/server.js'), {
    namedExports: {
        getServerEndpoint: () => ORIGIN,
        resolveServerUrl: (url) => url,
    },
});

mock.module(js('crypto/identity-service.js'), {
    namedExports: {
        getCurrentIdentity: () => currentIdentity,
    },
});

mock.module(js('core/api.js'), {
    namedExports: {
        api: async () => { throw new Error('unexpected api call'); },
    },
});

const gate = await import(js('crypto/keys/peer-key-gate.js'));
const session = await import(js('crypto/keys/session.js'));

async function clearAll() {
    session.clearSessionKeys();
    ls.clear();
}

beforeEach(async () => {
    await clearAll();
});

afterEach(async () => {
    await clearAll();
});

test('no user → getPeerTrustContext() returns null', async () => {
    const ctx = await gate.getPeerTrustContext();
    assert.equal(ctx, null,
        'getPeerTrustContext() returns null when getOwnUserId() returns null');
});

test('no user → getTrustedPeerKeys() throws (fail closed)', async () => {
    await assert.rejects(
        gate.getTrustedPeerKeys(ALICE),
        /no signed-in account or server context/,
        'getTrustedPeerKeys() throws when trust context is null'
    );
});

test('no user → clearSessionKeys() does not throw', () => {
    assert.doesNotThrow(() => session.clearSessionKeys());
    assert.doesNotThrow(() => session.clearSessionKeys());
});
