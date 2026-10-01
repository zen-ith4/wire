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
} from '../groups/message-crypto.js';
import { rotateSenderKey } from '../groups/rotation.js';
import { receiveKdm } from '../groups/kdm.js';
import { getMySenderKey, forgetSenderKey } from '../groups/sender-key.js';
import { deleteAllSenderKeysForGroup } from '../groups/sender-key-store.js';

export { MissingSenderKeyError };

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

export async function encryptOutgoingGroupMessage(groupId, plaintext) {
    return encryptGroupMessage(getGroupIdentity(), groupId, plaintext);
}

export async function decryptIncomingGroupMessage(groupId, envelopeJson) {
    return decryptGroupMessage(getGroupIdentity(), envelopeJson);
}

/** {plaintext, senderKeyId} where senderKeyId is the id of the key that actually decrypted it. */
export async function decryptIncomingGroupMessageDetailed(groupId, envelopeJson) {
    return decryptGroupMessageDetailed(getGroupIdentity(), envelopeJson);
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

        const { senderKeyId, recipients } = await rotateSenderKey(identity, groupId, epoch, memberUserIds);

        try {
            await api(`/api/groups/${groupId}/kdms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ epoch, recipients }),
            });
        } catch (e) {
            // Distribution failed, so nobody else can ever read this key.
            // Left in place it would be selected as "current" (its epoch
            // matches), the next call would return false without retrying,
            // and every message would be undecryptable for the group
            // (MD-6). Discard it so the next call starts clean.
            try { await forgetSenderKey(senderKeyId); } catch { /* best effort */ }
            throw e;
        }

        return true;
    };

    const lockName = `wire-group-key-ensure:${identity.userId}:${groupId}`;
    if (globalThis.navigator?.locks?.request) {
        return navigator.locks.request(lockName, run);
    }
    return run();
}

// Random per-browser-PROFILE id (shared by all tabs, distinct per browser
// or device). It is only a mailbox cursor: it lets the server hand each
// device the KDMs THAT device has not consumed yet, instead of treating the
// first device's ack as delivery to every device of the account (MD-4).
const DEVICE_ID_KEY = 'wire:group-device-id';

export function getGroupDeviceId() {
    try {
        let id = globalThis.localStorage?.getItem(DEVICE_ID_KEY);
        if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
            const bytes = crypto.getRandomValues(new Uint8Array(16));
            id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
            globalThis.localStorage?.setItem(DEVICE_ID_KEY, id);
        }
        return id;
    } catch {
        // No storage: fall back to legacy per-account delivery.
        return null;
    }
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
    const deviceId = getGroupDeviceId();
    const params = [];
    if (groupId != null) params.push(`group_id=${encodeURIComponent(groupId)}`);
    if (deviceId) params.push(`device_id=${encodeURIComponent(deviceId)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    const rows = await api(`/api/groups/kdms${qs}`);

    if (!Array.isArray(rows) || rows.length === 0) {
        return 0;
    }

    const consumedIds = [];

    for (const row of rows) {
        try {
            await receiveKdm(identity, row);
            consumedIds.push(row.id);
        } catch (e) {
            console.error('Failed to consume group KDM', row.id, e);
        }
    }

    if (consumedIds.length > 0) {
        await api('/api/groups/kdms/ack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: consumedIds, ...(deviceId ? { device_id: deviceId } : {}) }),
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
