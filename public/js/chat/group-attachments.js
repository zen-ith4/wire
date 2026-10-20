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
import { encryptOutgoingGroupMessage, decryptIncomingGroupMessageDetailed, UnverifiedMessageError } from '../crypto/messages/group-message-crypto.js';

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

/**
 * The compiled-in HARD CEILING on the cap the server reports, in MB.
 *
 * A hostile (or compromised) server must not be able to raise the client's
 * own memory bound: the value the server reports is only ever used when it
 * is SMALLER than this ceiling. The server stays the authority for the
 * files it accepts, but the client never trusts a server value above its own
 * ceiling.
 */
export const MAX_GROUP_ATTACHMENT_HARD_MAX_MB = DEFAULT_GROUP_ATTACHMENT_UPLOAD_MAX_MB;

/**
 * The largest file the client will ever DOWNLOAD, in bytes: the compiled-in
 * cap times 1 MB. A signed `att_len` above this is refused BEFORE a request
 * is sent (STEP 3E item 0): the download is bounded by the SIGNED size, not
 * by what the server chooses to send.
 */
export const MAX_GROUP_ATTACHMENT_PLAINTEXT_BYTES = MAX_GROUP_ATTACHMENT_HARD_MAX_MB * 1024 * 1024;

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
 * Reads a response body with a HARD bound.
 *
 * The primary path streams the body (`Response.body.getReader()`) into a
 * buffer of exactly `expectedBytes` bytes and cancels the stream the moment
 * it delivers more than that - the body is never buffered beyond what was
 * signed.
 *
 * The fallback (an environment without a streaming body) needs a declared
 * `Content-Length`: without it there is no bound, so the download is refused
 * instead of read. With it, the browser itself stops the body at the
 * declared length, so the read is bounded by the same number that was
 * signed.
 *
 * @param {Response} res
 * @param {number} expectedBytes the exact ciphertext length (att_len + 16)
 * @param {boolean} hasContentLength whether the response declared a length
 * @returns {Promise<Uint8Array>}
 */
export async function readBoundedAttachmentBody(res, expectedBytes, hasContentLength) {
    if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const out = new Uint8Array(expectedBytes);
        let filled = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || !value.length) continue;
                if (filled + value.length > expectedBytes) {
                    // More than was signed: stop reading NOW.
                    await reader.cancel().catch(() => {});
                    throw new UnverifiedMessageError('attachment-mismatch');
                }
                out.set(value, filled);
                filled += value.length;
            }
        } catch (e) {
            await reader.cancel().catch(() => {});
            throw e;
        }
        if (filled !== expectedBytes) {
            throw new UnverifiedMessageError('attachment-mismatch');
        }
        return out;
    }

    // No streaming body: only a declared length makes the read bounded.
    if (!hasContentLength) {
        throw new UnverifiedMessageError('attachment-mismatch');
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== expectedBytes) {
        throw new UnverifiedMessageError('attachment-mismatch');
    }
    return new Uint8Array(buf);
}

/**
 * Downloads the ciphertext of a group attachment (session header, never a
 * token in the URL). The signal aborts the download when the row leaves the
 * DOM.
 *
 * The download is BOUNDED (STEP 3E item 0):
 *   - the signed size is known before the request: a file bigger than the
 *     client's own maximum is refused WITHOUT sending a request;
 *   - a `Content-Length` that is not exactly the signed length aborts the
 *     request before the body is read;
 *   - the body itself is read with a hard bound and cancelled the moment it
 *     delivers more than was signed.
 *
 * @param {object} a
 * @param {number} a.groupId
 * @param {number} a.messageId
 * @param {AbortSignal} [a.signal]
 * @param {number} a.expectedBytes the exact ciphertext length (att_len + 16)
 * @param {number} [a.maxBytes] the client's own maximum (never raised by a
 *   server value)
 */
export async function fetchGroupAttachmentCiphertext({ groupId, messageId, signal, expectedBytes, maxBytes } = {}) {
    const token = getToken();
    if (!token) throw new Error('Authentication required');

    const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
        ? Number(maxBytes)
        : MAX_GROUP_ATTACHMENT_PLAINTEXT_BYTES;

    // (1) The SIGNED size, before any request: a file that is bigger than
    // the client's own maximum is refused without a request at all.
    const expected = Number(expectedBytes);
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > limit) {
        throw new UnverifiedMessageError('attachment-mismatch');
    }

    // The request is aborted through OUR controller, so a mismatch can stop
    // it even when the caller's signal is not triggered.
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', forward, { once: true });
    }

    let res;
    try {
        res = await fetch(groupAttachmentUrl(groupId, messageId), {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
        });
    } finally {
        if (signal) signal.removeEventListener('abort', forward);
    }
    if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);

    // (2) The declared length must be exactly what was signed.
    const declared = res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('content-length')
        : null;
    const hasContentLength = declared !== null && declared !== undefined && declared !== '';
    if (hasContentLength) {
        if (!/^\d+$/.test(String(declared)) || Number(declared) !== expected) {
            controller.abort();
            throw new UnverifiedMessageError('attachment-mismatch');
        }
    }

    // (3) The body, read with a hard bound.
    return readBoundedAttachmentBody(res, expected, hasContentLength);
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

/* =========================================================
 * The lazy receive path (STEP 3D item 2)
 *
 * The decorate NEVER downloads a file: it renders a placeholder row built
 * from the SIGNED meta (the name, the size from the signed att_len, and the
 * declared type - a hint only). The file is fetched when its row becomes
 * visible AND it is small enough to be auto-loaded; everything else waits
 * for an explicit click.
 * ========================================================= */

/** The largest file that is fetched automatically when its row becomes
 *  visible. Anything bigger waits for an explicit "Download (X MB)" click. */
export const GROUP_ATTACHMENT_AUTO_LOAD_MAX_BYTES = 5 * 1024 * 1024;

/** How many downloads may be in flight at the same time. */
export const GROUP_ATTACHMENT_MAX_CONCURRENT_DOWNLOADS = 2;

/** The rows of this module: message id -> the row's state. */
const rows = new Map();

/** The rows waiting for their file: filled by the decorate (the signed meta,
 *  the binding and the message row) and consumed by the loader. */
const staged = new Map();

/** The download queue and the number of downloads in flight. */
const queue = [];
let inFlight = 0;

/** The observer that watches the rows for visibility. */
let observer = null;

/** The blob URLs of the rendered files, per message id, so a re-render can
 *  revoke the previous one (and so a removed row can revoke its own). */
const blobUrls = new Map();

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** "5 MB", "1.2 MB", "512 KB", "80 B" - a hint for the user. */
export function formatGroupAttachmentSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return 'unknown size';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether the file may be fetched AUTOMATICALLY when its row becomes
 * visible: an image (by the DECLARED type - the sniffed type decides what is
 * rendered later) that is not bigger than the auto-load limit.
 */
export function isAutoLoadableGroupAttachment({ mime, size } = {}) {
    const type = String(mime || '').toLowerCase();
    if (!INLINE_IMAGE_MIMES.includes(type)) return false;
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes < 0) return false;
    return bytes <= GROUP_ATTACHMENT_AUTO_LOAD_MAX_BYTES;
}

/**
 * The placeholder row of a message whose file is not loaded yet.
 *
 * The name is the SANITISED name, the size comes from the SIGNED att_len
 * and the type is the DECLARED one - shown only as a hint (the real type is
 * the sniffed one, after the download).
 */
export function groupAttachmentPlaceholderHtml(msg, { name, size, mime } = {}) {
    const id = Number(msg?.id ?? 0);
    const shown = sanitiseGroupFileName(name);
    const bytes = Number(size) > 0 ? Number(size) : 0;
    const type = String(mime || '').slice(0, MAX_GROUP_ATTACHMENT_MIME);
    const auto = isAutoLoadableGroupAttachment({ mime: type, size: bytes });
    const label = auto ? 'Download' : `Download (${formatGroupAttachmentSize(bytes)})`;
    const sizeText = escapeHtml(formatGroupAttachmentSize(bytes));
    const typeText = type ? escapeHtml(type) : '';
    return `<div class="chat-attachment chat-attachment-lazy" data-group-attachment-id="${id}">
      <span class="chat-attachment-name">${escapeHtml(shown)}</span>
      <span class="chat-attachment-size">${sizeText}${typeText ? ' - ' + typeText : ''}</span>
      <button type="button" class="chat-attachment-download" data-action="group-attachment-download" data-msg-id="${id}" title="Download">${label}</button>
    </div>`;
}

/**
 * The content of a loaded file: the image (inline, from a blob URL) or the
 * name and the download link.
 *
 * The name is written as TEXT (escaped, never as markup) and is always the
 * SANITISED name. Only a sniffed inline type is rendered as an image; the
 * download is always served as application/octet-stream (never the declared
 * mime).
 */
export function groupAttachmentContentHtml(id, received) {
    const name = escapeHtml(received.name);

    const old = blobUrls.get(String(id));
    if (old) {
        URL.revokeObjectURL(old);
        blobUrls.delete(String(id));
    }

    if (received.inlineMime) {
        const url = URL.createObjectURL(new Blob([received.bytes], { type: received.inlineMime }));
        blobUrls.set(String(id), url);
        const urlAttr = escapeHtml(url);
        const dims = received.w && received.h
            ? ` width="${Number(received.w)}" height="${Number(received.h)}"`
            : '';
        return `<div class="chat-attachment-image-wrap">
      <img class="chat-attachment-image" src="${urlAttr}" alt="${name}"${dims}>
    </div>`;
    }

    const url = URL.createObjectURL(new Blob([received.bytes], { type: 'application/octet-stream' }));
    blobUrls.set(String(id), url);
    const urlAttr = escapeHtml(url);
    const nameAttr = escapeHtml(received.name);
    return `<span class="chat-attachment-name">${name}</span>
      <a class="chat-attachment-download" href="${urlAttr}" download="${nameAttr}" title="Download">Download</a>`;
}

/** The per-row placeholder for a file that must not be rendered. */
export function groupAttachmentUnavailableHtml() {
    return `<div class="chat-attachment chat-attachment-unsupported">
      <span class="chat-attachment-name">${GROUP_ATTACHMENT_UNAVAILABLE_NAME}</span>
    </div>`;
}

/** The per-row error for a download that failed for a reason the user can
 *  act on (a network error): a retry button. */
export function groupAttachmentErrorHtml(msg, reason) {
    const id = Number(msg?.id ?? 0);
    const why = escapeHtml(String(reason || 'download failed').slice(0, 120));
    return `<span class="chat-attachment-name">Download failed (${why})</span>
      <button type="button" class="chat-attachment-retry" data-action="group-attachment-retry" data-msg-id="${id}" title="Retry">Retry</button>`;
}

/**
 * Stages a message whose file is not loaded yet. Called by the decorate.
 * NO network happens here.
 */
export function stageGroupAttachment({ id, groupId, raw, binding, senderKeyId, meta, size } = {}) {
    staged.set(String(id), { id: String(id), groupId, raw, binding, senderKeyId, meta, size });
}

/**
 * Registers a RENDERED row so the loader can pick it up: the row is watched
 * for visibility, and a re-render replaces the element (the old one is
 * aborted and its blob URL revoked).
 */
export function registerGroupAttachmentRow(msg, node) {
    const id = String(msg?.id ?? '');
    const info = staged.get(id);
    if (!info || !node) return;
    const el = node.querySelector(`[data-group-attachment-id="${id}"]`);
    if (!el) return;

    let row = rows.get(id);
    if (row && row.el && row.el !== el) {
        // The row was re-rendered (the thread repaints). An in-flight
        // download is aborted (its row is gone) and started again when the
        // new row becomes visible; a LOADED row keeps its bytes and its blob
        // URL - there is no second download.
        if (row.state === 'loading' || row.state === 'queued') {
            softAbortGroupAttachment(row);
        } else {
            row.el = el;
        }
    }
    if (!row) {
        row = { id, state: 'idle', controller: null, blobUrl: null };
        rows.set(id, row);
    }
    row.el = el;
    row.groupId = info.groupId;
    row.raw = info.raw;
    row.binding = info.binding;
    row.senderKeyId = info.senderKeyId;
    row.meta = info.meta;
    row.size = info.size;

    if (row.state === 'loaded' || row.state === 'mismatch' || row.state === 'error') {
        // A finished row keeps its outcome across a re-render: the loaded
        // content, the "Attachment unavailable" placeholder or the error with
        // its retry button.
        renderRow(row);
    } else {
        observeRow(row);
    }
}

/** The observer that watches the rows for visibility. */
function ensureObserver() {
    if (observer) return observer;
    if (typeof IntersectionObserver === 'undefined') return null;
    observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const id = String(entry.target?.dataset?.groupAttachmentId ?? '');
            const row = rows.get(id);
            if (!row) continue;
            observer.unobserve(entry.target);
            if (row.state === 'idle' && isAutoLoadableGroupAttachment({ mime: row.meta?.file?.mime, size: row.size })) {
                enqueueGroupAttachment(row);
            }
        }
    }, { rootMargin: '200px' });
    return observer;
}

function observeRow(row) {
    const obs = ensureObserver();
    if (!obs || !row.el) return;
    obs.observe(row.el);
}

/**
 * Starts (or retries) the download of one row. At most
 * GROUP_ATTACHMENT_MAX_CONCURRENT_DOWNLOADS downloads run at the same time.
 */
export function downloadGroupAttachment(id) {
    const row = rows.get(String(id));
    if (!row) return false;
    if (row.state === 'queued' || row.state === 'loading') return false;
    enqueueGroupAttachment(row);
    return true;
}

function enqueueGroupAttachment(row) {
    if (!row || row.state === 'queued' || row.state === 'loading') return;
    row.state = 'queued';
    if (!queue.includes(row.id)) queue.push(row.id);
    pumpQueue();
}

function pumpQueue() {
    while (inFlight < GROUP_ATTACHMENT_MAX_CONCURRENT_DOWNLOADS && queue.length) {
        const id = queue.shift();
        const row = rows.get(String(id));
        if (!row || row.state !== 'queued') continue;
        inFlight++;
        row.state = 'loading';
        row.controller = typeof AbortController === 'undefined' ? null : new AbortController();
        runDownload(row).finally(() => {
            inFlight--;
            row.controller = null;
            pumpQueue();
        });
    }
}

/** How many downloads are in flight right now (the tests assert the cap). */
export function groupAttachmentDownloadsInFlight() {
    return inFlight;
}

/** How many downloads are waiting in the queue right now. */
export function groupAttachmentQueueLength() {
    return queue.length;
}

/** The state of one row: 'idle', 'queued', 'loading', 'loaded', 'mismatch',
 *  'error' or 'aborted'. */
export function groupAttachmentRowState(id) {
    const row = rows.get(String(id));
    return row ? row.state : null;
}

async function runDownload(row) {
    try {
        // STEP 3E item 0: the download is bounded by the SIGNED size (the
        // verified att_len) and by the client's own maximum - never by what
        // the server chooses to send.
        const expectedBytes = (Number(row.size) || 0) + GCM_TAG_BYTES;
        const ciphertext = await fetchGroupAttachmentCiphertext({
            groupId: row.groupId,
            messageId: row.raw.id,
            signal: row.controller?.signal,
            expectedBytes,
            maxBytes: MAX_GROUP_ATTACHMENT_PLAINTEXT_BYTES,
        });
        const bytes = await decryptGroupAttachmentBytes({
            groupId: row.groupId,
            ciphertext,
            rowIvBase64: row.raw.attachment_iv,
            binding: row.binding,
            senderKeyId: row.senderKeyId,
            ref: `att:${row.raw.id}`,
        });
        if (row.state === 'aborted') return;
        const inlineMime = sniffInlineImageMime(bytes);
        row.bytes = bytes;
        row.inlineMime = inlineMime && INLINE_IMAGE_MIMES.includes(inlineMime) ? inlineMime : null;
        row.name = sanitiseGroupFileName(row.meta?.file?.name);
        row.state = 'loaded';
        renderRow(row);
    } catch (e) {
        if (row.state === 'aborted') return;
        if (e?.name === 'AbortError') {
            row.state = 'idle';
            return;
        }
        const reason = String(e?.reason || e?.message || e);
        if (e?.reason === 'attachment-mismatch') {
            // The bytes do not match what the sender signed: permanent, no
            // retry loop.
            row.state = 'mismatch';
        } else {
            row.state = 'error';
            row.error = reason;
        }
        renderRow(row);
    }
}

function renderRow(row) {
    const el = row.el;
    if (!el || !el.isConnected) return;
    if (row.state === 'loaded') {
        el.innerHTML = groupAttachmentContentHtml(row.id, {
            name: row.name,
            mime: row.meta?.file?.mime,
            w: row.meta?.file?.w,
            h: row.meta?.file?.h,
            bytes: row.bytes,
            inlineMime: row.inlineMime,
        });
        return;
    }
    if (row.state === 'mismatch') {
        el.innerHTML = groupAttachmentUnavailableHtml();
        return;
    }
    if (row.state === 'error') {
        el.innerHTML = groupAttachmentErrorHtml({ id: row.id }, row.error);
    }
}

/**
 * Aborts the download of one row and revokes its blob URL. The nonce is NOT
 * claimed: the claim happens inside the decrypt, which an aborted download
 * never reaches.
 */
export function abortGroupAttachment(id) {
    const key = String(id);
    const row = rows.get(key);
    if (row) {
        softAbortGroupAttachment(row);
        row.state = 'aborted';
        row.el = null;
    }
    const url = blobUrls.get(key);
    if (url) {
        URL.revokeObjectURL(url);
        blobUrls.delete(key);
    }
    const qi = queue.indexOf(key);
    if (qi !== -1) queue.splice(qi, 1);
}

/**
 * Aborts only the in-flight download of a row (the row's element is gone,
 * so the result would be thrown away). The bytes of a LOADED row are kept:
 * the thread repaints and the loader re-renders the content into the new
 * element - there is no second download and no lost content.
 */
function softAbortGroupAttachment(row) {
    if (row.controller) {
        try { row.controller.abort(); } catch { /* ignore */ }
        row.controller = null;
    }
    if (row.state === 'loading' || row.state === 'queued') row.state = 'idle';
    const qi = queue.indexOf(row.id);
    if (qi !== -1) queue.splice(qi, 1);
}

/**
 * Aborts the downloads of the rows that are no longer in the DOM: the group
 * was left, or the thread was repainted.
 *
 * The STAGED information (the signed meta, the binding) is kept: a repaint
 * re-uses the decorated messages from the thread's cache, so the row has to
 * be loadable again without decrypting the message a second time.
 */
export function abortDetachedGroupAttachments() {
    for (const [, row] of [...rows.entries()]) {
        if (row.el && row.el.isConnected) continue;
        softAbortGroupAttachment(row);
        row.el = null;
    }
}

/**
 * Aborts every download and revokes every blob URL: the thread was torn down
 * or the group was left for good.
 */
export function revokeAllGroupAttachments() {
    for (const id of [...rows.keys()]) abortGroupAttachment(id);
    rows.clear();
    staged.clear();
    queue.length = 0;
    if (observer) {
        observer.disconnect();
        observer = null;
    }
}

export { encryptOutgoingGroupMessage, decryptIncomingGroupMessageDetailed };
