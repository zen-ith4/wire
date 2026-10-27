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

import { getOrCreateGroupKdmKey } from '../keys/session.js';
import { encryptBytes, decryptBytes } from './aead.js';
import { zero, encodeFields } from './codec.js';
import { storeReceivedSenderKey } from './sender-key.js';
import { deriveSenderKeyId } from './sender-key-id.js';
import { importVerifyKey } from './signing.js';

const KDM_VERSION = 2;

// Phase C: the KDM plaintext is root(32) || signPub(65, uncompressed P-256 point
// 0x04||X||Y) = 97 bytes, inside the AES-GCM that is already bound (AAD) to the
// group, sender, recipient, epoch and version. A 32-byte plaintext is the
// pre-signing format.
const ROOT_LENGTH = 32;
const SIGN_PUB_LENGTH = 65;
const KDM_PAYLOAD_LENGTH = ROOT_LENGTH + SIGN_PUB_LENGTH;

/** A KDM whose plaintext is not exactly root(32)||signPub(65) with a 0x04 point prefix. */
export class KdmFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = 'KdmFormatError';
    }
}

/** A pre-signing KDM (32-byte plaintext): unusable, never acked, test groups must be recreated. */
export class LegacyKdmError extends KdmFormatError {
    constructor() {
        super('Legacy KDM format (no signing key); recreate the group');
        this.name = 'LegacyKdmError';
    }
}

/**
 * additionalData of a KDM wrap: binds the wrapped key to the group, sender,
 * recipient, epoch and format version it was made for, so the server cannot
 * relabel a row (move it to another group/epoch/recipient or pass it off as
 * coming from someone else). senderKeyId is NOT in here: it is derived from
 * the key after unwrapping (it would be circular).
 */
export function kdmAad({ groupId, fromUserId, toUserId, epoch }) {
    return encodeFields(
        'group-kdm-v2',
        Number(groupId),
        Number(fromUserId),
        Number(toUserId),
        Number(epoch),
        KDM_VERSION
    );
}

/**
 * Wraps one Sender Key (root + its signing public key) for one recipient.
 *
 * @param {Uint8Array} rawSenderKeyBytes the 32-byte root
 * @param {Uint8Array} signPub the 65-byte raw signing public key
 * @param {number} recipientUserId
 * @param {{groupId: number, fromUserId: number, epoch: number}} context
 * @returns {Promise<string>} JSON string — this is exactly what goes
 *   in group_key_distributions.wrapped_key; the server only ever
 *   sees this opaque string.
 */
export async function wrapSenderKeyForRecipient(rawSenderKeyBytes, signPub, recipientUserId, context) {
    if (!(rawSenderKeyBytes instanceof Uint8Array) || rawSenderKeyBytes.length !== ROOT_LENGTH) {
        throw new KdmFormatError('Sender Key root must be 32 bytes');
    }

    if (!(signPub instanceof Uint8Array) || signPub.length !== SIGN_PUB_LENGTH || signPub[0] !== 0x04) {
        throw new KdmFormatError('Signing public key must be 65 bytes, uncompressed');
    }

    const payload = new Uint8Array(KDM_PAYLOAD_LENGTH);
    payload.set(rawSenderKeyBytes, 0);
    payload.set(signPub, ROOT_LENGTH);

    let envelope;
    try {
        const wrapKey = await getOrCreateGroupKdmKey(recipientUserId);
        envelope = await encryptBytes(
            wrapKey,
            payload,
            undefined,
            kdmAad({ ...context, toUserId: recipientUserId })
        );
    } finally {
        zero(payload);
    }

    return JSON.stringify({
        v: KDM_VERSION,
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
 * R1 send-side policy (D1b): a recipient whose identity key no longer matches
 * this device's pin is SKIPPED, not allowed to fail the whole distribution and
 * not given a KDM. The group keeps working for everyone else, including the
 * removal-rotation path. The changed peer is recorded by peer-key-gate.js and
 * shown as "not receiving"; after the user accepts the new key the caller
 * performs a forced rotation (group-message-crypto.js) which wraps to them
 * again. Any other failure is still fatal: it is not a trust decision.
 *
 * @param {Uint8Array} rawSenderKeyBytes
 * @param {Uint8Array} signPub
 * @param {number[]} recipientUserIds
 * @param {{groupId: number, fromUserId: number, epoch: number}} context
 * @returns {Promise<{
 *   recipients: Array<{user_id: number, wrapped_key: string}>,
 *   skipped: Array<{user_id: number, reason: string}>
 * }>} `recipients` is ready to POST as the `recipients` array to
 *   POST /api/groups/:groupId/kdms.
 */
export async function distributeSenderKey(rawSenderKeyBytes, signPub, recipientUserIds, context) {
    if (!Array.isArray(recipientUserIds) || recipientUserIds.length === 0) {
        throw new Error('At least one recipient is required');
    }

    const uniqueIds = [...new Set(recipientUserIds.map(Number))];

    const results = await Promise.all(
        uniqueIds.map(async (userId) => {
            try {
                return {
                    ok: true,
                    recipient: {
                        user_id: userId,
                        wrapped_key: await wrapSenderKeyForRecipient(rawSenderKeyBytes, signPub, userId, context),
                    },
                };
            } catch (e) {
                if (e?.code === 'GROUP_PEER_KEY_CHANGED') {
                    return {
                        ok: false,
                        skipped: {
                            user_id: userId,
                            reason: 'peer-key-changed',
                        },
                    };
                }
                throw e;
            }
        })
    );

    const recipients = [];
    const skipped = [];

    for (const result of results) {
        if (result.ok) recipients.push(result.recipient);
        else skipped.push(result.skipped);
    }

    return { recipients, skipped };
}

/**
 * Unwraps a KDM's wrapped_key back into the raw Sender Key bytes.
 *
 * @param {string} wrappedKeyJson the group_key_distributions row's
 *   wrapped_key field, verbatim
 * @param {{groupId: number, fromUserId: number, toUserId: number, epoch: number}} context
 *   taken from the server row; they are authenticated as AAD, so a row the
 *   server relabelled fails here. For a self-KDM fromUserId equals toUserId
 *   (an identity ECDH'd with itself is a well-defined X25519 operation).
 * @returns {Promise<Uint8Array>} raw Sender Key bytes (32 bytes) —
 *   caller is responsible for importing + zeroing per sender-key.js.
 * @throws {KdmFormatError|LegacyKdmError} on any structural problem (fail closed)
 */
export async function unwrapKdm(wrappedKeyJson, context) {
    const { rawBytes } = await unwrapKdmDetailed(wrappedKeyJson, context);
    return rawBytes;
}

/**
 * Same as unwrapKdm but also returns the signing public key carried in the KDM
 * (65 raw bytes) and the KDM version (always 2: it is the only format).
 * Fails closed: wrong plaintext length, a first point byte other than 0x04 and a
 * point that is not on the curve all throw before the caller can store anything.
 */
export async function unwrapKdmDetailed(wrappedKeyJson, context) {
    let envelope;

    try {
        envelope = JSON.parse(wrappedKeyJson);
    } catch {
        throw new Error('Malformed KDM payload');
    }

    if (envelope?.v !== KDM_VERSION || envelope?.alg !== 'AES-GCM') {
        throw new Error('Unsupported KDM version/algorithm');
    }

    // The pairwise key of the CLAIMED sender (context.fromUserId = the row's
    // from_user_id): a KDM that was not wrapped by that sender fails here, before
    // anything is parsed or stored.
    const wrapKey = await getOrCreateGroupKdmKey(context.fromUserId);
    const payload = await decryptBytes(wrapKey, envelope, kdmAad(context));

    try {
        if (payload.length === ROOT_LENGTH) {
            throw new LegacyKdmError();
        }

        if (payload.length !== KDM_PAYLOAD_LENGTH) {
            throw new KdmFormatError('Unwrapped KDM has an invalid length');
        }

        if (payload[ROOT_LENGTH] !== 0x04) {
            throw new KdmFormatError('KDM signing public key is not an uncompressed point');
        }

        const signPub = payload.slice(ROOT_LENGTH);

        try {
            await importVerifyKey(signPub);
        } catch {
            throw new KdmFormatError('KDM signing public key is not a valid P-256 point');
        }

        return { rawBytes: payload.slice(0, ROOT_LENGTH), signPub, version: envelope.v };
    } finally {
        zero(payload);
    }
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
    const { rawBytes, signPub } = await unwrapKdmDetailed(kdmRow.wrapped_key, {
        groupId: kdmRow.group_id,
        fromUserId: kdmRow.from_user_id,
        toUserId: kdmRow.to_user_id,
        epoch: kdmRow.epoch,
    });

    try {
        // The id commits to (root, group, owner, epoch, signPub), where the owner is
        // the sender whose pairwise key just unwrapped this KDM.
        const senderKeyId = await deriveSenderKeyId(kdmRow.group_id, kdmRow.from_user_id, kdmRow.epoch, rawBytes, signPub);

        await storeReceivedSenderKey(identity, {
            senderKeyId,
            groupId: kdmRow.group_id,
            ownerUserId: kdmRow.from_user_id,
            epoch: kdmRow.epoch,
            signPub,
        }, rawBytes);

        return { senderKeyId };
    } finally {
        zero(rawBytes);
    }
}
