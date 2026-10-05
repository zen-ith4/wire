const KEY_ALGORITHM = {
    name: "X25519",
};

const PRIVATE_KEY_ALGORITHM = {
    name: "X25519",
};

import {
    deriveCredentials,
    KDF_ITERATIONS,
    KDF_NAME,
    IDENTITY_VERSION
} from "./credentials.js";

const KDF_HASH = "SHA-256";
const AES_KEY_LENGTH = 256;
const AES_IV_LENGTH = 12;


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
 * Key schedule of the identity wrap (F12): see credentials.js. The password is
 * stretched with PBKDF2 and split by HKDF into authKey (sent to the server as a
 * login credential) and wrapKey (this file's AES-GCM key, never sent anywhere).
 * `deriveIdentityUnlockKey` (below) exposes the raw wrapKey bytes so the
 * Electron shell can cache them for auto-unlock; `deriveWrapKey` imports the
 * same bytes as a non-extractable AES-GCM key for normal use.
 */
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


/*
 * F12: the identity private key is encrypted with the wrapKey that the
 * password derives (credentials.js), NOT with a key the server could ever
 * reconstruct from anything it receives. The salt/iterations are the ACCOUNT's
 * (the server enforces that they match users.kdf_salt), so any device can
 * re-derive the same wrapKey from the password alone.
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


export async function encryptIdentityPrivateKey(
    privateKey,
    password,
    kdf
) {
    ensureWebCrypto();

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


/*
 * Same, for an already-exported PKCS#8 buffer. Used by the password-change
 * path, which re-wraps the identity WITHOUT importing it as a CryptoKey (the
 * restored identity key is non-extractable on purpose).
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
            KDF_NAME,

        kdfParams: {
            iterations:
                kdf.iterations,

            hash:
                KDF_HASH
        },

        version:
            IDENTITY_VERSION
    };
}


function readKdfParams(kdfParams) {
    const iterations = kdfParams?.iterations;

    if (
        !Number.isInteger(iterations) ||
        iterations < KDF_ITERATIONS
    ) {
        throw new Error(
            "Invalid PBKDF2 iterations"
        );
    }

    if (kdfParams?.hash !== KDF_HASH) {
        throw new Error(
            "Unsupported KDF hash"
        );
    }

    return iterations;
}


export async function decryptIdentityPrivateKey(
    encryptedPrivateKey,
    password,
    salt,
    iv,
    kdfParams
) {
    const decrypted =
        await decryptIdentityPkcs8(
            encryptedPrivateKey,
            password,
            salt,
            iv,
            kdfParams
        );

    try {
        return await importPrivateKey(
            decrypted
        );
    } finally {
        new Uint8Array(decrypted).fill(0);
    }
}


/** Decrypts to the raw PKCS#8 bytes (caller must zero them). */
export async function decryptIdentityPkcs8(
    encryptedPrivateKey,
    password,
    salt,
    iv,
    kdfParams
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

    const iterations =
        readKdfParams(kdfParams);

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

    const encryptionKey =
        await deriveWrapKey(
            password,
            salt,
            iterations
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
        throw new Error(
            "Unable to decrypt identity key"
        );
    }

    return decrypted;
}


export async function createEncryptedIdentity(
    password,
    kdf
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

    if (
        identity.version !== IDENTITY_VERSION
    ) {
        throw new Error(
            "Unsupported identity version"
        );
    }

    if (
        identity.kdf !== KDF_NAME
    ) {
        throw new Error(
            "Unsupported identity KDF"
        );
    }

    const privateKey =
        await decryptIdentityPrivateKey(
            identity.encryptedPrivateKey,
            password,
            identity.salt,
            identity.iv,
            identity.kdfParams
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
 * - deriveIdentityUnlockKey() runs the same derivation as
 *   deriveWrapKey() above and returns the raw wrapKey bytes
 *   (base64) - never the password, never the private key, never
 *   the authKey. It is meaningless without the corresponding
 *   encryptedPrivateKey/iv, which are stored server-side. Anyone who
 *   holds it can decrypt the identity: it must stay on this device.
 *
 * - decryptIdentityPrivateKeyWithDerivedKey() is the mirror of
 *   decryptIdentityPrivateKey(), except it takes an already-
 *   derived key instead of a password, so it can skip PBKDF2
 *   entirely on a cache hit.
 */

export async function deriveIdentityUnlockKey(
    password,
    salt,
    kdfParams
) {
    ensureWebCrypto();
    validatePassword(password);

    if (typeof salt !== "string") {
        throw new Error("Invalid salt");
    }

    const iterations =
        readKdfParams(kdfParams);

    const { wrapKeyBytes } =
        await deriveCredentials(
            password,
            salt,
            iterations
        );

    try {
        return arrayBufferToBase64(wrapKeyBytes);
    } finally {
        wrapKeyBytes.fill(0);
    }
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