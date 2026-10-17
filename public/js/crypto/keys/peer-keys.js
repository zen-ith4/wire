import { api } from '../../core/api.js';


const X25519_PUBLIC_KEY_LENGTH = 32;


/* =========================================================
 * Base64
 * ========================================================= */

function base64ToArrayBuffer(base64) {

    if (
        typeof base64 !== 'string' ||
        base64.length === 0
    ) {
        throw new Error(
            'Invalid public key'
        );
    }


    let binary;

    try {
        binary = atob(base64);
    } catch {
        throw new Error(
            'Invalid Base64 public key'
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


/* =========================================================
 * Import X25519 public key
 * ========================================================= */

async function importPeerPublicKey(publicKey) {

    const keyBytes =
        base64ToArrayBuffer(publicKey);


    if (
        keyBytes.length !==
        X25519_PUBLIC_KEY_LENGTH
    ) {
        throw new Error(
            'Invalid X25519 public key length'
        );
    }


    return crypto.subtle.importKey(
        'raw',
        keyBytes,
        {
            name: 'X25519'
        },
        false,
        []
    );
}


/* =========================================================
 * Fetch peer public key
 * ========================================================= */

export async function getPeerPublicKey(
    userId
) {

    if (
        !Number.isInteger(Number(userId)) ||
        Number(userId) <= 0
    ) {
        throw new Error(
            'Invalid user ID'
        );
    }


    const data = await api(
        `/api/me/identity-key/${Number(userId)}`,
        {
            method: 'GET'
        }
    );


    if (
        !data ||
        typeof data.publicKey !== 'string'
    ) {
        throw new Error(
            'Invalid identity public key response'
        );
    }


    return importPeerPublicKey(
        data.publicKey
    );
}


/* =========================================================
 * Retired keys (key archive)
 * ========================================================= */

/**
 * The peer's current and RETIRED X25519 public keys, as base64.
 *
 * Why this exists: when a peer rotates their identity key, the outgoing key is
 * preserved server-side (identity_key_rotations) but /api/me/identity-key/:id
 * serves only the newest one. Every message encrypted before that rotation used
 * the OLD key, so a client holding only the current one can no longer read them.
 *
 * This widens the CHOICE of key only. Nothing about how anything is encrypted or
 * decrypted changes: each candidate goes through the existing
 * deriveSessionKeyFromPeer with the existing 'Wire-E2EE-v1' info, and the caller
 * runs the identical AES-GCM decrypt against each in turn.
 *
 * Both keys come from the history endpoint rather than being exported locally.
 * crypto.subtle.importKey(..., extractable = false, ...) is how getPeerPublicKey
 * imports a peer key, so exporting it back to raw bytes is impossible —
 * SubtleCrypto throws "key is not extractable". The server already hands over the
 * base64 for both, so asking for it is both simpler and the only way that works.
 *
 * Any failure (no contact, rate limited, offline, peer has no key) resolves to an
 * empty history rather than throwing: the caller must still be able to try the
 * current key alone.
 *
 * @param {number} userId
 * @returns {Promise<{current: string, history: string[]}>} base64; `current` is ''
 *   when the history could not be read at all.
 */
export async function getPeerKeyCandidates(
    userId
) {
    if (
        !Number.isInteger(Number(userId)) ||
        Number(userId) <= 0
    ) {
        throw new Error(
            'Invalid user ID'
        );
    }

    let current = '';
    let history = [];

    try {
        const data =
            await api(
                `/api/me/identity-key-history/${Number(userId)}`
            );

        if (
            typeof data?.current?.publicKey === 'string'
        ) {
            current =
                data.current.publicKey;
        }

        if (
            Array.isArray(data?.history)
        ) {
            history =
                data.history
                    .map((entry) =>
                        typeof entry?.publicKey === 'string'
                            ? entry.publicKey
                            : null
                    )
                    .filter(Boolean);
        }
    } catch {
        current = '';
        history = [];
    }

    return {
        current,
        history
    };
}


function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * STEP 1B: the peer's server-side DM E2EE floor (users.dm_e2ee_min_version).
 *
 * Reads the same /api/me/identity-key/:id response getPeerPublicKey() uses, and
 * adds one additive field. A missing, invalid or absent field is treated as 1,
 * so a peer that predates the column behaves exactly as an unupgraded peer.
 *
 * This is a separate fetch rather than a change to getPeerPublicKey() - that
 * function must keep returning exactly what it returns now - and it is NOT
 * cached, so a fresh value is read on every send. An opt-in performed on the
 * server is therefore visible on the next send without a server-side change; a
 * browser that needs an existing conversation to move over reloads instead.
 *
 * @param {number|string} userId
 * @returns {Promise<number>} 1 or 2
 */
export async function getPeerDmMinVersion(userId) {
    if (
        !Number.isInteger(Number(userId)) ||
        Number(userId) <= 0
    ) {
        throw new Error(
            'Invalid user ID'
        );
    }

    const data = await api(
        `/api/me/identity-key/${Number(userId)}`,
        {
            method: 'GET'
        }
    );

    const raw = data ? data.dmE2eeMinVersion : null;
    if (!Number.isInteger(raw) || raw < 1) {
        return 1;
    }
    return raw > 2 ? 2 : raw;
}