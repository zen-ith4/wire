// public/js/crypto/credentials.js
//
// F12: the password never leaves the browser, and neither does anything the
// server could use to decrypt the identity key.
//
//   master  = PBKDF2-HMAC-SHA-256(password, accountSalt, 600,000 iterations)
//   authKey = HKDF-SHA-256(master, salt = 32 zero bytes, info = "Wire-Auth-v1")
//   wrapKey = HKDF-SHA-256(master, salt = 32 zero bytes, info = "Wire-Identity-Wrap-v1")
//
// Only `authKey` is sent to the server (login, registration, password change,
// "confirm your password" prompts). The server treats it like a password (bcrypt).
// `wrapKey` encrypts the identity private key and stays here. The two are
// outputs of HKDF under different labels, so knowing one reveals nothing about
// the other, and neither reveals `master` or the password.
//
// Pure module (no imports, no network) so it also runs under Node tests. The
// server-side twin for operator-supplied passwords is utils/credentials.js.

export const KDF_ITERATIONS = 600000;
export const KDF_SALT_BYTES = 16;
export const KDF_NAME = 'PBKDF2-SHA-256+HKDF-SHA-256';
export const IDENTITY_VERSION = 2;

const AUTH_INFO = new TextEncoder().encode('Wire-Auth-v1');
const WRAP_INFO = new TextEncoder().encode('Wire-Identity-Wrap-v1');

function b64ToBytes(b64) {
    if (typeof b64 !== 'string' || !b64) throw new Error('Invalid Base64 data');
    let bin;
    try { bin = atob(b64); } catch { throw new Error('Invalid Base64 data'); }
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

export function bytesToB64Url(bytes) {
    return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateKdfSalt() {
    return bytesToB64(crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES)));
}

/**
 * @param {string} password exactly as entered (UTF-8, no trimming/normalising)
 * @param {string} saltB64 the account's 16-byte salt
 * @param {number} iterations MUST be >= KDF_ITERATIONS. This is enforced HERE, on
 *   the client, no matter what the server says: a hostile server that answered
 *   "use 1 iteration" could otherwise harvest an authKey that is trivially
 *   brute-forceable back to the password.
 * @returns {Promise<{authKey: string, wrapKeyBytes: Uint8Array}>}
 *   authKey: 43 base64url chars. wrapKeyBytes: 32 bytes, caller must zero them.
 */
export async function deriveCredentials(password, saltB64, iterations = KDF_ITERATIONS) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('Password is required');
    }

    if (!Number.isInteger(iterations) || iterations < KDF_ITERATIONS) {
        throw new Error('Refusing a weaker KDF than the client minimum');
    }

    const salt = b64ToBytes(saltB64);

    if (salt.length !== KDF_SALT_BYTES) {
        throw new Error('Invalid KDF salt length');
    }

    const pwKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );

    const masterBits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        pwKey,
        256
    );

    const master = new Uint8Array(masterBits);

    try {
        const hkdf = await crypto.subtle.importKey('raw', master, { name: 'HKDF' }, false, ['deriveBits']);
        const zeroSalt = new Uint8Array(32);

        const authBits = await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: zeroSalt, info: AUTH_INFO }, hkdf, 256
        );
        const wrapBits = await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: zeroSalt, info: WRAP_INFO }, hkdf, 256
        );

        const authBytes = new Uint8Array(authBits);
        const authKey = bytesToB64Url(authBytes);
        authBytes.fill(0);

        return { authKey, wrapKeyBytes: new Uint8Array(wrapBits) };
    } finally {
        master.fill(0);
    }
}

/** Non-extractable AES-256-GCM key from wrapKey bytes. */
export function importWrapKey(wrapKeyBytes) {
    return crypto.subtle.importKey(
        'raw',
        wrapKeyBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}
