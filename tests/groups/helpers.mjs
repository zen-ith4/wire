// tests/groups/helpers.mjs
//
// Test-only infrastructure for the groups/* crypto modules. Nothing
// here ships to the browser. Two things Node doesn't provide that
// the production code needs are polyfilled:
//
// - navigator.locks (Web Locks API) — real per-name mutual exclusion,
//   good enough to validate nonce-lock.js's critical section.
// - indexedDB — via fake-indexeddb, with a fresh IDBFactory per
//   *simulated device* (see useDeviceStorage below) so two different
//   people's "mine" Sender Key rows in the shared object store don't
//   collide the way they would if every simulated actor shared one
//   real browser's storage. Sender-key-store.js's real production
//   code has no device/user partitioning in its IndexedDB schema —
//   correctly, since a real browser only ever holds one person's
//   data — so the test is what has to isolate actors, not the code
//   under test.
//
// Everything else (crypto.subtle, btoa/atob, TextEncoder) is Node's
// real, unmocked implementation — every X25519/HKDF/AES-GCM
// operation in these tests is the actual algorithm running for real,
// not a stub.

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import * as senderKeyStore from '../../public/js/crypto/groups/sender-key-store.js';
import { clearSenderKeyCache } from '../../public/js/crypto/groups/sender-key.js';

/* =========================================================
 * Web Locks polyfill
 * ========================================================= */

const lockQueues = new Map();

function requestLock(name, callback) {
    const previous = lockQueues.get(name) || Promise.resolve();

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    lockQueues.set(name, previous.then(() => gate));

    return previous.then(async () => {
        try {
            return await callback();
        } finally {
            release();
        }
    });
}

export function installWebLocksPolyfill() {
    if (typeof globalThis.navigator === 'undefined') {
        globalThis.navigator = {};
    }
    globalThis.navigator.locks = { request: requestLock };
}

/* =========================================================
 * Per-device fake IndexedDB
 * ========================================================= */

globalThis.IDBKeyRange = IDBKeyRange;

/**
 * A fresh, empty IndexedDB "browser profile". Two calls to this
 * represent two genuinely different devices/people; one call reused
 * for two "tabs" represents the same device's shared storage.
 */
export function newDeviceStorage() {
    return new IDBFactory();
}

/**
 * Makes `factory` the active indexedDB for whatever groups/* code
 * runs next, and resets sender-key-store.js's cached DB connection
 * so it actually reopens against the newly-active factory instead of
 * reusing a handle to whichever factory was active last.
 */
export function useDeviceStorage(factory) {
    globalThis.indexedDB = factory;
    senderKeyStore.__resetForTests();
    clearSenderKeyCache();
}

/* =========================================================
 * Test identities
 * ========================================================= */

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

/**
 * A full {privateKey, publicKey, userId} identity — the shape every
 * groups/* function expects (see sender-key.js's module doc comment)
 * — for a synthetic test user, with a real X25519 key pair.
 */
export async function makeTestIdentity(userId) {
    const keyPair = await crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveBits']
    );

    const rawPublic = await crypto.subtle.exportKey('raw', keyPair.publicKey);

    // Mirror identity.js's importPrivateKey: non-extractable from
    // this point on, exactly like a real unlocked identity.
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'X25519' },
        false,
        ['deriveBits']
    );

    return {
        userId,
        privateKey,
        publicKey: arrayBufferToBase64(rawPublic),
        _publicKeyCryptoKey: keyPair.publicKey, // test-only convenience, see fake-session.mjs
    };
}

/* =========================================================
 * Fake pairwise session-key provider
 * ========================================================= */
//
// kdm.js imports getOrCreateSessionKey from ../keys/session.js,
// which (in the real app) fetches a peer's public key over HTTP via
// core/api.js. Tests mock that one module (via node:test's
// mock.module) so kdm.js gets real pairwise session keys — the
// actual X25519 ECDH + HKDF from key-derivation.js, nothing faked at
// the crypto layer — derived from an in-memory registry of test
// identities instead of a network round trip. See each test file's
// beforeEach for how this is wired up per "current actor".

export function makeSessionKeyProvider(identitiesByUserId) {
    let currentActorId = null;

    return {
        setCurrentActor(userId) {
            currentActorId = userId;
        },
        async getOrCreateSessionKey(peerUserId) {
            const { deriveSessionKeyFromPeer } = await import(
                '../../public/js/crypto/keys/key-derivation.js'
            );

            const me = identitiesByUserId.get(currentActorId);
            const peer = identitiesByUserId.get(Number(peerUserId));

            if (!me) throw new Error(`No current actor set (wanted peer ${peerUserId})`);
            if (!peer) throw new Error(`Unknown test peer ${peerUserId}`);

            return deriveSessionKeyFromPeer(me.privateKey, peer._publicKeyCryptoKey);
        },
    };
}
