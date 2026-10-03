// public/js/crypto/groups/codec.js
//
// Identical logic to the base64 helpers duplicated across
// identity.js / messages/encrypt.js / messages/decrypt.js /
// keys/peer-keys.js — centralized here so the group crypto module
// (all new code) doesn't add a fifth copy.

export function bytesToBase64(bytes) {
    const view =
        bytes instanceof ArrayBuffer
            ? new Uint8Array(bytes)
            : bytes;

    let binary = '';

    for (const byte of view) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}

export function base64ToBytes(base64) {
    if (typeof base64 !== 'string' || !base64.length) {
        throw new Error('Invalid Base64 data');
    }

    let binary;

    try {
        binary = atob(base64);
    } catch {
        throw new Error('Invalid Base64 data');
    }

    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

/**
 * Best-effort zeroing of a Uint8Array holding sensitive material
 * (raw Sender Key bytes, decrypted key material in transit between
 * unwrap and re-import) once we're done with the JS reference to it.
 * Not a guarantee — the JS engine may have copied the bytes
 * elsewhere — but it's the same "remove our reference ASAP" posture
 * key-derivation.js already takes with the raw ECDH shared secret,
 * applied consistently here too.
 */
export function zero(bytes) {
    if (bytes instanceof Uint8Array) {
        bytes.fill(0);
    }
}

/**
 * Unambiguous encoding of a list of fields for use as AES-GCM additionalData
 * (or as an HMAC message). Every field is written as
 *     1 type byte (0 = UTF-8 text, 1 = raw bytes) | 4-byte big-endian length | data
 * so no two different field lists can encode to the same bytes (unlike
 * "a|b|c" joins, where a field containing the separator shifts the rest).
 * Numbers are written as their decimal text.
 *
 * @param {...(string|number|Uint8Array)} parts
 * @returns {Uint8Array}
 */
export function encodeFields(...parts) {
    const enc = new TextEncoder();
    const chunks = parts.map((part) => {
        if (part instanceof Uint8Array) return { type: 1, bytes: part };
        if (typeof part === 'string' || typeof part === 'number') {
            return { type: 0, bytes: enc.encode(String(part)) };
        }
        throw new Error('encodeFields: unsupported field type');
    });

    const total = chunks.reduce((n, c) => n + 5 + c.bytes.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let offset = 0;

    for (const { type, bytes } of chunks) {
        out[offset] = type;
        view.setUint32(offset + 1, bytes.length);
        out.set(bytes, offset + 5);
        offset += 5 + bytes.length;
    }

    return out;
}
