// public/js/chat/group-attachments.js
//
// STEP 3C: group attachments, client side.
//
// This is the ONLY client module that may call encryptAttachmentForGroup /
// decryptAttachmentForGroup (tests/groups/group-signing-messages.test.mjs
// C3-12 enforces that).
//
// What it does:
//   - builds and parses the ENCRYPTED message plaintext that carries the
//     file metadata (the server never sees the name/mime/dimensions);
//   - sanitises the file name the way the receiver rules require;
//   - sniffs the DECRYPTED bytes before anything is rendered inline;
//   - encrypts a file and signs it into the message envelope (the signed
//     att_iv / att_ct_hash / att_len are the receiver's authority);
//   - downloads and decrypts a received file with the VERIFIED binding.
//
// The whole feature is behind GROUP_ATTACHMENTS_UI_ENABLED (false).

import { getToken } from '../core/auth.js';
import { resolveServerUrl } from '../core/server.js';
import {
    encryptAttachmentForGroup,
    decryptAttachmentForGroup,
    computeImageDimensions,
} from '../crypto/messages/attachment-crypto.js';
import { encryptOutgoingGroupMessage, decryptIncomingGroupMessageDetailed } from '../crypto/messages/group-message-crypto.js';

/* =========================================================
 * Limits (see docs/GROUP_ATTACHMENTS_E2EE.md, section "3C")
 * ========================================================= */

export const MAX_GROUP_ATTACHMENT_CAPTION = 60000;
export const MAX_GROUP_ATTACHMENT_NAME = 255;
export const MAX_GROUP_ATTACHMENT_MIME = 127;
export const MAX_GROUP_ATTACHMENT_DIMENSION = 20000;

/** The four types that may ever be rendered inline - and only after the
 *  DECRYPTED bytes were sniffed to match. SVG is never in this list. */
export const INLINE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The wording of the per-row placeholder of a file that must not be rendered
 *  (the same wording the DM path uses). */
export const GROUP_ATTACHMENT_UNAVAILABLE_NAME = 'Attachment unavailable';

/* =========================================================
 * The encrypted plaintext format
 * ========================================================= */

const META_VERSION = 1;

/**
 * Builds the plaintext of a group message that carries a file.
 * @param {{text?: string, file?: {name: string, mime: string, w?: number|null, h?: number|null}}} f
 * @returns {string} JSON
 */
export function buildGroupAttachmentPlaintext({ text = '', file } = {}) {
    const caption = String(text || '').slice(0, MAX_GROUP_ATTACHMENT_CAPTION);
    const meta = { v: META_VERSION, text: caption };
    if (file) {
        meta.file = {
            name: String(file.name || 'file').slice(0, MAX_GROUP_ATTACHMENT_NAME),
            mime: String(file.mime || 'application/octet-stream').slice(0, MAX_GROUP_ATTACHMENT_MIME),
        };
        if (Number.isInteger(file.w) && file.w > 0 && file.w <= MAX_GROUP_ATTACHMENT_DIMENSION) meta.file.w = file.w;
        if (Number.isInteger(file.h) && file.h > 0 && file.h <= MAX_GROUP_ATTACHMENT_DIMENSION) meta.file.h = file.h;
    }
    return JSON.stringify(meta);
}

/**
 * Parses the plaintext of a group message. STRICT: an unknown version, an
 * unknown key or a bad field is a malformed meta object (null), not
 * something to ignore.
 * @param {string} plaintext
 * @returns {{text: string, file: {name: string, mime: string, w?: number, h?: number}|null}|null}
 */
export function parseGroupAttachmentPlaintext(plaintext) {
    if (typeof plaintext !== 'string' || !plaintext) return null;
    let obj;
    try {
        obj = JSON.parse(plaintext);
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (obj.v !== META_VERSION) return null;
    for (const key of Object.keys(obj)) {
        if (key !== 'v' && key !== 'text' && key !== 'file') return null;
    }
    if (typeof obj.text !== 'string') return null;

    if (obj.file === undefined || obj.file === null) {
        return { text: obj.text, file: null };
    }
    const f = obj.file;
    if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
    for (const key of Object.keys(f)) {
        if (key !== 'name' && key !== 'mime' && key !== 'w' && key !== 'h') return null;
    }
    if (typeof f.name !== 'string' || !f.name || f.name.length > MAX_GROUP_ATTACHMENT_NAME) return null;
    if (typeof f.mime !== 'string' || !f.mime || f.mime.length > MAX_GROUP_ATTACHMENT_MIME) return null;
    const out = { name: f.name, mime: f.mime.toLowerCase() };
    for (const dim of ['w', 'h']) {
        if (f[dim] === undefined) continue;
        if (!Number.isInteger(f[dim]) || f[dim] <= 0 || f[dim] > MAX_GROUP_ATTACHMENT_DIMENSION) return null;
        out[dim] = f[dim];
    }
    return { text: obj.text, file: out };
}

/* =========================================================
 * Receiver sanitising rules
 * ========================================================= */

// Path separators, control characters and bidi/override characters.
const STRIP_RE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\]/g;

/**
 * The file name as the receiver shows it: path separators, control
 * characters and bidi/override characters are stripped, and an empty result
 * becomes the literal "file".
 */
export function sanitiseGroupFileName(name) {
    const cleaned = String(name == null ? '' : name).replace(STRIP_RE, '').trim();
    return cleaned || 'file';
}

/* =========================================================
 * Sniffing the DECRYPTED bytes
 * ========================================================= */

function startsWith(bytes, sig) {
    if (bytes.length < sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
    return true;
}

/**
 * The inline type of the DECRYPTED bytes, or null. The declared mime is
 * never enough: a file that CLAIMS image/png but holds HTML or SVG is not
 * rendered inline.
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
export function sniffInlineImageMime(bytes) {
    if (!bytes || bytes.length < 12) return null;
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    // WEBP: "RIFF" ....  "WEBP"
    if (bytes.length >= 12 && startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
}

/* =========================================================
 * Send
 * ========================================================= */

export class GroupAttachmentTooLargeError extends Error {
    constructor(maxMb) {
        super(`File is larger than ${maxMb} MB`);
        this.name = 'GroupAttachmentTooLargeError';
        this.maxMb = maxMb;
    }
}

/**
 * Encrypts a file for a group and signs it into the message envelope.
 * The returned `fields` are what the server stores; the real name, mime and
 * dimensions travel inside the ENCRYPTED plaintext.
 *
 * The order is fixed: (1) the Sender Key is ensured, (2) the file bytes are
 * read, (3) the file is encrypted (a fresh counter), (4) the plaintext JSON
 * is built, (5) the message is encrypted and signed with the file binding.
 *
 * @returns {Promise<{file: File, fields: Record<string,string>}>}
 */
export async function prepareGroupAttachmentUpload({ file, caption = '', replyToId = 0, groupId, ensureKey, maxMb = 50 }) {
    if (!file || typeof file.size !== 'number') throw new Error('No file to encrypt');
    if (file.size <= 0) throw new Error('The file is empty');
    if (file.size > maxMb * 1024 * 1024) throw new GroupAttachmentTooLargeError(maxMb);
    if (String(caption || '').length > MAX_GROUP_ATTACHMENT_CAPTION) {
        throw new Error(`The caption is longer than ${MAX_GROUP_ATTACHMENT_CAPTION} characters`);
    }

    // (1) the Sender Key, before anything is encrypted.
    if (typeof ensureKey === 'function') await ensureKey();

    // (3) the file, under a fresh counter of the Sender Key.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { ivBase64, ciphertext } = await encryptAttachmentForGroup(groupId, bytes.buffer);

    // (4) the plaintext that carries the metadata.
    let width = null;
    let height = null;
    if (typeof file.type === 'string' && file.type.startsWith('image/')) {
        try {
            const dims = await computeImageDimensions(new Blob([bytes], { type: file.type }));
            width = dims?.width ?? null;
            height = dims?.height ?? null;
        } catch {
            width = null;
            height = null;
        }
    }
    const plaintext = buildGroupAttachmentPlaintext({
        text: caption,
        file: { name: file.name || 'file', mime: file.type || 'application/octet-stream', w: width, h: height },
    });

    // (5) the signed envelope.
    const envelope = await encryptOutgoingGroupMessage(groupId, plaintext, {
        replyToId: Number(replyToId) || null,
        attachment: { ivBase64, ciphertext, plaintextLength: bytes.byteLength },
    });

    return {
        file: new File([ciphertext], 'attachment.bin', { type: 'application/octet-stream' }),
        fields: {
            content: envelope,
            attachment_iv: ivBase64,
        },
    };
}

/* =========================================================
 * Receive
 * ========================================================= */

function groupAttachmentUrl(groupId, messageId) {
    return resolveServerUrl(`/api/groups/${encodeURIComponent(groupId)}/attachments/${encodeURIComponent(messageId)}`);
}

/**
 * Downloads the ciphertext of a group attachment (session header, never a
 * token in the URL).
 */
export async function fetchGroupAttachmentCiphertext({ groupId, messageId, signal } = {}) {
    const token = getToken();
    if (!token) throw new Error('Authentication required');
    const res = await fetch(groupAttachmentUrl(groupId, messageId), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal,
    });
    if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
}

/**
 * Decrypts a downloaded group attachment with the VERIFIED binding.
 * Throws UnverifiedMessageError('attachment-mismatch') when the bytes do not
 * match what the sender signed.
 */
export async function decryptGroupAttachmentBytes({ groupId, ciphertext, rowIvBase64, binding, senderKeyId, ref } = {}) {
    const plain = await decryptAttachmentForGroup({
        groupId, ciphertext, rowIvBase64, binding, senderKeyId, ref,
    });
    return new Uint8Array(plain);
}

/**
 * The whole receive side for one group message: the verified binding comes
 * from decryptGroupMessageDetailed, the file is downloaded and decrypted, and
 * the bytes are sniffed before anything may be rendered inline.
 *
 * @param {object} a
 * @param {number} a.groupId
 * @param {object} a.raw the message ROW (for its id and its attachment_iv column)
 * @param {string} a.plaintext the DECRYPTED message plaintext (the meta JSON)
 * @param {object} a.binding the verified binding
 * @param {string} a.senderKeyId
 * @returns {Promise<{name: string, mime: string, w?: number, h?: number, bytes: Uint8Array, inlineMime: string|null}>}
 */
export async function receiveGroupAttachment({ groupId, raw, plaintext, binding, senderKeyId }) {
    const meta = parseGroupAttachmentPlaintext(plaintext);
    if (!meta || !meta.file) throw new Error('Malformed group attachment meta');

    const ciphertext = await fetchGroupAttachmentCiphertext({ groupId, messageId: raw.id });
    const bytes = await decryptGroupAttachmentBytes({
        groupId,
        ciphertext,
        rowIvBase64: raw.attachment_iv,
        binding,
        senderKeyId,
        ref: `att:${raw.id}`,
    });
    const inlineMime = sniffInlineImageMime(bytes);
    return {
        name: sanitiseGroupFileName(meta.file.name),
        mime: meta.file.mime,
        w: meta.file.w,
        h: meta.file.h,
        bytes,
        // Only a sniffed type may be rendered inline - the declared mime is
        // never enough.
        inlineMime: inlineMime && INLINE_IMAGE_MIMES.includes(inlineMime) ? inlineMime : null,
    };
}

export { encryptOutgoingGroupMessage, decryptIncomingGroupMessageDetailed };

/* =========================================================
 * Render
 * ========================================================= */

// Blob URLs of the rendered files, per message id, so a re-render can revoke
// the previous one (and so a removed row can revoke its own).
const blobUrls = new Map();

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The HTML of a received group attachment.
 *
 * The name is written as TEXT (escaped, never as markup) and is always the
 * SANITISED name. Only a sniffed inline type is rendered as an image, from a
 * blob URL; everything else is a download link to a blob URL of the decrypted
 * bytes, served as application/octet-stream (never the declared mime).
 */
export function groupAttachmentHtml(msg, received) {
    // The escaped values are computed ONCE and interpolated: the CSP guard
    // (tests/csp-static.test.mjs) allows no escapeHtml() call inside a
    // quoted attribute value in a new file.
    const name = escapeHtml(received.name);
    const id = String(msg?.id ?? '');

    const old = blobUrls.get(id);
    if (old) {
        URL.revokeObjectURL(old);
        blobUrls.delete(id);
    }

    if (received.inlineMime) {
        const url = URL.createObjectURL(new Blob([received.bytes], { type: received.inlineMime }));
        blobUrls.set(id, url);
        const urlAttr = escapeHtml(url);
        const dims = received.w && received.h
            ? ` width="${Number(received.w)}" height="${Number(received.h)}"`
            : '';
        return `<div class="chat-attachment chat-attachment-image-wrap">
      <img class="chat-attachment-image" src="${urlAttr}" alt="${name}"${dims}>
    </div>`;
    }

    // Not an inline type: a download of the decrypted bytes, as
    // application/octet-stream, with the sanitised name.
    const url = URL.createObjectURL(new Blob([received.bytes], { type: 'application/octet-stream' }));
    blobUrls.set(id, url);
    const urlAttr = escapeHtml(url);
    const nameAttr = escapeHtml(received.name);
    return `<div class="chat-attachment chat-attachment-file">
      <span class="chat-attachment-name">${name}</span>
      <a class="chat-attachment-download" href="${urlAttr}" download="${nameAttr}" title="Download">Download</a>
    </div>`;
}

/** The per-row placeholder for a file that must not be rendered. */
export function groupAttachmentUnavailableHtml() {
    return `<div class="chat-attachment chat-attachment-unsupported">
      <span class="chat-attachment-name">${GROUP_ATTACHMENT_UNAVAILABLE_NAME}</span>
    </div>`;
}

/**
 * Revokes the blob URL (and forgets the bytes) of one message.
 */
export function revokeGroupAttachment(messageId) {
    const id = String(messageId);
    const url = blobUrls.get(id);
    if (url) {
        URL.revokeObjectURL(url);
        blobUrls.delete(id);
    }
}
