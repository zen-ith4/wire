// services/identityKeyHistory.service.js
//
// READ side of the identity-key archive.
//
// WHY THIS FILE EXISTS AT ALL
// The archive table already exists: identity_key_rotations (credentialSchema.js:28)
// is written by me.controller.js:953 inside the SAME transaction as the UPDATE
// that replaces identity_keys.public_key. Rotation has therefore never destroyed
// a public key - the old one is already preserved, append-only, with the moment
// it was retired.
//
// What was missing is the other direction: nothing ever READ that table. A grep
// of the repo finds exactly two references to it, the CREATE TABLE and the
// INSERT. So the keys were being kept and could not be reached. This service is
// that read path, and nothing else.
//
// WHY THERE IS NO identity_key_history TABLE
// A separate archive table would duplicate identity_key_rotations row for row:
// fingerprint = SHA-256(public_key) is derivable, created_at is the `at` of the
// rotation that produced the key, retired_at is the `at` of the rotation that
// retired it. Adding one would give two sources of truth that can disagree.
//
// RETENTION
// No history row is ever deleted or updated while the account exists. There is
// no pruning, no TTL and no cap: a public key is 32 bytes and a rotation is a
// rare, deliberate, user-initiated action, so the table grows at a rate that
// makes retention a non-issue. The one exception is deliberate and is the
// account being deleted - identity_key_rotations has ON DELETE CASCADE, so
// deleting an account removes its key history with it. That is a privacy
// decision, not a storage decision, and it is the reason "never delete" is
// scoped to the account's lifetime rather than stated absolutely.

const crypto = require('crypto');

const { getDb } = require('../config/database');

const X25519_PUBLIC_KEY_BYTES = 32;

/**
 * SHA-256 over the RAW 32 public key bytes, base64.
 *
 * Computed here rather than stored: it is a pure function of a value the row
 * already holds, and a stored copy would be a second thing that can go stale.
 * Never logged, never returned for a caller that is not authorized to see the
 * key it is derived from.
 *
 * @param {string} base64PublicKey
 * @returns {string} base64 SHA-256, or '' when the key is not a 32-byte X25519 key
 */
function fingerprintOf(base64PublicKey) {
    if (typeof base64PublicKey !== 'string' || !base64PublicKey.length) {
        return '';
    }

    const raw = Buffer.from(base64PublicKey, 'base64');

    if (raw.length !== X25519_PUBLIC_KEY_BYTES) {
        return '';
    }

    return crypto.createHash('sha256').update(raw).digest('base64');
}

function describeKey(publicKey, createdAt, retiredAt) {
    return {
        fingerprint: fingerprintOf(publicKey),
        publicKey,
        createdAt: createdAt || null,
        retiredAt: retiredAt || null,
    };
}

/**
 * The peer's full key chain, newest key last.
 *
 * Reconstructed from two tables rather than a third:
 *   identity_keys.public_key        the key in use now
 *   identity_key_rotations          the append-only log of what replaced what
 *
 * The log is walked oldest-first. Every rotation retires exactly one key
 * (old_public_key) and installs one (new_public_key), so a key that was itself
 * installed by an earlier rotation shows up as the old_public_key of the next
 * one - which is why walking old_public_key alone reaches the whole chain.
 *
 * @param {number} peerUserId
 * @returns {{userId:number, current:object|null, history:object[]}|null}
 *   null when the user has no identity key at all (never created one).
 */
function getIdentityKeyHistory(peerUserId) {
    const db = getDb();

    const identity = db.prepare(
        'SELECT public_key, created_at FROM identity_keys WHERE user_id = ?'
    ).get(peerUserId);

    if (!identity) {
        return null;
    }

    const rotations = db.prepare(`
        SELECT old_public_key, new_public_key, at
        FROM identity_key_rotations
        WHERE user_id = ?
        ORDER BY at ASC, id ASC
    `).all(peerUserId);

    // When each key started and stopped being in use.
    const createdAt = new Map();
    const retiredAt = new Map();

    for (const r of rotations) {
        createdAt.set(r.new_public_key, r.at);
        retiredAt.set(r.old_public_key, r.at);
    }

    // The very first key predates every logged rotation; identity_keys.created_at
    // is the original row's timestamp and rotation UPDATEs never touch it.
    const oldestFirstRotation = rotations[0];
    if (oldestFirstRotation && !createdAt.has(oldestFirstRotation.old_public_key)) {
        createdAt.set(oldestFirstRotation.old_public_key, identity.created_at);
    }

    const currentKey = identity.public_key;
    const history = [];
    const seen = new Set();

    for (const r of rotations) {
        const oldKey = r.old_public_key;

        // Defensive: a row whose old key is the current one would mean the log
        // and the table disagree. Skip it rather than emit a key twice.
        if (oldKey === currentKey || seen.has(oldKey)) continue;

        seen.add(oldKey);
        history.push(describeKey(oldKey, createdAt.get(oldKey), retiredAt.get(oldKey)));
    }

    return {
        userId: Number(peerUserId),
        current: describeKey(currentKey, createdAt.get(currentKey), null),
        history,
    };
}

/**
 * May `requesterId` see `peerId`'s key history?
 *
 * Own keys are always the caller's to see. Otherwise they must share a direct
 * message or a group: those are the relationships over which the caller already
 * receives ciphertext, so the keys that ciphertext was built from are not a new
 * disclosure.
 *
 * @param {number} requesterId
 * @param {number} peerId
 * @returns {boolean}
 */
function canViewIdentityKeyHistory(requesterId, peerId) {
    if (requesterId === peerId) return true;

    const db = getDb();

    const dm = db.prepare(`
        SELECT 1 AS x
        FROM direct_messages
        WHERE (sender_id = ? AND recipient_id = ?)
           OR (sender_id = ? AND recipient_id = ?)
        LIMIT 1
    `).get(requesterId, peerId, peerId, requesterId);

    if (dm) return true;

    const group = db.prepare(`
        SELECT 1 AS x
        FROM group_members a
        JOIN group_members b ON b.group_id = a.group_id
        WHERE a.user_id = ? AND b.user_id = ?
        LIMIT 1
    `).get(requesterId, peerId);

    return !!group;
}

module.exports = {
    getIdentityKeyHistory,
    canViewIdentityKeyHistory,
    fingerprintOf,
};