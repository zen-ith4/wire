// B4: createIdentity must not keep an extractable private key. After wrapping,
// the private key is re-imported as non-extractable (same as restoreIdentity),
// and the exported PKCS8 buffer is zeroed. exportKey on the returned private
// key must throw.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const PUBLIC = new URL('../public/', import.meta.url).href;

/* ---------------------------------------------------------------- fetch mock */
let fetchImpl;
const realFetch = globalThis.fetch;

function mockFetch(impl) {
    fetchImpl = impl;
    globalThis.fetch = impl;
}

afterEach(() => {
    globalThis.fetch = realFetch;
});

/* ---------------------------------------------------------------- module deps */

mock.module(new URL('./js/crypto/credentials.js', PUBLIC).href, {
    namedExports: {
        KDF_ITERATIONS: 1000,
        KDF_SALT_BYTES: 16,
        KDF_NAME: 'PBKDF2-SHA-256+HKDF-SHA-256',
        IDENTITY_VERSION: 2,
        bytesToB64: (b) => Buffer.from(b).toString('base64'),
        bytesToB64Url: (b) => Buffer.from(b).toString('base64'),
        generateKdfSalt: () => crypto.getRandomValues(new Uint8Array(16)),
        deriveCredentials: async () => ({ authKey: 'test-auth-key' }),
        importWrapKey: () => null,
    },
});

mock.module(new URL('./js/crypto/account-kdf.js', PUBLIC).href, {
    namedExports: {
        fetchOwnKdfParams: async () => ({ scheme: 1 }),
        pinScheme2: () => {},
    },
});

mock.module(new URL('./js/crypto/identity.js', PUBLIC).href, {
    namedExports: {
        createEncryptedIdentity: async () => {
            const pair = await crypto.subtle.generateKey(
                { name: 'X25519' },
                true,
                ['deriveBits']
            );
            const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
            const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
            return {
                keyPair: pair,
                publicKey: Buffer.from(raw).toString('base64'),
                encryptedPrivateKey: new Uint8Array(pkcs8),
                kdf: 'PBKDF2',
                kdfParams: {},
                salt: 'test-salt',
                iv: 'test-iv',
                version: 1,
            };
        },
        decryptIdentityPrivateKeyWithDerivedKey: async () => null,
        encryptIdentityPkcs8: async () => new ArrayBuffer(0),
        decryptIdentityPkcs8: async () => null,
        assertKnownIdentityFormat: () => {},
        deriveIdentityUnlockKey: async () => new ArrayBuffer(0),
        restoreIdentityFromServer: async () => null,
        importPrivateKey: async (pkcs8) => {
            return crypto.subtle.importKey(
                'pkcs8',
                pkcs8,
                { name: 'X25519' },
                false,
                ['deriveBits']
            );
        },
    },
});

mock.module(new URL('./js/core/server.js', PUBLIC).href, {
    namedExports: {
        resolveServerUrl: (url) => url,
    },
});

const identityService = await import(new URL('./js/crypto/identity-service.js', PUBLIC).href);
const { createIdentity, getCurrentIdentity } = identityService;

const TOKEN = 'test-token-' + crypto.randomUUID();

test('createIdentity private key is non-extractable (exportKey throws)', async () => {
    mockFetch(async () => {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    await createIdentity('test-password-12345', TOKEN);

    const current = getCurrentIdentity();
    assert.ok(current, 'current identity is set');
    assert.ok(current.privateKey, 'private key is set');

    // exportKey on the non-extractable private key must throw.
    await assert.rejects(
        crypto.subtle.exportKey('pkcs8', current.privateKey),
        /extractable|not extractable|key is not extractable/
    );
});
