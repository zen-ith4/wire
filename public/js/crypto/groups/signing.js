// public/js/crypto/groups/signing.js
//
// Per-message sender authentication primitive (Phase C1).
//
// AES-GCM under a Sender Key is symmetric: every member who holds Alice's Sender
// Key can produce a ciphertext that authenticates as "Alice's key". To make a
// message attributable to ONE device, every group message is additionally signed
// with a signing key that exists only on the device that owns the Sender Key.
//
//   algorithm   ECDSA over P-256 with SHA-256 (WebCrypto only)
//   signature   raw IEEE P1363 r||s, exactly 64 bytes
//   public key  raw uncompressed point, exactly 65 bytes (0x04 || X || Y)
//
// This module is a pure primitive: it knows nothing about KDMs, storage, the
// replay seen-set or the UI. Later steps (C2/C3) wire it in.
//
// Fail closed: verifyMessage() never throws and returns false for ANY malformed
// input (wrong signature length, unusable key, bad field); importVerifyKey()
// throws a SigningFormatError for a malformed public key so the caller can map it
// to "unverified" instead of letting an exception reach the thread renderer.
//
// What is signed (encodeSignedBytes): length-prefixed fields, in this order,
// starting with a domain-separation label:
//
//   "wire-group-msg-sig/v1", groupId, senderKeyId, counter, iv (12 raw bytes),
//   ciphertext (raw bytes incl. the GCM tag, i.e. the DECODED bytes, never the
//   base64 text, which is not canonical), replyToId (decimal text, or the
//   raw-empty field for "no reply"), attachment (raw bytes, empty today).
//
// The attachment slot is reserved: group attachments are DISABLED in the client.
// WARNING: before group attachment SENDING is ever enabled, the attachment bytes
// (e.g. their iv and a hash of the ciphertext) MUST be bound into this slot.
// Today an attachment is only AEAD-protected under the Sender Key, so any member
// who holds that key could forge a file "from" the key's owner.
//
// ECDSA signatures are malleable ((r, n-s) also verifies; WebCrypto does not
// enforce low-S). That cannot create a second accepted message: acceptance is
// keyed by (senderKeyId, full nonce) in the replay seen-set
// (sender-key-store.js claimNonce), so a re-signed copy of the same ciphertext is
// the same message ('same' ref) or a replay ('conflict'), never a new one.

import { encodeFields } from './codec.js';

export const SIG_LABEL = 'wire-group-msg-sig/v1';
export const SIGNATURE_LENGTH = 64;
export const PUBLIC_KEY_LENGTH = 65;

const IV_LENGTH = 12;
const EMPTY = new Uint8Array(0);
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' };

export class SigningFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SigningFormatError';
    }
}

function isPositiveSafeInt(n) {
    return Number.isSafeInteger(n) && n > 0;
}

/**
 * Canonical, unambiguous byte string that is signed / verified.
 * Throws SigningFormatError on any field that is not exactly of the expected shape.
 *
 * @param {object} f
 * @param {number} f.groupId positive integer
 * @param {string} f.senderKeyId non-empty string
 * @param {number} f.counter non-negative integer
 * @param {Uint8Array} f.iv 12 bytes
 * @param {Uint8Array} f.ciphertext raw decoded ciphertext (non-empty)
 * @param {number|null} [f.replyToId] positive integer, or null for "not a reply"
 * @param {Uint8Array} [f.attachment] reserved slot, empty today
 * @returns {Uint8Array}
 */
export function encodeSignedBytes(f) {
    if (!f || typeof f !== 'object') throw new SigningFormatError('Missing signed fields');

    const { groupId, senderKeyId, counter, iv, ciphertext } = f;
    const replyToId = f.replyToId === undefined ? null : f.replyToId;
    const attachment = f.attachment === undefined ? EMPTY : f.attachment;

    if (!isPositiveSafeInt(groupId)) throw new SigningFormatError('Invalid groupId');
    if (typeof senderKeyId !== 'string' || !senderKeyId) throw new SigningFormatError('Invalid senderKeyId');
    if (!Number.isSafeInteger(counter) || counter < 0) throw new SigningFormatError('Invalid counter');
    if (!(iv instanceof Uint8Array) || iv.length !== IV_LENGTH) throw new SigningFormatError('Invalid iv');
    if (!(ciphertext instanceof Uint8Array) || ciphertext.length === 0) throw new SigningFormatError('Invalid ciphertext');
    if (replyToId !== null && !isPositiveSafeInt(replyToId)) throw new SigningFormatError('Invalid reply_to_id');
    if (!(attachment instanceof Uint8Array)) throw new SigningFormatError('Invalid attachment slot');

    return encodeFields(
        SIG_LABEL,
        groupId,
        senderKeyId,
        counter,
        iv,
        ciphertext,
        // "no reply" is a RAW empty field (type byte 1), a reply is decimal TEXT
        // (type byte 0): the two can never encode to the same bytes.
        replyToId === null ? EMPTY : String(replyToId),
        attachment
    );
}

/**
 * Generates a fresh signing key pair for ONE Sender Key.
 *
 * The private key is returned EXTRACTABLE on purpose: C2 exports it once (PKCS#8)
 * to persist it wrapped (same mechanism as the Sender Key) and immediately
 * re-imports a NON-extractable copy for use; the extractable handle and the
 * exported bytes are dropped/zeroed right after. Nothing here persists anything.
 *
 * @returns {Promise<{privateKey: CryptoKey, publicKeyRaw: Uint8Array}>}
 */
export async function generateSigningKeyPair() {
    const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
    const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

    if (publicKeyRaw.length !== PUBLIC_KEY_LENGTH || publicKeyRaw[0] !== 0x04) {
        throw new Error('Unexpected P-256 public key encoding');
    }

    return { privateKey: pair.privateKey, publicKeyRaw };
}

/**
 * Imports a peer's raw public key as a non-extractable verify-only key.
 * Fails closed: wrong length, wrong first byte, or a point that is not on the
 * curve all throw SigningFormatError (WebCrypto validates the point).
 *
 * @param {Uint8Array} publicKeyRaw 65 bytes, 0x04 || X || Y
 * @returns {Promise<CryptoKey>}
 */
export async function importVerifyKey(publicKeyRaw) {
    if (!(publicKeyRaw instanceof Uint8Array) || publicKeyRaw.length !== PUBLIC_KEY_LENGTH) {
        throw new SigningFormatError('Signing public key must be 65 bytes');
    }

    if (publicKeyRaw[0] !== 0x04) {
        throw new SigningFormatError('Signing public key must be an uncompressed point');
    }

    try {
        return await crypto.subtle.importKey('raw', publicKeyRaw, ALGORITHM, false, ['verify']);
    } catch {
        throw new SigningFormatError('Signing public key is not a valid P-256 point');
    }
}

/**
 * @param {CryptoKey} privateKey ECDSA P-256 private key (sign usage)
 * @param {object} fields see encodeSignedBytes
 * @returns {Promise<Uint8Array>} exactly 64 bytes (raw r||s)
 */
export async function signMessage(privateKey, fields) {
    if (!(privateKey instanceof CryptoKey) || privateKey.type !== 'private') {
        throw new SigningFormatError('Invalid signing key');
    }

    const bytes = encodeSignedBytes(fields);
    const sig = new Uint8Array(await crypto.subtle.sign(SIGN_PARAMS, privateKey, bytes));

    if (sig.length !== SIGNATURE_LENGTH) {
        throw new Error('Unexpected signature length');
    }

    return sig;
}

/**
 * Verifies a signature over the canonical bytes of `fields`.
 * NEVER throws: any malformed input (key, signature or fields) is `false`.
 *
 * @param {CryptoKey} verifyKey from importVerifyKey()
 * @param {Uint8Array} signature exactly 64 bytes
 * @param {object} fields see encodeSignedBytes
 * @returns {Promise<boolean>}
 */
export async function verifyMessage(verifyKey, signature, fields) {
    try {
        if (!(verifyKey instanceof CryptoKey) || verifyKey.type !== 'public') return false;
        if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_LENGTH) return false;

        const bytes = encodeSignedBytes(fields);

        return (await crypto.subtle.verify(SIGN_PARAMS, verifyKey, signature, bytes)) === true;
    } catch {
        return false;
    }
}
