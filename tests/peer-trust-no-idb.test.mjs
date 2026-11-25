// B2 (part 1): mayTryRetiredKey must fail closed when pin storage is unavailable.
//
// This test runs in its own file so that IndexedDB can be removed BEFORE
// peer-trust.js is imported, ensuring openDb() rejects on first call.
//
// Without IndexedDB, getPeerPin() throws inside mayTryRetiredKey(), and the
// catch branch returns {allowed: false, reason: 'no-pin-storage'} — fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// No IndexedDB at all → openDb() will reject.
delete globalThis.indexedDB;

const trust = await import('../public/js/crypto/keys/peer-trust.js');

const CTX = { origin: 'https://wire.test', ownUserId: 1 };

// A deterministic 32-byte X25519-shaped public key.
function fakeKey(seed) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = seed;
    return Buffer.from(bytes).toString('base64');
}

const PEER = 7;
const THEIRS = fakeKey(42);

test('mayTryRetiredKey: pin storage unavailable → allowed:false (fail closed)', async () => {
    const verdict = await trust.mayTryRetiredKey(PEER, THEIRS, CTX);
    assert.equal(verdict.allowed, false,
        'unavailable pin storage must refuse retired keys (fail closed)');
    assert.equal(verdict.reason, 'no-pin-storage');
    assert.ok(verdict.fingerprint, 'fingerprint is computed');
});