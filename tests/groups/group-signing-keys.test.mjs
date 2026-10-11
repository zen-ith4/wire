// Phase C2: key lifecycle of the per-Sender-Key message-signing key pair.
//
//  - generation: extractable only to export once, every temporary buffer zeroed,
//    only NON-extractable keys remain reachable from the cache;
//  - storage: PKCS#8 wrapped under the local wrap key with AAD
//    group-sig-priv-v1 | senderKeyId | ownerUserId, in the SAME put as the root;
//  - the senderKeyId commits to the signing public key;
//  - KDM payload = root(32) || signPub(65), fail closed on every structural problem;
//  - a KDM is accepted only if it unwrapped under the pairwise key of the claimed sender;
//  - owner / signPub of a stored id are immutable;
//  - rotation drops the superseded own private signing key only after the new key is
//    durably stored (fault injection), and a send already in flight keeps its key;
//  - lockIdentity's cache clear drops the signing keys; a second device never gets a
//    private signing key.
//
// Real X25519 / HKDF / AES-GCM / ECDSA (Node WebCrypto) and real fake-indexeddb; only
// the pairwise-session provider is wired to in-memory identities (like group-crypto).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
    installWebLocksPolyfill,
    newDeviceStorage,
    useDeviceStorage,
    makeTestIdentity,
    makeSessionKeyProvider,
} from './helpers.mjs';

installWebLocksPolyfill();

const GROUP = 77;

const identities = new Map();
const sessionProvider = makeSessionKeyProvider(identities);

mock.module('../../public/js/crypto/keys/session.js', {
    namedExports: {
        getOrCreateSessionKey: (id) => sessionProvider.getOrCreateSessionKey(id),
        getOrCreateGroupKdmKey: (id) => sessionProvider.getOrCreateGroupKdmKey(id),
    },
});

const sk = await import('../../public/js/crypto/groups/sender-key.js');
const kdm = await import('../../public/js/crypto/groups/kdm.js');
const { rotateSenderKey } = await import('../../public/js/crypto/groups/rotation.js');
const store = await import('../../public/js/crypto/groups/sender-key-store.js');
const ids = await import('../../public/js/crypto/groups/sender-key-id.js');
const signing = await import('../../public/js/crypto/groups/signing.js');
const mc = await import('../../public/js/crypto/groups/message-crypto.js');
const { encryptBytes, decryptBytes } = await import('../../public/js/crypto/groups/aead.js');
const codec = await import('../../public/js/crypto/groups/codec.js');
const { deriveLocalWrapKey } = await import('../../public/js/crypto/groups/local-wrap-key.js');

async function user(id) {
    if (!identities.has(id)) identities.set(id, await makeTestIdentity(id));
    return identities.get(id);
}

async function makeDevice(identity) {
    const storage = newDeviceStorage();
    return {
        identity,
        storage,
        async run(fn) {
            useDeviceStorage(storage);
            sessionProvider.setCurrentActor(identity.userId);
            return fn();
        },
    };
}

/** Rotates as `owner` (deferred, like production) and lands the KDMs on every recipient device. */
async function rotateAndDeliver(owner, epoch, recipients, { group = GROUP } = {}) {
    const pending = await owner.run(() =>
        rotateSenderKey(owner.identity, group, epoch, recipients.map((d) => d.identity.userId), { deferPersist: true })
    );
    await owner.run(() => pending.commit());

    for (const device of recipients) {
        const row = pending.recipients.find((r) => r.user_id === device.identity.userId);
        await device.run(() => kdm.receiveKdm(device.identity, kdmRow(owner.identity.userId, device.identity.userId, epoch, row.wrapped_key, group)));
    }

    return pending;
}

function kdmRow(from, to, epoch, wrapped, group = GROUP) {
    return { id: 1, group_id: group, from_user_id: from, to_user_id: to, epoch, wrapped_key: wrapped };
}

/** A KDM with an arbitrary plaintext, wrapped under the pairwise key of from<->to as `from` would. */
async function craftKdm({ from, to, epoch, payload, group = GROUP }) {
    sessionProvider.setCurrentActor(from);
    const key = await sessionProvider.getOrCreateGroupKdmKey(to);
    const env = await encryptBytes(key, payload, undefined, kdm.kdmAad({ groupId: group, fromUserId: from, toUserId: to, epoch }));
    return JSON.stringify({ v: 2, alg: 'AES-GCM', iv: env.iv, ciphertext: env.ciphertext });
}

const sampleFields = (senderKeyId, over = {}) => ({
    groupId: GROUP,
    senderKeyId,
    counter: 3,
    iv: Uint8Array.from({ length: 12 }, (_, i) => i),
    ciphertext: Uint8Array.from({ length: 24 }, (_, i) => i + 5),
    replyToId: null,
    ...over,
});

function objectStoreProto() {
    // the prototype fake-indexeddb uses for object stores, to inject faults
    const probe = newDeviceStorage();
    return new Promise((resolve) => {
        const req = probe.open('probe', 1);
        req.onupgradeneeded = () => {
            resolve(Object.getPrototypeOf(req.result.createObjectStore('s')));
        };
    });
}

async function withPutFault(predicate, fn) {
    const proto = await objectStoreProto();
    const original = proto.put;
    proto.put = function (value, key) {
        if (predicate(value)) throw new Error('injected IndexedDB fault');
        return original.call(this, value, key);
    };
    try {
        return await fn();
    } finally {
        proto.put = original;
    }
}

/* ============================================================ generation */

test('C2-1: the signing key is generated extractable only to be exported once; every temporary buffer is zeroed; only NON-extractable keys stay reachable from the cache', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    const exported = [];
    const subtle = crypto.subtle;
    const original = subtle.exportKey.bind(subtle);
    subtle.exportKey = async (format, key) => {
        const out = await original(format, key);
        if (format === 'pkcs8' && key.algorithm?.name === 'ECDSA') exported.push(out);
        return out;
    };

    try {
        await dev.run(async () => {
            const gen = await sk.generateSenderKey(alice, GROUP, 0);

            assert.equal(exported.length, 1, 'the private key was exported exactly once');
            assert.equal(exported[0].byteLength, 138, 'PKCS#8 P-256');
            assert.ok(new Uint8Array(exported[0]).every((b) => b === 0), 'the exported PKCS#8 buffer was zeroed after wrapping');

            // the key handed back and cached is non-extractable
            assert.equal(gen.signKey.extractable, false);
            await assert.rejects(() => crypto.subtle.exportKey('pkcs8', gen.signKey), 'the private key can no longer be exported');
            await assert.rejects(() => crypto.subtle.exportKey('jwk', gen.signKey));

            const cached = sk.__cachedKeysForTests();
            assert.ok(cached.length >= 3, 'AES, verify and signing keys are cached');
            for (const k of cached) {
                assert.equal(k.extractable, false, `cached ${k.type}/${k.algorithm} must be non-extractable`);
            }
            assert.equal(cached.filter((k) => k.type === 'private' && k.algorithm === 'ECDSA').length, 1);
            assert.equal(cached.filter((k) => k.extractable).length, 0, 'no extractable copy is reachable from the cache');
        });
    } finally {
        subtle.exportKey = original;
    }
});

test('C2-2: after a restore from IndexedDB the cached signing key is non-extractable and signs for the stored public key', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    const first = await dev.run(async () => {
        const g = await sk.generateSenderKey(alice, GROUP, 0);
        return { id: g.senderKeyId, pub: g.signPub };
    });

    await dev.run(async () => {
        // run() cleared the cache: this is a restore from disk
        assert.equal(sk.__cachedKeysForTests().length, 0, 'control: cold cache');

        const mine = await sk.getMySenderKey(alice, GROUP);
        assert.ok(mine, 'restored');
        assert.equal(mine.senderKeyId, first.id);
        assert.equal(mine.signKey.extractable, false);
        await assert.rejects(() => crypto.subtle.exportKey('pkcs8', mine.signKey));

        for (const k of sk.__cachedKeysForTests()) assert.equal(k.extractable, false);
        assert.deepEqual([...mine.signPub], [...first.pub]);

        const sig = await signing.signMessage(mine.signKey, sampleFields(mine.senderKeyId));
        const vk = await signing.importVerifyKey(first.pub);
        assert.equal(await signing.verifyMessage(vk, sig, sampleFields(mine.senderKeyId)), true);
    });
});

test('C2-3: wrapped storage: PKCS#8 under the local wrap key with AAD group-sig-priv-v1 | senderKeyId | ownerUserId', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const g = await sk.generateSenderKey(alice, GROUP, 0);
        const rec = await store.getSenderKeyRecord(g.senderKeyId);

        assert.deepEqual(Object.keys(rec.signKeyWrapped).sort(), ['ciphertext', 'iv']);
        assert.equal(codec.base64ToBytes(rec.signPub).length, 65);
        assert.equal(codec.base64ToBytes(rec.signPub)[0], 0x04);
        assert.equal(rec.isMine, 1);

        const wrapKey = await deriveLocalWrapKey(alice);
        const aad = (id, owner) => codec.encodeFields('group-sig-priv-v1', id, owner);

        const pkcs8 = await decryptBytes(wrapKey, rec.signKeyWrapped, aad(g.senderKeyId, 1));
        assert.equal(pkcs8.length, 138);

        await assert.rejects(() => decryptBytes(wrapKey, rec.signKeyWrapped, aad('0'.repeat(64), 1)), 'bound to the senderKeyId');
        await assert.rejects(() => decryptBytes(wrapKey, rec.signKeyWrapped, aad(g.senderKeyId, 2)), 'bound to the owner');
        await assert.rejects(() => decryptBytes(wrapKey, rec.signKeyWrapped), 'no AAD at all');
        await assert.rejects(() => decryptBytes(wrapKey, rec.signKeyWrapped, codec.encodeFields('group-sig-priv-v2', g.senderKeyId, 1)), 'bound to the label');
    });
});

test('C2-4: the root, the public key and the wrapped signing key land in ONE put, only after the caller commits; a failed put leaves nothing', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const pending = await rotateSenderKey(alice, GROUP, 0, [1], { deferPersist: true });

        assert.equal(await store.getSenderKeyRecord(pending.senderKeyId), null, 'nothing on disk before commit');
        assert.equal(await sk.getMySenderKey(alice, GROUP), null, 'and never selectable before commit');
        assert.equal(sk.__cachedKeysForTests().length, 0, 'nor cached');

        await pending.commit();

        const rec = await store.getSenderKeyRecord(pending.senderKeyId);
        assert.ok(rec.wrappedKey && rec.signPub && rec.signKeyWrapped, 'one record holds root + public key + wrapped signing key');
    });

    // fault: the put itself fails -> neither the root nor the signing key exists
    const dev2 = await makeDevice(alice);
    await dev2.run(async () => {
        const pending = await rotateSenderKey(alice, GROUP, 0, [1], { deferPersist: true });
        await withPutFault((v) => v?.signKeyWrapped, async () => {
            await assert.rejects(() => pending.commit(), /injected/);
        });
        assert.equal(await store.getSenderKeyRecord(pending.senderKeyId), null);
        assert.deepEqual(await store.getAllSenderKeysForGroup(GROUP), []);
        assert.equal(await sk.getMySenderKey(alice, GROUP), null);
    });
});

/* ======================================================= id commitment */

test('C2-5: the senderKeyId commits to signPub: another public key, another id; a row with an altered signPub or metadata is rejected on load', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const a = (await signing.generateSigningKeyPair()).publicKeyRaw;
        const b = (await signing.generateSigningKeyPair()).publicKeyRaw;

        const idA = await ids.deriveSenderKeyId(GROUP, 1, 0, root, a);
        assert.match(idA, /^[0-9a-f]{64}$/);
        assert.equal(idA, await ids.deriveSenderKeyId(GROUP, 1, 0, root, a));
        assert.notEqual(idA, await ids.deriveSenderKeyId(GROUP, 1, 0, root, b), 'same root, other signing key => other id');

        for (const bad of [undefined, null, new Uint8Array(65), new Uint8Array(64), Uint8Array.from([2, ...new Uint8Array(32)])]) {
            await assert.rejects(() => ids.deriveSenderKeyId(GROUP, 1, 0, root, bad));
        }
    });

    // a stored row that was altered no longer re-derives to its own id
    for (const [name, mutate] of [
        ['signPub swapped for another valid key', async (r) => ({ ...r, signPub: codec.bytesToBase64((await signing.generateSigningKeyPair()).publicKeyRaw) })],
        ['ownerUserId altered', async (r) => ({ ...r, ownerUserId: 99 })],
        ['epoch altered', async (r) => ({ ...r, epoch: r.epoch + 1 })],
        ['groupId altered', async (r) => ({ ...r, groupId: GROUP + 1 })],
        ['signPub removed (pre-signing row)', async (r) => { const { signPub, ...rest } = r; return rest; }],
        ['signPub not a point', async (r) => ({ ...r, signPub: codec.bytesToBase64(Uint8Array.from([4, ...new Uint8Array(64).fill(7)])) })],
    ]) {
        const d = await makeDevice(alice);
        await d.run(async () => {
            const g = await sk.generateSenderKey(alice, GROUP, 0);
            const rec = await store.getSenderKeyRecord(g.senderKeyId);
            await store.putSenderKeyRecord(await mutate(rec));
            sk.clearSenderKeyCache();

            const originalWarn = console.warn;
            console.warn = () => {};
            try {
                assert.equal(await sk.loadSenderKey(alice, g.senderKeyId), null, `${name}: loads as "no key"`);
                assert.equal(await sk.getMySenderKey(alice, GROUP), null, `${name}: never used for sending`);
            } finally {
                console.warn = originalWarn;
            }
        });
    }
});

/* ================================================================ KDM */

test('C2-6: a KDM carries root || signPub (97 bytes) and the receiver stores the sender\'s public key, owner = the claimed sender, decrypt-only', async () => {
    const alice = await user(1);
    const bob = await user(2);
    const aliceDev = await makeDevice(alice);
    const bobDev = await makeDevice(bob);

    const sent = await rotateAndDeliver(aliceDev, 0, [aliceDev, bobDev]);
    const alicePub = await aliceDev.run(async () => (await sk.getMySenderKey(alice, GROUP)).signPub);

    await bobDev.run(async () => {
        const rec = await store.getSenderKeyRecord(sent.senderKeyId);
        assert.ok(rec, 'Bob stored the key under the id Alice derived');
        assert.equal(rec.ownerUserId, 1);
        assert.equal(rec.isMine, 0);
        assert.equal(rec.signKeyWrapped, undefined, 'a received key never carries a private signing key');
        assert.equal(rec.signPub, codec.bytesToBase64(alicePub));

        // the unwrapped payload layout
        const row = sent.recipients.find((r) => r.user_id === 2);
        const { rawBytes, signPub } = await kdm.unwrapKdmDetailed(row.wrapped_key, { groupId: GROUP, fromUserId: 1, toUserId: 2, epoch: 0 });
        assert.equal(rawBytes.length, 32);
        assert.equal(signPub.length, 65);
        assert.equal(signPub[0], 0x04);

        // and the existing message path still works with it
        const bundle = await sk.loadSenderKeyBundle(bob, sent.senderKeyId);
        assert.ok(bundle.verifyKey && bundle.signKey === null);
    });

    // the message path is unchanged: Alice sends, Bob decrypts
    const env = await aliceDev.run(() => mc.encryptGroupMessage(alice, GROUP, 'hello'));
    const text = await bobDev.run(() => mc.decryptGroupMessage(bob, GROUP, env, 1));
    assert.equal(text, 'hello');
});

test('C2-7: KDM structural problems fail closed and nothing is stored (length, 0x04, point not on the curve, legacy 32 bytes)', async () => {
    const alice = await user(1);
    const bob = await user(2);
    const bobDev = await makeDevice(bob);

    const root = crypto.getRandomValues(new Uint8Array(32));
    const pub = (await signing.generateSigningKeyPair()).publicKeyRaw;
    const cat = (...p) => Uint8Array.from(p.flatMap((x) => [...x]));
    const offCurve = pub.slice();
    offCurve[64] ^= 1;

    const cases = {
        'legacy 32-byte plaintext': [cat(root), kdm.LegacyKdmError],
        'empty payload': [new Uint8Array(1), kdm.KdmFormatError],
        '96 bytes': [cat(root, pub.slice(0, 64)), kdm.KdmFormatError],
        '98 bytes': [cat(root, pub, Uint8Array.of(0)), kdm.KdmFormatError],
        '64 bytes (root only twice)': [cat(root, root), kdm.KdmFormatError],
        'first point byte 0x02': [cat(root, Uint8Array.of(2), pub.slice(1)), kdm.KdmFormatError],
        'first point byte 0x00': [cat(root, Uint8Array.of(0), pub.slice(1)), kdm.KdmFormatError],
        'point off the curve': [cat(root, offCurve), kdm.KdmFormatError],
        'all-zero point': [cat(root, Uint8Array.of(4), new Uint8Array(64)), kdm.KdmFormatError],
    };

    for (const [name, [payload, ErrorClass]] of Object.entries(cases)) {
        const wrapped = await craftKdm({ from: 1, to: 2, epoch: 0, payload });
        await bobDev.run(async () => {
            await assert.rejects(() => kdm.receiveKdm(bob, kdmRow(1, 2, 0, wrapped)), ErrorClass, name);
            assert.deepEqual(await store.getAllSenderKeysForGroup(GROUP), [], `${name}: nothing stored`);
            assert.equal(sk.__cachedKeysForTests().length, 0, `${name}: nothing cached`);
        });
    }

    // control: the same shape with a valid key is accepted
    const good = await craftKdm({ from: 1, to: 2, epoch: 0, payload: cat(root, pub) });
    await bobDev.run(async () => {
        await kdm.receiveKdm(bob, kdmRow(1, 2, 0, good));
        assert.equal((await store.getAllSenderKeysForGroup(GROUP)).length, 1);
    });
    assert.ok(alice);
});

test('C2-8: a KDM that did not unwrap under the pairwise key of the CLAIMED sender is rejected before anything is stored', async () => {
    const [alice, bob, mallory, carol] = await Promise.all([user(1), user(2), user(3), user(4)]);
    const bobDev = await makeDevice(bob);
    const root = crypto.getRandomValues(new Uint8Array(32));
    const pub = (await signing.generateSigningKeyPair()).publicKeyRaw;
    const payload = Uint8Array.from([...root, ...pub]);

    // Mallory wraps for Bob under HER pairwise key but the row claims it is from Alice
    const forged = await craftKdm({ from: 3, to: 2, epoch: 0, payload });

    // an honest KDM from Alice, relabelled in every field the server controls
    const honest = await craftKdm({ from: 1, to: 2, epoch: 0, payload });

    const attempts = {
        'wrapped by Mallory, row claims Alice': kdmRow(1, 2, 0, forged),
        'honest row relabelled: from Carol': kdmRow(4, 2, 0, honest),
        'honest row relabelled: to Carol': kdmRow(1, 4, 0, honest),
        'honest row relabelled: other epoch': kdmRow(1, 2, 1, honest),
        'honest row relabelled: other group': kdmRow(1, 2, 0, honest, GROUP + 1),
    };

    for (const [name, row] of Object.entries(attempts)) {
        await bobDev.run(async () => {
            await assert.rejects(() => kdm.receiveKdm(bob, row), name);
            assert.deepEqual(await store.getAllSenderKeysForGroup(GROUP), [], `${name}: nothing stored`);
            assert.deepEqual(await store.getAllSenderKeysForGroup(GROUP + 1), [], `${name}: nothing stored (other group)`);
        });
    }

    // control: the honest row, unmodified, is accepted and its owner is Alice
    await bobDev.run(async () => {
        await kdm.receiveKdm(bob, kdmRow(1, 2, 0, honest));
        const rows = await store.getAllSenderKeysForGroup(GROUP);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].ownerUserId, 1);
    });
    assert.ok(alice && mallory && carol);
});

/* ===================================================== immutable owner */

test('C2-9 (D): owner / group / epoch / signPub of a stored senderKeyId are immutable: a conflicting KDM is rejected and never overwrites', async () => {
    const alice = await user(1);
    const bob = await user(2);
    const aliceDev = await makeDevice(alice);
    const bobDev = await makeDevice(bob);

    const sent = await rotateAndDeliver(aliceDev, 0, [aliceDev, bobDev]);

    await bobDev.run(async () => {
        const before = await store.getSenderKeyRecord(sent.senderKeyId);
        const bundle = await sk.loadSenderKeyBundle(bob, sent.senderKeyId);
        const wrapKey = await deriveLocalWrapKey(bob);
        const root = await decryptBytes(wrapKey, before.wrappedKey);
        const otherPub = (await signing.generateSigningKeyPair()).publicKeyRaw;

        const base = { senderKeyId: sent.senderKeyId, groupId: GROUP, ownerUserId: 1, epoch: 0, signPub: bundle.signPub };

        for (const [name, params] of Object.entries({
            'other owner': { ...base, ownerUserId: 3 },
            'other signPub': { ...base, signPub: otherPub },
            'other epoch': { ...base, epoch: 1 },
            'other group': { ...base, groupId: GROUP + 1 },
        })) {
            await assert.rejects(() => sk.storeReceivedSenderKey(bob, params, root), sk.SenderKeyConflictError, name);
            assert.deepEqual(await store.getSenderKeyRecord(sent.senderKeyId), before, `${name}: the stored row is untouched`);
        }

        // an identical re-delivery is idempotent
        await sk.storeReceivedSenderKey(bob, base, root);
        assert.deepEqual(await store.getSenderKeyRecord(sent.senderKeyId), before);
    });
});

test('C2-10 (D): Mallory forwarding Alice\'s root and public key in HER OWN KDM gets another id, owner Mallory, and Alice\'s row is untouched', async () => {
    const alice = await user(1);
    const bob = await user(2);
    const mallory = await user(3);
    const aliceDev = await makeDevice(alice);
    const bobDev = await makeDevice(bob);
    const malloryDev = await makeDevice(mallory);

    const sent = await rotateAndDeliver(aliceDev, 0, [aliceDev, bobDev, malloryDev]);

    // Mallory unwraps Alice's KDM (she is a member), then re-wraps root||pub for Bob as herself
    const stolen = await malloryDev.run(async () => {
        const row = sent.recipients.find((r) => r.user_id === 3);
        return kdm.unwrapKdmDetailed(row.wrapped_key, { groupId: GROUP, fromUserId: 1, toUserId: 3, epoch: 0 });
    });
    const forwarded = await craftKdm({ from: 3, to: 2, epoch: 0, payload: Uint8Array.from([...stolen.rawBytes, ...stolen.signPub]) });

    await bobDev.run(async () => {
        const aliceRow = await store.getSenderKeyRecord(sent.senderKeyId);
        const { senderKeyId: forwardedId } = await kdm.receiveKdm(bob, kdmRow(3, 2, 0, forwarded));

        assert.notEqual(forwardedId, sent.senderKeyId, 'the owner is committed in the id');
        const forwardedRow = await store.getSenderKeyRecord(forwardedId);
        assert.equal(forwardedRow.ownerUserId, 3, 'attributed to the sender whose pairwise key unwrapped it');
        assert.deepEqual(await store.getSenderKeyRecord(sent.senderKeyId), aliceRow, 'Alice\'s row is untouched');
    });
});

/* ================================================================ rotation */

test('C2-11: rotation creates a NEW pair; the old public key only verifies old messages; the superseded signing PRIVATE key is dropped, the row (root, public key) stays', async () => {
    const alice = await user(1);
    const bob = await user(2);
    const aliceDev = await makeDevice(alice);
    const bobDev = await makeDevice(bob);

    const k1 = await rotateAndDeliver(aliceDev, 0, [aliceDev, bobDev]);
    const env1 = await aliceDev.run(() => mc.encryptGroupMessage(alice, GROUP, 'old key message'));
    const k2 = await rotateAndDeliver(aliceDev, 1, [aliceDev, bobDev]);

    assert.notEqual(k1.senderKeyId, k2.senderKeyId);

    await aliceDev.run(async () => {
        const r1 = await store.getSenderKeyRecord(k1.senderKeyId);
        const r2 = await store.getSenderKeyRecord(k2.senderKeyId);
        assert.equal(r1.signKeyWrapped, undefined, 'the superseded private signing key is gone');
        assert.ok(r1.wrappedKey && r1.signPub, 'but the old root and public key remain');
        assert.ok(r2.signKeyWrapped, 'the new key keeps its signing key');
        assert.notEqual(r1.signPub, r2.signPub, 'a new pair per Sender Key');

        const mine = await sk.getMySenderKey(alice, GROUP);
        assert.equal(mine.senderKeyId, k2.senderKeyId);

        // the old public key verifies old-key signatures only
        const v1 = await signing.importVerifyKey(codec.base64ToBytes(r1.signPub));
        const v2 = await signing.importVerifyKey(codec.base64ToBytes(r2.signPub));
        const sig2 = await signing.signMessage(mine.signKey, sampleFields(k2.senderKeyId));
        assert.equal(await signing.verifyMessage(v2, sig2, sampleFields(k2.senderKeyId)), true);
        assert.equal(await signing.verifyMessage(v1, sig2, sampleFields(k2.senderKeyId)), false, 'old public key does not verify the new key\'s signature');
    });

    // the old key still decrypts its history for everyone
    assert.equal(await bobDev.run(() => mc.decryptGroupMessage(bob, GROUP, env1, 11)), 'old key message');
});

test('C2-12 (B): rotation fault injection: a failed cleanup leaves the old key usable; the next rotation drops both; a failed commit changes nothing', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const first = await rotateSenderKey(alice, GROUP, 0, [1], { deferPersist: true });
        await first.commit();

        // 1. the new key's commit fails (put throws): the old key is untouched and still selected
        const failing = await rotateSenderKey(alice, GROUP, 1, [1], { deferPersist: true });
        await withPutFault((v) => v?.signKeyWrapped && v.epoch === 1, async () => {
            await assert.rejects(() => failing.commit(), /injected/);
        });
        assert.ok((await store.getSenderKeyRecord(first.senderKeyId)).signKeyWrapped, 'old signing key intact after a failed commit');
        assert.equal((await sk.getMySenderKey(alice, GROUP)).senderKeyId, first.senderKeyId, 'old key still the sending key');
        assert.equal(await store.getSenderKeyRecord(failing.senderKeyId), null);

        // 2. the new key is stored but the CLEANUP fails: both keys stay usable, the new one is selected
        const second = await rotateSenderKey(alice, GROUP, 1, [1], { deferPersist: true });
        const warn = console.warn;
        console.warn = () => {};
        try {
            await withPutFault((v) => v?.isMine === 1 && !v.signKeyWrapped, async () => {
                await second.commit(); // must not throw
            });
        } finally {
            console.warn = warn;
        }
        assert.ok((await store.getSenderKeyRecord(first.senderKeyId)).signKeyWrapped, 'old signing key survives a failed cleanup');
        assert.ok((await store.getSenderKeyRecord(second.senderKeyId)).signKeyWrapped);
        assert.equal((await sk.getMySenderKey(alice, GROUP)).senderKeyId, second.senderKeyId, 'the newest key is selected');

        // 3. the next successful rotation drops BOTH superseded signing keys
        const third = await rotateSenderKey(alice, GROUP, 2, [1], { deferPersist: true });
        await third.commit();
        assert.equal((await store.getSenderKeyRecord(first.senderKeyId)).signKeyWrapped, undefined);
        assert.equal((await store.getSenderKeyRecord(second.senderKeyId)).signKeyWrapped, undefined);
        assert.ok((await store.getSenderKeyRecord(third.senderKeyId)).signKeyWrapped);
    });
});

test('C2-13 (B): a process that dies before commit (key distributed, nothing persisted) leaves the old key fully usable', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const first = await rotateSenderKey(alice, GROUP, 0, [1], { deferPersist: true });
        await first.commit();

        // "POST returned 201, process died before commit()": the pending key is simply abandoned
        const abandoned = await rotateSenderKey(alice, GROUP, 1, [1], { deferPersist: true });
        assert.ok(abandoned.recipients.length === 1);
    });

    // relaunch: a fresh cache over the same storage
    await dev.run(async () => {
        const mine = await sk.getMySenderKey(alice, GROUP);
        assert.ok(mine, 'old key still usable');
        assert.ok((await store.getSenderKeyRecord(mine.senderKeyId)).signKeyWrapped);
        assert.equal((await store.getAllSenderKeysForGroup(GROUP)).length, 1);
    });
});

test('C2-14 (B): a send in flight with the old key does not lose its signing key when a rotation commits underneath it', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const first = await rotateSenderKey(alice, GROUP, 0, [1], { deferPersist: true });
        await first.commit();

        // the send picks up the old key ...
        const inFlight = await sk.getMySenderKey(alice, GROUP);
        assert.equal(inFlight.senderKeyId, first.senderKeyId);

        // ... a rotation commits (old signing key dropped from disk AND from the cache) ...
        const second = await rotateSenderKey(alice, GROUP, 1, [1], { deferPersist: true });
        await second.commit();
        assert.equal((await store.getSenderKeyRecord(first.senderKeyId)).signKeyWrapped, undefined);

        // ... and the in-flight send can still sign with the handle it already holds
        const f = sampleFields(first.senderKeyId);
        const sig = await signing.signMessage(inFlight.signKey, f);
        assert.equal(await signing.verifyMessage(await signing.importVerifyKey(inFlight.signPub), sig, f), true);

        // a send that STARTS now uses the new key
        assert.equal((await sk.getMySenderKey(alice, GROUP)).senderKeyId, second.senderKeyId);
    });
});

test('C2-15 (B): sends racing a rotation commit never fail and never get a key without its own signing key', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const first = await rotateSenderKey(alice, GROUP, 0, [1], { deferPersist: true });
        await first.commit();
        const second = await rotateSenderKey(alice, GROUP, 1, [1], { deferPersist: true });

        const results = [];
        const readers = Array.from({ length: 25 }, async (_, i) => {
            for (let n = 0; n < 4; n++) {
                if ((i + n) % 3 === 0) sk.clearSenderKeyCache(); // cold cache: read straight from disk
                results.push(await sk.getMySenderKey(alice, GROUP));
            }
        });

        await Promise.all([...readers, second.commit()]);

        assert.equal(results.length, 100);
        for (const r of results) {
            assert.ok(r, 'a send never finds "no key" while a rotation commits');
            assert.ok([first.senderKeyId, second.senderKeyId].includes(r.senderKeyId));
            const f = sampleFields(r.senderKeyId);
            assert.equal(await signing.verifyMessage(await signing.importVerifyKey(r.signPub), await signing.signMessage(r.signKey, f), f), true, 'the signing key matches the key it came with');
        }
    });
});

/* ================================================== sending requirements */

test('C2-16: sending requires an OWN row with a signing key: a row without one (or with a swapped one) is unusable for sending', async () => {
    const alice = await user(1);
    const bob = await user(2);
    const aliceDev = await makeDevice(alice);
    const bobDev = await makeDevice(bob);

    // (a) a RECEIVED key (isMine 0) is never a sending key, even at a higher epoch and from Alice herself
    await rotateAndDeliver(aliceDev, 0, [aliceDev, bobDev]);
    await bobDev.run(async () => {
        assert.equal(await sk.getMySenderKey(bob, GROUP), null, 'Bob has only a received key');
        await assert.rejects(() => mc.encryptGroupMessage(bob, GROUP, 'x'), /No Sender Key/);
    });

    // (b) an own row whose signing key was stripped is unusable; the caller sees "no key" and re-keys
    await aliceDev.run(async () => {
        const mine = await sk.getMySenderKey(alice, GROUP);
        const rec = await store.getSenderKeyRecord(mine.senderKeyId);
        const { signKeyWrapped, ...stripped } = rec;
        await store.putSenderKeyRecord(stripped);
        sk.clearSenderKeyCache();

        assert.equal(await sk.getMySenderKey(alice, GROUP), null);
        await assert.rejects(() => mc.encryptGroupMessage(alice, GROUP, 'x'), /No Sender Key/);

        // a re-key at the SAME epoch becomes the sending key and is usable
        const rekey = await rotateSenderKey(alice, GROUP, 0, [1], { deferPersist: true });
        await rekey.commit();
        const now = await sk.getMySenderKey(alice, GROUP);
        assert.equal(now.senderKeyId, rekey.senderKeyId);
        assert.equal(typeof (await mc.encryptGroupMessage(alice, GROUP, 'works again')), 'string');
    });

    // (c) another key's signing key moved into this row: it does not match, never used
    const dev = await makeDevice(alice);
    await dev.run(async () => {
        const g1 = await sk.generateSenderKey(alice, GROUP, 0);
        const g2 = await sk.generateSenderKey(alice, GROUP, 1);
        const r1 = await store.getSenderKeyRecord(g1.senderKeyId);
        const r2 = await store.getSenderKeyRecord(g2.senderKeyId);
        await store.putSenderKeyRecord({ ...r2, signKeyWrapped: r1.signKeyWrapped });
        sk.clearSenderKeyCache();
        const warn = console.warn;
        console.warn = () => {};
        try {
            assert.equal(await sk.getMySenderKey(alice, GROUP), null);
        } finally {
            console.warn = warn;
        }
    });
});

/* ======================================================= lock / devices */

test('C2-17: lockIdentity\'s cache clear drops every signing key from memory; without the identity they cannot be restored', async () => {
    const alice = await user(1);
    const eve = await user(5);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        await sk.generateSenderKey(alice, GROUP, 0);
        assert.equal(sk.__cachedKeysForTests().filter((k) => k.type === 'private').length, 1, 'control: a signing key is in memory');

        sk.clearSenderKeyCache(); // what identity-service.lockIdentity() calls
        assert.equal(sk.__cachedKeysForTests().length, 0, 'nothing left in memory');

        // a different identity (a locked / other account) cannot restore them from disk
        const stolen = await sk.getMySenderKey({ ...eve, userId: 1 }, GROUP);
        assert.equal(stolen, null, 'no signing key without the identity that wrapped it');
        assert.equal(sk.__cachedKeysForTests().filter((k) => k.type === 'private').length, 0);

        // the real identity restores it
        assert.ok(await sk.getMySenderKey(alice, GROUP));
    });
});

test('C2-18: a second device stores the other device\'s root and signPub verify-only and never gets a private signing key; it has its own pair', async () => {
    const alice = await user(1);
    const dev1 = await makeDevice(alice);
    const dev2 = await makeDevice(alice);

    // device 1 mints and distributes (self-KDM lands on both devices)
    const k1 = await rotateAndDeliver(dev1, 0, [dev1, dev2]);
    const pub1 = await dev1.run(async () => (await sk.getMySenderKey(alice, GROUP)).signPub);

    await dev2.run(async () => {
        const rec = await store.getSenderKeyRecord(k1.senderKeyId);
        assert.equal(rec.isMine, 0);
        assert.equal(rec.signKeyWrapped, undefined, 'no private signing key on the second device');
        assert.equal(rec.signPub, codec.bytesToBase64(pub1), 'the correct public key of device 1');

        const bundle = await sk.loadSenderKeyBundle(alice, k1.senderKeyId);
        assert.equal(bundle.signKey, null);
        assert.ok(bundle.verifyKey);
        assert.equal(await sk.getMySenderKey(alice, GROUP), null, 'device 2 has no sending key of its own yet');

        // device 2 mints its own: a different id and a different signing pair
        const own = await sk.generateSenderKey(alice, GROUP, 0);
        assert.notEqual(own.senderKeyId, k1.senderKeyId);
        assert.notDeepEqual([...own.signPub], [...pub1]);
        assert.equal((await sk.getMySenderKey(alice, GROUP)).senderKeyId, own.senderKeyId);
    });

    // and device 1 holds device 2's key verify-only the same way
    const k2 = await rotateAndDeliver(dev2, 0, [dev1, dev2]);
    await dev1.run(async () => {
        const rec = await store.getSenderKeyRecord(k2.senderKeyId);
        assert.equal(rec.isMine, 0);
        assert.equal(rec.signKeyWrapped, undefined);
        assert.equal((await sk.getMySenderKey(alice, GROUP)).senderKeyId !== k2.senderKeyId, true, 'never sends with the other device\'s key');
    });
});

/* ===================================================== extra safety nets */

test('C2-19 (B): clearSupersededSigningKeys touches nothing unless the keep row is durably stored with its own signing key, and never a row that is not superseded', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const g0 = await sk.generateSenderKey(alice, GROUP, 0);
        const g1 = await sk.generateSenderKey(alice, GROUP, 1);
        const has = async (id) => Boolean((await store.getSenderKeyRecord(id)).signKeyWrapped);

        // keep row does not exist -> nothing dropped
        assert.deepEqual(await store.clearSupersededSigningKeys(GROUP, 1, 'e'.repeat(64)), []);
        assert.equal(await has(g0.senderKeyId), true);

        // keep row exists but has no signing key of its own -> nothing dropped
        const rec1 = await store.getSenderKeyRecord(g1.senderKeyId);
        const { signKeyWrapped, ...stripped } = rec1;
        await store.putSenderKeyRecord(stripped);
        assert.deepEqual(await store.clearSupersededSigningKeys(GROUP, 1, g1.senderKeyId), []);
        assert.equal(await has(g0.senderKeyId), true);
        await store.putSenderKeyRecord(rec1);

        // keep row belongs to another owner -> nothing dropped
        assert.deepEqual(await store.clearSupersededSigningKeys(GROUP, 2, g1.senderKeyId), []);
        assert.equal(await has(g0.senderKeyId), true);

        // a keep row that is OLDER than another own row (a late commit) never strips the newer one
        assert.deepEqual(await store.clearSupersededSigningKeys(GROUP, 1, g0.senderKeyId), []);
        assert.equal(await has(g1.senderKeyId), true, 'the newer epoch keeps its signing key');

        // the normal case drops exactly the superseded row
        assert.deepEqual(await store.clearSupersededSigningKeys(GROUP, 1, g1.senderKeyId), [g0.senderKeyId]);
        assert.equal(await has(g0.senderKeyId), false);
        assert.equal(await has(g1.senderKeyId), true);
    });
});

test('C2-15b (B): a send that picked the old row just before a rotation dropped its signing key re-selects the new key instead of failing', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const first = await rotateSenderKey(alice, GROUP, 0, [1], { deferPersist: true });
        await first.commit();
        const staleRows = await store.getAllSenderKeysForGroup(GROUP); // the selection as it was BEFORE the rotation

        const second = await rotateSenderKey(alice, GROUP, 1, [1], { deferPersist: true });
        await second.commit();
        assert.equal((await store.getSenderKeyRecord(first.senderKeyId)).signKeyWrapped, undefined);
        sk.clearSenderKeyCache();

        // make the FIRST row selection return the stale (pre-rotation) row, as an interleaved read would
        const probe = newDeviceStorage();
        const indexProto = await new Promise((resolve) => {
            const req = probe.open('probe2', 1);
            req.onupgradeneeded = () => resolve(Object.getPrototypeOf(req.result.createObjectStore('s').createIndex('i', 'x')));
        });
        const original = indexProto.getAll;
        let stale = true;
        indexProto.getAll = function (range) {
            if (stale && range?.lower?.[1] === 1) {
                stale = false;
                const fake = { result: staleRows.filter((r) => r.isMine === 1) };
                Object.defineProperty(fake, 'onsuccess', { set(fn) { queueMicrotask(() => fn()); } });
                Object.defineProperty(fake, 'onerror', { set() {} });
                return fake;
            }
            return original.call(this, range);
        };

        try {
            const mine = await sk.getMySenderKey(alice, GROUP);
            assert.ok(mine, 'the send does not fail with "no key"');
            assert.equal(mine.senderKeyId, second.senderKeyId, 'it moved on to the new key');
            assert.equal(stale, false, 'control: the stale selection was actually served');
        } finally {
            indexProto.getAll = original;
        }
    });
});

test('C2-16b: an own row without a signing key never hides a usable one in the selection', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const good = await sk.generateSenderKey(alice, GROUP, 0);
        const legacy = await sk.generateSenderKey(alice, GROUP, 7);
        const rec = await store.getSenderKeyRecord(legacy.senderKeyId);
        const { signKeyWrapped, ...stripped } = rec;
        await store.putSenderKeyRecord(stripped);

        const picked = await store.getMySenderKeyForGroup(GROUP, 1);
        assert.equal(picked.senderKeyId, good.senderKeyId, 'a higher-epoch row without a signing key is not a sending candidate');
    });
});

test('C2-20: the KDM plaintext buffers (wrap and unwrap) are zeroed after use', async () => {
    const alice = await user(1);
    const bob = await user(2);
    const aliceDev = await makeDevice(alice);
    const bobDev = await makeDevice(bob);

    const subtle = crypto.subtle;
    const origEncrypt = subtle.encrypt.bind(subtle);
    const origDecrypt = subtle.decrypt.bind(subtle);
    const plaintexts = [];
    const decrypted = [];
    subtle.encrypt = async (algo, key, data) => {
        if (algo.name === 'AES-GCM' && data.byteLength === 97) plaintexts.push(data);
        return origEncrypt(algo, key, data);
    };
    subtle.decrypt = async (algo, key, data) => {
        const out = await origDecrypt(algo, key, data);
        if (algo.name === 'AES-GCM' && out.byteLength === 97) decrypted.push(out);
        return out;
    };

    try {
        const sent = await rotateAndDeliver(aliceDev, 0, [aliceDev, bobDev]);
        assert.ok(sent.senderKeyId);
    } finally {
        subtle.encrypt = origEncrypt;
        subtle.decrypt = origDecrypt;
    }

    assert.ok(plaintexts.length >= 2, 'control: KDM plaintexts were observed (one per recipient)');
    for (const p of plaintexts) assert.ok(new Uint8Array(p.buffer, p.byteOffset, p.byteLength).every((b) => b === 0), 'wrap buffer zeroed');
    assert.ok(decrypted.length >= 2, 'control: unwrapped plaintexts were observed');
    for (const d of decrypted) assert.ok(new Uint8Array(d).every((b) => b === 0), 'unwrapped buffer zeroed');
});

test('C2-16c: a stored signing private key that does not belong to the row\'s public key is never used for sending (even when correctly wrapped for that id)', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const g = await sk.generateSenderKey(alice, GROUP, 0);
        const rec = await store.getSenderKeyRecord(g.senderKeyId);

        // a DIFFERENT key pair, wrapped exactly as the real one would be for this id and owner
        const other = await signing.generateSigningKeyPair();
        const pkcs8 = await signing.exportSigningPrivateKey(other.privateKey);
        const wrapKey = await deriveLocalWrapKey(alice);
        const signKeyWrapped = await encryptBytes(wrapKey, pkcs8, undefined, codec.encodeFields('group-sig-priv-v1', g.senderKeyId, 1));
        await store.putSenderKeyRecord({ ...rec, signKeyWrapped });
        sk.clearSenderKeyCache();

        const warn = console.warn;
        console.warn = () => {};
        try {
            assert.equal(await sk.getMySenderKey(alice, GROUP), null, 'private key and public key do not match');
        } finally {
            console.warn = warn;
        }
    });
});

test('C2-9b: storeReceivedSenderKey itself fails closed on a malformed signing public key and stores nothing', async () => {
    const bob = await user(2);
    const dev = await makeDevice(bob);
    const good = (await signing.generateSigningKeyPair()).publicKeyRaw;
    const offCurve = good.slice();
    offCurve[64] ^= 1;

    await dev.run(async () => {
        for (const [name, signPub] of Object.entries({
            'too short': good.slice(0, 64),
            'compressed prefix': Uint8Array.from([2, ...good.slice(1)]),
            'off the curve': offCurve,
            'missing': undefined,
        })) {
            const root = crypto.getRandomValues(new Uint8Array(32));
            await assert.rejects(
                () => sk.storeReceivedSenderKey(bob, { senderKeyId: 'c'.repeat(64), groupId: GROUP, ownerUserId: 1, epoch: 0, signPub }, root),
                name
            );
            assert.deepEqual(await store.getAllSenderKeysForGroup(GROUP), [], `${name}: nothing stored`);
            assert.equal(sk.__cachedKeysForTests().length, 0, `${name}: nothing cached`);
        }
    });
});
