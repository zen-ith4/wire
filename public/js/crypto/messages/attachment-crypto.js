// public/js/crypto/messages/attachment-crypto.js
//
// Phase 4: encrypts/decrypts attachment file bytes with the SAME key
// as the message they're attached to (DM session key / group Sender
// Key), but always under their OWN fresh nonce — reusing a message's
// nonce for its attachment would be catastrophic nonce reuse under
// AES-GCM (same key + same nonce, two different plaintexts).
//
// Deliberately does NOT reuse groups/aead.js's encryptBytes/
// decryptBytes here: those base64-encode the ciphertext, which is
// the right choice for small JSON-embeddable payloads (message text,
// KDMs) but wrong for potentially-multi-megabyte file bytes — base64
// adds ~33% size overhead and forces a full in-memory string
// conversion. Attachments go straight to/from ArrayBuffers instead,
// matching how they're already uploaded (FormData) and downloaded
// (fetch + arrayBuffer()).

import { getOrCreateSessionKey } from '../keys/session.js';
import { bytesToBase64, base64ToBytes } from '../groups/codec.js';
import { reserveNextCounter } from '../groups/nonce-lock.js';
import { nonceFromCounter } from '../groups/message-crypto.js';
import { getMySenderKey, loadSenderKey } from '../groups/sender-key.js';
import { getGroupIdentity } from './group-message-crypto.js';
import { MissingSenderKeyError } from '../groups/message-crypto.js';

export { MissingSenderKeyError };

/**
 * @param {number} peerId
 * @param {ArrayBuffer} fileBytes
 * @returns {Promise<{ivBase64: string, ciphertext: ArrayBuffer}>}
 */
export async function encryptAttachmentForDm(peerId, fileBytes) {
    const sessionKey = await getOrCreateSessionKey(peerId);
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        sessionKey,
        fileBytes
    );

    return { ivBase64: bytesToBase64(iv), ciphertext };
}

/**
 * @param {number} peerId
 * @param {ArrayBuffer} ciphertext
 * @param {string} ivBase64
 * @returns {Promise<ArrayBuffer>} plaintext file bytes
 */
export async function decryptAttachmentForDm(peerId, ciphertext, ivBase64) {
    const sessionKey = await getOrCreateSessionKey(peerId);
    const iv = base64ToBytes(ivBase64);

    try {
        return await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            sessionKey,
            ciphertext
        );
    } catch {
        throw new Error('Attachment authentication failed');
    }
}

/**
 * @param {number} groupId
 * @param {ArrayBuffer} fileBytes
 * @returns {Promise<{ivBase64: string, ciphertext: ArrayBuffer}>}
 * @throws if this device has no Sender Key to encrypt with yet —
 *   callers must call group-message-crypto.js's
 *   ensureSenderKeyForGroup() first, same as before sending text.
 */
export async function encryptAttachmentForGroup(groupId, fileBytes) {
    const identity = getGroupIdentity();
    const mine = await getMySenderKey(identity, groupId);

    if (!mine) {
        throw new Error('No Sender Key to encrypt with yet — rotate/distribute one first');
    }

    // A fresh counter from the SAME per-Sender-Key sequence message
    // text uses (nonce-lock.js) — the attachment is just one more
    // thing this Sender Key encrypts, and every encryption under a
    // given key needs its own never-reused counter/nonce regardless
    // of whether it's message text or a file.
    const counter = await reserveNextCounter(mine.senderKeyId);
    const iv = nonceFromCounter(counter);

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        mine.cryptoKey,
        fileBytes
    );

    return { ivBase64: bytesToBase64(iv), ciphertext };
}

/**
 * @param {ArrayBuffer} ciphertext
 * @param {string} ivBase64
 * @param {string} senderKeyId the Sender Key that encrypted this
 *   attachment — the SAME id as the attachment's message envelope's
 *   own senderKeyId (see this file's module doc comment and
 *   media/attachments.js's group decrypt path for how callers get
 *   this from the already-decrypted message object).
 * @returns {Promise<ArrayBuffer>} plaintext file bytes
 * @throws {MissingSenderKeyError} same self-heal contract as
 *   decryptGroupMessage — the caller should treat this the same way
 *   (background KDM drain + retry), not as a hard failure.
 */
export async function decryptAttachmentForGroup(ciphertext, ivBase64, senderKeyId) {
    const identity = getGroupIdentity();
    const cryptoKey = await loadSenderKey(identity, senderKeyId);

    if (!cryptoKey) {
        throw new MissingSenderKeyError(senderKeyId);
    }

    const iv = base64ToBytes(ivBase64);

    try {
        return await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            ciphertext
        );
    } catch {
        throw new Error('Attachment authentication failed');
    }
}

/**
 * Client-side image dimension extraction (Phase 4 — the server can
 * no longer read them from ciphertext). Uses createImageBitmap where
 * available (fast, doesn't touch the DOM) and falls back to an
 * <img> element for browsers/formats that don't support it.
 *
 * @param {Blob} blob the plaintext image bytes, NOT yet encrypted
 * @returns {Promise<{width: number, height: number}|null>} null if
 *   the bytes aren't a decodable image — callers should treat that
 *   as "no dimensions available", not as an error worth blocking the
 *   upload over.
 */
export async function computeImageDimensions(blob) {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(blob);
            const dims = { width: bitmap.width, height: bitmap.height };
            bitmap.close?.();
            return dims;
        } catch {
            // fall through to the <img> fallback below
        }
    }

    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();

        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
        };

        img.src = url;
    });
}
