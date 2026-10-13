// tests/attachment-crypto.test.mjs
//
// computeImageDimensions() is not covered here — it depends on
// browser-only APIs (createImageBitmap / Image / URL.createObjectURL
// against a real rendering engine) that aren't meaningfully
// mockable in Node without a full DOM+image-decoder stack. Manual
// verification in a real browser is the appropriate check for that
// one function; everything else here is pure WebCrypto logic, which
// Node's real crypto.subtle runs identically to a browser's.

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
// The repo root is derived from this file, so the test runs from any
// checkout instead of only at a hardcoded absolute path. fileURLToPath
// is for fs paths; mock.module() and import() need a real file:// URL.
const js = (rel) => pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "js", rel)
).href;


import {
    installWebLocksPolyfill,
    newDeviceStorage,
    useDeviceStorage,
    makeTestIdentity,
} from './groups/helpers.mjs';

installWebLocksPolyfill();

const identitiesByUserId = new Map();
let currentActorId = null;

mock.module(js('crypto/identity-service.js'), {
    namedExports: {
        getCurrentIdentity: () => {
            const id = identitiesByUserId.get(currentActorId);
            return id ? { privateKey: id.privateKey, publicKey: id.publicKey } : null;
        },
    },
});

mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => (currentActorId ? { id: currentActorId } : null),
        getToken: () => 'fake-token',
        logout: () => {},
    },
});

mock.module(js('core/api.js'), {
    namedExports: {
        api: async () => {
            throw new Error('api() should not be called in this test — only rotation.js/sender-key.js are exercised directly');
        },
    },
});

mock.module(js('crypto/keys/session.js'), {
    namedExports: {
        getOrCreateGroupKdmKey: async (peerUserId) => {
            const { deriveSessionKeyFromPeer, GROUP_KDM_INFO } = await import(
                js('crypto/keys/key-derivation.js')
            );
            const me = identitiesByUserId.get(currentActorId);
            const peer = identitiesByUserId.get(Number(peerUserId));
            return deriveSessionKeyFromPeer(me.privateKey, peer._publicKeyCryptoKey, GROUP_KDM_INFO);
        },
        getOrCreateSessionKey: async (peerUserId) => {
            const { deriveSessionKeyFromPeer } = await import(
                js('crypto/keys/key-derivation.js')
            );
            const me = identitiesByUserId.get(currentActorId);
            const peer = identitiesByUserId.get(Number(peerUserId));
            return deriveSessionKeyFromPeer(me.privateKey, peer._publicKeyCryptoKey);
        },
    },
});

const {
    encryptAttachmentForDm,
    decryptAttachmentForDm,
    encryptAttachmentForGroup,
    decryptAttachmentForGroup,
} = await import(js('crypto/messages/attachment-crypto.js'));

const { rotateSenderKey } = await import(
    js('crypto/groups/rotation.js')
);

async function ensureUsers(...ids) {
    for (const id of ids) {
        if (!identitiesByUserId.has(id)) {
            identitiesByUserId.set(id, await makeTestIdentity(id));
        }
    }
}

function setActor(userId) {
    currentActorId = userId;
}

test('DM attachment: encrypt as alice, decrypt as bob, plaintext matches', async () => {
    await ensureUsers(1, 2);

    const original = new TextEncoder().encode('this is definitely a photo of my cat').buffer;

    setActor(1);
    const { ivBase64, ciphertext } = await encryptAttachmentForDm(2, original);

    assert.ok(ivBase64.length > 0);
    assert.notDeepEqual(Buffer.from(ciphertext), Buffer.from(original), 'ciphertext must not equal plaintext');

    setActor(2);
    const decrypted = await decryptAttachmentForDm(1, ciphertext, ivBase64);

    assert.deepEqual(Buffer.from(decrypted), Buffer.from(original));
});

test('DM attachment: tampered ciphertext fails authentication', async () => {
    await ensureUsers(11, 12);

    const original = new TextEncoder().encode('secret file bytes').buffer;

    setActor(11);
    const { ivBase64, ciphertext } = await encryptAttachmentForDm(12, original);

    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;

    setActor(12);
    await assert.rejects(
        () => decryptAttachmentForDm(11, tampered.buffer, ivBase64),
        /authentication failed/
    );
});

test('group attachment: encrypt/decrypt round trip using the message-associated senderKeyId', async () => {
    await ensureUsers(21);
    const groupId = 500;
    const storage = newDeviceStorage();
    useDeviceStorage(storage);
    setActor(21);

    const identity = { userId: 21, ...identitiesByUserId.get(21) };
    await rotateSenderKey(identity, groupId, 0, [21]);

    const { getMySenderKey } = await import(
        js('crypto/groups/sender-key.js')
    );
    const mine = await getMySenderKey(identity, groupId);

    const original = new TextEncoder().encode('group photo bytes').buffer;

    const { ivBase64, ciphertext } = await encryptAttachmentForGroup(groupId, original);
    const decrypted = await decryptAttachmentForGroup(groupId, ciphertext, ivBase64, mine.senderKeyId, 'a1');

    assert.deepEqual(Buffer.from(decrypted), Buffer.from(original));

    // F3: the attachment is bound to (group, senderKeyId, counter, iv): presenting it
    // as another group's attachment, or with a relabelled iv/counter, fails.
    await assert.rejects(
        () => decryptAttachmentForGroup(groupId + 1, ciphertext, ivBase64, mine.senderKeyId, 'a1'),
        /authentication failed/
    );
    const ivBytes = Buffer.from(ivBase64, 'base64');
    ivBytes[11] ^= 0x01; // counter 0 -> 1: a different nonce AND a different AAD counter
    await assert.rejects(
        () => decryptAttachmentForGroup(groupId, ciphertext, ivBytes.toString('base64'), mine.senderKeyId, 'a1'),
        /authentication failed/
    );

    // Counter is shared with messages: two attachments get distinct counters and nonces.
    const second = await encryptAttachmentForGroup(groupId, original);
    assert.notEqual(second.ivBase64, ivBase64);
    assert.deepEqual(
        Buffer.from(await decryptAttachmentForGroup(groupId, second.ciphertext, second.ivBase64, mine.senderKeyId, 'a2')),
        Buffer.from(original)
    );
});

test('group attachment: throws before any Sender Key exists for the group', async () => {
    await ensureUsers(31);
    const storage = newDeviceStorage();
    useDeviceStorage(storage);
    setActor(31);

    await assert.rejects(
        () => encryptAttachmentForGroup(999, new ArrayBuffer(8)),
        /No Sender Key/
    );
});

test('group attachment: unknown senderKeyId raises MissingSenderKeyError (self-heal path)', async () => {
    await ensureUsers(41);
    const storage = newDeviceStorage();
    useDeviceStorage(storage);
    setActor(41);

    const { MissingSenderKeyError } = await import(
        js('crypto/messages/attachment-crypto.js')
    );

    await assert.rejects(
        () => decryptAttachmentForGroup(1, new ArrayBuffer(8), 'AAAAAAAAAAAAAAAA', 'nonexistent-sender-key-id', 'a1'),
        MissingSenderKeyError
    );
});
