// B4: createIdentity must zero the real exported PKCS8 buffer, not just a
// copy. `new Uint8Array(buf).fill(0)` only zeroes a copy when buf is already
// a Uint8Array, so the buffer must be zeroed in place. After createIdentity,
// the private key is non-extractable and the original PKCS8 buffer is all zeros.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const PUBLIC = new URL('../public/', import.meta.url).href;

/* ---------------------------------------------------------------- fetch mock */
const realFetch = globalThis.fetch;

function mockFetch(impl) {
    globalThis.fetch = impl;
}

/* ---------------------------------------------------------------- exportKey spy */
// Intercepts crypto.subtle.exportKey and hands back a fresh Uint8Array for
// every pkcs8 export, so the test can observe whether createIdentity zeroes
// the real buffer rather than a copy.
const exportedPkcs8 = [];
const realExportKey = crypto.subtle.exportKey.bind(crypto.subtle);

function spyExportKey() {
    crypto.subtle.exportKey = async (format, key) => {
        const buf = await realExportKey(format, key);
        if (format === 'pkcs8') {
            const copy = new Uint8Array(buf);
            exportedPkcs8.push(copy);
            return copy;
        }
        return buf;
    };
}

afterEach(() => {
    globalThis.fetch = realFetch;
    crypto.subtle.exportKey = realExportKey;
    exportedPkcs8.length = 0;
    lockIdentity();
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
const { createIdentity, getCurrentIdentity, lockIdentity } = identityService;

const TOKEN = 'test-token-' + crypto.randomUUID();

test('createIdentity zeros the real PKCS8 buffer and keeps the private key non-extractable', async () => {
    spyExportKey();
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

    // The PKCS8 buffer that createIdentity exported and re-imported must have
    // been zeroed in place (not just a copy).
    assert.ok(exportedPkcs8.length >= 1, 'a pkcs8 buffer was exported');
    const last = exportedPkcs8[exportedPkcs8.length - 1];
    assert.ok(
        [...last].every((b) => b === 0),
        'the exported PKCS8 buffer was zeroed in place'
    );
});
