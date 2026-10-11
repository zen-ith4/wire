// public/js/crypto/messages/group-message-crypto.js
//
// The public/js/crypto/groups/* modules (Phase 2) are deliberately
// identity-agnostic — every function takes an explicit
// {privateKey, publicKey, userId} rather than reading a module
// singleton, so they stay testable in isolation (see
// tests/groups/*). This file is the one place that bridges that to
// the app's actual singletons (identity-service.js's unlocked
// identity + core/auth.js's current user) and adds the REST
// orchestration (rotate-and-POST-KDMs, drain-and-ack) the UI layer
// calls into. Mirrors messages/message-crypto.js's role for DMs.

import { getCurrentIdentity } from '../identity-service.js';
import { getCurrentUser } from '../../core/auth.js';
import { api } from '../../core/api.js';

import {
    encryptGroupMessage,
    decryptGroupMessage,
    decryptGroupMessageDetailed,
    MissingSenderKeyError,
    ReplayedMessageError,
    UnverifiedMessageError,
} from '../groups/message-crypto.js';
import { rotateSenderKey } from '../groups/rotation.js';
import { receiveKdm } from '../groups/kdm.js';
import { getMySenderKey } from '../groups/sender-key.js';
import { deleteAllSenderKeysForGroup, getOrCreateDeviceId } from '../groups/sender-key-store.js';

export { MissingSenderKeyError, ReplayedMessageError, UnverifiedMessageError };

export function getGroupIdentity() {
    const identity = getCurrentIdentity();
    if (!identity) {
        throw new Error('Your encryption key is locked — unlock it to use groups');
    }

    const user = getCurrentUser();
    if (!user || !Number.isInteger(Number(user.id)) || Number(user.id) <= 0) {
        throw new Error('Not signed in');
    }

    return { ...identity, userId: Number(user.id) };
}

export async function encryptOutgoingGroupMessage(groupId, plaintext, options = {}) {
    return encryptGroupMessage(getGroupIdentity(), groupId, plaintext, options);
}

export async function decryptIncomingGroupMessage(groupId, envelopeJson, messageId, expect = {}) {
    return decryptGroupMessage(getGroupIdentity(), groupId, envelopeJson, messageId, expect);
}

/**
 * {plaintext, senderKeyId, ownerUserId, replyToId}: senderKeyId is the id of the key that
 * actually decrypted it, ownerUserId the owner of the key whose signature VERIFIED, and
 * replyToId the SIGNED reply target. `expect` = {expectedSenderId?, serverReplyToId?}
 * are the server's claims, checked after the signature and before the nonce is claimed.
 */
export async function decryptIncomingGroupMessageDetailed(groupId, envelopeJson, messageId, expect = {}) {
    return decryptGroupMessageDetailed(getGroupIdentity(), groupId, envelopeJson, messageId, expect);
}

/**
 * Reads the `senderKeyId` out of a group message envelope
 * (group_messages.content, verbatim) WITHOUT decrypting anything.
 *
 * Intended to be called only AFTER decryptIncomingGroupMessage() has
 * succeeded on the same envelope: decryptGroupMessage() selects the
 * AES key by this very id, so a successful decrypt proves the id is
 * the one that actually authenticated this message (a tampered id
 * would load a different/missing key and fail GCM auth). That is what
 * makes it safe for the group decorate() hook to expose it on the
 * decorated message for attachment decryption — see group.js's
 * decorateGroupMessages().
 *
 * @param {string} envelopeJson
 * @returns {string} the Sender Key id
 * @throws {Error} on a malformed envelope / missing id
 */
export function readEnvelopeSenderKeyId(envelopeJson) {
    let envelope;

    try {
        envelope = JSON.parse(envelopeJson);
    } catch {
        throw new Error('Malformed group message envelope');
    }

    if (typeof envelope?.senderKeyId !== 'string' || !envelope.senderKeyId) {
        throw new Error('Missing senderKeyId');
    }

    return envelope.senderKeyId;
}

/**
 * Makes sure this device has a Sender Key it can send with, current
 * as of `epoch` (the caller's own group_members.key_epoch row from
 * GET /api/groups). If it already does, this is a no-op — no needless
 * rotation on every message send, only when actually missing one
 * (first send ever in this group on this device) or behind
 * (`mine.epoch !== epoch`, e.g. this device missed a membership-
 * change rotation while offline).
 *
 * @param {number} groupId
 * @param {number[]} memberUserIds current group membership — MUST
 *   include the current user's own id (self-KDM, see rotation.js);
 *   callers pass the live member list from GET
 *   /api/groups/:groupId/members.
 * @param {number} epoch
 * @returns {Promise<boolean>} true if a rotation actually happened
 */
export async function ensureSenderKeyForGroup(groupId, memberUserIds, epoch) {
    const identity = getGroupIdentity();

    // Cross-TAB mutual exclusion. Tabs of one browser profile share
    // IndexedDB but not JS heaps, so group.js's in-memory in-flight map
    // cannot stop two tabs from both seeing "no key yet" and both minting
    // and distributing one (MD-5). Web Locks are shared across tabs of an
    // origin; the check is repeated inside the lock so the second tab finds
    // the first tab's key and returns.
    const run = async () => {
        const mine = await getMySenderKey(identity, groupId);

        if (mine && mine.epoch === epoch) {
            return false;
        }

        // Phase C: `mine` only exists when this device has an OWN row with a usable
        // signing private key (getMySenderKey), so a row without one triggers a
        // re-key here. The commit below (after the 201, under this lock) also drops
        // the signing keys of the keys it supersedes.
        // F1 / MD-6: the new key is held in memory only. It is written to
        // IndexedDB AFTER the server confirmed the KDM batch (201), so:
        //  - fetch throws            -> nothing was ever persisted, discard;
        //  - process dies mid-POST   -> nothing on disk, the next call mints
        //                               and distributes a fresh key;
        //  - POST ok, process dies   -> recipients hold a key this device lost;
        //    before persist             the next call mints another (harmless:
        //                               v2 ids are per key, nonces per key).
        const pending = await rotateSenderKey(identity, groupId, epoch, memberUserIds, { deferPersist: true });

        try {
            await api(`/api/groups/${groupId}/kdms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ epoch, recipients: pending.recipients }),
            });
        } catch (e) {
            pending.discard();
            throw e;
        }

        await pending.commit();

        return true;
    };

    const lockName = `wire-group-key-ensure:${identity.userId}:${groupId}`;
    if (globalThis.navigator?.locks?.request) {
        return navigator.locks.request(lockName, run);
    }
    return run();
}

// Random per-browser-PROFILE id (shared by all tabs, distinct per browser
// or device), stored next to the keys (sender-key-store.js). It is only a
// mailbox cursor: it lets the server hand each device the KDMs THAT device
// has not consumed yet (MD-4). It is mandatory: the server rejects
// drain/ack without it.
export async function getGroupDeviceId() {
    return getOrCreateDeviceId();
}

/**
 * Drains this account's undelivered KDM mailbox (every group, or one
 * group if `groupId` is given), consuming and locally storing every
 * Sender Key found, then acking only the rows actually stored — a
 * row that fails to consume (malformed, or wrapped for a peer whose
 * public key couldn't be fetched) is left unacked rather than lost,
 * so the next drain (e.g. after reconnecting) tries it again instead
 * of silently giving up on that Sender Key forever.
 *
 * @param {number|null} [groupId]
 * @returns {Promise<number>} how many KDMs were newly consumed
 */
export async function drainGroupKdms(groupId = null) {
    const identity = getGroupIdentity();
    const deviceId = await getGroupDeviceId();
    const params = [`device_id=${encodeURIComponent(deviceId)}`];
    if (groupId != null) params.push(`group_id=${encodeURIComponent(groupId)}`);
    const qs = `?${params.join('&')}`;
    const rows = await api(`/api/groups/kdms${qs}`);

    if (!Array.isArray(rows) || rows.length === 0) {
        return 0;
    }

    const consumedIds = [];
    const failedIds = [];
    const failureKinds = new Map();

    for (const row of rows) {
        try {
            await receiveKdm(identity, row);
            consumedIds.push(row.id);
        } catch (e) {
            // Left UNACKED on purpose (see above): never lost, retried by the next
            // drain. A legacy (pre-signing) or otherwise unusable KDM must not
            // flood the console on every drain, so failures are summarised in ONE
            // line per drain below.
            failedIds.push(row.id);
            const kind = e?.name || 'Error';
            failureKinds.set(kind, (failureKinds.get(kind) || 0) + 1);
        }
    }

    if (failedIds.length > 0) {
        console.warn(
            `[group-e2ee] ${failedIds.length} KDM(s) could not be consumed and were left unacked ` +
            `(${[...failureKinds].map(([k, n]) => `${k}: ${n}`).join(', ')}); first id ${failedIds[0]}`
        );
    }

    if (consumedIds.length > 0) {
        await api('/api/groups/kdms/ack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: consumedIds, device_id: deviceId }),
        });
    }

    return consumedIds.length;
}

/**
 * Wipes every locally-stored Sender Key for a group this device no
 * longer belongs to (left, or removed by someone else) — called from
 * the group:membership-changed handler (see group.js) so no key
 * material for a group we're no longer in sits in IndexedDB
 * indefinitely. Safe no-op if nothing was stored.
 */
export async function forgetGroupKeys(groupId) {
    await deleteAllSenderKeysForGroup(groupId);
}
