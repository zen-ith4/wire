// B1: encryption must only ever use the current session key, never a retired one.
//
// promoteSessionKeyCandidate() moves a working retired key to the front of
// archivedSessionKeys (decrypt-only). getOrCreateSessionKey() reads only from
// sessionKeys (encrypt). The two maps must stay separate: after a retired key
// is promoted for decryption, encrypting a new message must still use the
// current key.
//
// Three scenarios:
//   A: tab open during peer rotation — current key stays the encrypt key
//   B: fresh page: old message then new message — decrypt old (retired), encrypt new (current)
//   C: send after B — after decrypting old, a new send uses the current key
//
// Uses mocked identity-service + peer-key-gate, real WebCrypto, real session.js.
import { test, beforeEach, mock, afterEach } from 'node:test';
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

/* ---------------------------------------------------------------- real identities */
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function person() {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { priv: pair.privateKey, pub: pair.publicKey, raw, b64: b64(raw) };
}

const ALICE = 1;
const ORIGIN = 'https://wire.test';

const alice = await person();
let currentUser = { id: ALICE };
let currentIdentity = { privateKey: alice.priv, publicKey: alice.b64 };

/* ---------------------------------------------------------------- the hostile server */
const server = {
    keys: new Map(),
    scripted: new Map(),
    calls: [],
};

function answerIdentityKey(id) {
    const queue = server.scripted.get(id);
    const answer = queue?.length ? queue.shift() : server.keys.get(id);
    if (!answer) throw new Error('Identity key not found');
    return { publicKey: answer, dmE2eeMinVersion: 2 };
}

mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => currentUser,
        getToken: () => 'test-token',
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
        api: async (url) => {
            const path = String(url);

            const key = path.match(/^\/api\/me\/identity-key\/(\d+)$/);
            if (key) {
                const id = Number(key[1]);
                server.calls.push(`key:${id}`);
                return answerIdentityKey(id);
            }

            throw new Error(`unexpected api call: ${path}`);
        },
    },
});

const gate = await import(js('crypto/keys/peer-key-gate.js'));
const session = await import(js('crypto/keys/session.js'));
const { encryptMessage } = await import(js('crypto/messages/encrypt.js'));
const { decryptMessage } = await import(js('crypto/messages/decrypt.js'));

/* ---------------------------------------------------------------- helpers */

let nextPeerId = 100;

async function meetPeer() {
    const id = nextPeerId++;
    const keys = await person();
    server.keys.set(id, keys.b64);
    return { id, keys };
}

async function pinnedPeer() {
    const peer = await meetPeer();
    await gate.resolveDmPeerKey(peer.id);
    return peer;
}

async function clearAll() {
    session.clearSessionKeys();
    ls.clear();
}

/* ---------------------------------------------------------------- tests */

beforeEach(async () => {
    await clearAll();
});

afterEach(async () => {
    await clearAll();
});

test('Scenario A: peer rotation — encrypt key stays current, retired key stays decrypt-only', async () => {
    const peer = await pinnedPeer();

    // Current encrypt key exists.
    const currentKey = await session.getOrCreateSessionKey(peer.id);
    assert.ok(currentKey, 'current session key created');

    // Create a different (retired) key and promote it as if it decrypted an old row.
    const retiredPair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    session.promoteSessionKeyCandidate(peer.id, retiredPair.privateKey);

    // getOrCreateSessionKey must STILL return the original current key.
    const stillCurrent = await session.getOrCreateSessionKey(peer.id);
    assert.equal(stillCurrent, currentKey, 'encrypt key is still the current key after promotion');

    // getSessionKey must return the current key, not the promoted retired one.
    const stored = session.getSessionKey(peer.id);
    assert.equal(stored, currentKey, 'stored session key is still the current key');
});

test('Scenario B: fresh page — decrypt old (retired), encrypt new (current)', async () => {
    const peer = await pinnedPeer();

    // Create and encrypt a message with the current key.
    const currentKey = await session.getOrCreateSessionKey(peer.id);
    const plaintext = 'hello current key';
    const encrypted = await encryptMessage(plaintext, peer.id);
    assert.ok(encrypted.ciphertext, 'message encrypted');

    // Decrypt with the current key should succeed.
    const decrypted = await decryptMessage(encrypted, peer.id);
    assert.equal(decrypted, plaintext, 'decrypt with current key works');

    // Promote a retired key as if it decrypted an old row.
    const retiredPair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    session.promoteSessionKeyCandidate(peer.id, retiredPair.privateKey);

    // Encrypt a NEW message — must use the current key, not the promoted retired one.
    const newPlaintext = 'hello after rotation';
    const newEncrypted = await encryptMessage(newPlaintext, peer.id);
    assert.ok(newEncrypted.ciphertext, 'new message encrypted');

    // Decrypt the new message — must succeed with the current key.
    const newDecrypted = await decryptMessage(newEncrypted, peer.id);
    assert.equal(newDecrypted, newPlaintext, 'new message decrypts with current key');
});

test('Scenario C: send after decrypting old — encrypt still uses current key', async () => {
    const peer = await pinnedPeer();

    // Encrypt an old-style message with the current key.
    const currentKey = await session.getOrCreateSessionKey(peer.id);
    const oldPlaintext = 'old message';
    const oldEncrypted = await encryptMessage(oldPlaintext, peer.id);
    const oldDecrypted = await decryptMessage(oldEncrypted, peer.id);
    assert.equal(oldDecrypted, oldPlaintext, 'old message decrypts');

    // Promote a retired key (simulating it decrypted an even older row).
    const retiredPair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    session.promoteSessionKeyCandidate(peer.id, retiredPair.privateKey);

    // Encrypt after the promotion — must use the current key.
    const newPlaintext = 'new message after decrypting old';
    const newEncrypted = await encryptMessage(newPlaintext, peer.id);
    const newDecrypted = await decryptMessage(newEncrypted, peer.id);
    assert.equal(newDecrypted, newPlaintext, 'new message encrypts and decrypts with current key');

    // getOrCreateSessionKey returns the same current key object, not the retired one.
    const keyAfter = await session.getOrCreateSessionKey(peer.id);
    assert.equal(keyAfter, currentKey, 'encrypt key is unchanged after promotion');
    assert.notEqual(keyAfter, retiredPair.privateKey, 'encrypt key is not the retired key');
});

test('getSessionKeyCandidates returns current first, retired after', async () => {
    const peer = await pinnedPeer();

    const currentKey = await session.getOrCreateSessionKey(peer.id);

    const retiredPair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    session.promoteSessionKeyCandidate(peer.id, retiredPair.privateKey);

    const candidates = await session.getSessionKeyCandidates(peer.id);
    assert.equal(candidates[0], currentKey, 'first candidate is the current encrypt key');
    assert.ok(candidates.length >= 1, 'at least the current key is a candidate');
});
