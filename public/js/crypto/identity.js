const KEY_ALGORITHM = {
    name: "X25519",
};

const PRIVATE_KEY_ALGORITHM = {
    name: "X25519",
};

import {
    deriveCredentials,
    KDF_ITERATIONS as V2_KDF_ITERATIONS,
    KDF_NAME as V2_KDF_NAME,
    IDENTITY_VERSION as V2_IDENTITY_VERSION
} from "./credentials.js";

const KDF_NAME = "PBKDF2-SHA-256";
const KDF_HASH = "SHA-256";
const KDF_ITERATIONS = 600000;
const AES_KEY_LENGTH = 256;
const AES_IV_LENGTH = 12;
const SALT_LENGTH = 16;
const IDENTITY_VERSION = 1;


function ensureWebCrypto() {
    if (!globalThis.crypto?.subtle) {
        throw new Error("Web Crypto API is not available");
    }
}


function validatePassword(password) {
    if (
        typeof password !== "string" ||
        password.length === 0
    ) {
        throw new Error("Password is required");
    }
}


function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);

    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}


function base64ToArrayBuffer(base64) {
    if (
        typeof base64 !== "string" ||
        !base64
    ) {
        throw new Error("Invalid Base64 data");
    }

    let binary;

    try {
        binary = atob(base64);
    } catch {
        throw new Error("Invalid Base64 data");
    }

    const bytes =
        new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes.buffer;
}


export async function generateIdentityKeyPair() {
    ensureWebCrypto();

    return crypto.subtle.generateKey(
        KEY_ALGORITHM,
        true,
        ["deriveBits"]
    );
}


export async function exportPublicKey(keyPair) {
    ensureWebCrypto();

    if (!keyPair?.publicKey) {
        throw new Error("Invalid identity key pair");
    }

    const raw =
        await crypto.subtle.exportKey(
            "raw",
            keyPair.publicKey
        );

    const bytes =
        new Uint8Array(raw);

    if (bytes.length !== 32) {
        throw new Error(
            "Invalid X25519 public key"
        );
    }

    return arrayBufferToBase64(raw);
}


export async function exportPrivateKey(keyPair) {
    ensureWebCrypto();

    if (!keyPair?.privateKey) {
        throw new Error(
            "Invalid identity key pair"
        );
    }

    return crypto.subtle.exportKey(
        "pkcs8",
        keyPair.privateKey
    );
}


export async function importPrivateKey(pkcs8) {
    ensureWebCrypto();

    if (!(pkcs8 instanceof ArrayBuffer)) {
        throw new Error(
            "Invalid PKCS#8 private key"
        );
    }

    return crypto.subtle.importKey(
        "pkcs8",
        pkcs8,
        PRIVATE_KEY_ALGORITHM,
        false,
        ["deriveBits"]
    );
}


/*
 * Runs the PBKDF2 step and returns the raw derived bits.
 *
 * This is the one piece of the KDF pipeline that needs to be
 * reachable on its own: `deriveIdentityUnlockKey` (below) exposes
 * these same raw bytes so the Electron shell can cache them for
 * auto-unlock. `deriveEncryptionKey` (also below) wraps this and
 * immediately imports the result as a non-extractable AES-GCM key
 * for normal encrypt/decrypt use - identical to what `deriveKey`
 * produced directly before this change. No parameter, iteration
 * count, hash, or output length differs from before.
 */
async function derivePasswordKeyMaterial(
    password,
    salt,
    iterations
) {
    ensureWebCrypto();
    validatePassword(password);

    if (!(salt instanceof Uint8Array)) {
        throw new Error("Invalid salt");
    }

    if (
        !Number.isInteger(iterations) ||
        iterations < 100000
    ) {
        throw new Error(
            "Invalid PBKDF2 iterations"
        );
    }

    const encoder =
        new TextEncoder();

    const passwordKey =
        await crypto.subtle.importKey(
            "raw",
            encoder.encode(password),
            {
                name: "PBKDF2"
            },
            false,
            ["deriveBits"]
        );

    return crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt,
            iterations,
            hash: KDF_HASH
        },
        passwordKey,
        AES_KEY_LENGTH
    );
}


async function importAesGcmKey(
    rawKeyBits,
    extractable
) {
    ensureWebCrypto();

    return crypto.subtle.importKey(
        "raw",
        rawKeyBits,
        {
            name: "AES-GCM",
            length: AES_KEY_LENGTH
        },
        extractable,
        [
            "encrypt",
            "decrypt"
        ]
    );
}


async function deriveEncryptionKey(
    password,
    salt,
    iterations = KDF_ITERATIONS
) {
    const rawKeyBits =
        await derivePasswordKeyMaterial(
            password,
            salt,
            iterations
        );

    // Same result as the old direct deriveKey() call: a
    // non-extractable AES-GCM key, usable only for encrypt/decrypt.
    return importAesGcmKey(
        rawKeyBits,
        false
    );
}


/*
 * F12 (scheme 2) wrapper: the identity is encrypted with the wrapKey that the
 * password derives together with the authKey (credentials.js). The salt and
 * iteration count are the ACCOUNT's (the server enforces that they match
 * users.kdf_salt), so any device re-derives the same wrapKey from the password.
 * The wrapKey is never sent anywhere; the authKey cannot be turned into it.
 */
async function deriveWrapKey(password, saltB64, iterations) {
    validatePassword(password);

    const { wrapKeyBytes } =
        await deriveCredentials(password, saltB64, iterations);

    try {
        return await importAesGcmKey(wrapKeyBytes, false);
    } finally {
        wrapKeyBytes.fill(0);
    }
}


/*
 * Wrap an already-exported PKCS#8 buffer (v2). The password-change and
 * migration paths use this so the identity never has to be imported as an
 * extractable CryptoKey.
 */
export async function encryptIdentityPkcs8(
    privateKeyBytes,
    password,
    kdf
) {
    ensureWebCrypto();
    validatePassword(password);

    if (
        !kdf ||
        typeof kdf.salt !== "string" ||
        !Number.isInteger(kdf.iterations)
    ) {
        throw new Error(
            "Account KDF parameters are required"
        );
    }

    const iv =
        crypto.getRandomValues(
            new Uint8Array(AES_IV_LENGTH)
        );

    const encryptionKey =
        await deriveWrapKey(
            password,
            kdf.salt,
            kdf.iterations
        );

    const encrypted =
        await crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv
            },
            encryptionKey,
            privateKeyBytes
        );

    return {
        encryptedPrivateKey:
            arrayBufferToBase64(encrypted),

        salt:
            kdf.salt,

        iv:
            arrayBufferToBase64(iv),

        kdf:
            V2_KDF_NAME,

        kdfParams: {
            iterations:
                kdf.iterations,

            hash:
                KDF_HASH
        },

        version:
            V2_IDENTITY_VERSION
    };
}


// kdf = { salt, iterations } of the account -> v2 wrapper (scheme 2).
// kdf omitted -> the legacy v1 wrapper (only reachable for unmigrated accounts).
export async function encryptIdentityPrivateKey(
    privateKey,
    password,
    kdf = null
) {
    ensureWebCrypto();
    validatePassword(password);

    if (!privateKey) {
        throw new Error(
            "Private key is required"
        );
    }

    const privateKeyBytes =
        await crypto.subtle.exportKey(
            "pkcs8",
            privateKey
        );

    if (kdf) {
        try {
            return await encryptIdentityPkcs8(
                privateKeyBytes,
                password,
                kdf
            );
        } finally {
            new Uint8Array(privateKeyBytes).fill(0);
        }
    }

    const salt =
        crypto.getRandomValues(
            new Uint8Array(SALT_LENGTH)
        );

    const iv =
        crypto.getRandomValues(
            new Uint8Array(AES_IV_LENGTH)
        );

    const encryptionKey =
        await deriveEncryptionKey(
            password,
            salt,
            KDF_ITERATIONS
        );

    const encrypted =
        await crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv
            },
            encryptionKey,
            privateKeyBytes
        );

    return {
        encryptedPrivateKey:
            arrayBufferToBase64(encrypted),

        salt:
            arrayBufferToBase64(salt),

        iv:
            arrayBufferToBase64(iv),

        kdf:
            KDF_NAME,

        kdfParams: {
            iterations:
                KDF_ITERATIONS,

            hash:
                KDF_HASH
        },

        version:
            IDENTITY_VERSION
    };
}


/*
 * Decrypts to the raw PKCS#8 bytes (caller must zero them). Handles both
 * wrappers: v1 (PBKDF2(password, identity salt) -> AES-GCM) and v2 (account
 * salt, PBKDF2+HKDF wrapKey).
 */
export async function decryptIdentityPkcs8(
    encryptedPrivateKey,
    password,
    salt,
    iv,
    kdfParams,
    version = 1
) {
    ensureWebCrypto();
    validatePassword(password);

    if (
        typeof encryptedPrivateKey !== "string" ||
        typeof salt !== "string" ||
        typeof iv !== "string"
    ) {
        throw new Error(
            "Invalid encrypted identity data"
        );
    }

    const params =
        kdfParams &&
        typeof kdfParams === "object"
            ? kdfParams
            : {};

    const iterations =
        params.iterations;

    const hash =
        params.hash;

    const isV2 =
        version === V2_IDENTITY_VERSION;

    if (
        !Number.isInteger(iterations) ||
        iterations < (isV2 ? V2_KDF_ITERATIONS : 100000)
    ) {
        throw new Error(
            "Invalid PBKDF2 iterations"
        );
    }

    if (hash !== KDF_HASH) {
        throw new Error(
            "Unsupported KDF hash"
        );
    }

    const ivBytes =
        new Uint8Array(
            base64ToArrayBuffer(iv)
        );

    const encryptedBytes =
        base64ToArrayBuffer(
            encryptedPrivateKey
        );

    if (
        ivBytes.length !== AES_IV_LENGTH
    ) {
        throw new Error(
            "Invalid IV length"
        );
    }

    let encryptionKey;

    if (isV2) {
        encryptionKey =
            await deriveWrapKey(
                password,
                salt,
                iterations
            );
    } else {
        const saltBytes =
            new Uint8Array(
                base64ToArrayBuffer(salt)
            );

        if (
            saltBytes.length !== SALT_LENGTH
        ) {
            throw new Error(
                "Invalid salt length"
            );
        }

        encryptionKey =
            await deriveEncryptionKey(
                password,
                saltBytes,
                iterations
            );
    }

    try {
        return await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: ivBytes
            },
            encryptionKey,
            encryptedBytes
        );
    } catch {
        throw new Error(
            "Unable to decrypt identity key"
        );
    }
}


export async function decryptIdentityPrivateKey(
    encryptedPrivateKey,
    password,
    salt,
    iv,
    kdfParams,
    version = 1
) {
    const decrypted =
        await decryptIdentityPkcs8(
            encryptedPrivateKey,
            password,
            salt,
            iv,
            kdfParams,
            version
        );

    try {
        return await importPrivateKey(
            decrypted
        );
    } finally {
        new Uint8Array(decrypted).fill(0);
    }
}


export async function createEncryptedIdentity(
    password,
    kdf = null
) {
    validatePassword(password);

    const keyPair =
        await generateIdentityKeyPair();

    const publicKey =
        await exportPublicKey(
            keyPair
        );

    const encrypted =
        await encryptIdentityPrivateKey(
            keyPair.privateKey,
            password,
            kdf
        );

    return {
        keyPair,
        publicKey,
        ...encrypted
    };
}


// (version, kdf) must be exactly one of the two known pairs.
export function assertKnownIdentityFormat(identity) {
    const v1 =
        identity?.version === IDENTITY_VERSION &&
        identity?.kdf === KDF_NAME;

    const v2 =
        identity?.version === V2_IDENTITY_VERSION &&
        identity?.kdf === V2_KDF_NAME;

    if (!v1 && !v2) {
        throw new Error(
            "Unsupported identity version or KDF"
        );
    }
}


export async function restoreIdentityFromServer(
    identity,
    password
) {
    if (
        !identity ||
        identity.exists !== true
    ) {
        throw new Error(
            "Identity key does not exist"
        );
    }

    assertKnownIdentityFormat(identity);

    const privateKey =
        await decryptIdentityPrivateKey(
            identity.encryptedPrivateKey,
            password,
            identity.salt,
            identity.iv,
            identity.kdfParams,
            identity.version
        );

    return {
        privateKey,
        publicKey:
            identity.publicKey
    };
}


/*
 * =========================================================
 * Auto-unlock support (Electron)
 * =========================================================
 *
 * These two functions exist ONLY to let the Electron shell cache
 * the minimum secret needed to re-unlock the identity on the next
 * launch without asking for the password again. Neither one
 * touches the KDF parameters, the ciphertext format, or the
 * account password:
 *
 * - deriveIdentityUnlockKey() runs the exact same PBKDF2 step as
 *   deriveEncryptionKey() above and returns the raw derived AES
 *   key bytes (base64) - never the password, never the private
 *   key. It is meaningless without the corresponding
 *   encryptedPrivateKey/iv, which stay server-side.
 *
 * - decryptIdentityPrivateKeyWithDerivedKey() is the mirror of
 *   decryptIdentityPrivateKey(), except it takes an already-
 *   derived key instead of a password, so it can skip PBKDF2
 *   entirely on a cache hit.
 */

export async function deriveIdentityUnlockKey(
    password,
    salt,
    kdfParams,
    version = 1
) {
    ensureWebCrypto();
    validatePassword(password);

    if (typeof salt !== "string") {
        throw new Error("Invalid salt");
    }

    if (version === V2_IDENTITY_VERSION) {
        // v2: the cached secret is the wrapKey (never the password, never the
        // authKey). The floor on the iteration count is enforced by
        // deriveCredentials().
        const { wrapKeyBytes } =
            await deriveCredentials(
                password,
                salt,
                kdfParams?.iterations
            );

        try {
            return arrayBufferToBase64(wrapKeyBytes);
        } finally {
            wrapKeyBytes.fill(0);
        }
    }

    const params =
        kdfParams &&
        typeof kdfParams === "object"
            ? kdfParams
            : {};

    const iterations =
        params.iterations;

    const hash =
        params.hash;

    if (
        !Number.isInteger(iterations) ||
        iterations < 100000
    ) {
        throw new Error(
            "Invalid PBKDF2 iterations"
        );
    }

    if (hash !== KDF_HASH) {
        throw new Error(
            "Unsupported KDF hash"
        );
    }

    const saltBytes =
        new Uint8Array(
            base64ToArrayBuffer(salt)
        );

    if (saltBytes.length !== SALT_LENGTH) {
        throw new Error(
            "Invalid salt length"
        );
    }

    const rawKeyBits =
        await derivePasswordKeyMaterial(
            password,
            saltBytes,
            iterations
        );

    return arrayBufferToBase64(rawKeyBits);
}


export async function decryptIdentityPrivateKeyWithDerivedKey(
    encryptedPrivateKey,
    derivedKeyBase64,
    iv
) {
    ensureWebCrypto();

    if (
        typeof encryptedPrivateKey !== "string" ||
        typeof derivedKeyBase64 !== "string" ||
        typeof iv !== "string"
    ) {
        throw new Error(
            "Invalid encrypted identity data"
        );
    }

    const ivBytes =
        new Uint8Array(
            base64ToArrayBuffer(iv)
        );

    if (ivBytes.length !== AES_IV_LENGTH) {
        throw new Error(
            "Invalid IV length"
        );
    }

    const rawKeyBits =
        base64ToArrayBuffer(
            derivedKeyBase64
        );

    const encryptedBytes =
        base64ToArrayBuffer(
            encryptedPrivateKey
        );

    const encryptionKey =
        await importAesGcmKey(
            rawKeyBits,
            false
        );

    let decrypted;

    try {
        decrypted =
            await crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: ivBytes
                },
                encryptionKey,
                encryptedBytes
            );
    } catch {
        // Wrong/stale derived key, tampered ciphertext, or a
        // ciphertext produced under a different salt/password
        // (e.g. the password was changed elsewhere since this
        // key was cached) - AES-GCM's auth tag check fails
        // exactly the same way decryptIdentityPrivateKey() does
        // on a wrong password. Callers treat this identically:
        // fall back to prompting for the password.
        throw new Error(
            "Unable to decrypt identity key"
        );
    }

    return importPrivateKey(
        decrypted
    );
}


export {
    arrayBufferToBase64,
    base64ToArrayBuffer
};