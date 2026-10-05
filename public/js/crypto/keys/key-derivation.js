const X25519_DERIVE_BITS = 256;
const AES_KEY_LENGTH = 256;

const PROTOCOL_INFO = new TextEncoder().encode(
    'Wire-E2EE-v1'
);

// F2: KDM wrapping uses its OWN key (distinct HKDF info) so a DM ciphertext
// made with the 1:1 session key can never be accepted as a KDM, and vice versa.
export const GROUP_KDM_INFO = new TextEncoder().encode(
    'Wire-E2EE-Group-KDM-v2'
);


/**
 * Derive a raw X25519 shared secret.
 *
 * @param {CryptoKey} privateKey
 * @param {CryptoKey} peerPublicKey
 * @returns {Promise<ArrayBuffer>}
 */
export async function deriveSharedSecret(
    privateKey,
    peerPublicKey
) {
    if (!(privateKey instanceof CryptoKey)) {
        throw new Error(
            'Invalid identity private key'
        );
    }

    if (!(peerPublicKey instanceof CryptoKey)) {
        throw new Error(
            'Invalid peer public key'
        );
    }

    if (
        privateKey.algorithm?.name !== 'X25519'
    ) {
        throw new Error(
            'Identity key must be X25519'
        );
    }

    if (
        peerPublicKey.algorithm?.name !== 'X25519'
    ) {
        throw new Error(
            'Peer key must be X25519'
        );
    }

    return crypto.subtle.deriveBits(
        {
            name: 'X25519',
            public: peerPublicKey
        },
        privateKey,
        X25519_DERIVE_BITS
    );
}


/**
 * Convert the X25519 shared secret into
 * an AES-GCM session key using HKDF-SHA-256.
 *
 * @param {ArrayBuffer} sharedSecret
 * @param {Uint8Array} info HKDF info string (domain separation);
 *   defaults to the DM protocol's, so existing callers are unaffected.
 * @returns {Promise<CryptoKey>}
 */
async function deriveSessionKey(
    sharedSecret,
    info = PROTOCOL_INFO
) {
    if (
        !(sharedSecret instanceof ArrayBuffer) ||
        sharedSecret.byteLength !== 32
    ) {
        throw new Error(
            'Invalid shared secret'
        );
    }

    const hkdfKey =
        await crypto.subtle.importKey(
            'raw',
            sharedSecret,
            {
                name: 'HKDF'
            },
            false,
            ['deriveKey']
        );

    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(32),
            info
        },
        hkdfKey,
        {
            name: 'AES-GCM',
            length: AES_KEY_LENGTH
        },
        false,
        [
            'encrypt',
            'decrypt'
        ]
    );
}


/**
 * Derive a session key from
 * our identity private key and
 * the peer's public key.
 *
 * @param {CryptoKey} privateKey
 * @param {CryptoKey} peerPublicKey
 * @returns {Promise<CryptoKey>}
 */
export async function deriveSessionKeyFromPeer(
    privateKey,
    peerPublicKey,
    info
) {
    const sharedSecret =
        await deriveSharedSecret(
            privateKey,
            peerPublicKey
        );

    try {
        return await deriveSessionKey(
            sharedSecret,
            info
        );
    } finally {
        /*
         * Remove our JS reference to the
         * shared secret as soon as possible.
         */
        new Uint8Array(sharedSecret).fill(0);
    }
}