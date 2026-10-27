import {
    encryptMessage
} from './encrypt.js';

import {
    decryptMessage
} from './decrypt.js';

import {
    createEncryptedMessagePayload,
    validateEncryptedMessagePayload
} from './payload.js';

import {
    buildDmV2Content,
    buildDmV2AttachmentMetaContent,
    openDmV2Envelope,
    openDmV2AttachmentEnvelope,
    noteDmV2Version,
    chooseDmVersion,
    assertDmVersionAllowed,
    assertDmV2ContentFits,
    getPeerDmMinVersion,
    DmDowngradeRefusedError
} from './dm-v2-wire.js';

import { getCurrentUser } from '../../core/auth.js';


/* =========================================================
 * Encrypt outgoing message
 * ========================================================= */

export async function encryptOutgoingMessage(
    plaintext,
    senderId,
    recipientId
) {
    if (
        typeof plaintext !== 'string' ||
        !plaintext.length
    ) {
        throw new Error(
            'Message cannot be empty'
        );
    }

    if (
        !Number.isInteger(Number(senderId)) ||
        Number(senderId) <= 0
    ) {
        throw new Error(
            'Invalid sender ID'
        );
    }

    if (
        !Number.isInteger(Number(recipientId)) ||
        Number(recipientId) <= 0
    ) {
        throw new Error(
            'Invalid recipient ID'
        );
    }

    const encrypted =
        await encryptMessage(
            plaintext,
            Number(recipientId)
        );

    return createEncryptedMessagePayload(
        encrypted,
        Number(senderId),
        Number(recipientId)
    );
}


/* =========================================================
 * Decrypt incoming message
 * ========================================================= */

export async function decryptIncomingMessage(
    payload,
    peerUserId
) {
    // STEP 1B: attachments and other v1-only callers must never be able to
    // open or mint a v2 envelope. A v2 payload here is a mistake or an attack,
    // and we refuse rather than try to decode it.
    if (payload && payload.encryption && payload.encryption.version !== 1) {
        throw new Error(
            'decryptIncomingMessage cannot read a v2 payload; use decryptDmTextV2'
        );
    }

    const encrypted =
        validateEncryptedMessagePayload(
            payload
        );

    if (
        !Number.isInteger(Number(peerUserId)) ||
        Number(peerUserId) <= 0
    ) {
        throw new Error(
            'Invalid peer user ID'
        );
    }

    return decryptMessage(
        encrypted,
        Number(peerUserId)
    );
}


/* =========================================================
 * STEP 1B - DM v2 text
 *
 * These are deliberately separate from the v1 two above, which stay
 * byte-identical: encryptOutgoingMessage/decryptIncomingMessage are still
 * called by the attachment path (attachment-e2ee.js) and must not change.
 * ========================================================= */

/**
 * Encrypt one DM text message as a v2 envelope, choosing the version per peer.
 *
 * @param {string} plaintext
 * @param {number} senderId
 * @param {number} recipientId
 * @param {number} [replyToId] 0 when absent - MUST be the value the server keeps
 * @returns {Promise<{version: number, content: string, msgId: string, peerMinVersion: number}>}
 */
export async function encryptDmTextV2(plaintext, senderId, recipientId, replyToId = 0) {
    if (
        typeof plaintext !== 'string' ||
        !plaintext.length
    ) {
        throw new Error(
            'Message cannot be empty'
        );
    }

    // Version choice per peer: peer min 1 -> v1 via the unchanged path,
    // peer >= 2 -> v2. The layer-2 pin can only raise this decision, never
    // lower it: sending v1 to a pinned-2 peer is a downgrade and is refused.
    const peerMinVersion = await getPeerDmMinVersion(recipientId);
    const version = chooseDmVersion(recipientId, peerMinVersion);

    if (version === 1) {
        assertDmVersionAllowed(recipientId, 1);
        const payload = await encryptOutgoingMessage(
            plaintext,
            Number(senderId),
            Number(recipientId)
        );
        const content = JSON.stringify(payload);

        // R2: v1 is subject to the same server cap. Measure the serialised
        // envelope (the value the server stores), not the plaintext, so this is
        // the exact boundary the server checks. Refuse instead of letting a cut
        // envelope reach the row.
        assertDmV2ContentFits(content.length);

        return {
            version: 1,
            content,
            msgId: null,
            peerMinVersion
        };
    }

    assertDmVersionAllowed(recipientId, 2);

    const { content, msgId } = await buildDmV2Content({
        plaintext,
        senderId: Number(senderId),
        recipientId: Number(recipientId),
        replyToId: Number(replyToId) || 0
    });

    // Record the highest version seen for this peer on the send side.
    noteDmV2Version(recipientId, 2);

    return {
        version: 2,
        content,
        msgId,
        peerMinVersion
    };
}

/**
 * Decrypt a received DM text envelope.
 *
 * On a v2 envelope the caller MUST supply the stored row's reply_to_id and id
 * (via `rowId`) - the AAD binds replyToId, and the msgId replay check needs the
 * row id to tell a re-read from a replay.
 *
 * @param {object} payload
 * @param {number} peerId
 * @param {{replyToId?: number, rowId?: number}} [ctx]
 * @returns {Promise<string>}
 */
export async function decryptDmTextV2(payload, peerId, ctx = {}) {
    const version = payload && payload.encryption ? Number(payload.encryption.version) : null;

    if (version === 1) {
        const plaintext = await decryptIncomingMessage(payload, peerId);
        // A v1 envelope from a peer pinned at >= 2 is still decrypted (history
        // is not the attack), but the caller is told so it can surface the
        // one-time downgrade notice.
        return plaintext;
    }

    if (version !== 2) {
        throw new Error('Unsupported encryption version');
    }

    const { plaintext } = await openDmV2Envelope({
        payload,
        peerId: Number(peerId),
        ownUserId: Number(getCurrentUser()?.id),
        replyToId: Number((ctx && ctx.replyToId) || 0),
        rowId: ctx ? ctx.rowId : null
    });

    noteDmV2Version(peerId, 2);
    return plaintext;
}

/* =========================================================
 * STEP 2A - DM attachments
 *
 * The attachment meta gets the v2 envelope under its own AAD label
 * ('dm-att-v2'); the caption is TEXT and uses the unchanged v2 text path. The
 * version choice and the layer-2 pin are the text rules, unchanged (docs 5.4).
 * ========================================================= */

/**
 * The version to use for this upload, decided and pin-checked BEFORE any file is
 * read, decoded or encrypted (STEP 2A D5).
 *
 * Split from the encryption on purpose: prepareDmAttachmentUpload must refuse a
 * downgrade while it still has nothing on disk and nothing in memory, and a test
 * proves it by spying on the File's read methods.
 *
 * @param {number} recipientId
 * @returns {Promise<{version: number, peerMinVersion: number}>}
 */
export async function resolveDmAttachmentVersion(recipientId) {
    const peerMinVersion = await getPeerDmMinVersion(recipientId);
    const version = chooseDmVersion(recipientId, peerMinVersion);
    // Throws DmDowngradeRefusedError rather than silently sending v1 to a peer
    // this browser has already exchanged v2 with.
    assertDmVersionAllowed(recipientId, version);
    return { version, peerMinVersion };
}

/**
 * Encrypt one attachment-meta JSON string as a v2 envelope (label 'dm-att-v2').
 *
 * @returns {Promise<{version: number, content: string, msgId: string, peerMinVersion: number}>}
 */
export async function encryptDmAttachmentMetaV2(metaPlain, senderId, recipientId, replyToId = 0) {
    const { content, msgId } = await buildDmV2AttachmentMetaContent({
        plaintext: metaPlain,
        senderId: Number(senderId),
        recipientId: Number(recipientId),
        replyToId: Number(replyToId) || 0
    });
    noteDmV2Version(recipientId, 2);
    return { version: 2, content, msgId, peerMinVersion: null };
}

/**
 * Decrypt a received v2 attachment-meta envelope.
 *
 * The caller MUST supply the stored row's `reply_to_id` and id, exactly like
 * decryptDmTextV2: the AAD binds replyToId and the replay check needs the row id.
 *
 * @param {object} payload
 * @param {number} peerId
 * @param {{replyToId?: number, rowId?: number}} [ctx]
 * @returns {Promise<string>}
 */
export async function decryptDmAttachmentMetaV2(payload, peerId, ctx = {}) {
    const { plaintext } = await openDmV2AttachmentEnvelope({
        payload,
        peerId: Number(peerId),
        ownUserId: Number(getCurrentUser()?.id),
        replyToId: Number((ctx && ctx.replyToId) || 0),
        rowId: ctx ? ctx.rowId : null
    });
    noteDmV2Version(peerId, 2);
    return plaintext;
}

// Re-export so callers importing from message-crypto see the same surface.
export { DmDowngradeRefusedError } from './dm-v2-wire.js';