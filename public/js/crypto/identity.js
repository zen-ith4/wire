// public/js/crypto/identity.js

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


/* =========================================================
 * Validation
 * ========================================================= */

function ensureWebCrypto() {
    if (!globalThis.crypto?.subtle) {
        throw new Error("Web Crypto API is not available");
    }
}

function validatePassphrase(passphrase) {
    if (
        typeof passphrase !== "string" ||
        passphrase.length === 0
    ) {
        throw new Error("Passphrase is required");
    }
}


/* =========================================================
 * Base64 helpers
 * ========================================================= */

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);

    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    if (typeof base64 !== "string" || !base64) {
        throw new Error("Invalid Base64 data");
    }

    let binary;

    try {
        binary = atob(base64);
    } catch {
        throw new Error("Invalid Base64 data");
    }

    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes.buffer;
}


/* =========================================================
 * Identity generation
 * ========================================================= */

export async function generateIdentityKeyPair() {
    ensureWebCrypto();

    return crypto.subtle.generateKey(
        KEY_ALGORITHM,
        true,
        ["deriveBits"]
    );
}


/* =========================================================
 * Public key
 * ========================================================= */

export async function exportPublicKey(keyPair) {
    ensureWebCrypto();

    if (!keyPair?.publicKey) {
        throw new Error("Invalid identity key pair");
    }

    const raw = await crypto.subtle.exportKey(
        "raw",
        keyPair.publicKey
    );

    const bytes = new Uint8Array(raw);

    if (bytes.length !== 32) {
        throw new Error("Invalid X25519 public key");
    }

    return arrayBufferToBase64(raw);
}


/* =========================================================
 * Private key export
 * ========================================================= */

export async function exportPrivateKey(keyPair) {
    ensureWebCrypto();

    if (!keyPair?.privateKey) {
        throw new Error("Invalid identity key pair");
    }

    return crypto.subtle.exportKey(
        "pkcs8",
        keyPair.privateKey
    );
}


/* =========================================================
 * Private key import
 * ========================================================= */

export async function importPrivateKey(pkcs8) {
    ensureWebCrypto();

    if (!(pkcs8 instanceof ArrayBuffer)) {
        throw new Error("Invalid PKCS#8 private key");
    }

    return crypto.subtle.importKey(
        "pkcs8",
        pkcs8,
        PRIVATE_KEY_ALGORITHM,
        true,
        ["deriveBits"]
    );
}


/* =========================================================
 * Key derivation
 * ========================================================= */

async function deriveEncryptionKey(
    passphrase,
    salt,
    iterations = KDF_ITERATIONS
) {
    ensureWebCrypto();
    validatePassphrase(passphrase);

    if (!(salt instanceof Uint8Array)) {
        throw new Error("Invalid salt");
    }

    if (
        !Number.isInteger(iterations) ||
        iterations < 100000
    ) {
        throw new Error("Invalid PBKDF2 iterations");
    }

    const encoder = new TextEncoder();

    const passphraseKey =
        await crypto.subtle.importKey(
            "raw",
            encoder.encode(passphrase),
            {
                name: "PBKDF2"
            },
            false,
            ["deriveKey"]
        );

    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations,
            hash: KDF_HASH
        },
        passphraseKey,
        {
            name: "AES-GCM",
            length: AES_KEY_LENGTH
        },
        false,
        ["encrypt", "decrypt"]
    );
}


/* =========================================================
 * Encrypt private key
 * ========================================================= */

export async function encryptIdentityPrivateKey(
    privateKey,
    passphrase
) {
    ensureWebCrypto();
    validatePassphrase(passphrase);

    if (!privateKey) {
        throw new Error("Private key is required");
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
            passphrase,
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

        kdf: KDF_NAME,

        kdfParams: {
            iterations: KDF_ITERATIONS,
            hash: KDF_HASH
        },

        version: IDENTITY_VERSION
    };
}


/* =========================================================
 * Decrypt private key
 * ========================================================= */

export async function decryptIdentityPrivateKey(
    encryptedPrivateKey,
    passphrase,
    salt,
    iv,
    kdfParams
) {
    ensureWebCrypto();
    validatePassphrase(passphrase);

    if (
        typeof encryptedPrivateKey !== "string" ||
        typeof salt !== "string" ||
        typeof iv !== "string"
    ) {
        throw new Error("Invalid encrypted identity data");
    }

    const params =
        kdfParams && typeof kdfParams === "object"
            ? kdfParams
            : {};

    const iterations =
        Number.isInteger(params.iterations)
            ? params.iterations
            : KDF_ITERATIONS;

    const hash =
        typeof params.hash === "string"
            ? params.hash
            : KDF_HASH;

    if (hash !== "SHA-256") {
        throw new Error("Unsupported KDF hash");
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

    if (saltBytes.length !== SALT_LENGTH) {
        throw new Error("Invalid salt length");
    }

    if (ivBytes.length !== AES_IV_LENGTH) {
        throw new Error("Invalid IV length");
    }

    const encryptionKey =
        await deriveEncryptionKey(
            passphrase,
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

    return importPrivateKey(decrypted);
}


/* =========================================================
 * Complete identity creation
 * ========================================================= */

export async function createEncryptedIdentity(
    passphrase
) {
    validatePassphrase(passphrase);

    const keyPair =
        await generateIdentityKeyPair();

    const publicKey =
        await exportPublicKey(keyPair);

    const encrypted =
        await encryptIdentityPrivateKey(
            keyPair.privateKey,
            passphrase
        );

    return {
        keyPair,
        publicKey,
        ...encrypted
    };
}


/* =========================================================
 * Restore identity from server data
 * ========================================================= */

export async function restoreIdentityFromServer(
    identity,
    passphrase
) {
    if (
        !identity ||
        identity.exists !== true
    ) {
        throw new Error(
            "Identity key does not exist"
        );
    }

    const privateKey =
        await decryptIdentityPrivateKey(
            identity.encryptedPrivateKey,
            passphrase,
            identity.salt,
            identity.iv,
            identity.kdfParams
        );

    return {
        privateKey,
        publicKey: identity.publicKey
    };
}


/* =========================================================
 * Export helpers
 * ========================================================= */

export {
    arrayBufferToBase64,
    base64ToArrayBuffer
};