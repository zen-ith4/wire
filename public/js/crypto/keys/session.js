import {
    deriveSessionKeyFromPeer,
    GROUP_KDM_INFO
} from './key-derivation.js';

import {
    getPeerPublicKey
} from './peer-keys.js';

import {
    getCurrentIdentity
} from '../identity-service.js';


const sessionKeys = new Map();

// Group KDM wrap keys: same ECDH shared secret as the DM session, but a
// different HKDF info (key-derivation.js GROUP_KDM_INFO), cached separately.
const kdmKeys = new Map();
const pendingKdmKeys = new Map();

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
}


/* =========================================================
 * Clear
 * ========================================================= */

export function clearSessionKeys() {
    sessionKeys.clear();
    pendingSessionKeys.clear();
    kdmKeys.clear();
    pendingKdmKeys.clear();
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