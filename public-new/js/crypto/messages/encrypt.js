import {
    getOrCreateSessionKey
} from '../keys/session.js';


const IV_LENGTH = 12;
const PROTOCOL_VERSION = 1;
const ALGORITHM = 'AES-GCM';


function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);

    let binary = '';

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}


/**
 * Encrypt a plaintext message for a peer.
 *
 * @param {string} plaintext
 * @param {number|string} peerUserId
 * @returns {Promise<object>}
 */
export async function encryptMessage(
    plaintext,
    peerUserId
) {
    if (
        typeof plaintext !== 'string'
    ) {
        throw new Error(
            'Message must be a string'
        );
    }

    if (!plaintext.length) {
        throw new Error(
            'Message cannot be empty'
        );
    }

    const sessionKey =
        await getOrCreateSessionKey(
            peerUserId
        );

    const iv =
        crypto.getRandomValues(
            new Uint8Array(IV_LENGTH)
        );

    const encoded =
        new TextEncoder().encode(
            plaintext
        );

    const ciphertext =
        await crypto.subtle.encrypt(
            {
                name: ALGORITHM,
                iv
            },
            sessionKey,
            encoded
        );

    return {
        version: PROTOCOL_VERSION,
        algorithm: ALGORITHM,
        iv: arrayBufferToBase64(iv),
        ciphertext: arrayBufferToBase64(
            ciphertext
        )
    };
}