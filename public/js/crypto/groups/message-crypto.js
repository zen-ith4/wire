// public/js/crypto/groups/message-crypto.js
//
// Encrypts/decrypts actual group message text with a Sender Key
// (Section 3, step 3). Deliberately does NOT use a random IV the way
// messages/encrypt.js does for DMs — a Sender Key is shared by
// however many tabs/sessions the owning device has open, so nonce
// uniqueness can't rely on randomness alone (a big enough group chat
// really can send fast enough for two random 96-bit IVs to collide
// over a key's lifetime, and correctness here shouldn't depend on
// "probably fine"). Instead the nonce is built deterministically
// from the per-Sender-Key counter that nonce-lock.js reserves under
// a Web Lock — see plan_prompt.md 2.2.

import { encryptBytes, decryptBytes } from './aead.js';
import { reserveNextCounter } from './nonce-lock.js';
import { getMySenderKey, loadSenderKey } from './sender-key.js';

const ENVELOPE_VERSION = 1;

/**
 * 12-byte AES-GCM nonce from a monotonic counter: 4 zero bytes
 * (reserved) + the counter as an 8-byte big-endian integer. A
 * Sender Key is never reused across rotations (sender-key.js always
 * mints a fresh random key + id on rotation, and nonce-lock.js's
 * lock/counter start over at 0 under the new key's own lock name —
 * see 2.2), so "same key, same counter" can only happen if this
 * function is ever called with an unreserved counter, which callers
 * here never do.
 */
export function nonceFromCounter(counter) {
    if (!Number.isInteger(counter) || counter < 0) {
        throw new Error('Invalid counter');
    }

    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);

    // Counter fits in the low 8 bytes; JS safe integers (2^53) are
    // far below what an 8-byte counter can hold, so split into two
    // 32-bit big-endian words rather than using BigInt for a value
    // that will never be that large in practice.
    const high = Math.floor(counter / 0x100000000);
    const low = counter >>> 0;

    view.setUint32(4, high);
    view.setUint32(8, low);

    return iv;
}

/**
 * @param {object} identity {privateKey, publicKey, userId}
 * @param {number} groupId
 * @param {string} plaintext
 * @returns {Promise<string>} JSON string ready to send as
 *   group_messages.content
 */
export async function encryptGroupMessage(identity, groupId, plaintext) {
    if (typeof plaintext !== 'string' || !plaintext.length) {
        throw new Error('Message cannot be empty');
    }

    const mine = await getMySenderKey(identity, groupId);

    if (!mine) {
        throw new Error(
            'No Sender Key to send with yet — rotate/distribute one first'
        );
    }

    const counter = await reserveNextCounter(mine.senderKeyId);
    const nonce = nonceFromCounter(counter);
    const plaintextBytes = new TextEncoder().encode(plaintext);

    const { iv, ciphertext } = await encryptBytes(mine.cryptoKey, plaintextBytes, nonce);

    return JSON.stringify({
        v: ENVELOPE_VERSION,
        alg: 'AES-GCM',
        senderKeyId: mine.senderKeyId,
        counter,
        iv,
        ciphertext,
    });
}

export class MissingSenderKeyError extends Error {
    constructor(senderKeyId) {
        super(`No local Sender Key for id ${senderKeyId}`);
        this.name = 'MissingSenderKeyError';
        this.senderKeyId = senderKeyId;
    }
}

/**
 * @param {object} identity {privateKey, publicKey, userId}
 * @param {string} envelopeJson group_messages.content, verbatim
 * @returns {Promise<string>} plaintext
 * @throws {MissingSenderKeyError} if this device has never received
 *   a KDM for the message's Sender Key — the UI layer (Phase 3)
 *   should treat this as "self-heal": re-drain/re-request KDMs
 *   rather than treating it as a hard failure, since a member who
 *   only just joined, or who missed one KDM, is an expected case
 *   (plan_prompt.md's acceptance checklist: "losing one member's KDM
 *   doesn't corrupt the group for everyone else").
 */
export async function decryptGroupMessage(identity, envelopeJson) {
    const { plaintext } = await decryptGroupMessageDetailed(identity, envelopeJson);
    return plaintext;
}

/**
 * Same as decryptGroupMessage, but also returns the senderKeyId that was
 * actually handed to the key lookup for THIS decrypt. The id is parsed once
 * and that one value both selects the key and is reported, so the reported
 * id is by construction the id of the key that authenticated the message
 * (no second parse of the envelope that could disagree with the first).
 *
 * @returns {Promise<{plaintext: string, senderKeyId: string}>}
 */
export async function decryptGroupMessageDetailed(identity, envelopeJson) {
    let envelope;

    try {
        envelope = JSON.parse(envelopeJson);
    } catch {
        throw new Error('Malformed group message envelope');
    }

    if (envelope?.v !== ENVELOPE_VERSION || envelope?.alg !== 'AES-GCM') {
        throw new Error('Unsupported group message envelope');
    }

    if (typeof envelope.senderKeyId !== 'string' || !envelope.senderKeyId) {
        throw new Error('Missing senderKeyId');
    }

    const senderKeyId = envelope.senderKeyId;
    const cryptoKey = await loadSenderKey(identity, senderKeyId);

    if (!cryptoKey) {
        throw new MissingSenderKeyError(senderKeyId);
    }

    const plaintextBytes = await decryptBytes(cryptoKey, envelope);

    return {
        plaintext: new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes),
        senderKeyId,
    };
}
