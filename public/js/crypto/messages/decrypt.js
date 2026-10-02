import {
    getOrCreateSessionKey
} from '../keys/session.js';


const IV_LENGTH = 12;
const PROTOCOL_VERSION = 1;
const ALGORITHM = 'AES-GCM';


function base64ToUint8Array(base64) {
    if (
        typeof base64 !== 'string' ||
        !base64.length
    ) {
        throw new Error(
            'Invalid Base64 data'
        );
    }

    let binary;

    try {
        binary = atob(base64);
    } catch {
        throw new Error(
            'Invalid Base64 data'
        );
    }

    const bytes =
        new Uint8Array(binary.length);

    for (
        let i = 0;
        i < binary.length;
        i++
    ) {
        bytes[i] =
            binary.charCodeAt(i);
    }

    return bytes;
}


/**
 * Decrypt an encrypted message.
 *
 * @param {object} encryptedMessage
 * @param {number|string} peerUserId
 * @returns {Promise<string>}
 */
export async function decryptMessage(
    encryptedMessage,
    peerUserId
) {
    if (
        !encryptedMessage ||
        typeof encryptedMessage !== 'object'
    ) {
        throw new Error(
            'Invalid encrypted message'
        );
    }

    if (
        encryptedMessage.version !==
        PROTOCOL_VERSION
    ) {
        throw new Error(
            'Unsupported encryption version'
        );
    }

    if (
        encryptedMessage.algorithm !==
        ALGORITHM
    ) {
        throw new Error(
            'Unsupported encryption algorithm'
        );
    }

    const iv =
        base64ToUint8Array(
            encryptedMessage.iv
        );

    if (
        iv.length !== IV_LENGTH
    ) {
        throw new Error(
            'Invalid AES-GCM IV length'
        );
    }

    const ciphertext =
        base64ToUint8Array(
            encryptedMessage.ciphertext
        );

    if (!ciphertext.length) {
        throw new Error(
            'Empty ciphertext'
        );
    }

    const sessionKey =
        await getOrCreateSessionKey(
            peerUserId
        );

    let plaintext;

    try {
        plaintext =
            await crypto.subtle.decrypt(
                {
                    name: ALGORITHM,
                    iv
                },
                sessionKey,
                ciphertext
            );
    } catch {
        throw new Error(
            'Message authentication failed'
        );
    }

    return new TextDecoder(
        'utf-8',
        {
            fatal: true
        }
    ).decode(plaintext);
}