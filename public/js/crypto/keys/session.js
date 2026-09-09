import {
    deriveSessionKeyFromPeer
} from './key-derivation.js';

import {
    getPeerPublicKey
} from './peer-keys.js';

import {
    getCurrentIdentity
} from '../identity-service.js';


const sessionKeys = new Map();


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

    return createSessionKey(id);
}


/* =========================================================
 * Remove
 * ========================================================= */

export function removeSessionKey(userId) {
    const id =
        normalizeUserId(userId);

    sessionKeys.delete(id);
}


/* =========================================================
 * Clear
 * ========================================================= */

export function clearSessionKeys() {
    sessionKeys.clear();
}