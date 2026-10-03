// public/js/crypto/groups/sender-key-id.js
//
// Key schedule of a Sender Key (F8).
//
// What travels in a KDM and sits wrapped in IndexedDB is a 32-byte ROOT secret.
// It is never used directly. Two independent subkeys are derived from it with
// HKDF-SHA-256 and distinct info labels:
//
//     encKey = HKDF(root, info = "Wire-GroupKey-enc-v2")  -> AES-256-GCM key
//     idKey  = HKDF(root, info = "Wire-GroupKey-id-v2")   -> HMAC-SHA-256 key
//
// and the public senderKeyId is
//
//     id = hex(HMAC-SHA-256(idKey, encodeFields("group-sender-key-id-v2",
//                                               groupId, ownerUserId, epoch)))
//
// (length-prefixed fields, not "|" joins). The id is a PRF of the key, so two
// distinct keys (e.g. minted by two devices of one account at the same epoch)
// get distinct ids while every recipient arrives at the same id after
// unwrapping the KDM, without it being transmitted. Because encKey and idKey
// are independent, publishing the id in every message reveals nothing about
// the AES key.

import { encodeFields } from './codec.js';

const ENC_INFO = new TextEncoder().encode('Wire-GroupKey-enc-v2');
const ID_INFO = new TextEncoder().encode('Wire-GroupKey-id-v2');

async function importRoot(rootBytes) {
    if (!(rootBytes instanceof Uint8Array) || rootBytes.length !== 32) {
        throw new Error('Sender Key root must be 32 bytes');
    }
    return crypto.subtle.importKey('raw', rootBytes, { name: 'HKDF' }, false, ['deriveKey']);
}

/** AES-256-GCM key used to encrypt messages/attachments (non-extractable). */
export async function deriveSenderEncKey(rootBytes) {
    const root = await importRoot(rootBytes);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: ENC_INFO },
        root,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function deriveSenderKeyId(groupId, ownerUserId, epoch, rootBytes) {
    const root = await importRoot(rootBytes);
    const idKey = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: ID_INFO },
        root,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign']
    );
    const mac = await crypto.subtle.sign(
        'HMAC',
        idKey,
        encodeFields('group-sender-key-id-v2', Number(groupId), Number(ownerUserId), Number(epoch))
    );

    return Array.from(new Uint8Array(mac))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
