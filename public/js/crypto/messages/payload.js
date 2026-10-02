// public/js/crypto/messages/payload.js

const PROTOCOL_VERSION = 1;
const ALGORITHM = 'AES-GCM';

const MAX_CIPHERTEXT_LENGTH = 64 * 1024;
const MAX_IV_LENGTH = 12;


/* =========================================================
 * Validation
 * ========================================================= */

function requireString(value, name) {
    if (
        typeof value !== 'string' ||
        value.length === 0
    ) {
        throw new Error(
            `${name} is required`
        );
    }
}

function requirePositiveInteger(value, name) {
    if (
        !Number.isInteger(value) ||
        value <= 0
    ) {
        throw new Error(
            `Invalid ${name}`
        );
    }
}


/* =========================================================
 * Base64 validation
 * ========================================================= */

function validateBase64(value, name) {
    requireString(value, name);

    let binary;

    try {
        binary = atob(value);
    } catch {
        throw new Error(
            `Invalid Base64 ${name}`
        );
    }

    if (!binary.length) {
        throw new Error(
            `Empty Base64 ${name}`
        );
    }

    return binary.length;
}


/* =========================================================
 * Create encrypted message payload
 * ========================================================= */

export function createEncryptedMessagePayload(
    encryptedMessage,
    senderId,
    recipientId
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

    requirePositiveInteger(
        Number(senderId),
        'sender ID'
    );

    requirePositiveInteger(
        Number(recipientId),
        'recipient ID'
    );

    const ivLength =
        validateBase64(
            encryptedMessage.iv,
            'IV'
        );

    if (ivLength !== MAX_IV_LENGTH) {
        throw new Error(
            'Invalid AES-GCM IV'
        );
    }

    const ciphertextLength =
        validateBase64(
            encryptedMessage.ciphertext,
            'ciphertext'
        );

    if (
        ciphertextLength >
        MAX_CIPHERTEXT_LENGTH
    ) {
        throw new Error(
            'Ciphertext is too large'
        );
    }

    return {
        encryption: {
            version: PROTOCOL_VERSION,
            algorithm: ALGORITHM,
            iv: encryptedMessage.iv,
            ciphertext:
                encryptedMessage.ciphertext
        },

        senderId: Number(senderId),
        recipientId: Number(recipientId)
    };
}


/* =========================================================
 * Validate received encrypted payload
 * ========================================================= */

export function validateEncryptedMessagePayload(
    payload
) {
    if (
        !payload ||
        typeof payload !== 'object'
    ) {
        throw new Error(
            'Invalid encrypted message payload'
        );
    }

    if (
        !payload.encryption ||
        typeof payload.encryption !== 'object'
    ) {
        throw new Error(
            'Missing encryption payload'
        );
    }

    const encryption =
        payload.encryption;

    if (
        encryption.version !==
        PROTOCOL_VERSION
    ) {
        throw new Error(
            'Unsupported encryption version'
        );
    }

    if (
        encryption.algorithm !==
        ALGORITHM
    ) {
        throw new Error(
            'Unsupported encryption algorithm'
        );
    }

    const ivLength =
        validateBase64(
            encryption.iv,
            'IV'
        );

    if (ivLength !== MAX_IV_LENGTH) {
        throw new Error(
            'Invalid AES-GCM IV'
        );
    }

    const ciphertextLength =
        validateBase64(
            encryption.ciphertext,
            'ciphertext'
        );

    if (
        ciphertextLength >
        MAX_CIPHERTEXT_LENGTH
    ) {
        throw new Error(
            'Ciphertext is too large'
        );
    }

    return {
        version: encryption.version,
        algorithm: encryption.algorithm,
        iv: encryption.iv,
        ciphertext: encryption.ciphertext
    };
}