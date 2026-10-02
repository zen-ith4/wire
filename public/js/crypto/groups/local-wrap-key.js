// public/js/crypto/groups/local-wrap-key.js
//
// plan_prompt.md 2.3: "Persist Sender Keys to IndexedDB only in
// wrapped/encrypted form ... reuse that mechanism [the identity
// private key's at-rest protection]". The identity private key is
// wrapped with a *password*-derived key (identity.js), but we don't
// keep the password in memory after unlock (identity-service.js
// only retains the unlocked CryptoKey) — re-deriving that exact key
// later would mean re-prompting for the password on every Sender
// Key write, which defeats the point of Sender Keys being generated
// transparently.
//
// Instead this derives a *local-only* wrapping key the same way
// key-derivation.js derives a DM session key — X25519 ECDH + HKDF-
// SHA-256 — except against the user's own identity key pair instead
// of a peer's (privateKey combined with the matching public key is a
// valid, deterministic X25519 operation: it's still just "my private
// scalar times a public point on the curve", it just happens that
// both belong to me). That secret is derivable only by whoever holds
// the identity private key, and — because Wire's identity keys are
// password-portable across a user's devices, not device-bound (see
// plan_prompt.md 2.1) — every device that unlocks the same identity
// derives the exact same wrap key without any of them ever storing
// it.
//
// Cryptographic hygiene: this MUST NOT reuse the DM session key's
// HKDF info string. Two keys for two different purposes (message
// confidentiality vs. local-storage-at-rest wrapping) must never
// come from the same (secret, salt, info) triple, or a self-DM would
// derive the exact same key as this wrap key. Hence the distinct
// info string below and the parameterized
// deriveSessionKeyFromPeer()/deriveSharedSecret() in
// keys/key-derivation.js.

import {
    deriveSharedSecret,
} from '../keys/key-derivation.js';

const WRAP_KEY_INFO = new TextEncoder().encode(
    'Wire-E2EE-Group-SenderKeyWrap-v1'
);

const AES_KEY_LENGTH = 256;

let cachedWrapKey = null;
let cachedForPublicKey = null;

async function importOwnPublicKey(publicKeyBase64) {
    const binary = atob(publicKeyBase64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    if (bytes.length !== 32) {
        throw new Error('Invalid X25519 public key');
    }

    return crypto.subtle.importKey(
        'raw',
        bytes,
        { name: 'X25519' },
        false,
        []
    );
}

/**
 * @param {{privateKey: CryptoKey, publicKey: string}} identity the
 *   unlocked identity from identity-service.js's getCurrentIdentity()
 * @returns {Promise<CryptoKey>} non-extractable AES-GCM key
 */
export async function deriveLocalWrapKey(identity) {
    if (!identity?.privateKey || typeof identity?.publicKey !== 'string') {
        throw new Error('Identity is not unlocked');
    }

    // Cheap memo: re-deriving on every call is correct but wasteful
    // (an X25519 deriveBits + HKDF per message send). Safe to cache
    // for the lifetime of this unlock, since the inputs (private key
    // handle, own public key) don't change until lock/relock.
    if (cachedWrapKey && cachedForPublicKey === identity.publicKey) {
        return cachedWrapKey;
    }

    const ownPublicKey = await importOwnPublicKey(identity.publicKey);
    const sharedSecret = await deriveSharedSecret(identity.privateKey, ownPublicKey);

    let wrapKey;

    try {
        const hkdfKey = await crypto.subtle.importKey(
            'raw',
            sharedSecret,
            { name: 'HKDF' },
            false,
            ['deriveKey']
        );

        wrapKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: WRAP_KEY_INFO,
            },
            hkdfKey,
            { name: 'AES-GCM', length: AES_KEY_LENGTH },
            false,
            ['encrypt', 'decrypt']
        );
    } finally {
        new Uint8Array(sharedSecret).fill(0);
    }

    cachedWrapKey = wrapKey;
    cachedForPublicKey = identity.publicKey;

    return wrapKey;
}

/**
 * Called on identity lock (see identity-service.js's lockIdentity())
 * so a locked session doesn't keep a usable wrap key sitting in
 * memory.
 */
export function clearLocalWrapKeyCache() {
    cachedWrapKey = null;
    cachedForPublicKey = null;
}
