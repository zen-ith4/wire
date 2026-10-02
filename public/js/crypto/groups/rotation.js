// public/js/crypto/groups/rotation.js
//
// Ties sender-key.js (generate/persist) and kdm.js (distribute)
// together for the two moments plan_prompt.md Section 3 calls out:
//
// - step 1: a member's first send in a group ever (no Sender Key
//   exists locally yet).
// - step 4: a member was removed/left — every *remaining* member
//   must rotate to a new Sender Key and redistribute it to the
//   now-smaller membership (including themselves, per 2.1).
//
// Both are "generate a new key, then fan it out to `recipientUserIds`"
// — the only difference is which epoch the server expects and who's
// in the recipient list. This module doesn't decide *when* to
// rotate or *who's* currently a member (that's server/UI state —
// Phase 3 wires group:membership-changed and key_epoch checks to
// this); it just does the generate+fan-out mechanics correctly once
// told to.

import { generateSenderKey } from './sender-key.js';
import { distributeSenderKey } from './kdm.js';
import { zero } from './codec.js';

/**
 * @param {object} identity {privateKey, publicKey, userId}
 * @param {number} groupId
 * @param {number} epoch the epoch this new Sender Key belongs to —
 *   the caller reads this from group_members.key_epoch (their own
 *   row) so it matches what the server expects on the KDM POST.
 * @param {number[]} recipientUserIds current group membership,
 *   MUST include identity.userId (self-KDM — 2.1). Callers pass the
 *   group's live member list; this function doesn't second-guess it.
 * @returns {Promise<{senderKeyId: string, recipients: Array<{user_id: number, wrapped_key: string}>}>}
 *   `recipients` is exactly the `recipients` array
 *   POST /api/groups/:groupId/kdms expects, alongside `epoch`.
 */
export async function rotateSenderKey(identity, groupId, epoch, recipientUserIds) {
    if (!recipientUserIds.map(Number).includes(Number(identity.userId))) {
        throw new Error(
            'recipientUserIds must include the sender\'s own user id (self-KDM)'
        );
    }

    const { senderKeyId, rawBytes } = await generateSenderKey(identity, groupId, epoch);

    try {
        const recipients = await distributeSenderKey(rawBytes, recipientUserIds);
        return { senderKeyId, recipients };
    } finally {
        zero(rawBytes);
    }
}
