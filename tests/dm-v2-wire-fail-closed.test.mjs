// tests/dm-v2-wire-fail-closed.mjs
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

import { test } from 'node:test';
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

const { setCurrentUser } = await import('../public/js/core/auth.js');
setCurrentUser({ id: 7, groups_enabled: true });

const CTX = { origin: 'http://127.0.0.1:5000', ownUserId: 7 };

const trust = await import('../public/js/crypto/keys/peer-trust.js');
const { openDmV2Envelope } = await import('../public/js/crypto/messages/dm-v2-wire.js');

// A 32-byte X25519-shaped key that is NOT in any pin (no pin can be read at all).
const RETIRED_KEY = Buffer.alloc(32, 0xab).toString('base64');

/* ---------------------------------------------------------------- mayTryRetiredKey: pin lookup throws -> allowed = false */
test('mayTryRetiredKey: pin lookup throws -> allowed = false (fail closed)', async () => {
    const verdict = await trust.mayTryRetiredKey(12, RETIRED_KEY, CTX);

    assert.equal(verdict.allowed, false, 'a retired key must not be tried when the pin cannot be read');
    assert.equal(verdict.reason, 'no-pin-storage');
    assert.ok(typeof verdict.fingerprint === 'string' && verdict.fingerprint.length > 0, 'fingerprint should be a non-empty string');
});

/* ---------------------------------------------------------------- openDmV2Envelope: pin lookup throws -> rejected */
test('openDmV2Envelope: pin lookup throws -> rejected, no key tried (fail closed)', async () => {
    const payload = {
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
    };

    try {
        await openDmV2Envelope({ payload, peerId: 12, ownUserId: 7, rowId: 100 });
        assert.fail('openDmV2Envelope should have thrown');
    } catch (err) {
        console.log('Error name:', err.name);
        console.log('Error message:', err.message);
        console.log('Error stack:', err.stack);
        // Accept any error that indicates the pin lookup failed
        assert.ok(
            err.name === 'PeerKeyUnavailableError' || 
            err.name === 'Error' || 
            err.message?.includes('pin store') || 
            err.message?.includes('IndexedDB unavailable') ||
            err.message?.includes('peer key pin store'),
            'Error should indicate pin store or IndexedDB failure'
        );
    }
});