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

/**
 * The client's fallback upload cap, in MB.
 *
 * STEP 3D item 3: the SERVER's cap is `GROUP_UPLOAD_MAX_MB`
 * (config/constants.js), an environment value. The client cannot read it
 * today: the DM path learns the DM cap from `GET /api/dm/limits`
 * (public/js/media/attachment-e2ee.js:292) and there is NO group
 * equivalent - adding one would need `routes/groups.routes.js`, which this
 * step may not touch. Until that endpoint exists this constant is the
 * client's best knowledge, and the server stays the authority: it rejects
 * anything over its own cap (the client would then get a 400).
 */
export const DEFAULT_GROUP_ATTACHMENT_UPLOAD_MAX_MB = 50;

/** The four types that may ever be rendered inline - and only after the
 *  DECRYPTED bytes were sniffed to match. SVG is never in this list. */
export const INLINE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The wording of the per-row placeholder of a file that must not be rendered
 *  (the same wording the DM path uses). */
export const GROUP_ATTACHMENT_UNAVAILABLE_NAME = 'Attachment unavailable';

/* =========================================================
 * The envelope limit (STEP 3D item 0)
 *
 * The server refuses a `content` longer than 90,000 characters
 * (controllers/groups.controller.js). The client must refuse BEFORE the
 * upload, because a refusal after the upload burns the file's counter and
 * the message's counter and leaves an orphan file on disk.
 *
 * The caption cap alone is NOT enough: the plaintext is JSON (a newline
 * costs 2 characters, a NUL costs 6), then UTF-8 (an accent costs 2
 * bytes, an emoji 4) and then base64 (4 characters per 3 bytes). So
 * 60,000 characters of caption can be 160,000 - 480,000 envelope
 * characters. The client therefore measures the ENVELOPE, not the caption.
 * ========================================================= */

/** The server's hard limit on the `content` field. */
export const SERVER_MAX_CONTENT_CHARS = 90000;

/** The margin the client keeps: the client refuses before the server would. */
export const GROUP_ATTACHMENT_ENVELOPE_MARGIN = 2000;

/** The named limit the client enforces on the FINAL signed envelope. */
export const MAX_GROUP_ATTACHMENT_ENVELOPE_CHARS = SERVER_MAX_CONTENT_CHARS - GROUP_ATTACHMENT_ENVELOPE_MARGIN;

/** The AES-GCM tag length (the ciphertext is the plaintext plus these bytes). */
const GCM_TAG_BYTES = 16;

/**
 * The shape of the signed envelope (crypto/groups/message-crypto.js). Only
 * `ciphertext` grows with the caption (it is the base64 of the encrypted
 * plaintext); every other field has a fixed width. The values below are the
 * WIDEST possible ones, so the estimate is an upper bound.
 *
 * A test compares this estimate against a REAL envelope, so a change in the
 * envelope shape cannot pass unnoticed.
 */
const ENVELOPE_SHAPE = {
    v: 2,
    alg: 'AES-GCM',
    senderKeyId: 'f'.repeat(64),
    counter: Number.MAX_SAFE_INTEGER,
    iv: 'A'.repeat(16),
    ciphertext: '',
    reply_to_id: Number.MAX_SAFE_INTEGER,
    sig: 'A'.repeat(88),
    att_iv: 'A'.repeat(16),
    att_ct_hash: 'A'.repeat(44),
    att_len: '99999999999999999999',
};

/** The fixed part of the envelope: its length with an empty ciphertext,
 *  minus the two quote characters the empty string occupies. */
const ENVELOPE_FIXED_CHARS = JSON.stringify(ENVELOPE_SHAPE).length - 2;

/** The JSON-escaped form of a string, without the surrounding quotes: a
 *  newline is 2 characters, a NUL is 6, an accent stays 1. */
function jsonEscapedLength(text) {
    const s = String(text == null ? '' : text);
    if (s.length === 0) return '';
    const quoted = JSON.stringify(s);
    return quoted.length - 2;
}

/** The UTF-8 byte length of a string. */
export function utf8ByteLength(text) {
    return new TextEncoder().encode(String(text == null ? '' : text)).length;
}

/**
 * An upper bound of the signed envelope's length for a given plaintext.
 */
export function estimateEnvelopeChars(plaintext) {
    const bytes = utf8ByteLength(plaintext);
    const ciphertextChars = 4 * Math.ceil((bytes + GCM_TAG_BYTES) / 3);
    return ENVELOPE_FIXED_CHARS + ciphertextChars;
}

/**
 * An upper bound of the signed envelope's length for a given caption, computed
 * WITHOUT building the plaintext and without touching the file bytes: the
 * caption's JSON-escaped, UTF-8 encoded length on top of the fixed part of
 * the meta object.
 *
 * @param {string} caption
 * @param {number} fixedMetaBytes the UTF-8 length of the meta object with an
 *   EMPTY caption (the name, mime and the largest possible dimensions)
 */
export function estimateEnvelopeCharsForCaption(caption, fixedMetaBytes) {
    // The escaped caption is what ends up in the plaintext; its UTF-8 byte
    // length is what the base64 runs over.
    const escapedBytes = utf8ByteLength(JSON.stringify(String(caption == null ? '' : caption)).slice(1, -1));
    const worstPlaintextBytes = fixedMetaBytes + escapedBytes;
    const ciphertextChars = 4 * Math.ceil((worstPlaintextBytes + GCM_TAG_BYTES) / 3);
    return ENVELOPE_FIXED_CHARS + ciphertextChars;
}

/**
 * The largest caption (in PLAIN ASCII characters) that still fits into the
 * envelope limit. Non-ASCII characters and control characters cost more, so
 * this is the upper bound, not a promise.
 */
export function maxCaptionCharsForLimit(fixedMetaBytes) {
    const room = Math.floor(((MAX_GROUP_ATTACHMENT_ENVELOPE_CHARS - ENVELOPE_FIXED_CHARS) * 3) / 4) - GCM_TAG_BYTES;
    return Math.max(0, room - fixedMetaBytes);
}

/** Thrown when the caption would produce an envelope the server would refuse. */
export class GroupAttachmentEnvelopeTooLargeError extends Error {
    constructor(measured, limit, maxCaptionChars) {
        super(
            `The caption is too long: this message would be ${measured} characters, the limit is ${limit}. `
            + `At most ${maxCaptionChars} plain characters (fewer if the caption contains newlines, quotes or non-ASCII characters).`
        );
        this.name = 'GroupAttachmentEnvelopeTooLargeError';
        this.measured = measured;
        this.limit = limit;
        this.maxCaptionChars = maxCaptionChars;
    }
}

/** The fixed part of the meta object, in UTF-8 bytes: the name, the mime and
 *  the LARGEST possible dimensions (the real ones are only known after the
 *  image was read, and the bound must stay an upper bound). */
function metaFixedBytesForBound(name, mime) {
    const probe = buildGroupAttachmentPlaintext({
        text: '',
        file: {
            name: String(name || 'file'),
            mime: String(mime || 'application/octet-stream'),
            w: MAX_GROUP_ATTACHMENT_DIMENSION,
            h: MAX_GROUP_ATTACHMENT_DIMENSION,
        },
    });
    return utf8ByteLength(probe);
}

/**
 * Refuses a caption whose WORST-CASE envelope would be over the limit.
 * Called before anything is encrypted, so no counter is reserved.
 *
 * @param {string} caption
 * @param {number} fixedMetaBytes
 * @returns {number} the upper bound it measured
 */
export function assertCaptionFitsEnvelope(caption, fixedMetaBytes) {
    const bound = estimateEnvelopeCharsForCaption(caption, fixedMetaBytes);
    if (bound > MAX_GROUP_ATTACHMENT_ENVELOPE_CHARS) {
        throw new GroupAttachmentEnvelopeTooLargeError(
            bound,
            MAX_GROUP_ATTACHMENT_ENVELOPE_CHARS,
            maxCaptionCharsForLimit(fixedMetaBytes)
        );
    }
    return bound;
}

/**
 * The final guard: the MEASURED signed envelope. The bound above is
 * deliberately pessimistic, so this only fires if the envelope shape changed
 * under us.
 *
 * @param {string} envelope
 * @param {number} [fixedMetaBytes]
 */
export function assertEnvelopeWithinLimit(envelope, fixedMetaBytes = 0) {
    if (typeof envelope === 'string' && envelope.length > MAX_GROUP_ATTACHMENT_ENVELOPE_CHARS) {
        throw new GroupAttachmentEnvelopeTooLargeError(
            envelope.length,
            MAX_GROUP_ATTACHMENT_ENVELOPE_CHARS,
            maxCaptionCharsForLimit(fixedMetaBytes)
        );
    }
    return envelope;
}

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

/** The maximum length of the DISPLAYED name. The signed meta keeps up to
 *  MAX_GROUP_ATTACHMENT_NAME (255) characters - this is what the receiver
 *  shows and what the download is named. */
export const MAX_GROUP_ATTACHMENT_DISPLAY_NAME = 120;

/**
 * The characters that are stripped from a receiver-visible file name:
 *
 *  - C0 controls (U+0000-U+001F) and DEL;
 *  - the path separators "/" and "\";
 *  - the bidi controls: the Arabic letter mark U+061C, the embeddings and
 *    overrides U+202A-U+202E and the isolates U+2066-U+2069;
 *  - the zero-width and formatting characters: U+200B-U+200F (zero-width
 *    space/non-joiner/joiner, LRM, RLM), U+2028/U+2029 (line and paragraph
 *    separator), U+2060-U+2064 (word joiner, invisible operators, invisible
 *    separator) and U+FEFF (BOM / zero-width no-break space);
 *  - the variation selectors U+FE00-U+FE0F.
 *
 * The supplementary planes are stripped separately (see below).
 */
const STRIP_RE = /[\u0000-\u001F\u007F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF\uFE00-\uFE0F/\\]/g;

/**
 * The same, from the supplementary planes: the variation selectors
 * U+E0100-U+E01EF and the tag characters U+E0000-U+E007F. They are invisible
 * and can carry a hidden payload (an emoji tag sequence is a known way to
 * smuggle data past a human reader), so a file name never keeps them.
 */
const STRIP_SUPPLEMENTARY_RE = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** The longest extension that is kept when the displayed name is capped. */
const MAX_KEPT_EXTENSION_CHARS = 16;

/**
 * Caps the DISPLAYED name, keeping the extension.
 * @param {string} name
 * @param {number} [max]
 */
export function capGroupFileName(name, max = MAX_GROUP_ATTACHMENT_DISPLAY_NAME) {
    const text = String(name == null ? '' : name);
    if (text.length <= max) return text;
    const dot = text.lastIndexOf('.');
    // Only a SHORT extension is kept - otherwise the "extension" is really
    // part of the name.
    const ext = dot > 0 && text.length - dot <= MAX_KEPT_EXTENSION_CHARS ? text.slice(dot) : '';
    const base = ext ? text.slice(0, dot) : text;
    const room = Math.max(1, max - ext.length);
    return base.slice(0, room) + ext;
}

/**
 * The file name as the receiver shows it.
 *
 * Stripped: path separators, control characters, the bidi controls, the
 * zero-width and formatting characters (and their supplementary-plane
 * cousins). Then: the trailing dots and spaces go (they are invisible on
 * some file systems), the leading dots go (the download must not be a
 * hidden file), and what is left is capped to
 * MAX_GROUP_ATTACHMENT_DISPLAY_NAME characters with the extension kept.
 * An empty result becomes the literal "file".
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitiseGroupFileName(name) {
    let cleaned = String(name == null ? '' : name)
        .replace(STRIP_RE, '')
        .replace(STRIP_SUPPLEMENTARY_RE, '')
        .trim();

    // Leading dots go: ".bashrc" must not become a hidden download.
    cleaned = cleaned.replace(/^\.+/, '');
    // Trailing dots and spaces go.
    cleaned = cleaned.replace(/[. ]+$/, '');

    if (!cleaned) return 'file';

    // The cap can cut a name so that it ends in a dot again.
    const capped = capGroupFileName(cleaned).replace(/[. ]+$/, '');
    return capped || 'file';
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
export async function prepareGroupAttachmentUpload({ file, caption = '', replyToId = 0, groupId, ensureKey, maxMb = DEFAULT_GROUP_ATTACHMENT_UPLOAD_MAX_MB }) {
    if (!file || typeof file.size !== 'number') throw new Error('No file to encrypt');
    if (file.size <= 0) throw new Error('The file is empty');
    if (file.size > maxMb * 1024 * 1024) throw new GroupAttachmentTooLargeError(maxMb);
    const captionText = String(caption || '');
    if (captionText.length > MAX_GROUP_ATTACHMENT_CAPTION) {
        throw new Error(
            `The caption is longer than ${MAX_GROUP_ATTACHMENT_CAPTION} characters `
            + '(fewer if it contains newlines, quotes or non-ASCII characters).'
        );
    }

    // (0) STEP 3D item 0: the CHEAP check comes FIRST, before any counter is
    // reserved. The caption is JSON-escaped, UTF-8 encoded and then base64
    // encoded, so 60,000 characters can be far more than 60,000 envelope
    // characters; measuring the caption alone is not enough.
    const fixedMetaBytes = metaFixedBytesForBound(file.name, file.type);
    assertCaptionFitsEnvelope(captionText, fixedMetaBytes);

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
        text: captionText,
        file: { name: file.name || 'file', mime: file.type || 'application/octet-stream', w: width, h: height },
    });

    // (5) the signed envelope.
    const envelope = await encryptOutgoingGroupMessage(groupId, plaintext, {
        replyToId: Number(replyToId) || null,
        attachment: { ivBase64, ciphertext, plaintextLength: bytes.byteLength },
    });

    // The final guard: the MEASURED envelope, not the estimate. The bound
    // above is deliberately pessimistic, so this only fires if the envelope
    // shape changed under us.
    assertEnvelopeWithinLimit(envelope, fixedMetaBytes);

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
