// tests/dm-v2-wire-fail-closed.test.mjs
//
// B2: dm-v2-wire.js must fail closed when the pin lookup throws.
// A retired key must NOT be tried when the pin cannot be consulted.
//
// The old code had `catch { allowed = true }` around mayTryRetiredKey(),
// so a throwing pin lookup fell through and the retired key was tried anyway.
// The fix: when the pin lookup throws, allowed = false — skip the retired key.
// This is now enforced at the peer-key-gate layer (getTrustedPeerKeys throws
// PeerKeyUnavailableError when getPeerPin throws), so selectSenderKey() and
// openDmV2Envelope() reject rather than try any key.
//
// This file installs a THROWING IndexedDB stand-in BEFORE importing any crypto
// module, so getPeerPin() -> readRecord() -> openDb() rejects and every code
// path that consults the pin fails closed.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/* ---------------------------------------------------------------- Throwing IndexedDB stand-in */
function installThrowingIndexedDb() {
    globalThis.indexedDB = {
        open: () => {
            const request = {
                onsuccess: null,
                onerror: null,
                onupgradeneeded: null,
                result: null,
            };
            // Immediately trigger onerror to simulate failure
            queueMicrotask(() => {
                if (request.onerror) {
                    request.onerror({ target: request, error: new Error('IndexedDB unavailable') });
                }
            });
            return request;
        }
    };
}
installThrowingIndexedDb();

/* ---------------------------------------------------------------- localStorage stand-in */
const ls = new Map();
globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(k, String(v)); },
    removeItem: (k) => { ls.delete(k); },
    clear: () => { ls.clear(); },
};
globalThis.window = { location: { origin: 'http://127.0.0.1:5000' }, Capacitor: undefined };
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

const PUBLIC = new URL('../public/', import.meta.url).href;

/* ---------------------------------------------------------------- Mock identity-service to provide a mock identity */
let mockPrivateKey;
let mockPublicKey;

// Generate a mock key pair for testing
async function generateMockKeyPair() {
    const pair = await crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveBits']
    );
    const rawPub = await crypto.subtle.exportKey('raw', pair.publicKey);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    mockPublicKey = Buffer.from(rawPub).toString('base64');
    mockPrivateKey = pkcs8;
    return { mockPrivateKey, mockPublicKey };
}

mock.module(new URL('./js/crypto/identity-service.js', PUBLIC).href, {
    namedExports: {
        getCurrentIdentity: () => ({
            privateKey: mockPrivateKey,
            publicKey: mockPublicKey,
        }),
        isIdentityUnlocked: () => true,
        lockIdentity: () => {},
    },
});

/* ---------------------------------------------------------------- Mock other dependencies */
mock.module(new URL('./js/core/server.js', PUBLIC).href, {
    namedExports: {
        resolveServerUrl: (url) => url,
        getServerEndpoint: () => 'http://127.0.0.1:5000',
    },
});

mock.module(new URL('./js/core/auth.js', PUBLIC).href, {
    namedExports: {
        getCurrentUser: () => ({ id: 7 }),
        getToken: () => 'test-token',
        setCurrentUser: () => {},
    },
});

mock.module(new URL('./js/crypto/keys/peer-keys.js', PUBLIC).href, {
    namedExports: {
        getPeerPublicKeyBase64: async () => Buffer.alloc(32, 0xcd).toString('base64'),
        getPeerKeyCandidates: async () => ({ current: Buffer.alloc(32, 0xcd).toString('base64'), history: [] }),
        getPeerDmMinVersion: async () => 2,
    },
});

/* ---------------------------------------------------------------- Import test subjects AFTER mocks */
await generateMockKeyPair();

const { setCurrentUser } = await import('../public/js/core/auth.js');
setCurrentUser({ id: 7, groups_enabled: true });

const CTX = { origin: 'http://127.0.0.1:5000', ownUserId: 7 };

const trust = await import('../public/js/crypto/keys/peer-trust.js');
const { openDmV2Envelope } = await import('../public/js/crypto/messages/dm-v2-wire.js');
const { getTrustedPeerKeys } = await import('../public/js/crypto/keys/peer-key-gate.js');

// A 32-byte X25519-shaped key that is NOT in any pin (no pin can be read at all).
const RETIRED_KEY = Buffer.alloc(32, 0xab).toString('base64');

const envelopePayload = () => ({
    encryption: {
        version: 2,
        algorithm: 'AES-GCM',
        iv: Buffer.alloc(12).toString('base64'),
        ciphertext: Buffer.from('aa', 'hex').toString('base64'),
        senderFp: Buffer.alloc(32).toString('base64'),
        msgId: '0123456789abcdef'
    },
    senderId: 12,   // a peer, not the local user (7) -> goes through the pin path
    recipientId: 7
});

/* ---------------------------------------------------------------- mayTryRetiredKey: pin lookup throws -> allowed = false */
test('mayTryRetiredKey: pin lookup throws -> allowed = false (fail closed)', async () => {
    const verdict = await trust.mayTryRetiredKey(12, RETIRED_KEY, CTX);

    assert.equal(verdict.allowed, false, 'a retired key must not be tried when the pin cannot be read');
    assert.equal(verdict.reason, 'no-pin-storage');
    assert.ok(typeof verdict.fingerprint === 'string' && verdict.fingerprint.length > 0, 'fingerprint should be a non-empty string');
});

/* ---------------------------------------------------------------- openDmV2Envelope: pin lookup throws -> rejected */
test('openDmV2Envelope: pin lookup throws -> rejected with PeerKeyUnavailableError (fail closed)', async () => {
    try {
        await openDmV2Envelope({ payload: envelopePayload(), peerId: 12, ownUserId: 7, rowId: 100 });
        assert.fail('openDmV2Envelope should have thrown');
    } catch (err) {
        // Must be PeerKeyUnavailableError from getTrustedPeerKeys
        assert.equal(err.name, 'PeerKeyUnavailableError', 'should throw PeerKeyUnavailableError');
        assert.ok(err.message.includes('peer key pin store') || err.message.includes('IndexedDB unavailable'), 'error message should indicate pin store failure');
        assert.equal(err.code, 'PEER_KEY_UNAVAILABLE', 'should have correct error code');
        assert.equal(err.peerId, 12, 'should include peerId');
        assert.ok(err.reason, 'should include reason');
        // It failed BEFORE the sender-key/decrypt stage: a "no usable sender key"
        // outcome would mean the pin check had been skipped.
        assert.notEqual(err.code, 'DM_V2_NO_SENDER_KEY', 'must fail at the pin gate, not during decryption');
    }
});

/* ---------------------------------------------------------------- unrelated input errors are not relabelled */
test('unrelated error is propagated as-is, not converted into a pin failure', async () => {
    // peerId 0 fails validation inside the gate, before any pin is touched.
    // If fail-closed code swallowed/mapped unrelated errors this would come
    // back as PeerKeyUnavailableError; it must stay a plain Error.
    await assert.rejects(
        () => getTrustedPeerKeys(0),
        (err) => {
            assert.equal(err.name, 'Error');
            assert.equal(err.code, undefined);
            assert.equal(err.message, 'Invalid user ID');
            return true;
        }
    );

    await assert.rejects(
        () => openDmV2Envelope({ payload: envelopePayload(), peerId: 0, ownUserId: 7, rowId: 100 }),
        (err) => err.message === 'Invalid user ID' && err.code === undefined
    );
});
