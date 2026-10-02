const KEY_ALGORITHM = {
    name: "X25519",
};

const PRIVATE_KEY_ALGORITHM = {
    name: "X25519",
};

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


export async function encryptIdentityPrivateKey(
    privateKey,
    password
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


export async function decryptIdentityPrivateKey(
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

    const ivBytes =
        new Uint8Array(
            base64ToArrayBuffer(iv)
        );

    const encryptedBytes =
        base64ToArrayBuffer(
            encryptedPrivateKey
        );

    if (
        saltBytes.length !== SALT_LENGTH
    ) {
        throw new Error(
            "Invalid salt length"
        );
    }

    if (
        ivBytes.length !== AES_IV_LENGTH
    ) {
        throw new Error(
            "Invalid IV length"
        );
    }

    const encryptionKey =
        await deriveEncryptionKey(
            password,
            saltBytes,
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

    return importPrivateKey(
        decrypted
    );
}


export async function createEncryptedIdentity(
    password
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
            password
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
    kdfParams
) {
    ensureWebCrypto();
    validatePassword(password);

    if (typeof salt !== "string") {
        throw new Error("Invalid salt");
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