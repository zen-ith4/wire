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
import { base64ToBytes, bytesToBase64, encodeFields } from './codec.js';
import { reserveNextCounter, getNoncePrefix } from './nonce-lock.js';
import { getMySenderKey, loadSenderKeyBundle } from './sender-key.js';
import { signMessage, verifyMessage, SIGNATURE_LENGTH } from './signing.js';
import { claimNonce } from './sender-key-store.js';

const ENVELOPE_VERSION = 2;
const IV_LENGTH = 12;

/**
 * 12-byte AES-GCM nonce = 4-byte per-process random prefix (nonce-lock.js,
 * F10) || 8-byte big-endian counter. The counter is reserved under a Web Lock
 * and persisted before use, so (key, counter) is unique per device; the random
 * prefix keeps nonces distinct even if a restored/cloned profile replays an
 * old counter. A receiver does not know the prefix: it reads it from the iv
 * and only checks that the LAST 8 bytes equal the envelope counter
 * (readNonce / the check in decryptGroupMessageDetailed).
 */
export function nonceFromCounter(counter, prefix) {
    if (!Number.isInteger(counter) || counter < 0 || counter > Number.MAX_SAFE_INTEGER) {
        throw new Error('Invalid counter');
    }

    if (!(prefix instanceof Uint8Array) || prefix.length !== 4) {
        throw new Error('Invalid nonce prefix');
    }

    const iv = new Uint8Array(IV_LENGTH);
    const view = new DataView(iv.buffer);

    iv.set(prefix, 0);
    view.setUint32(4, Math.floor(counter / 0x100000000));
    view.setUint32(8, counter >>> 0);

    return iv;
}

/** Splits an iv into its (unknown-to-the-receiver) prefix and its counter. */
export function readNonce(iv) {
    if (!(iv instanceof Uint8Array) || iv.length !== IV_LENGTH) {
        throw new Error('Invalid AES-GCM IV length');
    }

    const view = new DataView(iv.buffer, iv.byteOffset, iv.byteLength);
    const high = view.getUint32(4);

    if (high > 0x1fffff) {
        throw new Error('Counter out of range');
    }

    return { prefix: iv.slice(0, 4), counter: high * 0x100000000 + view.getUint32(8) };
}

/**
 * additionalData for group messages: binds the ciphertext to its group, its
 * Sender Key, its counter and its full iv, so none of them can be relabelled.
 */
export function messageAad(groupId, senderKeyId, counter, iv) {
    return encodeFields('group-msg-v2', Number(groupId), senderKeyId, counter, iv);
}

/** Same, for attachments (distinct label: a message can never pass as a file or vice versa). */
export function attachmentAad(groupId, senderKeyId, counter, iv) {
    return encodeFields('group-att-v2', Number(groupId), senderKeyId, counter, iv);
}

/**
 * @param {object} identity {privateKey, publicKey, userId}
 * @param {number} groupId
 * @param {string} plaintext
 * @returns {Promise<string>} JSON string ready to send as
 *   group_messages.content
 */
export async function encryptGroupMessage(identity, groupId, plaintext, { replyToId = null } = {}) {
    if (typeof plaintext !== 'string' || !plaintext.length) {
        throw new Error('Message cannot be empty');
    }

    if (replyToId !== null && !(Number.isSafeInteger(replyToId) && replyToId > 0)) {
        throw new Error('Invalid reply_to_id');
    }

    const mine = await getMySenderKey(identity, groupId);

    if (!mine) {
        throw new Error(
            'No Sender Key to send with yet — rotate/distribute one first'
        );
    }

    const counter = await reserveNextCounter(mine.senderKeyId);
    const nonce = nonceFromCounter(counter, getNoncePrefix());
    const plaintextBytes = new TextEncoder().encode(plaintext);

    const { iv, ciphertext } = await encryptBytes(
        mine.cryptoKey,
        plaintextBytes,
        nonce,
        messageAad(groupId, mine.senderKeyId, counter, nonce)
    );

    // Phase C3: sign what the receiver verifies BEFORE decrypting. The signing key
    // belongs to THIS device's Sender Key only. reply_to_id is part of the signed
    // bytes (and of the envelope); the attachment slot is empty (group attachments
    // are disabled: see UNBOUND_ENVELOPE_KEYS).
    const signature = await signMessage(mine.signKey, {
        groupId: Number(groupId),
        senderKeyId: mine.senderKeyId,
        counter,
        iv: nonce,
        ciphertext: base64ToBytes(ciphertext),
        replyToId,
        attachment: new Uint8Array(0),
    });

    return JSON.stringify({
        v: ENVELOPE_VERSION,
        alg: 'AES-GCM',
        senderKeyId: mine.senderKeyId,
        counter,
        iv,
        ciphertext,
        reply_to_id: replyToId,
        sig: bytesToBase64(signature),
    });
}

/**
 * Thrown for a message that must not be rendered because it cannot be attributed to
 * the owner of its Sender Key: no or malformed signature, a signature that does not
 * verify, a verified owner that is not the server's sender, a reply target that the
 * server contradicts, an unexpected attachment field, or a key that cannot verify.
 * PERMANENT: callers never retry it (only "key not arrived" is retried).
 * `reason` is a fixed enum, never message content.
 */
export class UnverifiedMessageError extends Error {
    constructor(reason, message) {
        super(message || `Group message authentication failed: could not be verified (${reason})`);
        this.name = 'UnverifiedMessageError';
        this.reason = reason;
        this.permanent = true;
    }
}

/**
 * Envelope fields that would carry attachment data. Group attachments are DISABLED
 * and the signed bytes only contain an EMPTY attachment slot, so an envelope that
 * carries any of these is unverified: attachment SENDING can only be enabled after
 * its bytes are bound into the signature (signing.js header), and this refusal makes
 * a half-wired attachment path fail loudly instead of passing unauthenticated.
 */
const UNBOUND_ENVELOPE_KEYS = ['att', 'attachment', 'attachments'];

/**
 * Thrown when a ciphertext authenticates correctly but its (senderKeyId, nonce)
 * was already accepted for a DIFFERENT message (F4): somebody re-posted stored
 * ciphertext under a fresh message id. The same message arriving again under
 * the same id is NOT a replay and never raises this.
 */
export class ReplayedMessageError extends Error {
    constructor(senderKeyId, counter) {
        super('Replayed group message rejected');
        this.name = 'ReplayedMessageError';
        this.senderKeyId = senderKeyId;
        this.counter = counter;
    }
}

/**
 * Records that (senderKeyId, nonce) was accepted for `ref`. Called only AFTER
 * authentication succeeded, so corrupt data never burns a nonce.
 * @param {Uint8Array} iv the full 12-byte nonce of the message / attachment
 * @param {string} ref e.g. "msg:123" or "att:123": stable per message
 */
export async function acceptNonceOnce(senderKeyId, iv, counter, ref) {
    if (typeof ref !== 'string' || ref.length < 5) {
        throw new Error('A message reference is required for replay protection');
    }

    const nonceHex = Array.from(iv, (b) => b.toString(16).padStart(2, '0')).join('');
    const status = await claimNonce({ senderKeyId, nonceHex, counter, ref });

    if (status === 'conflict') {
        throw new ReplayedMessageError(senderKeyId, counter);
    }
}

export function messageRef(messageId) {
    if (messageId === undefined || messageId === null || messageId === '') {
        throw new Error('A message id is required for replay protection');
    }
    return `msg:${messageId}`;
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
 * @param {number} groupId the group this message was delivered in (bound into the AAD)
 * @param {string} envelopeJson group_messages.content, verbatim
 * @param {string|number} messageId the SERVER message id this envelope came with
 *   (replay protection: the first id to claim a counter owns it)
 * @returns {Promise<string>} plaintext
 * @throws {MissingSenderKeyError} if this device has never received
 *   a KDM for the message's Sender Key — the UI layer (Phase 3)
 *   should treat this as "self-heal": re-drain/re-request KDMs
 *   rather than treating it as a hard failure, since a member who
 *   only just joined, or who missed one KDM, is an expected case
 *   (plan_prompt.md's acceptance checklist: "losing one member's KDM
 *   doesn't corrupt the group for everyone else").
 */
export async function decryptGroupMessage(identity, groupId, envelopeJson, messageId, expect = {}) {
    const { plaintext } = await decryptGroupMessageDetailed(identity, groupId, envelopeJson, messageId, expect);
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
export async function decryptGroupMessageDetailed(identity, groupId, envelopeJson, messageId, expect = {}) {
    const ref = messageRef(messageId);

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

    // The counter in the envelope is only a label for the nonce: it must be
    // exactly what the iv carries in its last 8 bytes. (The first 4 bytes are
    // the sender's random prefix, which we cannot predict.)
    if (!Number.isInteger(envelope.counter) || envelope.counter < 0) {
        throw new Error('Invalid group message counter');
    }

    let iv;
    let nonce;
    try {
        iv = base64ToBytes(envelope.iv);
        nonce = readNonce(iv);
    } catch {
        throw new Error('Invalid group message nonce');
    }

    if (nonce.counter !== envelope.counter) {
        throw new Error('Group message counter does not match its nonce');
    }

    // ---- Phase C3: structure of the signed envelope. Every problem is "unverified",
    // never an exception that could break a thread (fail closed).
    for (const key of UNBOUND_ENVELOPE_KEYS) {
        if (Object.hasOwn(envelope, key)) {
            throw new UnverifiedMessageError('attachment-not-bound');
        }
    }

    let signature;
    let ciphertextBytes;
    try {
        signature = base64ToBytes(envelope.sig);
        ciphertextBytes = base64ToBytes(envelope.ciphertext);
    } catch {
        throw new UnverifiedMessageError('no-signature');
    }

    if (typeof envelope.sig !== 'string' || signature.length !== SIGNATURE_LENGTH) {
        throw new UnverifiedMessageError('no-signature');
    }

    const signedReplyToId = envelope.reply_to_id;
    if (!Object.hasOwn(envelope, 'reply_to_id') ||
        (signedReplyToId !== null && !(Number.isSafeInteger(signedReplyToId) && signedReplyToId > 0))) {
        throw new UnverifiedMessageError('bad-reply-id');
    }

    let bundle;
    try {
        bundle = await loadSenderKeyBundle(identity, senderKeyId);
    } catch (e) {
        if (e?.permanent === true) throw new UnverifiedMessageError('key-unusable');
        throw e;
    }

    if (!bundle) {
        throw new MissingSenderKeyError(senderKeyId);
    }

    // VERIFY first: before the AES-GCM decrypt, before anything is rendered, and
    // before the nonce is claimed (a forgery must not burn a nonce).
    const valid = await verifyMessage(bundle.verifyKey, signature, {
        groupId: Number(groupId),
        senderKeyId,
        counter: envelope.counter,
        iv,
        ciphertext: ciphertextBytes,
        replyToId: signedReplyToId,
        attachment: new Uint8Array(0),
    });

    if (!valid) {
        throw new UnverifiedMessageError('bad-signature', 'Group message authentication failed: the signature does not verify');
    }

    // Attribution is the owner of the VERIFIED key, never the server's sender_id. The
    // server's sender_id must agree (an honest flow always does); otherwise this is a
    // re-post of somebody else's signed message or a server relabelling, and it is
    // refused BEFORE the nonce is claimed so it cannot burn the genuine message's nonce.
    const ownerUserId = Number(bundle.ownerUserId);

    if (expect.expectedSenderId !== undefined && Number(expect.expectedSenderId) !== ownerUserId) {
        throw new UnverifiedMessageError('sender-mismatch');
    }

    // The SIGNED reply target is authoritative. A non-null server value that differs
    // from it is a swap. A null server value with a signed target is allowed (the
    // target was deleted, or lives in another group and the server dropped it).
    if (expect.serverReplyToId !== undefined && expect.serverReplyToId !== null &&
        Number(expect.serverReplyToId) !== signedReplyToId) {
        throw new UnverifiedMessageError('reply-mismatch');
    }

    const plaintextBytes = await decryptBytes(
        bundle.cryptoKey,
        envelope,
        messageAad(groupId, senderKeyId, envelope.counter, iv)
    );

    // F4: only a message that AUTHENTICATED may claim its nonce.
    await acceptNonceOnce(senderKeyId, iv, envelope.counter, ref);

    return {
        plaintext: new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes),
        senderKeyId,
        ownerUserId,
        replyToId: signedReplyToId,
    };
}
