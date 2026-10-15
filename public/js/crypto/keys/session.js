import {
    deriveSessionKeyFromPeer,
    GROUP_KDM_INFO
} from './key-derivation.js';

import {
    getPeerPublicKey,
    getPeerKeyCandidates
} from './peer-keys.js';

import {
    getCurrentIdentity
} from '../identity-service.js';


const sessionKeys = new Map();

// Group KDM wrap keys: same ECDH shared secret as the DM session, but a
// different HKDF info (key-derivation.js GROUP_KDM_INFO), cached separately.
const kdmKeys = new Map();
const pendingKdmKeys = new Map();

// Session keys derived from the peer's RETIRED identity keys, peer -> keys, most
// recently successful first. Populated lazily: nothing here is fetched until a
// decrypt has already failed with the current key, so the ordinary read path
// makes no extra request at all.
//
// The key derivation is exactly the one in createSessionKey() — same X25519, same
// HKDF, same 'Wire-E2EE-v1' info. Nothing about how a message is encrypted or
// decrypted changes; this only widens which of the peer's keys is tried.
const archivedSessionKeys = new Map();
const pendingArchivedKeys = new Map();

// In-flight createSessionKey() promises, keyed by peer user id.
//
// Without this, decrypt.js/encrypt.js each call
// getOrCreateSessionKey() independently for every message that needs
// (en/de)cryption. sessionKeys only gets populated *after* a fetch
// succeeds, so opening a DM thread with several messages from the
// same peer fires off that many identical, concurrent
// GET /api/me/identity-key/:userId requests before any of them has
// had a chance to resolve and populate the cache — three messages in
// means three parallel fetches for the exact same key (and three
// identical failures if the peer has no identity key yet, instead of
// one). Tracking the in-flight promise here means every caller that
// asks for the same peer's session key while a fetch is already
// running gets that same promise instead of starting a new one.
const pendingSessionKeys = new Map();


/* =========================================================
 * Validation
 * ========================================================= */

function normalizeUserId(userId) {
    const id = Number(userId);

    if (
        !Number.isInteger(id) ||
        id <= 0
    ) {
        throw new Error(
            'Invalid user ID'
        );
    }

    return id;
}


/* =========================================================
 * Get session
 * ========================================================= */

export function getSessionKey(userId) {
    const id =
        normalizeUserId(userId);

    return sessionKeys.get(id) || null;
}


/* =========================================================
 * Create session
 * ========================================================= */

export async function createSessionKey(userId) {
    const id =
        normalizeUserId(userId);

    const identity =
        getCurrentIdentity();

    if (
        !identity ||
        !identity.privateKey
    ) {
        throw new Error(
            'Identity is not unlocked'
        );
    }

    const peerPublicKey =
        await getPeerPublicKey(id);

    const sessionKey =
        await deriveSessionKeyFromPeer(
            identity.privateKey,
            peerPublicKey
        );

    sessionKeys.set(
        id,
        sessionKey
    );

    return sessionKey;
}


/* =========================================================
 * Get or create
 * ========================================================= */

export async function getOrCreateSessionKey(
    userId
) {
    const id =
        normalizeUserId(userId);

    const existing =
        getSessionKey(id);

    if (existing) {
        return existing;
    }

    // Join an already-running fetch for this peer instead of
    // starting a duplicate one (see pendingSessionKeys above).
    const pending =
        pendingSessionKeys.get(id);

    if (pending) {
        return pending;
    }

    const creation =
        createSessionKey(id)
            .finally(() => {
                pendingSessionKeys.delete(id);
            });

    pendingSessionKeys.set(
        id,
        creation
    );

    return creation;
}


/* =========================================================
 * Remove
 * ========================================================= */

export function removeSessionKey(userId) {
    const id =
        normalizeUserId(userId);

    sessionKeys.delete(id);
    pendingSessionKeys.delete(id);
    kdmKeys.delete(id);
    pendingKdmKeys.delete(id);
    archivedSessionKeys.delete(id);
    pendingArchivedKeys.delete(id);
}


/* =========================================================
 * Clear
 * ========================================================= */

export function clearSessionKeys() {
    sessionKeys.clear();
    pendingSessionKeys.clear();
    kdmKeys.clear();
    pendingKdmKeys.clear();
    archivedSessionKeys.clear();
    pendingArchivedKeys.clear();
}


/* =========================================================
 * Retired-key candidates (key archive)
 * =========================================================
 *
 * WHAT THIS IS NOT
 * It is not a second key hierarchy, not a new protocol version and not an
 * escrow. It derives ordinary session keys from the peer's OLD PUBLIC keys with
 * the existing derivation (deriveSessionKeyFromPeer, 'Wire-E2EE-v1'), and hands
 * them to the caller as a list to try in turn against the identical AES-GCM
 * decrypt that already exists.
 *
 * WHAT IT CANNOT DO — state this plainly, it is the limit of the whole design
 * It recovers history when the PEER rotated and you did not. That is the case
 * the archive is for: your own private key never changed, so DH(your_sk, their
 * old_pk) is still computable if you can find their old_pk.
 *
 * It CANNOT recover history when YOU rotated. Those messages were sealed to
 * DH(your_old_sk, their_pk), and your old private key is gone: keys/key-storage.js
 * keeps exactly ONE keypair under 'wire_identity_key' and saveIdentityKey()
 * overwrites it, and identity-service.js holds only the current identity in
 * memory. Retaining old private keys would be key escrow. That is out of scope
 * and deliberately not implemented here; until it exists, rotating your own key
 * makes your own pre-rotation history unreadable to you, and no client-side
 * change can fix that.
 */

/**
 * Every session key that might open a message from `userId`, most likely first.
 *
 * Call this ONLY after the current key has already failed. It fetches the peer's
 * key history once per peer (memoised, including concurrent callers), derives a
 * key per retired public key, and caches the result.
 *
 * @param {number} userId
 * @returns {Promise<CryptoKey[]>} at least the current key; never empty when the
 *   peer has an identity key, so a caller can always try something.
 */
export async function getSessionKeyCandidates(userId) {
    const id = normalizeUserId(userId);

    const current = await getOrCreateSessionKey(id);
    const candidates = [current];

    const archived = await loadArchivedSessionKeys(id);
    for (const key of archived) {
        if (!candidates.includes(key)) {
            candidates.push(key);
        }
    }

    return candidates;
}

async function loadArchivedSessionKeys(id) {
    const cached = archivedSessionKeys.get(id);
    if (cached) {
        return cached;
    }

    const pending = pendingArchivedKeys.get(id);
    if (pending) {
        return pending;
    }

    const creation = buildArchivedSessionKeys(id)
        .finally(() => {
            pendingArchivedKeys.delete(id);
        });

    pendingArchivedKeys.set(id, creation);

    return creation;
}

async function buildArchivedSessionKeys(id) {
    const identity = getCurrentIdentity();

    if (!identity || !identity.privateKey) {
        archivedSessionKeys.set(id, []);
        return [];
    }

    const candidates = await getPeerKeyCandidates(id);

    const keys = [];

    for (const publicKey of candidates.history) {
        try {
            const imported = await importX25519(publicKey);
            keys.push(
                await deriveSessionKeyFromPeer(identity.privateKey, imported)
            );
        } catch {
            // A key the server handed us that will not import is not usable.
            // Skip it rather than failing the whole conversation.
        }
    }

    archivedSessionKeys.set(id, keys);

    return keys;
}

/**
 * Move the candidate that actually worked to the front, so the next message in
 * this conversation does not retry the same failing keys first.
 *
 * @param {number} userId
 * @param {CryptoKey} working
 */
export function promoteSessionKeyCandidate(userId, working) {
    const id = normalizeUserId(userId);

    if (sessionKeys.get(id) === working) {
        return;
    }

    sessionKeys.set(id, working);
    archivedSessionKeys.delete(id);
}

async function importX25519(base64) {
    return crypto.subtle.importKey(
        'raw',
        base64ToBytes(base64),
        { name: 'X25519' },
        false,
        []
    );
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}


/* =========================================================
 * Group KDM wrap key (F2)
 * ========================================================= */

async function createGroupKdmKey(id) {
    const identity = getCurrentIdentity();

    if (!identity || !identity.privateKey) {
        throw new Error('Identity is not unlocked');
    }

    const peerPublicKey = await getPeerPublicKey(id);
    const key = await deriveSessionKeyFromPeer(
        identity.privateKey,
        peerPublicKey,
        GROUP_KDM_INFO
    );

    kdmKeys.set(id, key);
    return key;
}

export async function getOrCreateGroupKdmKey(userId) {
    const id = normalizeUserId(userId);

    const existing = kdmKeys.get(id);
    if (existing) return existing;

    const pending = pendingKdmKeys.get(id);
    if (pending) return pending;

    const creation = createGroupKdmKey(id).finally(() => {
        pendingKdmKeys.delete(id);
    });

    pendingKdmKeys.set(id, creation);
    return creation;
}