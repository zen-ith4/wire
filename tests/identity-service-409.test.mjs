// B3: a 409 'Identity key already exists' response from PUT /me/identity-key
// must be surfaced as a failure, not silently treated as success.
//
// The dead branch that checked for "user already exists" and optionally
// verified via GET /me/identity-key has been removed. uploadIdentity() now
// always throws on a non-ok response.
//
// Tests createIdentity() end-to-end with a mocked fetch that returns 409.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const TEST_ROOT = new URL('../', import.meta.url).href;
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

// Mock credentials.js: exports used by createIdentity and credential-migration.js.
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

// Mock account-kdf.js: fetchOwnKdfParams returns scheme 1 (legacy, no salt needed).
mock.module(new URL('./js/crypto/account-kdf.js', PUBLIC).href, {
    namedExports: {
        fetchOwnKdfParams: async () => ({ scheme: 1 }),
        pinScheme2: () => {},
    },
});

// Mock identity.js: createEncryptedIdentity returns a minimal identity object.
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

// Mock core/server.js: resolveServerUrl passes URLs through.
mock.module(new URL('./js/core/server.js', PUBLIC).href, {
    namedExports: {
        resolveServerUrl: (url) => url,
    },
});

const identityService = await import(new URL('./js/crypto/identity-service.js', PUBLIC).href);
const { createIdentity } = identityService;

const TOKEN = 'test-token-' + crypto.randomUUID();

test('createIdentity throws on 409 Identity key already exists', async () => {
    mockFetch(async (url, opts) => {
        // The PUT to /me/identity-key returns 409
        if (opts.method === 'PUT' && String(url).includes('identity-key')) {
            return new Response(
                JSON.stringify({ error: 'Identity key already exists' }),
                { status: 409, headers: { 'content-type': 'application/json' } }
            );
        }
        return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });

    await assert.rejects(
        createIdentity('test-password-12345', TOKEN),
        /Identity key already exists/
    );
});

test('createIdentity throws on generic error response', async () => {
    mockFetch(async (url, opts) => {
        if (opts.method === 'PUT' && String(url).includes('identity-key')) {
            return new Response(
                JSON.stringify({ error: 'Some other error' }),
                { status: 500, headers: { 'content-type': 'application/json' } }
            );
        }
        return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });

    await assert.rejects(
        createIdentity('test-password-12345', TOKEN),
        /Some other error/
    );
});
