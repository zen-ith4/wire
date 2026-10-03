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
import { zero } from './codec.js';
import { deriveSenderKeyIdV2, SENDER_KEY_SCHEME_KEY_DERIVED } from './sender-key-id.js';
import {
    putSenderKeyRecord,
    putSenderKeyRecordIfAbsent,
    getSenderKeyRecord,
    getMySenderKeyForGroup,
    deleteSenderKeyRecord,
} from './sender-key-store.js';

const SENDER_KEY_BYTE_LENGTH = 32; // AES-256

// senderKeyId -> non-extractable CryptoKey. Never persisted as-is;
// this is purely a per-tab in-memory speed-up so every encrypt/
// decrypt call doesn't have to unwrap from IndexedDB again. Cleared
// on identity lock (clearSenderKeyCache, called alongside
// clearLocalWrapKeyCache — see identity-service.js integration in
// Phase 3).
const cryptoKeyCache = new Map();

async function importSenderKeyBytes(rawBytes) {
    return crypto.subtle.importKey(
        'raw',
        rawBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Generates a brand new Sender Key for a group: fresh random bytes and an
 * id that is a PRF of those bytes (sender-key-id.js, scheme 2:
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
    // The id is derived FROM the key (sender-key-id.js, scheme 2), so two
    // devices of one account can never mint the same id for different keys.
    const rawBytes = crypto.getRandomValues(new Uint8Array(SENDER_KEY_BYTE_LENGTH));
    const senderKeyId = await deriveSenderKeyIdV2(groupId, identity.userId, epoch, rawBytes);

    const cryptoKey = await importSenderKeyBytes(rawBytes);

    const meta = {
        senderKeyId,
        groupId,
        ownerUserId: identity.userId,
        epoch,
        // isMine === "generated on THIS device, therefore the only kind of
        // key this device may ever ENCRYPT with" (nonce-lock.js counters
        // are per device). scheme 2 marks records written by this code so
        // legacy rows (scheme undefined) are never selected for sending.
        isMine: 1,
        scheme: SENDER_KEY_SCHEME_KEY_DERIVED,
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
            async commit() {
                try {
                    await persistWrapped(identity, meta, rawBytes);
                    cryptoKeyCache.set(senderKeyId, cryptoKey);
                } finally {
                    zero(rawBytes);
                }
            },
            discard() {
                zero(rawBytes);
            },
        };
    }

    await persistWrapped(identity, meta, rawBytes);

    cryptoKeyCache.set(senderKeyId, cryptoKey);

    return { senderKeyId, cryptoKey, rawBytes };
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
 * Never overwrites a different key already stored under the same id;
 * that could only happen for legacy (scheme 1) ids that collide across
 * devices, and replacing the key would make every message encrypted
 * under the first one unreadable. The existing key wins.
 *
 * @param {object} identity
 * @param {object} params {senderKeyId, groupId, ownerUserId, epoch, scheme}
 * @param {Uint8Array} rawBytes
 */
export async function storeReceivedSenderKey(identity, params, rawBytes) {
    const existing = await getSenderKeyRecord(params.senderKeyId);

    if (existing) {
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
        scheme: params.scheme,
    }, rawBytes, { ifAbsent: !existing });

    if (!written) {
        return loadSenderKey(identity, params.senderKeyId);
    }

    cryptoKeyCache.set(params.senderKeyId, cryptoKey);

    return cryptoKey;
}

/**
 * Unwraps and imports a Sender Key already on disk, caching the
 * result. Used when a tab starts up with no in-memory cache yet but
 * IndexedDB already has the key from an earlier session/tab.
 */
export async function loadSenderKey(identity, senderKeyId) {
    const cached = cryptoKeyCache.get(senderKeyId);
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
        const cryptoKey = await importSenderKeyBytes(rawBytes);
        cryptoKeyCache.set(senderKeyId, cryptoKey);
        return cryptoKey;
    } finally {
        zero(rawBytes);
    }
}

/**
 * The Sender Key this device currently sends with in a group, if any
 * (metadata + usable CryptoKey). Null means the caller needs to
 * generate+distribute one before it can send — see rotation.js.
 */
export async function getMySenderKey(identity, groupId) {
    const record = await getMySenderKeyForGroup(groupId, identity.userId);
    if (!record) return null;

    const cryptoKey = await loadSenderKey(identity, record.senderKeyId);
    if (!cryptoKey) return null;

    return { senderKeyId: record.senderKeyId, epoch: record.epoch, cryptoKey };
}

export async function forgetSenderKey(senderKeyId) {
    cryptoKeyCache.delete(senderKeyId);
    await deleteSenderKeyRecord(senderKeyId);
}

export function clearSenderKeyCache() {
    cryptoKeyCache.clear();
}
