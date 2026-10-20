// public/js/crypto/keys/peer-key-gate.js
//
// The group-side gate over peer-trust.js. DMs enforce the pin in the chat
// layer (chat/dm-key-trust.js); the group path cannot, because its wrap and
// unwrap keys are derived inside the crypto layer before any UI exists
// (groups/kdm.js -> keys/session.js). This module is the additive seam that
// lets session.js consult the same pin without importing chat/.
//
// It owns exactly three things:
//   - the pin CONTEXT (origin + own user id, the same key peer-trust.js uses);
//   - the TOFU evaluate/pin decision for one peer key, including the local-key
//     branch for the sender's own user id (self-KDM);
//   - a per-session list of peers whose key changed and was therefore not
//     used, so the group UI can render "not receiving" and clear it on accept.
//
// It changes no wire format and no pin namespace. A peer already pinned (or
// verified) in a DM is protected in groups for free because both paths read
// the same IndexedDB record.
//
// FAIL CLOSED. If there is no signed-in context, no fetchable key, or no
// IndexedDB to read the pin from, the caller gets an error and no KDM is
// produced or consumed. That is different from the DM retired-key fallback in
// session.js, which still fails open; the group path does not.

import {
    getPeerPublicKeyBase64,
    getPeerKeyCandidates
} from './peer-keys.js';

import {
    evaluatePeerKey,
    pinOnFirstUse
} from './peer-trust.js';


const changedPeers = new Map();

/** A group KDM could not be tied to a pinned peer key. No key material was used. */
export class GroupPeerKeyError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'GroupPeerKeyError';
        this.code = code;
    }
}

/** The peer's server-supplied key is not one this device has accepted. */
export class GroupPeerKeyChangedError extends GroupPeerKeyError {
    constructor(peerId, fingerprint, pending) {
        super(
            `Peer ${peerId}'s identity key has changed; refusing to use it until accepted`,
            'GROUP_PEER_KEY_CHANGED'
        );
        this.name = 'GroupPeerKeyChangedError';
        this.peerId = Number(peerId);
        this.fingerprint = fingerprint || null;
        this.pending = pending || null;
    }
}

/** The pin cannot be consulted (no context, no key, storage unavailable). */
export class GroupPeerKeyUnavailableError extends GroupPeerKeyError {
    constructor(peerId, reason, cause) {
        super(
            `Cannot verify peer ${peerId}'s identity key (${reason})`,
            'GROUP_PEER_KEY_UNAVAILABLE'
        );
        this.name = 'GroupPeerKeyUnavailableError';
        this.peerId = Number(peerId);
        this.reason = reason;
        if (cause) this.cause = cause;
    }
}

function normalizeUserId(userId) {
    const id = Number(userId);

    if (!Number.isInteger(id) || id <= 0) {
        throw new Error('Invalid user ID');
    }

    return id;
}

/**
 * The current user's id, or null when nobody is signed in.
 *
 * Dynamic import on purpose: peer-keys.js -> api.js -> auth.js means this
 * module is already reachable from auth.js's dependency graph, and a static
 * back-import would be gratuitous.
 */
export async function getOwnUserId() {
    try {
        const { getCurrentUser } = await import('../../core/auth.js');
        const id = Number(getCurrentUser()?.id);

        if (!Number.isInteger(id) || id <= 0) {
            return null;
        }

        return id;
    } catch {
        return null;
    }
}

/**
 * The (origin, ownUserId) the pin store is keyed by, or null when there is no
 * logged-in user / no server configured. Same shape peer-trust.js expects.
 */
export async function getPeerTrustContext() {
    try {
        const { getServerEndpoint } = await import('../../core/server.js');
        const origin = getServerEndpoint();
        const ownUserId = await getOwnUserId();

        if (!origin || !ownUserId) {
            return null;
        }

        return { origin: String(origin), ownUserId };
    } catch {
        return null;
    }
}

/**
 * Resolve the one key that may be used for `peerId` this round.
 *
 * For the sender's own id the local identity public key is used and the
 * server is never asked: a server that substitutes the account's own key
 * could otherwise read every self-KDM, i.e. every Sender Key this device
 * distributes (2.8 S).
 *
 * For every other peer: fetch ONCE, evaluate against the pin, pin on first
 * contact exactly like a DM would, and fail closed on `changed` or on any
 * missing piece. The caller derives from `publicKey` below — the same bytes
 * that were evaluated, never a second fetch.
 *
 * @param {number} peerId
 * @param {number|null} ownUserId
 * @param {string} ownPublicKey local identity public key (base64)
 * @returns {Promise<{state: string, publicKey: string, fingerprint: string|null}>}
 */
export async function resolveGroupPeerKey(peerId, ownUserId, ownPublicKey) {
    const id = normalizeUserId(peerId);

    if (ownUserId != null && id === Number(ownUserId)) {
        if (typeof ownPublicKey !== 'string' || !ownPublicKey) {
            throw new GroupPeerKeyUnavailableError(
                id,
                'local identity key is not available'
            );
        }

        return { state: 'self', publicKey: ownPublicKey, fingerprint: null };
    }

    const context = await getPeerTrustContext();

    if (!context) {
        throw new GroupPeerKeyUnavailableError(
            id,
            'no signed-in account or server context'
        );
    }

    let publicKey;

    try {
        publicKey = await getPeerPublicKeyBase64(id);
    } catch (e) {
        throw new GroupPeerKeyUnavailableError(
            id,
            'peer identity key could not be fetched',
            e
        );
    }

    let evaluated;

    try {
        evaluated = await evaluatePeerKey(id, publicKey, context);
    } catch (e) {
        throw new GroupPeerKeyUnavailableError(
            id,
            'peer key pin store is not available',
            e
        );
    }

    if (evaluated.state === 'first-contact') {
        let retired = [];

        try {
            retired = (await getPeerKeyCandidates(id)).history;
        } catch {
            retired = [];
        }

        try {
            await pinOnFirstUse(id, publicKey, context, retired);
        } catch (e) {
            throw new GroupPeerKeyUnavailableError(
                id,
                'first-contact key could not be pinned',
                e
            );
        }

        evaluated = { ...evaluated, state: 'ok' };
    }

    if (evaluated.state === 'changed') {
        changedPeers.set(id, {
            peerId: id,
            fingerprint: evaluated.fingerprint,
            pending: evaluated.pending,
            at: Date.now(),
        });

        throw new GroupPeerKeyChangedError(
            id,
            evaluated.fingerprint,
            evaluated.pending
        );
    }

    changedPeers.delete(id);

    return {
        state: evaluated.state,
        publicKey,
        fingerprint: evaluated.fingerprint,
    };
}

/* =========================================================
 * Changed-peer state (the group "not receiving" list)
 * ========================================================= */

/** Peers whose changed key stopped a group wrap/unwrap this session. */
export function getChangedGroupPeers() {
    return [...changedPeers.values()];
}

export function clearChangedGroupPeer(peerId) {
    changedPeers.delete(Number(peerId));
}

export function resetGroupPeerKeyState() {
    changedPeers.clear();
}


// A logout must not leave one account's changed-peer list visible to the next.
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('wire:logout', () => {
        resetGroupPeerKeyState();
    });
}
