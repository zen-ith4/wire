import { api } from '../../core/api.js';


/* =========================================================
 * Fetch peer public key
 * ========================================================= */

/**
 * The peer's current identity public key, base64, exactly as the server
 * returned it.
 *
 * This is the server's word and nothing more: nothing may derive from it until
 * keys/peer-key-gate.js has compared these exact bytes with the pin. There is
 * deliberately no helper here that fetches AND imports. That shape is what let
 * the DM paths encrypt to, and decrypt with, a key no check had ever seen, because
 * the check had fetched its own copy.
 *
 * @param {number|string} userId
 * @returns {Promise<string>}
 */
export async function getPeerPublicKeyBase64(
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


    return data.publicKey;
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
 * Like getPeerPublicKeyBase64() this is the server's word: `current` here is not
 * checked against anything and must never be used as a key. Callers take `history`
 * and filter it through the pin (mayTryRetiredKey, pinOnFirstUse).
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
 * Reads the same /api/me/identity-key/:id response getPeerPublicKeyBase64() uses,
 * and adds one additive field. A missing, invalid or absent field is treated as 1,
 * so a peer that predates the column behaves exactly as an unupgraded peer.
 *
 * This is a separate fetch and it is NOT cached, so a fresh value is read on every
 * send. An opt-in performed on the server is therefore visible on the next send
 * without a server-side change; a browser that needs an existing conversation to
 * move over reloads instead.
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