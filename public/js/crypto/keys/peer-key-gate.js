// public/js/crypto/keys/peer-key-gate.js
//
// The gate over peer-trust.js: the one place the server's word about a peer's key
// meets the pin, so the bytes that get used are the bytes that got checked. Group
// wrap and unwrap keys are derived inside the crypto layer before any UI exists
// (groups/kdm.js -> keys/session.js), and DM keys are derived there too
// (messages/dm-v2-wire.js, keys/session.js). This module is the seam that lets
// them consult the pin without importing chat/.
//
// It owns exactly four things:
//   - the pin CONTEXT (origin + own user id, the same key peer-trust.js uses);
//   - the TOFU evaluate/pin decision for one peer key, including the local-key
//     branch for the sender's own user id (self-KDM);
//   - the DM rule: encrypt only to bytes that were just evaluated
//     (resolveDmPeerKey), decrypt only with keys already in the pin
//     (getTrustedPeerKeys);
//   - a per-session list of peers whose key changed and was therefore not
//     used, so the group UI can render "not receiving" and clear it on accept.
//
// It changes no wire format and no pin namespace. A peer already pinned (or
// verified) in a DM is protected in groups for free because both paths read
// the same IndexedDB record.
//
// FAIL CLOSED. If there is no signed-in context, no fetchable key, or no
// IndexedDB to read the pin from, the caller gets an error and no key is
// produced or consumed.

import {
    getPeerPublicKeyBase64,
    getPeerKeyCandidates
} from './peer-keys.js';

import {
    evaluatePeerKey,
    getPeerPin,
    pinOnFirstUse,
    pinnedPeerKeys
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

/**
 * A DM must not use this peer's key: it is not one this device has accepted.
 * Nothing has been encrypted, so the caller shows this to the user as it is.
 */
export class PeerKeyChangedError extends Error {
    constructor(peerId) {
        super("This contact's key has changed. Review the new key before sending.");
        this.name = 'PeerKeyChangedError';
        this.code = 'PEER_KEY_CHANGED';
        this.peerId = Number(peerId);
    }
}

/** The pin cannot be consulted for a DM (no context, no key, storage unavailable). */
export class PeerKeyUnavailableError extends Error {
    constructor(peerId, reason, cause) {
        super(`Cannot verify this contact's identity key (${reason})`);
        this.name = 'PeerKeyUnavailableError';
        this.code = 'PEER_KEY_UNAVAILABLE';
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
 * Evaluate one fetched key against the pin, pinning it on first contact.
 *
 * The answer is always about `publicKey`, these exact bytes. pinOnFirstUse() never
 * overwrites a pin, so when two calls race at first contact the loser's bytes may
 * not be what got pinned. Evaluating again after pinning means the loser is told so,
 * instead of carrying on as 'ok' with a key the pin does not hold.
 *
 * @param {number} peerId
 * @param {string} publicKey base64, the bytes the caller is about to use
 * @param {{origin: string, ownUserId: number}} context
 * @returns {Promise<{state: string, pin: object|null, pending: object|null, fingerprint: string}>}
 */
export async function evaluateAndPin(peerId, publicKey, context) {
    const evaluated = await evaluatePeerKey(peerId, publicKey, context);

    if (evaluated.state !== 'first-contact') {
        return evaluated;
    }

    let retired = [];

    try {
        retired = (await getPeerKeyCandidates(peerId)).history;
    } catch {
        retired = [];
    }

    await pinOnFirstUse(peerId, publicKey, context, retired);

    return evaluatePeerKey(peerId, publicKey, context);
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
        evaluated = await evaluateAndPin(id, publicKey, context);
    } catch (e) {
        throw new GroupPeerKeyUnavailableError(
            id,
            'peer key pin store is not available',
            e
        );
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
 * DM keys
 *
 * The same rule as the group gate above, for the two directions a DM has. A
 * server that lies can only make these fail: it cannot make a DM encrypt to, or
 * open under, a key this device did not choose to trust.
 * ========================================================= */

/** Fetch once and evaluate those bytes, mapping every failure to PeerKeyUnavailableError. */
async function fetchAndEvaluateDmKey(id, context) {
    let publicKey;

    try {
        publicKey = await getPeerPublicKeyBase64(id);
    } catch (e) {
        throw new PeerKeyUnavailableError(
            id,
            e?.message || 'peer identity key could not be fetched',
            e
        );
    }

    try {
        return { publicKey, evaluated: await evaluateAndPin(id, publicKey, context) };
    } catch (e) {
        throw new PeerKeyUnavailableError(id, 'peer key pin store is not available', e);
    }
}

/**
 * The key a DM may be ENCRYPTED to right now.
 *
 * Fetches once, evaluates, and returns those exact bytes: the caller derives from
 * the return value and fetches nothing. A separate check followed by a separate
 * fetch is not a narrow race against a hostile server, it is a bypass, because the
 * server chooses each answer: the real key for the check, its own for the encrypt.
 *
 * @param {number} peerId
 * @returns {Promise<{state: string, publicKey: string, fingerprint: string}>}
 * @throws {PeerKeyChangedError} the key is not one this device has accepted
 * @throws {PeerKeyUnavailableError} the pin or the key cannot be read
 */
export async function resolveDmPeerKey(peerId) {
    const id = normalizeUserId(peerId);
    const context = await getPeerTrustContext();

    if (!context) {
        throw new PeerKeyUnavailableError(id, 'no signed-in account or server context');
    }

    const { publicKey, evaluated } = await fetchAndEvaluateDmKey(id, context);

    if (evaluated.state === 'changed') {
        throw new PeerKeyChangedError(id);
    }

    return {
        state: evaluated.state,
        publicKey,
        fingerprint: evaluated.fingerprint,
    };
}

/**
 * Every key of this peer a DM may be DECRYPTED with, `current` first.
 *
 * They come from this device's pin, not from the server. The server is only asked
 * at first contact, when there is no pin to read and TOFU creates one. That is what
 * makes a changed key safe to ignore here: a row sealed to a key the user has not
 * accepted simply has no match, whatever the server says about that key.
 *
 * @param {number} peerId
 * @returns {Promise<Array<{fingerprint: string, publicKey: string}>>}
 * @throws {PeerKeyUnavailableError} the pin or the key cannot be read
 */
export async function getTrustedPeerKeys(peerId) {
    const id = normalizeUserId(peerId);
    const context = await getPeerTrustContext();

    if (!context) {
        throw new PeerKeyUnavailableError(id, 'no signed-in account or server context');
    }

    const readPin = async () => {
        try {
            return await getPeerPin(id, context);
        } catch (e) {
            throw new PeerKeyUnavailableError(id, 'peer key pin store is not available', e);
        }
    };

    let pin = await readPin();

    if (!pin) {
        await fetchAndEvaluateDmKey(id, context);
        pin = await readPin();
    }

    return pinnedPeerKeys(pin);
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
