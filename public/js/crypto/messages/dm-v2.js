// public/js/crypto/messages/dm-v2.js
//
// Phase 1, STEP 1A. DM envelope v2: directional keys and an authenticated
// envelope. NEW AND UNWIRED - nothing imports this module yet. The v1 path
// (encrypt.js, decrypt.js, payload.js, key-derivation.js, session.js) is
// untouched and stays byte-identical.
//
// Implements docs/e2ee-dm-hardening.md section 3 (3.1 directional derivation,
// 3.3 AAD layout) and section 4.2 (the v2 envelope) exactly as written there.
// Two deliberate deviations are listed at the BOTTOM of this file under
// "DEVIATIONS FROM THE DESIGN DOC"; read them before trusting any of this.
//
// Why v2 exists at all (section 5.3): v1 uses ONE symmetric key per pair, so a
// server that rewrites senderId/recipientId to reflect an alice->bob message as
// bob->alice produces a message both sides accept. Two directional keys plus an
// AAD that commits to every header field makes that a cryptographic
// impossibility rather than a server mislabelling.
//
// ATTACHMENTS ARE NOT HERE. Section 3.3 also specifies a `dmAttachmentAad` under
// the label 'dm-att-v2'. It is deliberately NOT implemented: DM attachment
// encryption is not wired in this project at all (docs/PORT_NOTES.md), so an
// attachment AAD would be unreachable code asserting a guarantee nothing uses.
// attachment-crypto.js keeps its own key and gains no AAD.

import {
    deriveSessionKeyFromPeer
} from '../keys/key-derivation.js';
import {
    encodeFields,
    zero
} from '../groups/codec.js';

/* =========================================================
 * Constants
 *
 * The four HKDF infos named in section 3.1. The two v1/group ones are exported
 * so a test can assert all four are distinct and that none is a prefix of
 * another; this module never derives anything with them.
 * ========================================================= */

export const DM_V2_VERSION = 2;
export const DM_V2_ALGORITHM = 'AES-GCM';

export const DM_V2_IV_LENGTH = 12;
export const DM_V2_TAG_LENGTH = 128;
export const DM_V2_FINGERPRINT_LENGTH = 32;
export const DM_V2_MSG_ID_BYTES = 8;
export const DM_V2_MSG_ID_LENGTH = 16;
export const DM_V2_MAX_CIPHERTEXT_LENGTH = 64 * 1024;

/** lower-id -> higher-id */
export const DM_V2_INFO_A2B = 'Wire-E2EE-DM-v2-a2b';
/** higher-id -> lower-id */
export const DM_V2_INFO_B2A = 'Wire-E2EE-DM-v2-b2a';
/** Existing v1 info, unchanged. Named here for the distinctness test only. */
export const DM_V1_INFO = 'Wire-E2EE-v1';
/** Existing group KDM info, unchanged. Named here for the distinctness test only. */
export const GROUP_KDM_INFO = 'Wire-E2EE-Group-KDM-v2';

/** AAD protocol label. Fixed forever: changing it breaks every row ever written. */
const AAD_LABEL = 'dm-msg-v2';

/* =========================================================
 * Errors
 * ========================================================= */

/** An IV that has already been used under the same key. Never acceptable. */
export class DmV2IvReplayError extends Error {
    constructor(scope) {
        super('AES-GCM IV reuse: this nonce has already been used for this key');
        this.name = 'DmV2IvReplayError';
        this.scope = String(scope);
    }
}

export class DmV2ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DmV2ValidationError';
    }
}

/* =========================================================
 * Small helpers
 * ========================================================= */

function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new DmV2ValidationError('expected bytes');
}

function bytesToBase64(bytes) {
    const view = toBytes(bytes);
    let binary = '';
    for (const byte of view) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function base64ToBytes(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new DmV2ValidationError(`${name} is required`);
    }
    let binary;
    try {
        binary = atob(value);
    } catch {
        throw new DmV2ValidationError(`Invalid Base64 ${name}`);
    }
    if (binary.length === 0) {
        throw new DmV2ValidationError(`Empty Base64 ${name}`);
    }
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}

function requireUserId(value, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        throw new DmV2ValidationError(`Invalid ${name}`);
    }
    return n;
}

function requireVersion(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        throw new DmV2ValidationError('Invalid version');
    }
    return n;
}

/**
 * replyToId is the one numeric field that is legitimately 0, because 0 is what
 * the AAD encodes for "no reply" (section 3.3). Every other number must be a
 * positive integer, so a missing/garbage reply is caught rather than silently
 * becoming 0 and colliding with a real "no reply".
 */
function requireReplyToId(value) {
    if (value === undefined || value === null || value === '') return 0;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
        throw new DmV2ValidationError('Invalid replyToId');
    }
    return n;
}

function requireFingerprint(value) {
    const bytes = toBytes(value);
    if (bytes.length !== DM_V2_FINGERPRINT_LENGTH) {
        throw new DmV2ValidationError(
            `Invalid senderKeyFp: expected ${DM_V2_FINGERPRINT_LENGTH} bytes, got ${bytes.length}`
        );
    }
    return bytes;
}

function requireIv(value) {
    const bytes = toBytes(value);
    if (bytes.length !== DM_V2_IV_LENGTH) {
        throw new DmV2ValidationError(
            `Invalid AES-GCM IV: expected ${DM_V2_IV_LENGTH} bytes, got ${bytes.length}`
        );
    }
    return bytes;
}

/* =========================================================
 * Direction (section 3.1)
 * ========================================================= */

/**
 * Which way this message travels, derived only from the two account ids so both
 * sides compute it identically with no extra state.
 *
 *     directionLabel(from, to) = Number(from) < Number(to) ? 'a2b' : 'b2a'
 *
 * @param {number|string} from
 * @param {number|string} to
 * @returns {'a2b'|'b2a'}
 */
export function directionLabel(from, to) {
    const f = requireUserId(from, 'fromUserId');
    const t = requireUserId(to, 'toUserId');
    return f < t ? 'a2b' : 'b2a';
}

/**
 * The HKDF info string for one direction. Distinct from every other info in the
 * codebase, which is what makes the v2 key impossible to confuse with a v1 DM
 * key or a group KDM key.
 *
 * @param {number|string} from
 * @param {number|string} to
 * @returns {string}
 */
export function dmV2Info(from, to) {
    return directionLabel(from, to) === 'a2b' ? DM_V2_INFO_A2B : DM_V2_INFO_B2A;
}

/**
 * Derive the directional AES-GCM key for one direction of one pair.
 *
 * Section 3.1:
 *
 *     ss  = X25519(sk_self, pk_peer)      // 32 bytes, zeroed in finally
 *     key = HKDF-SHA-256(ikm = ss, salt = 32 zero bytes, info, L = 256)
 *
 * `from`/`to` say which direction the resulting key is FOR; they do not change
 * the ECDH operands, which are always (our private, their public). Passing them
 * is what prevents the classic bug of deriving one key and labelling it both
 * ways.
 *
 * The shared secret is zeroed by deriveSessionKeyFromPeer()'s own `finally`, so
 * there is no second copy to clear here.
 *
 * @param {number|string} from
 * @param {number|string} to
 * @param {CryptoKey} privateKey our X25519 identity key
 * @param {CryptoKey} peerPublicKey the peer's X25519 public key
 * @returns {Promise<CryptoKey>} non-extractable AES-GCM-256
 */
export async function deriveDmV2Key(from, to, privateKey, peerPublicKey) {
    const info = new TextEncoder().encode(dmV2Info(from, to));
    return deriveSessionKeyFromPeer(privateKey, peerPublicKey, info);
}

/**
 * SHA-256 of the sender's OWN raw X25519 public key: the 32 raw bytes that go
 * into the AAD as `senderKeyFp` and onto the wire as `senderFp`.
 *
 * This is the identity fingerprint, NOT the DH fingerprint. That is deliberate
 * and is what gives key-change detection for free (section 3.3): if the server
 * swaps bob's key, the receiver derives a different shared secret, a different
 * AES key, and decryption fails. It cannot be stripped, because removing it
 * changes the AAD.
 *
 * @param {Uint8Array|ArrayBuffer} rawPublicKey 32 raw bytes
 * @returns {Promise<Uint8Array>} 32 bytes
 */
export async function senderKeyFingerprint(rawPublicKey) {
    const bytes = toBytes(rawPublicKey);
    if (bytes.length !== DM_V2_FINGERPRINT_LENGTH) {
        throw new DmV2ValidationError(
            `Invalid raw public key: expected ${DM_V2_FINGERPRINT_LENGTH} bytes, got ${bytes.length}`
        );
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
}

/* =========================================================
 * msgId (section 4.3)
 * ========================================================= */

/**
 * A client-generated message id: 8 random bytes -> 16 lowercase hex chars.
 *
 * The server id does not exist at encrypt time, so the client mints one and the
 * receiver uses it for within-device replay detection. Not a global anti-replay
 * guarantee - see section 7.
 *
 * @returns {string} 16 lowercase hex characters
 */
export function newDmV2MsgId() {
    const bytes = crypto.getRandomValues(new Uint8Array(DM_V2_MSG_ID_BYTES));
    let hex = '';
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
}

function requireMsgId(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value)) {
        throw new DmV2ValidationError('Invalid msgId: expected 16 lowercase hex characters');
    }
    return value;
}

/* =========================================================
 * AAD (section 3.3)
 * ========================================================= */

/**
 * The additionalData for one message.
 *
 *     encodeFields(
 *         'dm-msg-v2',   type 0,   9 bytes  protocol label
 *         version,       type 0,   1 byte   "2"
 *         fromUserId,    type 0,   decimal
 *         toUserId,      type 0,   decimal
 *         senderKeyFp,   type 1,  32 bytes  SHA-256 of the SENDER's pk
 *         direction,     type 0,   3 bytes  'a2b' | 'b2a'
 *         iv,            type 1,  12 bytes  the nonce itself
 *         replyToId,     type 0,   decimal, 0 when absent
 *     )
 *
 * ORDER IS PART OF THE FORMAT. Reordering these silently breaks every row ever
 * written, which is exactly why `replyToId` is included from the start rather
 * than "added later".
 *
 * `messageId` is deliberately absent (section 3.3): it lives in the envelope, and
 * the envelope is authenticated by being inside the ciphertext's own fields only
 * in the sense that the server cannot alter it without detection - the msgId is
 * NOT bound here, so a server CAN swap a msgId. That is accepted in section 4.3:
 * msgId is a replay hint, not an integrity claim.
 *
 * `direction` is accepted rather than derived so the caller controls it, but it
 * is CROSS-CHECKED against directionLabel(from, to). A caller that disagrees with
 * the ids is a bug, and this is where it gets caught instead of producing an AAD
 * nobody can reproduce.
 *
 * @returns {Uint8Array}
 */
export function dmMessageAad({
    version = DM_V2_VERSION,
    fromUserId,
    toUserId,
    senderKeyFp,
    direction,
    iv,
    replyToId = 0
} = {}) {
    const v = requireVersion(version);
    if (v !== DM_V2_VERSION) {
        throw new DmV2ValidationError(
            `dmMessageAad is v2 only; got version ${v}`
        );
    }

    const from = requireUserId(fromUserId, 'fromUserId');
    const to = requireUserId(toUserId, 'toUserId');
    const fp = requireFingerprint(senderKeyFp);
    const nonce = requireIv(iv);
    const reply = requireReplyToId(replyToId);

    const expected = directionLabel(from, to);
    if (direction !== expected) {
        throw new DmV2ValidationError(
            `direction "${direction}" contradicts directionLabel(${from}, ${to}) = "${expected}"`
        );
    }

    return encodeFields(
        AAD_LABEL,
        String(v),
        String(from),
        String(to),
        fp,
        expected,
        nonce,
        String(reply)
    );
}

/* =========================================================
 * Envelope (section 4.2)
 * ========================================================= */

/**
 * Build the v2 wire envelope from already-encrypted bytes.
 *
 * {
 *   encryption: { version: 2, algorithm: 'AES-GCM', iv, ciphertext, senderFp, msgId },
 *   senderId, recipientId
 * }
 *
 * senderFp is carried in the clear (section 4.2) so a receiver can name the
 * actual problem - "bob's key changed" rather than "authentication failed" - and
 * so it can be stored per row for offline history.
 *
 * @returns {object} the envelope, ready for JSON.stringify
 */
export function buildDmV2Envelope({
    ciphertext,
    iv,
    senderFp,
    msgId,
    senderId,
    recipientId
} = {}) {
    const from = requireUserId(senderId, 'senderId');
    const to = requireUserId(recipientId, 'recipientId');
    const nonce = requireIv(iv);
    const fp = requireFingerprint(senderFp);
    const id = requireMsgId(msgId);

    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
        throw new DmV2ValidationError('ciphertext is required');
    }
    const ciphertextLength = base64ToBytes(ciphertext, 'ciphertext').length;
    if (ciphertextLength > DM_V2_MAX_CIPHERTEXT_LENGTH) {
        throw new DmV2ValidationError('Ciphertext is too large');
    }

    return {
        encryption: {
            version: DM_V2_VERSION,
            algorithm: DM_V2_ALGORITHM,
            iv: bytesToBase64(nonce),
            ciphertext,
            senderFp: bytesToBase64(fp),
            msgId: id
        },
        senderId: from,
        recipientId: to
    };
}

/**
 * Validate a received v2 envelope and return it in a normalised shape.
 *
 * This reads `version` and `algorithm` FIRST, before anything else, exactly as
 * section 4.2 requires: they are the only discriminators, and reading them first
 * is what lets an old client simply fail to read a v2 message rather than
 * misread it.
 *
 * @returns {object} { version, algorithm, iv, ciphertext, senderFp, msgId, senderId, recipientId }
 */
export function validateDmV2Envelope(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new DmV2ValidationError('Invalid encrypted message payload');
    }
    if (!payload.encryption || typeof payload.encryption !== 'object') {
        throw new DmV2ValidationError('Missing encryption payload');
    }

    const encryption = payload.encryption;

    // Discriminators first.
    if (encryption.version !== DM_V2_VERSION) {
        throw new DmV2ValidationError(
            `Unsupported encryption version: ${JSON.stringify(encryption.version)}`
        );
    }
    if (encryption.algorithm !== DM_V2_ALGORITHM) {
        throw new DmV2ValidationError('Unsupported encryption algorithm');
    }

    const iv = requireIv(base64ToBytes(encryption.iv, 'IV'));
    const senderFp = requireFingerprint(base64ToBytes(encryption.senderFp, 'senderFp'));
    const msgId = requireMsgId(encryption.msgId);
    const senderId = requireUserId(payload.senderId, 'senderId');
    const recipientId = requireUserId(payload.recipientId, 'recipientId');

    const ciphertextLength = base64ToBytes(encryption.ciphertext, 'ciphertext').length;
    if (ciphertextLength > DM_V2_MAX_CIPHERTEXT_LENGTH) {
        throw new DmV2ValidationError('Ciphertext is too large');
    }

    return {
        version: encryption.version,
        algorithm: encryption.algorithm,
        iv: bytesToBase64(iv),
        senderFp: bytesToBase64(senderFp),
        msgId,
        ciphertext: encryption.ciphertext,
        senderId,
        recipientId
    };
}

/* =========================================================
 * Encrypt / decrypt
 * ========================================================= */

/**
 * Encrypt one DM text message as a v2 envelope.
 *
 * `fromUserId`/`toUserId` are the ENVELOPE's own ids, and that is the point:
 * they are bound into the AAD, so a server that relabels them after the fact
 * produces an AAD the receiver no longer computes, and the GCM tag check fails.
 *
 * `iv` and `msgId` are injectable ONLY so the known-answer tests can pin them.
 * Leave them null in real use; the module then generates fresh random values,
 * which is the only safe default for GCM.
 *
 * @param {object} o
 * @param {string} o.plaintext
 * @param {number} o.fromUserId
 * @param {number} o.toUserId
 * @param {Uint8Array} o.senderKeyFp 32 bytes, the SENDER's identity fingerprint
 * @param {CryptoKey} o.key directional AES-GCM key for this direction
 * @param {number} [o.replyToId] 0 when absent
 * @param {Uint8Array} [o.iv] test injection only
 * @param {string} [o.msgId] test injection only
 * @returns {Promise<{envelope: object, iv: Uint8Array, aad: Uint8Array, msgId: string}>}
 */
export async function encryptDmV2({
    plaintext,
    fromUserId,
    toUserId,
    senderKeyFp,
    key,
    replyToId = 0,
    iv = null,
    msgId = null
} = {}) {
    if (typeof plaintext !== 'string') {
        throw new DmV2ValidationError('Message must be a string');
    }
    if (plaintext.length === 0) {
        throw new DmV2ValidationError('Message cannot be empty');
    }

    const from = requireUserId(fromUserId, 'fromUserId');
    const to = requireUserId(toUserId, 'toUserId');
    const direction = directionLabel(from, to);
    const nonce = iv === null
        ? crypto.getRandomValues(new Uint8Array(DM_V2_IV_LENGTH))
        : requireIv(iv);
    const id = msgId === null ? newDmV2MsgId() : requireMsgId(msgId);

    const aad = dmMessageAad({
        version: DM_V2_VERSION,
        fromUserId: from,
        toUserId: to,
        senderKeyFp,
        direction,
        iv: nonce,
        replyToId
    });

    const ciphertext = await crypto.subtle.encrypt(
        {
            name: DM_V2_ALGORITHM,
            iv: nonce,
            additionalData: aad,
            tagLength: DM_V2_TAG_LENGTH
        },
        key,
        new TextEncoder().encode(plaintext)
    );

    const envelope = buildDmV2Envelope({
        ciphertext: bytesToBase64(ciphertext),
        iv: nonce,
        senderFp: senderKeyFp,
        msgId: id,
        senderId: from,
        recipientId: to
    });

    return { envelope, iv: nonce, aad, msgId: id };
}

/**
 * Decrypt a v2 envelope.
 *
 * Every AAD input is taken from the ENVELOPE the server handed us - the ids, the
 * direction, the iv - except `senderKeyFp`, which the caller supplies because it
 * is the receiver's job to choose WHICH of the sender's keys to try (section
 * 4.4's key history; the Phase 2 mayTryRetiredKey() rule decides that in 1B).
 * `replyToId` is likewise the caller-supplied stored row value, since it is
 * server-controlled metadata that the AAD must commit to.
 *
 * @param {object} o
 * @param {object} o.envelope as received
 * @param {Uint8Array} o.senderKeyFp the fingerprint of the key actually being used
 * @param {CryptoKey} o.key directional AES-GCM key for this direction
 * @param {number} [o.replyToId] stored row's reply_to_id, 0 when absent
 * @returns {Promise<string>} the plaintext
 */
export async function decryptDmV2({
    envelope,
    senderKeyFp,
    key,
    replyToId = 0
} = {}) {
    const validated = validateDmV2Envelope(envelope);

    const iv = base64ToBytes(validated.iv, 'IV');
    const fp = base64ToBytes(validated.senderFp, 'senderFp');
    const direction = directionLabel(validated.senderId, validated.recipientId);

    // The envelope's own senderFp is what the AAD committed to. If the caller
    // picked a key whose fingerprint differs, no tag will ever verify - so say so
    // now, with a message a human can act on, instead of returning a bare
    // "operation-specific failure".
    const callerFp = requireFingerprint(senderKeyFp);
    if (bytesToBase64(callerFp) !== validated.senderFp) {
        throw new DmV2ValidationError(
            'senderKeyFp does not match the envelope senderFp: the wrong sender key was selected'
        );
    }

    const aad = dmMessageAad({
        version: validated.version,
        fromUserId: validated.senderId,
        toUserId: validated.recipientId,
        senderKeyFp: fp,
        direction,
        iv,
        replyToId
    });

    const plaintext = await crypto.subtle.decrypt(
        {
            name: DM_V2_ALGORITHM,
            iv,
            additionalData: aad,
            tagLength: DM_V2_TAG_LENGTH
        },
        key,
        base64ToBytes(validated.ciphertext, 'ciphertext')
    );

    return new TextDecoder().decode(plaintext);
}

/* =========================================================
 * IV replay guard
 *
 * NOT in the design doc - added because a GCM nonce reuse is catastrophic and
 * the doc says nothing about who prevents it. It is bounded and stateless across
 * conversations; STEP 1B wires it into the send path. Nothing calls it yet.
 * ========================================================= */

export class IvReplayGuard {
    /**
     * @param {number} capacity most nonces remembered per scope. Bounded on
     *   purpose: an unbounded "have I seen this before" set is a memory leak and
     *   an attacker-controlled one, since the server chooses how many messages
     *   arrive. FIFO eviction means an attacker can push a nonce out of the
     *   window, which is a known and accepted limit - the real protection is
     *   that the client GENERATES the nonce, so the server cannot choose it.
     */
    constructor(capacity = 512) {
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new DmV2ValidationError('Invalid capacity');
        }
        this.capacity = capacity;
        this.seen = new Map();
    }

    /**
     * Record an IV for a scope (one conversation, or one key), or throw if this
     * exact nonce was already used there.
     *
     * @param {Uint8Array} iv
     * @param {string} scope
     * @throws {DmV2IvReplayError}
     */
    remember(iv, scope) {
        const nonce = requireIv(iv);
        const scopeKey = String(scope);
        // Keyed by the nonce's BYTES, not the Uint8Array identity: two equal
        // nonces are two different objects, and a Set would happily hold both.
        const nonceKey = bytesToBase64(nonce);

        let bucket = this.seen.get(scopeKey);
        if (!bucket) {
            bucket = new Set();
            this.seen.set(scopeKey, bucket);
        }

        if (bucket.has(nonceKey)) {
            throw new DmV2IvReplayError(scopeKey);
        }
        if (bucket.size >= this.capacity) {
            // FIFO: drop the oldest so the set stays bounded.
            bucket.delete(bucket.values().next().value);
        }
        bucket.add(nonceKey);
    }
}

/* =========================================================
 * Attachment meta envelope (STEP 2A.2)
 *
 * Section 3.3's dmAttachmentAad: the TEXT AAD with only the label changed, so a
 * file can never be replayed as a message and vice versa. The envelope shape and
 * the key derivation are shared with v2 text (no new HKDF info, no new key):
 * only the bytes the AAD commits to differ.
 *
 * These functions are deliberately self-contained instead of delegating to
 * dmMessageAad/encryptDmV2/decryptDmV2: the two labels are separate wire formats
 * and either must be able to change without silently moving the other. The text
 * path's bytes are pinned by KATs and were NOT touched by this step.
 * ========================================================= */

/** AAD protocol label for attachment meta. Fixed forever; distinct from the text label. */
export const DM_ATTACHMENT_AAD_LABEL = 'dm-att-v2';

/**
 * The additionalData for one attachment-meta envelope.
 *
 *     encodeFields(
 *         'dm-att-v2',   type 0,  10 bytes  protocol label
 *         version,       type 0,   1 byte   "2"
 *         fromUserId,    type 0,   decimal
 *         toUserId,      type 0,   decimal
 *         senderKeyFp,   type 1,  32 bytes  SHA-256 of the SENDER's pk
 *         direction,     type 0,   3 bytes  'a2b' | 'b2a'
 *         iv,            type 1,  12 bytes  the nonce itself
 *         replyToId,     type 0,   decimal, 0 when absent
 *     )
 *
 * The design sketch (section 3.3) also listed an `attachmentId`. It is DROPPED
 * (STEP 2A D2): it predates the STREAM format - the per-file key inside the meta
 * already binds the blob - and an unauthenticated id would repeat the msgId
 * problem (a server could swap it). The list above is final.
 *
 * @returns {Uint8Array}
 */
export function dmAttachmentAad({
    version = DM_V2_VERSION,
    fromUserId,
    toUserId,
    senderKeyFp,
    direction,
    iv,
    replyToId = 0
} = {}) {
    const v = requireVersion(version);
    if (v !== DM_V2_VERSION) {
        throw new DmV2ValidationError(
            `dmAttachmentAad is v2 only; got version ${v}`
        );
    }

    const from = requireUserId(fromUserId, 'fromUserId');
    const to = requireUserId(toUserId, 'toUserId');
    const fp = requireFingerprint(senderKeyFp);
    const nonce = requireIv(iv);
    const reply = requireReplyToId(replyToId);

    const expected = directionLabel(from, to);
    if (direction !== expected) {
        throw new DmV2ValidationError(
            `direction "${direction}" contradicts directionLabel(${from}, ${to}) = "${expected}"`
        );
    }

    return encodeFields(
        DM_ATTACHMENT_AAD_LABEL,
        String(v),
        String(from),
        String(to),
        fp,
        expected,
        nonce,
        String(reply)
    );
}

/**
 * Encrypt one attachment-meta JSON string as a v2 envelope under the
 * attachment label. Identical to encryptDmV2 except for the AAD label, so the
 * envelope shape, the version discriminator and the server's shape checks are
 * exactly the text ones.
 *
 * `iv` and `msgId` are injectable ONLY for the known-answer tests.
 *
 * @returns {Promise<{envelope: object, iv: Uint8Array, aad: Uint8Array, msgId: string}>}
 */
export async function encryptDmAttachmentV2({
    plaintext,
    fromUserId,
    toUserId,
    senderKeyFp,
    key,
    replyToId = 0,
    iv = null,
    msgId = null
} = {}) {
    if (typeof plaintext !== 'string') {
        throw new DmV2ValidationError('Message must be a string');
    }
    if (plaintext.length === 0) {
        throw new DmV2ValidationError('Message cannot be empty');
    }

    const from = requireUserId(fromUserId, 'fromUserId');
    const to = requireUserId(toUserId, 'toUserId');
    const direction = directionLabel(from, to);
    const nonce = iv === null
        ? crypto.getRandomValues(new Uint8Array(DM_V2_IV_LENGTH))
        : requireIv(iv);
    const id = msgId === null ? newDmV2MsgId() : requireMsgId(msgId);

    const aad = dmAttachmentAad({
        version: DM_V2_VERSION,
        fromUserId: from,
        toUserId: to,
        senderKeyFp,
        direction,
        iv: nonce,
        replyToId
    });

    const ciphertext = await crypto.subtle.encrypt(
        {
            name: DM_V2_ALGORITHM,
            iv: nonce,
            additionalData: aad,
            tagLength: DM_V2_TAG_LENGTH
        },
        key,
        new TextEncoder().encode(plaintext)
    );

    const envelope = buildDmV2Envelope({
        ciphertext: bytesToBase64(ciphertext),
        iv: nonce,
        senderFp: senderKeyFp,
        msgId: id,
        senderId: from,
        recipientId: to
    });

    return { envelope, iv: nonce, aad, msgId: id };
}

/**
 * Decrypt a v2 attachment-meta envelope. Same contract as decryptDmV2: every
 * AAD input comes from the envelope except `senderKeyFp`, which the caller
 * supplies because choosing WHICH of the sender's keys to try is the receiver's
 * job.
 *
 * @returns {Promise<string>} the plaintext
 */
export async function decryptDmAttachmentV2({
    envelope,
    senderKeyFp,
    key,
    replyToId = 0
} = {}) {
    const validated = validateDmV2Envelope(envelope);

    const iv = base64ToBytes(validated.iv, 'IV');
    const fp = base64ToBytes(validated.senderFp, 'senderFp');
    const direction = directionLabel(validated.senderId, validated.recipientId);

    const callerFp = requireFingerprint(senderKeyFp);
    if (bytesToBase64(callerFp) !== validated.senderFp) {
        throw new DmV2ValidationError(
            'senderKeyFp does not match the envelope senderFp: the wrong sender key was selected'
        );
    }

    const aad = dmAttachmentAad({
        version: validated.version,
        fromUserId: validated.senderId,
        toUserId: validated.recipientId,
        senderKeyFp: fp,
        direction,
        iv,
        replyToId
    });

    const plaintext = await crypto.subtle.decrypt(
        {
            name: DM_V2_ALGORITHM,
            iv,
            additionalData: aad,
            tagLength: DM_V2_TAG_LENGTH
        },
        key,
        base64ToBytes(validated.ciphertext, 'ciphertext')
    );

    return new TextDecoder().decode(plaintext);
}

/* =========================================================
 * DEVIATIONS FROM THE DESIGN DOC
 *
 * 1. Section 3.3 states the AAD is "worst case ... 109 bytes" for 10-digit ids.
 *    The layout it specifies, encoded the way encodeFields actually encodes,
 *    is 40 bytes of framing (8 fields x 5) + 9 + 1 + 10 + 10 + 32 + 3 + 12 + 10
 *    = 127 bytes. 109 is not reachable from the specified field list; it looks
 *    like the replyToId field (5 + 10 = 15) and part of another field were not
 *    counted. This module implements the NORMATIVE layout exactly and lets the
 *    length fall where the layout puts it. tests/dm-v2.test.mjs asserts the
 *    exact length of a worked example so the number is pinned rather than
 *    assumed. The doc's figure should be corrected.
 *
 * 2. Section 3.3's dmAttachmentAad is implemented (STEP 2A.2) under the label
 *    'dm-att-v2'. The sketch's `attachmentId` field is DROPPED (STEP 2A D2): it
 *    predates the STREAM format (the per-file key inside the meta already binds
 *    the blob) and an unauthenticated id would repeat the msgId problem. Field
 *    order is otherwise the text AAD's, only the label changed.
 *    attachment-crypto.js remains dead code and keeps its existing key.
 * ========================================================= */

/** Byte size of one AAD, for callers that need a bound. Derived, not a constant. */
export function dmV2AadLength({
    version = DM_V2_VERSION,
    fromUserId,
    toUserId,
    senderKeyFp,
    direction,
    iv,
    replyToId = 0
} = {}) {
    return dmMessageAad({
        version, fromUserId, toUserId, senderKeyFp, direction, iv, replyToId
    }).length;
}

/** Exposed for tests: the AAD label, so a test can assert it is not silently changed. */
export const DM_V2_AAD_LABEL = AAD_LABEL;
export { zero };