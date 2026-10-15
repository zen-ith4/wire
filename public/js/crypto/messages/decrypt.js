import {
    getOrCreateSessionKey,
    getSessionKeyCandidates,
    promoteSessionKeyCandidate
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
        plaintext =
            await decryptWithRetiredPeerKeys(
                encryptedMessage,
                peerUserId,
                iv,
                ciphertext
            );
    }

    return new TextDecoder(
        'utf-8',
        {
            fatal: true
        }
    ).decode(plaintext);
}


/**
 * Retry a failed decrypt against the peer's RETIRED identity keys.
 *
 * The reason this can happen at all: a peer who rotates their identity key keeps
 * the outgoing public key server-side, but only the newest one is served by
 * /api/me/identity-key/:userId. A message from before that rotation was sealed
 * to the old key, so the current session key cannot open it.
 *
 * The AES-GCM call below is the SAME call, with the SAME iv and the SAME
 * ciphertext, against a session key derived by the existing derivation from the
 * peer's old PUBLIC key. No AAD, no envelope version and no HKDF info change —
 * if any of those changed, messages already stored would stop decrypting.
 *
 * The current key is tried first, so the overwhelmingly common case costs one
 * extra AES-GCM attempt and no extra request: the key history is only fetched
 * after a failure.
 *
 * @throws the same 'Message authentication failed' as before when no key works,
 *   so a caller cannot tell "wrong key" from "no history" from "not authorized".
 */
async function decryptWithRetiredPeerKeys(
    encryptedMessage,
    peerUserId,
    iv,
    ciphertext
) {
    let candidates;

    try {
        candidates =
            await getSessionKeyCandidates(
                peerUserId
            );
    } catch {
        throw new Error('Message authentication failed');
    }

    for (const key of candidates) {
        let plaintext;

        try {
            plaintext =
                await crypto.subtle.decrypt(
                    {
                        name: ALGORITHM,
                        iv
                    },
                    key,
                    ciphertext
                );
        } catch {
            continue;
        }

        // Remember which key worked so the rest of this conversation does not
        // re-walk the same failures.
        promoteSessionKeyCandidate(peerUserId, key);

        return plaintext;
    }

    throw new Error('Message authentication failed');
}