// public/js/crypto/groups/sender-key.js
//
// Owns the lifecycle of a single Sender Key: generating the raw
// bytes, wrapping/unwrapping them for IndexedDB (2.3), and importing
// them as non-extractable CryptoKeys for actual use (2.3 again — "a
// key only ever used for crypto operations" gets imported
// non-extractable, same posture as session.js/identity.js).
//
// This module never writes ciphertext to the network — that's
// kdm.js (wrapping a Sender Key pairwise for a KDM) and
// message-crypto.js (encrypting a message with it). This module only
// ever talks to sender-key-store.js (local disk) and the in-memory
// cache below.
//
// Every function here that takes an `identity` expects
// {privateKey, publicKey, userId} — one field more than
// identity-service.js's getCurrentIdentity() returns. That's
// intentional: this module (and the rest of groups/*) deliberately
// doesn't import core/auth.js or identity-service.js itself, so it
// stays unit-testable with a plain fake identity object and no
// browser app context loaded (see tests/groups/*). Whoever wires
// this into the UI (Phase 3) builds that object once, by combining
// identity-service.getCurrentIdentity() with
// core/auth.getCurrentUser().id.

import { deriveLocalWrapKey } from './local-wrap-key.js';
import { encryptBytes, decryptBytes } from './aead.js';
import { zero, bytesToBase64, base64ToBytes, encodeFields } from './codec.js';
import { deriveSenderKeyId, deriveSenderEncKey } from './sender-key-id.js';
import { resetNoncePrefix } from './nonce-lock.js';
import {
    generateSigningKeyPair,
    exportSigningPrivateKey,
    importSigningPrivateKey,
    importVerifyKey,
    signingKeyMatchesPublic,
} from './signing.js';
import {
    putSenderKeyRecord,
    putSenderKeyRecordIfAbsent,
    getSenderKeyRecord,
    getMySenderKeyForGroup,
    deleteSenderKeyRecord,
    clearSupersededSigningKeys,
} from './sender-key-store.js';

const SENDER_KEY_BYTE_LENGTH = 32; // AES-256

// senderKeyId -> bundle {cryptoKey, verifyKey, signKey, signPub, ownerUserId,
// groupId, epoch}. Every CryptoKey in it is NON-extractable. Never persisted
// as-is; this is purely a per-tab in-memory speed-up so every encrypt/decrypt/
// sign/verify call doesn't have to unwrap from IndexedDB again. `signKey` (the
// signing PRIVATE key) is only ever present for a row generated on THIS device.
// Cleared on identity lock (clearSenderKeyCache, called alongside
// clearLocalWrapKeyCache — see identity-service.js integration in
// Phase 3).
const bundleCache = new Map();

/** additionalData of the wrapped signing private key: binds it to its key id and owner. */
function signKeyAad(senderKeyId, ownerUserId) {
    return encodeFields('group-sig-priv-v1', senderKeyId, Number(ownerUserId));
}

// The stored/transmitted 32 bytes are the ROOT secret; the AES key is a
// derived subkey (sender-key-id.js key schedule).
async function importSenderKeyBytes(rawBytes) {
    return deriveSenderEncKey(rawBytes);
}

/**
 * Generates a brand new Sender Key for a group: fresh random bytes and an
 * id that is a PRF of those bytes (sender-key-id.js:
 * HMAC-SHA-256(key, label|group|owner|epoch)). Two devices of one account
 * therefore never mint the same id for different keys, and every recipient
 * arrives at the same id after unwrapping the KDM, without it being
 * transmitted. The key is imported non-extractably for use and persisted
 * wrapped. A fresh key also means a fresh nonce-lock.js lock name and
 * counter, with no continuity to any prior key.
 *
 * With { deferPersist: true } (F1) nothing is written or cached until the
 * returned commit() is called; see messages/group-message-crypto.js.
 *
 * Does NOT distribute it — that's kdm.js's job, driven by whatever
 * orchestrates rotation (rotation.js). Generation and distribution
 * are kept separate so a failed KDM POST doesn't leave the caller
 * unsure whether a key was "half generated".
 *
 * @param {object} identity unlocked identity (identity-service.js)
 * @param {number} groupId
 * @param {number} epoch
 * @returns {Promise<{senderKeyId: string, cryptoKey: CryptoKey, rawBytes: Uint8Array}>}
 *   rawBytes is returned ONLY so the caller can fan it out via
 *   kdm.js in the same tick — callers must not persist or log it,
 *   and should let it go out of scope (zero it) once KDMs are built.
 */
export async function generateSenderKey(identity, groupId, epoch, { deferPersist = false } = {}) {
    // The id is derived FROM the key (sender-key-id.js), so two
    // devices of one account can never mint the same id for different keys.
    const rawBytes = crypto.getRandomValues(new Uint8Array(SENDER_KEY_BYTE_LENGTH));

    // Phase C: every Sender Key has its OWN message-signing key pair. The private
    // key is generated extractable ONLY so it can be exported once and wrapped; the
    // key used from here on is a NON-extractable re-import, every temporary byte
    // buffer is zeroed, and the extractable handle is not kept anywhere.
    let signKey;
    let signPub;
    let signKeyWrapped;
    let senderKeyId;
    let cryptoKey;

    try {
        const pair = await generateSigningKeyPair();
        signPub = pair.publicKeyRaw;
        const pkcs8 = await exportSigningPrivateKey(pair.privateKey);

        try {
            signKey = await importSigningPrivateKey(pkcs8);
            senderKeyId = await deriveSenderKeyId(groupId, identity.userId, epoch, rawBytes, signPub);
            const wrapKey = await deriveLocalWrapKey(identity);
            signKeyWrapped = await encryptBytes(wrapKey, pkcs8, undefined, signKeyAad(senderKeyId, identity.userId));
        } finally {
            zero(pkcs8);
        }

        cryptoKey = await importSenderKeyBytes(rawBytes);
    } catch (e) {
        zero(rawBytes);
        throw e;
    }

    const verifyKey = await importVerifyKey(signPub);

    const meta = {
        senderKeyId,
        groupId,
        ownerUserId: identity.userId,
        epoch,
        // isMine === "generated on THIS device, therefore the only kind of
        // key this device may ever ENCRYPT with" (nonce-lock.js counters
        // are per device).
        isMine: 1,
        signPub: bytesToBase64(signPub),
        signKeyWrapped,
    };
    const bundle = {
        cryptoKey,
        verifyKey,
        signKey,
        signPub,
        ownerUserId: Number(identity.userId),
        groupId: Number(groupId),
        epoch,
    };

    if (deferPersist) {
        // F1: the key is NOT on disk and NOT in the cache, so nothing can
        // select it as "current" until the caller has proven (HTTP 201) that
        // it was distributed. A process death anywhere before commit() leaves
        // no trace of an undistributed key. rawBytes stays alive until
        // commit() or discard(); the caller must call exactly one of them.
        return {
            senderKeyId,
            cryptoKey,
            rawBytes,
            signPub,
            signKey,
            async commit() {
                try {
                    // The root, the public key and the WRAPPED signing key land in
                    // ONE put. Only after that put completed (durably stored, and
                    // after the caller's 201) are the signing keys of the keys this
                    // one supersedes dropped.
                    await persistWrapped(identity, meta, rawBytes);
                    bundleCache.set(senderKeyId, bundle);
                } finally {
                    zero(rawBytes);
                }

                await dropSupersededSigningKeys(identity.userId, groupId, senderKeyId);
            },
            discard() {
                zero(rawBytes);
            },
        };
    }

    // Direct (non-deferred) callers have no KDM POST to wait for, so nothing
    // superseded is dropped here: the next deferred commit() does that.
    await persistWrapped(identity, meta, rawBytes);

    bundleCache.set(senderKeyId, bundle);

    return { senderKeyId, cryptoKey, rawBytes, signPub, signKey };
}

/**
 * Condition B: the superseded own signing private keys are dropped only AFTER the
 * new key is durably stored, by the caller that holds the sender-key lock
 * (messages/group-message-crypto.js ensureSenderKeyForGroup). A failure here never
 * fails the rotation: the old key simply stays usable (and is dropped by the next
 * rotation). A send already in flight keeps the CryptoKey it loaded, so it still
 * signs.
 */
async function dropSupersededSigningKeys(ownerUserId, groupId, keepSenderKeyId) {
    try {
        const cleared = await clearSupersededSigningKeys(groupId, ownerUserId, keepSenderKeyId);

        for (const id of cleared) {
            const bundle = bundleCache.get(id);
            if (bundle) bundleCache.set(id, { ...bundle, signKey: null });
        }
    } catch (e) {
        console.warn('[group-e2ee] could not drop a superseded signing key; it stays until the next rotation', e?.name || e);
    }
}

async function persistWrapped(identity, meta, rawBytes, { ifAbsent = false } = {}) {
    const wrapKey = await deriveLocalWrapKey(identity);
    const wrappedKey = await encryptBytes(wrapKey, rawBytes);
    const record = {
        ...meta,
        wrappedKey,
        createdAt: new Date().toISOString(),
    };

    if (ifAbsent) {
        return putSenderKeyRecordIfAbsent(record);
    }

    await putSenderKeyRecord(record);
    return true;
}

/** Thrown when a KDM re-uses a stored senderKeyId with a different owner / group / epoch / signing key. */
export class SenderKeyConflictError extends Error {
    constructor(senderKeyId) {
        super('A KDM conflicts with the stored owner or signing key of a Sender Key id');
        this.name = 'SenderKeyConflictError';
        this.senderKeyId = senderKeyId;
    }
}

/**
 * Stores a Sender Key received via KDM (from another member, or our
 * own self-KDM landing on a second device/tab).
 *
 * A received key is ALWAYS decrypt-only (`isMine: 0`), even when the
 * KDM's owner is our own account: that key was generated on a
 * DIFFERENT device, whose nonce counters this device cannot see.
 * Encrypting with it here would reuse (key, nonce) pairs. (The earlier
 * code derived isMine from the owner id, which is what turned a
 * self-KDM into a second sending device on the same key.)
 *
 * Never overwrites a different key already stored under the same id
 * (ids are a PRF of the key, so that needs a 256-bit collision or a hostile
 * relay); replacing the key would make every message encrypted under the
 * first one unreadable. The existing key wins.
 *
 * Phase C: the owner, the epoch and the signing public key (`signPub`, 65 raw bytes) of
 * a stored id are IMMUTABLE. A later KDM that carries an existing senderKeyId with a
 * different owner, group, epoch or signPub is rejected (SenderKeyConflictError) and
 * never overwrites the stored row. A received key never gets a signing private key.
 *
 * @param {object} identity
 * @param {object} params {senderKeyId, groupId, ownerUserId, epoch, signPub}
 * @param {Uint8Array} rawBytes
 */
export async function storeReceivedSenderKey(identity, params, rawBytes) {
    // Fail closed on a malformed signing public key BEFORE touching storage.
    const signPub = params.signPub;
    const verifyKey = await importVerifyKey(signPub);
    const signPubB64 = bytesToBase64(signPub);

    const existing = await getSenderKeyRecord(params.senderKeyId);

    if (existing) {
        if (
            Number(existing.groupId) !== Number(params.groupId) ||
            Number(existing.ownerUserId) !== Number(params.ownerUserId) ||
            Number(existing.epoch) !== Number(params.epoch) ||
            existing.signPub !== signPubB64
        ) {
            throw new SenderKeyConflictError(params.senderKeyId);
        }

        const wrapKey = await deriveLocalWrapKey(identity);
        let existingBytes = null;
        try {
            existingBytes = await decryptBytes(wrapKey, existing.wrappedKey);
        } catch {
            // wrapped under another account's local key: fall through and replace
        }

        if (existingBytes) {
            const same =
                existingBytes.length === rawBytes.length &&
                existingBytes.every((b, i) => b === rawBytes[i]);
            zero(existingBytes);

            if (same) {
                return loadSenderKey(identity, params.senderKeyId);
            }

            console.warn(
                '[group-e2ee] KDM carries a different key for an id already stored; keeping the existing key',
                params.senderKeyId
            );
            return loadSenderKey(identity, params.senderKeyId);
        }
    }

    const cryptoKey = await importSenderKeyBytes(rawBytes);

    // A row for another account's local wrap key (existing !== null but not
    // unwrappable) must be replaced; otherwise insert only if still absent so
    // a concurrently committed own sending key is never demoted (F1).
    const written = await persistWrapped(identity, {
        senderKeyId: params.senderKeyId,
        groupId: params.groupId,
        ownerUserId: params.ownerUserId,
        epoch: params.epoch,
        isMine: 0,
        signPub: signPubB64,
    }, rawBytes, { ifAbsent: !existing });

    if (!written) {
        return loadSenderKey(identity, params.senderKeyId);
    }

    bundleCache.set(params.senderKeyId, {
        cryptoKey,
        verifyKey,
        signKey: null,
        signPub: signPub.slice(),
        ownerUserId: Number(params.ownerUserId),
        groupId: Number(params.groupId),
        epoch: params.epoch,
    });

    return cryptoKey;
}

/**
 * Unwraps and imports a Sender Key already on disk, caching the result: the AES
 * key, the signing PUBLIC key as a verify-only CryptoKey, and, only for a row
 * generated on THIS device, the signing private key (non-extractable).
 *
 * Fails closed (returns null, one console line) when the row cannot be trusted:
 *  - it has no signing public key (a pre-signing row),
 *  - its signing public key is not a valid P-256 point,
 *  - the id no longer re-derives from (root, group, owner, epoch, signPub), i.e.
 *    the stored metadata or public key was altered.
 * A row whose signing PRIVATE key is missing or does not match its public key still
 * loads (it can decrypt and verify) but has `signKey: null`, so it is never used
 * for sending.
 *
 * @returns {Promise<object|null>} the bundle, see bundleCache
 */
export async function loadSenderKeyBundle(identity, senderKeyId) {
    const cached = bundleCache.get(senderKeyId);
    if (cached) return cached;

    const record = await getSenderKeyRecord(senderKeyId);
    if (!record) return null;

    const wrapKey = await deriveLocalWrapKey(identity);

    let rawBytes;
    try {
        rawBytes = await decryptBytes(wrapKey, record.wrappedKey);
    } catch {
        // Row was wrapped under a different identity's local key (a
        // previous account on this browser profile). It is unusable for
        // us; treat it as "no key" so the caller self-heals via a KDM
        // drain instead of failing every decrypt with an opaque error.
        return null;
    }

    try {
        if (typeof record.signPub !== 'string' || !record.signPub) {
            console.warn('[group-e2ee] stored Sender Key has no signing public key (pre-signing row); ignoring it', senderKeyId);
            return null;
        }

        let signPub;
        let verifyKey;
        try {
            signPub = base64ToBytes(record.signPub);
            verifyKey = await importVerifyKey(signPub);
        } catch {
            console.warn('[group-e2ee] stored Sender Key has an invalid signing public key; ignoring it', senderKeyId);
            return null;
        }

        const derived = await deriveSenderKeyId(record.groupId, record.ownerUserId, record.epoch, rawBytes, signPub);
        if (derived !== senderKeyId) {
            console.warn('[group-e2ee] stored Sender Key does not match its id (altered row?); ignoring it', senderKeyId);
            return null;
        }

        let signKey = null;

        if (record.isMine === 1 && record.signKeyWrapped) {
            let pkcs8 = null;
            try {
                pkcs8 = await decryptBytes(wrapKey, record.signKeyWrapped, signKeyAad(senderKeyId, record.ownerUserId));
                const candidate = await importSigningPrivateKey(pkcs8);
                if (await signingKeyMatchesPublic(candidate, verifyKey)) {
                    signKey = candidate;
                } else {
                    console.warn('[group-e2ee] stored signing key does not match its public key; not using it for sending', senderKeyId);
                }
            } catch {
                console.warn('[group-e2ee] stored signing key could not be restored; not using it for sending', senderKeyId);
            } finally {
                if (pkcs8) zero(pkcs8);
            }
        }

        const bundle = {
            cryptoKey: await importSenderKeyBytes(rawBytes),
            verifyKey,
            signKey,
            signPub,
            ownerUserId: Number(record.ownerUserId),
            groupId: Number(record.groupId),
            epoch: record.epoch,
        };
        bundleCache.set(senderKeyId, bundle);
        return bundle;
    } finally {
        zero(rawBytes);
    }
}

export async function loadSenderKey(identity, senderKeyId) {
    const bundle = await loadSenderKeyBundle(identity, senderKeyId);
    return bundle ? bundle.cryptoKey : null;
}

/**
 * The Sender Key this device currently sends with in a group, if any
 * (metadata + usable CryptoKeys). Null means the caller needs to
 * generate+distribute one before it can send — see rotation.js.
 *
 * Sending requires an OWN row (isMine) that has a signing private key restored
 * and matching its public key. A row without one is unusable here: null, and the
 * caller re-keys.
 */
export async function getMySenderKey(identity, groupId) {
    let previousId = null;

    // A rotation that commits between "pick the row" and "load its signing key"
    // drops the signing key of the row just picked. That only ever happens AFTER the
    // new key is durably stored, so re-selecting finds it: retry while the selection
    // moves on, never fall back to a key without a signing key.
    for (let attempt = 0; attempt < 3; attempt++) {
        const record = await getMySenderKeyForGroup(groupId, identity.userId);
        if (!record || record.senderKeyId === previousId) return null;

        const bundle = await loadSenderKeyBundle(identity, record.senderKeyId);

        if (bundle?.signKey) {
            return {
                senderKeyId: record.senderKeyId,
                epoch: record.epoch,
                cryptoKey: bundle.cryptoKey,
                signKey: bundle.signKey,
                signPub: bundle.signPub,
            };
        }

        previousId = record.senderKeyId;
    }

    return null;
}

export async function forgetSenderKey(senderKeyId) {
    bundleCache.delete(senderKeyId);
    await deleteSenderKeyRecord(senderKeyId);
}

export function clearSenderKeyCache() {
    // Drops every unwrapped key, the signing private keys included.
    bundleCache.clear();
    // Called on every identity lock: the next unlock draws a fresh random nonce
    // prefix (nonce-lock.js, F10).
    resetNoncePrefix();
}

/** Test-only: every CryptoKey (AES, verify, signing private) currently held in the in-memory cache. */
export function __cachedKeysForTests() {
    return [...bundleCache.values()].flatMap((b) => [b.cryptoKey, b.verifyKey, b.signKey]).filter(Boolean);
}
