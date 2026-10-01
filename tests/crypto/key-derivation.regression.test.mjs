// tests/crypto/key-derivation.regression.test.mjs
//
// Regression guard for public/js/crypto/keys/key-derivation.js.
//
// WHY THIS EXISTS: the HKDF parameters in key-derivation.js (info
// string, salt, hash, output length) are part of the on-the-wire /
// at-rest protocol. Every DM ever encrypted under the current
// parameters can only be decrypted by re-deriving the *exact same*
// key. Change any of them -- even "harmlessly" while refactoring --
// and existing conversations silently become undecryptable. This file
// pins that behavior so such a change fails loudly here instead.
//
// Two independent kinds of protection are used on purpose:
//   1. Known-answer vectors: fixed key pairs -> fixed shared secret
//      and fixed AES-GCM ciphertext. These are hard-coded snapshots
//      of the deployed behavior. If one of them has to change, that
//      is a protocol break and needs an explicit migration decision,
//      not just an edited constant here.
//   2. An independent oracle: the test re-derives the key using the
//      literal HKDF parameters written out *in this file* (not
//      imported from key-derivation.js), so the module is checked
//      against the spec rather than against itself.
//
// Run with the rest of the suite:  npm test
// (or just this file: node --test tests/crypto/key-derivation.regression.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    deriveSharedSecret,
    deriveSessionKeyFromPeer,
} from '../../public/js/crypto/keys/key-derivation.js';

// ---------- Pinned values (snapshot of deployed behavior) ----------

// Literal, on purpose -- do NOT import these from the module under test.
const DM_INFO_STRING = 'Wire-E2EE-v1';
const GROUP_WRAP_INFO_STRING = 'Wire-E2EE-Group-SenderKeyWrap-v1';

// X25519 shared secret for the fixed key pairs below.
const PINNED_SHARED_SECRET_HEX =
    'c9ea6a3f79a000b60b076d4afc990b272f3f0b5aaa3f0b8713c209273e363863';

// AES-256-GCM(key = HKDF-SHA256(secret, salt = 32 zero bytes,
// info = 'Wire-E2EE-v1'), iv = 12 zero bytes, PLAINTEXT) -- ciphertext+tag.
const PINNED_DM_CIPHERTEXT_HEX =
    'd8d8558af12a44912ab914fed878f8b120c4fc6e53501ae4522e8faf0b1f3dd4' +
    '72ae7e98a3a6d73027c164df9340';

const PLAINTEXT = new TextEncoder().encode('wire-hkdf-regression-plaintext');
const IV = new Uint8Array(12);

// ---------- Helpers ----------

const PKCS8_X25519_PREFIX = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

const toHex = (buf) => Buffer.from(buf).toString('hex');

// Deterministic X25519 key pair from a fixed 32-byte seed.
async function fixedKeyPair(seedStart) {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => seedStart + i);
    const pkcs8 = new Uint8Array(48);
    pkcs8.set(PKCS8_X25519_PREFIX);
    pkcs8.set(seed, 16);

    const extractable = await crypto.subtle.importKey(
        'pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits']
    );
    const jwk = await crypto.subtle.exportKey('jwk', extractable);

    // Non-extractable private key, matching how the app holds it.
    const privateKey = await crypto.subtle.importKey(
        'pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits']
    );
    const publicKey = await crypto.subtle.importKey(
        'jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
        { name: 'X25519' }, true, []
    );

    return { privateKey, publicKey };
}

// Independent oracle: raw secret -> HKDF -> AES-GCM key, with every
// parameter spelled out here rather than taken from the module.
async function oracleKey(privateKey, publicKey, infoString) {
    const secret = await crypto.subtle.deriveBits(
        { name: 'X25519', public: publicKey }, privateKey, 256
    );
    const hkdf = await crypto.subtle.importKey(
        'raw', secret, { name: 'HKDF' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(32),
            info: new TextEncoder().encode(infoString),
        },
        hkdf,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

const encrypt = (key) =>
    crypto.subtle.encrypt({ name: 'AES-GCM', iv: IV }, key, PLAINTEXT);

// ---------- Tests ----------

test('deriveSharedSecret matches the pinned known-answer vector', async () => {
    const alice = await fixedKeyPair(1);
    const bob = await fixedKeyPair(101);

    const secret = await deriveSharedSecret(alice.privateKey, bob.publicKey);

    assert.equal(secret.byteLength, 32);
    assert.equal(toHex(secret), PINNED_SHARED_SECRET_HEX);
});

test('default session key matches the pinned known-answer ciphertext', async () => {
    const alice = await fixedKeyPair(1);
    const bob = await fixedKeyPair(101);

    const key = await deriveSessionKeyFromPeer(alice.privateKey, bob.publicKey);

    assert.equal(
        toHex(await encrypt(key)),
        PINNED_DM_CIPHERTEXT_HEX,
        'DM session key derivation changed -- existing conversations ' +
        'would become undecryptable. This is a protocol break.'
    );
});

test('default info string is exactly "Wire-E2EE-v1" (checked against an independent oracle)', async () => {
    const alice = await fixedKeyPair(1);
    const bob = await fixedKeyPair(101);

    const fromModule = await deriveSessionKeyFromPeer(alice.privateKey, bob.publicKey);
    const fromOracle = await oracleKey(alice.privateKey, bob.publicKey, DM_INFO_STRING);

    assert.equal(toHex(await encrypt(fromModule)), toHex(await encrypt(fromOracle)));
});

test('omitting info and passing the DM info explicitly derive the same key', async () => {
    const alice = await fixedKeyPair(1);
    const bob = await fixedKeyPair(101);

    const implicit = await deriveSessionKeyFromPeer(alice.privateKey, bob.publicKey);
    const explicit = await deriveSessionKeyFromPeer(
        alice.privateKey,
        bob.publicKey,
        new TextEncoder().encode(DM_INFO_STRING)
    );

    assert.equal(toHex(await encrypt(implicit)), toHex(await encrypt(explicit)));
});

test('a custom info string is honored and matches the oracle (group wrap info)', async () => {
    const alice = await fixedKeyPair(1);
    const bob = await fixedKeyPair(101);

    const fromModule = await deriveSessionKeyFromPeer(
        alice.privateKey,
        bob.publicKey,
        new TextEncoder().encode(GROUP_WRAP_INFO_STRING)
    );
    const fromOracle = await oracleKey(alice.privateKey, bob.publicKey, GROUP_WRAP_INFO_STRING);

    assert.equal(toHex(await encrypt(fromModule)), toHex(await encrypt(fromOracle)));
});

test('domain separation: different info strings yield different, non-interchangeable keys', async () => {
    const alice = await fixedKeyPair(1);
    const bob = await fixedKeyPair(101);

    const dmKey = await deriveSessionKeyFromPeer(alice.privateKey, bob.publicKey);
    const wrapKey = await deriveSessionKeyFromPeer(
        alice.privateKey,
        bob.publicKey,
        new TextEncoder().encode(GROUP_WRAP_INFO_STRING)
    );

    const dmCiphertext = await encrypt(dmKey);
    assert.notEqual(toHex(dmCiphertext), toHex(await encrypt(wrapKey)));

    // A key derived for one purpose must not decrypt the other's data.
    await assert.rejects(
        crypto.subtle.decrypt({ name: 'AES-GCM', iv: IV }, wrapKey, dmCiphertext)
    );
});

test('both sides of a conversation derive the same key (ECDH symmetry)', async () => {
    const alice = await fixedKeyPair(1);
    const bob = await fixedKeyPair(101);

    const aliceKey = await deriveSessionKeyFromPeer(alice.privateKey, bob.publicKey);
    const bobKey = await deriveSessionKeyFromPeer(bob.privateKey, alice.publicKey);

    assert.equal(toHex(await encrypt(aliceKey)), toHex(await encrypt(bobKey)));
});

test('derived key is a non-extractable AES-256-GCM encrypt/decrypt key', async () => {
    const alice = await fixedKeyPair(1);
    const bob = await fixedKeyPair(101);

    const key = await deriveSessionKeyFromPeer(alice.privateKey, bob.publicKey);

    assert.equal(key.algorithm.name, 'AES-GCM');
    assert.equal(key.algorithm.length, 256);
    assert.equal(key.extractable, false);
    assert.deepEqual([...key.usages].sort(), ['decrypt', 'encrypt']);
});

test('input validation: rejects non-CryptoKey and non-X25519 keys', async () => {
    const alice = await fixedKeyPair(1);
    const bob = await fixedKeyPair(101);
    const aesKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );

    await assert.rejects(deriveSharedSecret({}, bob.publicKey), /Invalid identity private key/);
    await assert.rejects(deriveSharedSecret(alice.privateKey, {}), /Invalid peer public key/);
    await assert.rejects(deriveSharedSecret(aesKey, bob.publicKey), /Identity key must be X25519/);
    await assert.rejects(deriveSharedSecret(alice.privateKey, aesKey), /Peer key must be X25519/);
});
