// public/js/crypto/groups/aead.js
//
// A generic, key-agnostic AES-GCM envelope over raw bytes. The DM
// system's messages/encrypt.js + decrypt.js do the same thing but
// hardcode "plaintext is a UTF-8 string" (TextEncoder/TextDecoder) —
// everything here needs to encrypt raw bytes instead (a Sender
// Key's 32 key bytes for KDMs; UTF-8-encoded group message text for
// message-crypto.js, but produced by the caller so this module never
// assumes a string). Kept separate from messages/* rather than
// generalizing it, since messages/* is DM production code this task
// was told to extend, not rewrite.

import { bytesToBase64, base64ToBytes } from './codec.js';

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;

/**
 * @param {CryptoKey} key AES-GCM key (encrypt usage)
 * @param {Uint8Array} plaintextBytes
 * @param {Uint8Array} [iv] 12-byte nonce. Random by default — pass
 *   an explicit counter-derived IV for anything where nonce
 *   uniqueness can't rely on randomness alone (see
 *   groups/message-crypto.js and its use of groups/nonce-lock.js).
 * @returns {Promise<{iv: string, ciphertext: string}>} base64
 */
export async function encryptBytes(key, plaintextBytes, iv) {
    if (!(key instanceof CryptoKey)) {
        throw new Error('Invalid AES-GCM key');
    }

    if (!(plaintextBytes instanceof Uint8Array)) {
        throw new Error('Plaintext must be a Uint8Array');
    }

    const nonce = iv || crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    if (nonce.length !== IV_LENGTH) {
        throw new Error('Invalid AES-GCM IV length');
    }

    const ciphertext = await crypto.subtle.encrypt(
        { name: ALGORITHM, iv: nonce },
        key,
        plaintextBytes
    );

    return {
        iv: bytesToBase64(nonce),
        ciphertext: bytesToBase64(ciphertext),
    };
}

/**
 * @param {CryptoKey} key AES-GCM key (decrypt usage)
 * @param {{iv: string, ciphertext: string}} envelope base64
 * @returns {Promise<Uint8Array>}
 */
export async function decryptBytes(key, envelope) {
    if (!(key instanceof CryptoKey)) {
        throw new Error('Invalid AES-GCM key');
    }

    if (!envelope || typeof envelope !== 'object') {
        throw new Error('Invalid AEAD envelope');
    }

    const iv = base64ToBytes(envelope.iv);

    if (iv.length !== IV_LENGTH) {
        throw new Error('Invalid AES-GCM IV length');
    }

    const ciphertext = base64ToBytes(envelope.ciphertext);

    if (!ciphertext.length) {
        throw new Error('Empty ciphertext');
    }

    let plaintext;

    try {
        plaintext = await crypto.subtle.decrypt(
            { name: ALGORITHM, iv },
            key,
            ciphertext
        );
    } catch {
        throw new Error('Message authentication failed');
    }

    return new Uint8Array(plaintext);
}
