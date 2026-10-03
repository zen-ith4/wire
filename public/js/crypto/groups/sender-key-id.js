// public/js/crypto/groups/sender-key-id.js
//
// The senderKeyId is a PRF of the key itself:
//
//     id = hex(HMAC-SHA-256(key = senderKeyBytes,
//                           msg = "wire-sender-key-id/v2|group|owner|epoch"))
//
// so two distinct keys (e.g. minted by two devices of one account at the same
// epoch) always get distinct ids, while every recipient arrives at the same id
// after unwrapping the KDM, without the id being transmitted. HMAC output is
// independent of the key, so publishing it in every message reveals nothing
// about the key.

export async function deriveSenderKeyId(groupId, ownerUserId, epoch, rawKeyBytes) {
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
