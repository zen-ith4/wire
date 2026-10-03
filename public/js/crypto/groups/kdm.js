// public/js/crypto/groups/kdm.js
//
// A KDM is: a Sender Key's 32 raw bytes, pairwise-wrapped with the
// existing DM ECDH+AES-GCM session key (keys/session.js) for exactly
// one recipient. This module is the only place that does that
// wrapping/unwrapping — it never generates or persists Sender Keys
// itself (sender-key.js does that) and never talks to the server
// (the caller POSTs/GETs group_key_distributions rows; see
// api.js).
//
// plan_prompt.md 2.1: "the sender's own device must also send a KDM
// to itself... Treat 'self' as just another recipient in the fan-out
// loop — no special-casing required." distributeSenderKey() below
// does exactly that: it has no branch for "is this recipient me?",
// it just wraps for every user_id it's given. The caller (rotation.js)
// is what ensures the sender's own user_id is present in that list.

import { getOrCreateSessionKey } from '../keys/session.js';
import { encryptBytes, decryptBytes } from './aead.js';
import { zero } from './codec.js';
import { storeReceivedSenderKey } from './sender-key.js';
import { deriveSenderKeyId } from './sender-key-id.js';

/**
 * Wraps one Sender Key for one recipient.
 *
 * @param {Uint8Array} rawSenderKeyBytes
 * @param {number} recipientUserId
 * @returns {Promise<string>} JSON string — this is exactly what goes
 *   in group_key_distributions.wrapped_key; the server only ever
 *   sees this opaque string.
 */
export async function wrapSenderKeyForRecipient(rawSenderKeyBytes, recipientUserId) {
    const sessionKey = await getOrCreateSessionKey(recipientUserId);
    const envelope = await encryptBytes(sessionKey, rawSenderKeyBytes);

    return JSON.stringify({
        v: 2,
        alg: 'AES-GCM',
        iv: envelope.iv,
        ciphertext: envelope.ciphertext,
    });
}

/**
 * Wraps one Sender Key for every recipient in `recipientUserIds`
 * (which must include the sender's own user_id for self-KDM — see
 * the module doc comment above). Recipients are wrapped in parallel
 * since each is an independent pairwise ECDH + AES-GCM operation
 * with no shared state.
 *
 * @param {Uint8Array} rawSenderKeyBytes
 * @param {number[]} recipientUserIds
 * @returns {Promise<Array<{user_id: number, wrapped_key: string}>>}
 *   Ready to POST as the `recipients` array to
 *   POST /api/groups/:groupId/kdms.
 */
export async function distributeSenderKey(rawSenderKeyBytes, recipientUserIds) {
    if (!Array.isArray(recipientUserIds) || recipientUserIds.length === 0) {
        throw new Error('At least one recipient is required');
    }

    const uniqueIds = [...new Set(recipientUserIds.map(Number))];

    return Promise.all(
        uniqueIds.map(async (userId) => ({
            user_id: userId,
            wrapped_key: await wrapSenderKeyForRecipient(rawSenderKeyBytes, userId),
        }))
    );
}

/**
 * Unwraps a KDM's wrapped_key back into the raw Sender Key bytes.
 *
 * @param {string} wrappedKeyJson the group_key_distributions row's
 *   wrapped_key field, verbatim
 * @param {number} fromUserId the KDM's from_user_id — whose pairwise
 *   session key was used to wrap it. For a self-KDM this is the same
 *   as the current user's own id, which session.js handles the same
 *   as any other peer (an identity ECDH'd with itself is still a
 *   well-defined, deterministic X25519 operation).
 * @returns {Promise<Uint8Array>} raw Sender Key bytes (32 bytes) —
 *   caller is responsible for importing + zeroing per sender-key.js.
 */
export async function unwrapKdm(wrappedKeyJson, fromUserId) {
    const { rawBytes } = await unwrapKdmDetailed(wrappedKeyJson, fromUserId);
    return rawBytes;
}

/**
 * Same as unwrapKdm but also reports the KDM version (always 2: it is the
 * only format).
 */
export async function unwrapKdmDetailed(wrappedKeyJson, fromUserId) {
    let envelope;

    try {
        envelope = JSON.parse(wrappedKeyJson);
    } catch {
        throw new Error('Malformed KDM payload');
    }

    if (envelope?.v !== 2 || envelope?.alg !== 'AES-GCM') {
        throw new Error('Unsupported KDM version/algorithm');
    }

    const sessionKey = await getOrCreateSessionKey(fromUserId);
    const rawBytes = await decryptBytes(sessionKey, envelope);

    if (rawBytes.length !== 32) {
        throw new Error('Unwrapped KDM is not a valid AES-256 key');
    }

    return { rawBytes, version: envelope.v };
}

/**
 * Full receive path for one row out of GET /api/groups/kdms (see
 * groupKdm.service.js): unwrap it, then hand the raw bytes to
 * sender-key.js to import + persist (wrapped, per 2.3) under this
 * device's local key store. Idempotent to call twice for the same
 * row — sender-key.js's storage is a put-by-id, so re-consuming an
 * already-known senderKeyId just re-derives the same CryptoKey and
 * overwrites the same wrapped record with an equivalent one.
 *
 * The caller (Phase 3's KDM-drain flow) still owns marking the row
 * delivered via POST /api/groups/kdms/ack — deliberately not done
 * here, so a crash between unwrap and persist doesn't lose the row:
 * it's only acked once actually stored.
 *
 * @param {object} identity {privateKey, publicKey, userId}
 * @param {object} kdmRow one row from the drain endpoint:
 *   {group_id, from_user_id, to_user_id, wrapped_key, epoch}
 * @returns {Promise<{senderKeyId: string}>}
 */
export async function receiveKdm(identity, kdmRow) {
    const { rawBytes } = await unwrapKdmDetailed(kdmRow.wrapped_key, kdmRow.from_user_id);

    try {
        const senderKeyId = await deriveSenderKeyId(kdmRow.group_id, kdmRow.from_user_id, kdmRow.epoch, rawBytes);

        await storeReceivedSenderKey(identity, {
            senderKeyId,
            groupId: kdmRow.group_id,
            ownerUserId: kdmRow.from_user_id,
            epoch: kdmRow.epoch,
        }, rawBytes);

        return { senderKeyId };
    } finally {
        zero(rawBytes);
    }
}
