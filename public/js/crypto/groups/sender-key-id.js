// public/js/crypto/groups/sender-key-id.js
//
// One Sender Key exists per (group, owner, epoch) — plan_prompt.md
// Section 3: each member generates their own key, and rotation
// (step 4) has every remaining member generate a new one under the
// bumped epoch. That triple is already a unique, non-secret handle,
// so rather than the owner minting a random id that recipients would
// then have no way to learn except by trusting an unauthenticated
// field inside the KDM payload, everyone just computes the same id
// locally from data they already have:
//
// - The owner has it when generating (their own groupId/userId/epoch).
// - A recipient has it from the KDM row's (group_id, from_user_id,
//   epoch) — no extra field needed in the wrapped payload.
//
// This id is not secret (it identifies *which* key, not the key
// material) and doesn't need to be unguessable — only collision-
// resistant and identical for everyone deriving it from the same
// triple, which a plain SHA-256 gives us.

export async function deriveSenderKeyId(groupId, ownerUserId, epoch) {
    const encoded = new TextEncoder().encode(
        `${Number(groupId)}:${Number(ownerUserId)}:${Number(epoch)}`
    );
    const digest = await crypto.subtle.digest('SHA-256', encoded);

    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

// ---------------------------------------------------------------
// Scheme 2 (device-safe ids)
// ---------------------------------------------------------------
//
// The scheme above has a flaw: nothing in (group, owner, epoch)
// distinguishes one DEVICE of an account from another. Identity keys
// are per-account and portable, so two devices of the same user who
// both create their first key at the same epoch derived the SAME id
// for two DIFFERENT random keys. Recipients (and the second device
// itself, via the self-KDM) then overwrote one key with the other,
// which (a) made every earlier message from the first device
// undecryptable and (b) left both devices encrypting under one AES-GCM
// key with independent counters -> (key, nonce) reuse.
// Reproduced in tests/groups/group-multidevice.test.mjs (MD-1..MD-3).
//
// Fix: the id is now a PRF of the key itself,
//
//     id = hex(HMAC-SHA-256(key = senderKeyBytes,
//                           msg = "wire-sender-key-id/v2|group|owner|epoch"))
//
// so distinct keys always get distinct ids (collision only if two devices
// drew the same 256-bit key), while the id stays a pure function of data
// every recipient has AFTER unwrapping the KDM. The envelope format and
// the KDM plaintext are unchanged; the id is still an opaque string in the
// envelope. HMAC output is independent of the key (PRF), so publishing it
// in every message reveals nothing about the key. Group/owner/epoch stay in
// the message so a KDM relabelled by the server yields an id no envelope
// references (denial of service at worst, never a key/plaintext mix-up).

export const SENDER_KEY_SCHEME_LEGACY = 1;
export const SENDER_KEY_SCHEME_KEY_DERIVED = 2;

export async function deriveSenderKeyIdV2(groupId, ownerUserId, epoch, rawKeyBytes) {
    const hmacKey = await crypto.subtle.importKey(
        'raw',
        rawKeyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const label = new TextEncoder().encode(
        `wire-sender-key-id/v2|${Number(groupId)}|${Number(ownerUserId)}|${Number(epoch)}`
    );
    const mac = await crypto.subtle.sign('HMAC', hmacKey, label);

    return Array.from(new Uint8Array(mac))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
