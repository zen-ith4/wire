import {
    encryptMessage
} from './encrypt.js';

import {
    decryptMessage
} from './decrypt.js';

import {
    createEncryptedMessagePayload,
    validateEncryptedMessagePayload
} from './payload.js';


/* =========================================================
 * Encrypt outgoing message
 * ========================================================= */

export async function encryptOutgoingMessage(
    plaintext,
    senderId,
    recipientId
) {
    if (
        typeof plaintext !== 'string' ||
        !plaintext.length
    ) {
        throw new Error(
            'Message cannot be empty'
        );
    }

    if (
        !Number.isInteger(Number(senderId)) ||
        Number(senderId) <= 0
    ) {
        throw new Error(
            'Invalid sender ID'
        );
    }

    if (
        !Number.isInteger(Number(recipientId)) ||
        Number(recipientId) <= 0
    ) {
        throw new Error(
            'Invalid recipient ID'
        );
    }

    const encrypted =
        await encryptMessage(
            plaintext,
            Number(recipientId)
        );

    return createEncryptedMessagePayload(
        encrypted,
        Number(senderId),
        Number(recipientId)
    );
}


/* =========================================================
 * Decrypt incoming message
 * ========================================================= */

export async function decryptIncomingMessage(
    payload,
    peerUserId
) {
    const encrypted =
        validateEncryptedMessagePayload(
            payload
        );

    if (
        !Number.isInteger(Number(peerUserId)) ||
        Number(peerUserId) <= 0
    ) {
        throw new Error(
            'Invalid peer user ID'
        );
    }

    return decryptMessage(
        encrypted,
        Number(peerUserId)
    );
}