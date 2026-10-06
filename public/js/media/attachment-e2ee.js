// public/js/media/attachment-e2ee.js
//
// Client side of end-to-end encrypted DM attachments.
//
//  - prepareDmAttachmentUpload(): encrypts a file (and its caption)
//    BEFORE upload and returns the multipart fields the server expects.
//  - decryptAttachmentMetaEnvelope(): turns a message's opaque
//    `attachment_meta` into {name, mime, size, dimensions, voice flag}
//    and registers the per-file key in memory only (never persisted,
//    never logged).
//  - fetchDecryptedAttachment(): authenticated download of the
//    ciphertext, streamed through the chunk decryptor into a Blob.
//
// Key material lives only in the `secrets` Map below, keyed by
// `${scope}:${messageId}`, and is dropped when the message is removed.

import { getToken, logout } from '../core/auth.js';
import { resolveServerUrl } from '../core/server.js';
import { encryptOutgoingMessage, decryptIncomingMessage } from '../crypto/messages/message-crypto.js';
import { computeImageDimensions } from '../crypto/messages/attachment-crypto.js';
import {
  encryptAttachmentStream,
  decryptAttachmentStream,
  generateAttachmentKeyMaterial,
  buildAttachmentMeta,
  parseAttachmentMeta,
  streamBytesToBase64,
  AttachmentDecryptError,
} from '../crypto/messages/attachment-stream.js';

const secrets = new Map();
const unreadable = new Set();

// Decrypted blobs (not object URLs — each consumer creates and owns its
// own URL) so re-rendering a message does not re-download and
// re-decrypt it. Byte-capped; evicting a Blob needs no revoke.
const DECRYPTED_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const decryptedCache = new Map();
let decryptedCacheBytes = 0;

const inflight = new Map();

function secretKey(scope, id) {
  return `${scope}:${id}`;
}

export function registerAttachmentSecret(scope, id, parsedMeta) {
  secrets.set(secretKey(scope, id), parsedMeta);
}

export function getAttachmentSecret(scope, id) {
  return secrets.get(secretKey(scope, id)) || null;
}

export function markAttachmentUnreadable(scope, id) {
  unreadable.add(secretKey(scope, id));
}

export function isAttachmentUnreadable(scope, id) {
  return unreadable.has(secretKey(scope, id));
}

export function forgetAttachmentSecret(scope, id) {
  const key = secretKey(scope, id);
  secrets.delete(key);
  unreadable.delete(key);
  inflight.delete(key);
  const cached = decryptedCache.get(key);
  if (cached) {
    decryptedCacheBytes -= cached.size;
    decryptedCache.delete(key);
  }
}

export function clearAllAttachmentSecrets() {
  secrets.clear();
  unreadable.clear();
  inflight.clear();
  decryptedCache.clear();
  decryptedCacheBytes = 0;
}

function cacheDecrypted(key, blob) {
  if (blob.size > DECRYPTED_CACHE_MAX_BYTES) return;
  const existing = decryptedCache.get(key);
  if (existing) decryptedCacheBytes -= existing.size;
  decryptedCache.delete(key);
  decryptedCache.set(key, blob);
  decryptedCacheBytes += blob.size;
  while (decryptedCacheBytes > DECRYPTED_CACHE_MAX_BYTES && decryptedCache.size > 1) {
    const oldestKey = decryptedCache.keys().next().value;
    decryptedCacheBytes -= decryptedCache.get(oldestKey).size;
    decryptedCache.delete(oldestKey);
  }
}

/* =========================================================
 * Decrypt the metadata envelope of a received/sent message
 * ========================================================= */

/**
 * @returns the parsed metadata (with key material) or null when the
 * envelope is missing, tampered, or malformed. Never throws.
 */
export async function decryptAttachmentMetaEnvelope(envelopeString, peerId) {
  try {
    if (typeof envelopeString !== 'string' || !envelopeString) return null;
    const payload = JSON.parse(envelopeString);
    const plaintext = await decryptIncomingMessage(payload, Number(peerId));
    if (typeof plaintext !== 'string') return null;
    return parseAttachmentMeta(plaintext);
  } catch {
    return null;
  }
}

// Safe stand-in fields for a message whose attachment cannot be read.
export const UNREADABLE_ATTACHMENT_NAME = 'Attachment unavailable';

/**
 * Returns a copy of `msg` with the real attachment fields filled in from
 * the decrypted envelope (and the key registered), or with safe
 * placeholder fields when it cannot be decrypted. Messages without an
 * envelope (legacy plaintext attachments, text messages) are returned
 * unchanged.
 */
export async function applyAttachmentMeta(msg, peerId, scope = 'dm') {
  if (!msg || typeof msg.attachment_meta !== 'string' || !msg.attachment_meta) return msg;

  const meta = await decryptAttachmentMetaEnvelope(msg.attachment_meta, peerId);

  if (!meta) {
    markAttachmentUnreadable(scope, msg.id);
    return {
      ...msg,
      attachment_name: UNREADABLE_ATTACHMENT_NAME,
      attachment_mime: 'application/octet-stream',
      attachment_width: null,
      attachment_height: null,
      is_voice_message: false,
      attachment_unreadable: true,
    };
  }

  registerAttachmentSecret(scope, msg.id, meta);

  return {
    ...msg,
    attachment_name: meta.name,
    attachment_mime: meta.mime,
    attachment_size: meta.size || msg.attachment_size,
    attachment_width: meta.width,
    attachment_height: meta.height,
    is_voice_message: meta.isVoice,
    attachment_e2ee: true,
  };
}

// Reply previews only need the human-readable bits, never the key.
export async function applyReplyAttachmentMeta(replyTo, peerId) {
  if (!replyTo || typeof replyTo.attachment_meta !== 'string' || !replyTo.attachment_meta) return replyTo;

  const meta = await decryptAttachmentMetaEnvelope(replyTo.attachment_meta, peerId);
  const { attachment_meta: _omit, ...rest } = replyTo;

  if (!meta) {
    return { ...rest, attachment_name: UNREADABLE_ATTACHMENT_NAME, attachment_mime: 'application/octet-stream', is_voice_message: false };
  }

  return { ...rest, attachment_name: meta.name, attachment_mime: meta.mime, is_voice_message: meta.isVoice };
}

/* =========================================================
 * Authenticated download + decrypt
 * ========================================================= */

function attachmentUrl(scope, id, download = false) {
  const base = scope === 'dm'
    ? `/api/dm/attachments/${encodeURIComponent(id)}`
    : `/api/chat/attachments/${encodeURIComponent(id)}`;
  return resolveServerUrl(download ? `${base}?download=1` : base);
}

/**
 * Downloads the ciphertext with the normal session Authorization header
 * (no token in the URL) and decrypts it. Resolves to a Blob of the real
 * mime type; rejects with AttachmentDecryptError for any tampering.
 */
export async function fetchDecryptedAttachment(scope, id, { signal } = {}) {
  const key = secretKey(scope, id);
  const secret = secrets.get(key);
  if (!secret) throw new AttachmentDecryptError('No key for attachment');

  const cached = decryptedCache.get(key);
  if (cached) {
    decryptedCache.delete(key);
    decryptedCache.set(key, cached);
    return cached;
  }

  if (inflight.has(key) && !signal) return inflight.get(key);

  const work = (async () => {
    const token = getToken();
    if (!token) throw new Error('Authentication required');

    const response = await fetch(attachmentUrl(scope, id, true), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });

    if (!response.ok) {
      if (response.status === 401 && typeof logout === 'function') {
        try { logout(); } catch { /* ignore */ }
        throw new Error('Session expired');
      }
      throw new Error(`Attachment download failed (${response.status})`);
    }

    const source = response.body && typeof response.body.getReader === 'function'
      ? response.body
      : new Uint8Array(await response.arrayBuffer());

    const blob = await decryptAttachmentStream(source, secret.rawKey, secret.baseIv, secret.mime);
    cacheDecrypted(key, blob);
    return blob;
  })();

  if (!signal) {
    inflight.set(key, work);
    work.then(() => inflight.delete(key), () => inflight.delete(key));
  }

  return work;
}

/* =========================================================
 * Upload preparation (used by the composer's prepareUpload hook)
 * ========================================================= */

const MIN_IMAGE_BYTES_FOR_DIMENSIONS = 1;
const DIMENSIONS_TIMEOUT_MS = 5000;

/**
 * Encrypts `file` and `caption` for `recipientId`.
 * Returns { file, fields } where `file` is the ciphertext File to
 * upload and `fields` are extra multipart fields. The plaintext name,
 * mime, size, dimensions and voice flag only ever appear inside the
 * encrypted `attachment_meta` envelope.
 */
export async function prepareDmAttachmentUpload({ file, caption, isVoice, senderId, recipientId }) {
  if (!file || typeof file.size !== 'number') throw new Error('No file to encrypt');

  let width = null;
  let height = null;

  if (typeof file.type === 'string' && file.type.startsWith('image/') && file.size >= MIN_IMAGE_BYTES_FOR_DIMENSIONS) {
    // Dimensions are a layout hint only: never let a stuck decode
    // (or an environment without image decoding) block the upload.
    let timer;
    try {
      const dims = await Promise.race([
        computeImageDimensions(file),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), DIMENSIONS_TIMEOUT_MS);
        }),
      ]);
      width = dims?.width ?? null;
      height = dims?.height ?? null;
    } catch {
      // layout hint only
    } finally {
      clearTimeout(timer);
    }
  }

  const material = generateAttachmentKeyMaterial();
  const { blob } = await encryptAttachmentStream(file, material);

  const metaPlain = buildAttachmentMeta({
    rawKey: material.rawKey,
    baseIv: material.baseIv,
    name: file.name,
    mime: file.type,
    size: file.size,
    isVoice,
    width,
    height,
  });

  const metaEnvelope = await encryptOutgoingMessage(metaPlain, Number(senderId), Number(recipientId));

  const fields = {
    attachment_meta: JSON.stringify(metaEnvelope),
    attachment_iv: streamBytesToBase64(material.baseIv),
  };

  if (caption) {
    const captionEnvelope = await encryptOutgoingMessage(caption, Number(senderId), Number(recipientId));
    fields.content = JSON.stringify(captionEnvelope);
  }

  return {
    // Opaque name and type: nothing about the original file is sent in
    // the multipart headers either.
    file: new File([blob], 'attachment.bin', { type: 'application/octet-stream' }),
    fields,
  };
}
