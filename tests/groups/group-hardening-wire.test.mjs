// tests/groups/group-hardening-wire.test.mjs
//
// The v2 wire format (F2 KDM AAD + distinct HKDF info, F3 message/attachment AAD
// and counter<->iv check, F8 key schedule, F10 per-process nonce prefix).
// Real WebCrypto, real fake-indexeddb; only the "who is the peer" lookup is mocked
// (same approach as group-crypto.test.mjs).

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

const GROUP_ID = 42;
const identities = new Map();
const sessionProvider = makeSessionKeyProvider(identities);

mock.module('../../public/js/crypto/keys/session.js', {
    namedExports: {
        getOrCreateSessionKey: (id) => sessionProvider.getOrCreateSessionKey(id),
        getOrCreateGroupKdmKey: (id) => sessionProvider.getOrCreateGroupKdmKey(id),
    },
});

const sk = await import('../../public/js/crypto/groups/sender-key.js');
const { rotateSenderKey } = await import('../../public/js/crypto/groups/rotation.js');
const { receiveKdm, kdmAad } = await import('../../public/js/crypto/groups/kdm.js');
const mc = await import('../../public/js/crypto/groups/message-crypto.js');
const nl = await import('../../public/js/crypto/groups/nonce-lock.js');
const store = await import('../../public/js/crypto/groups/sender-key-store.js');
const ids = await import('../../public/js/crypto/groups/sender-key-id.js');
const codec = await import('../../public/js/crypto/groups/codec.js');
const { encryptBytes } = await import('../../public/js/crypto/groups/aead.js');

async function device(identity) {
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

async function user(id) {
    if (!identities.has(id)) identities.set(id, await makeTestIdentity(id));
    return identities.get(id);
}

/** Alice mints a key for `epoch`, Bob (and Alice) consume the KDMs. Returns the KDM rows too. */
async function setup({ epoch = 0, groupId = GROUP_ID } = {}) {
    const alice = await user(1);
    const bob = await user(2);
    await user(3);
    const aliceDev = await device(alice);
    const bobDev = await device(bob);

    const { recipients, senderKeyId } = await aliceDev.run(() =>
        rotateSenderKey(alice, groupId, epoch, [alice.userId, bob.userId])
    );

    const rowFor = (u) => ({
        id: 1,
        group_id: groupId,
        from_user_id: alice.userId,
        to_user_id: u.userId,
        epoch,
        wrapped_key: recipients.find((r) => r.user_id === u.userId).wrapped_key,
    });

    await bobDev.run(() => receiveKdm(bob, rowFor(bob)));

    return { alice, bob, aliceDev, bobDev, senderKeyId, rowFor, epoch, groupId };
}

const send = (s, text = 'hello', groupId = s.groupId) =>
    s.aliceDev.run(() => mc.encryptGroupMessage(s.alice, groupId, text));
const open = (s, envelope, groupId = s.groupId) =>
    s.bobDev.run(() => mc.decryptGroupMessage(s.bob, groupId, envelope, 't'));

// ---------------------------------------------------------------- F2

test('F2-a: a relabelled KDM row (group / epoch / recipient / sender) fails to unwrap', async () => {
    const s = await setup({ epoch: 0, groupId: 50 });
    const carol = await user(3);
    const row = s.rowFor(s.bob);

    // control: the untouched row is accepted (a fresh device consuming it)
    const fresh = await device(s.bob);
    await fresh.run(() => receiveKdm(s.bob, row));

    const relabels = {
        'wrong group': { ...row, group_id: 51 },
        'wrong epoch': { ...row, epoch: 1 },
        'wrong recipient': { ...row, to_user_id: carol.userId },
        'wrong sender': { ...row, from_user_id: carol.userId },
    };

    for (const [name, bad] of Object.entries(relabels)) {
        const d = await device(s.bob);
        await assert.rejects(() => d.run(() => receiveKdm(s.bob, bad)), /authentication failed/i, name);
        assert.equal(await d.run(() => store.getAllSenderKeysForGroup(bad.group_id)).then((r) => r.length), 0, `${name}: nothing stored`);
    }
});

test('F2-b: a 32-byte ciphertext made with the 1:1 DM session key cannot be accepted as a KDM', async () => {
    const s = await setup({ groupId: 52 });
    const dmKey = await s.aliceDev.run(() => sessionProvider.getOrCreateSessionKey(s.bob.userId));
    const raw = crypto.getRandomValues(new Uint8Array(32));

    // Exactly what a hostile relay could do with a captured DM: same plaintext size, same envelope shape.
    const dm = await encryptBytes(dmKey, raw);
    const asKdm = JSON.stringify({ v: 2, alg: 'AES-GCM', iv: dm.iv, ciphertext: dm.ciphertext });
    const d = await device(s.bob);
    await assert.rejects(
        () => d.run(() => receiveKdm(s.bob, { ...s.rowFor(s.bob), wrapped_key: asKdm })),
        /authentication failed/i
    );

    // And the wrap key itself is a different key than the DM key (distinct HKDF info).
    const kdmKey = await s.aliceDev.run(() => sessionProvider.getOrCreateGroupKdmKey(s.bob.userId));
    const probe = await encryptBytes(kdmKey, raw);
    await assert.rejects(() => crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: codec.base64ToBytes(probe.iv) }, dmKey, codec.base64ToBytes(probe.ciphertext)
    ));
});

test('F2-c: only one KDM format exists: v:1 (legacy) and unknown versions are rejected', async () => {
    const s = await setup({ groupId: 53 });
    const row = s.rowFor(s.bob);
    for (const v of [1, 3, undefined]) {
        const bad = JSON.stringify({ ...JSON.parse(row.wrapped_key), v });
        const d = await device(s.bob);
        await assert.rejects(() => d.run(() => receiveKdm(s.bob, { ...row, wrapped_key: bad })), /Unsupported KDM/, `v=${v}`);
    }
});

test('F2-d: encodeFields is unambiguous (length-prefixed, typed)', () => {
    const e = codec.encodeFields;
    assert.notDeepEqual(e('ab', 'c'), e('a', 'bc'));
    assert.notDeepEqual(e('a|b', 'c'), e('a', 'b|c'));
    assert.notDeepEqual(e('12', 3), e('1', 23));
    assert.notDeepEqual(e('x', new Uint8Array([0x78])), e('x', 'x'));
    assert.deepEqual(e('a', 1), e('a', 1));
    assert.notDeepEqual(kdmAad({ groupId: 1, fromUserId: 2, toUserId: 3, epoch: 4 }), kdmAad({ groupId: 1, fromUserId: 3, toUserId: 2, epoch: 4 }));
});

// ---------------------------------------------------------------- F8

test('F8-a: the stored/transmitted root is never the AES key; id and enc keys are independent subkeys', async () => {
    const s = await setup({ groupId: 54 });
    const msg = await send(s, 'subkeys');
    const env = JSON.parse(msg);

    // Re-import the raw root bytes DIRECTLY as an AES key (the pre-F8 behaviour): must not decrypt.
    const rec = await s.bobDev.run(() => store.getSenderKeyRecord(s.senderKeyId));
    const wrap = await s.bobDev.run(async () => (await import('../../public/js/crypto/groups/local-wrap-key.js')).deriveLocalWrapKey(s.bob));
    const { decryptBytes } = await import('../../public/js/crypto/groups/aead.js');
    const root = await decryptBytes(wrap, rec.wrappedKey);
    const direct = await crypto.subtle.importKey('raw', root, { name: 'AES-GCM' }, false, ['decrypt']);
    await assert.rejects(() => crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: codec.base64ToBytes(env.iv), additionalData: mc.messageAad(s.groupId, env.senderKeyId, env.counter, codec.base64ToBytes(env.iv)) },
        direct, codec.base64ToBytes(env.ciphertext)
    ), 'root used directly as the AES key must not decrypt');

    // The id is a function of (root, group, owner, epoch, signPub) with length-prefixed fields.
    const signPub = codec.base64ToBytes(rec.signPub); // call-site change (Phase C2): the id now commits to the signing public key
    const id = (g, o, e) => ids.deriveSenderKeyId(g, o, e, root, signPub);
    const base = await id(54, 1, 0);
    assert.equal(base, s.senderKeyId, 'recipient derives the same id as the sender');
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.notEqual(base, await id(55, 1, 0));
    assert.notEqual(base, await id(54, 2, 0));
    assert.notEqual(base, await id(54, 1, 1));
    assert.notEqual(await id(1, 23, 4), await id(12, 3, 4));
    const other = crypto.getRandomValues(new Uint8Array(32));
    assert.notEqual(base, await ids.deriveSenderKeyId(54, 1, 0, other, signPub));
    root.fill(0);
});

// ---------------------------------------------------------------- F3

test('F3-a: the counter is authenticated: a relabelled counter fails, with or without rewriting the iv', async () => {
    const s = await setup({ groupId: 56 });
    const env = JSON.parse(await send(s, 'counted'));
    assert.equal(await open(s, JSON.stringify(env)), 'counted', 'control');

    // counter field changed, iv untouched: refused before any decryption
    await assert.rejects(() => open(s, JSON.stringify({ ...env, counter: env.counter + 1 })), /does not match its nonce/);

    // counter AND iv rewritten consistently (keeping the sender's prefix): GCM refuses
    const iv = codec.base64ToBytes(env.iv);
    const forged = mc.nonceFromCounter(env.counter + 1, iv.slice(0, 4));
    await assert.rejects(
        () => open(s, JSON.stringify({ ...env, counter: env.counter + 1, iv: codec.bytesToBase64(forged) })),
        /authentication failed/i
    );
});

test('F3-b: the receiver does not need to know the prefix, only that iv[4..12] == counter', async () => {
    const s = await setup({ groupId: 57 });
    const env = JSON.parse(await send(s, 'prefix'));
    const iv = codec.base64ToBytes(env.iv);
    assert.equal(iv.length, 12);
    assert.equal(mc.readNonce(iv).counter, env.counter);

    // A different prefix is a different nonce: authentication fails (it is in the AAD and the nonce).
    const swapped = iv.slice();
    swapped[0] ^= 0xff;
    await assert.rejects(() => open(s, JSON.stringify({ ...env, iv: codec.bytesToBase64(swapped) })), /authentication failed/i);

    // Malformed iv / counter shapes are refused.
    await assert.rejects(() => open(s, JSON.stringify({ ...env, iv: codec.bytesToBase64(iv.slice(0, 8)) })), /nonce/i);
    await assert.rejects(() => open(s, JSON.stringify({ ...env, counter: -1 })), /counter/i);
    await assert.rejects(() => open(s, JSON.stringify({ ...env, counter: '5' })), /counter/i);
});

test('F3-c: swapped groupId / senderKeyId / another group\'s envelope fail on AAD alone (same key bytes)', async () => {
    const s = await setup({ groupId: 58 });
    const env = JSON.parse(await send(s, 'bound'));

    // Make Bob hold the IDENTICAL key bytes under a second id and a second group, so only AAD can tell them apart.
    const rec = await s.bobDev.run(() => store.getSenderKeyRecord(s.senderKeyId));
    const wrap = await s.bobDev.run(async () => (await import('../../public/js/crypto/groups/local-wrap-key.js')).deriveLocalWrapKey(s.bob));
    const { decryptBytes } = await import('../../public/js/crypto/groups/aead.js');
    const root = await decryptBytes(wrap, rec.wrappedKey);
    // call-site change (Phase C2): ids are derived from (root, group, owner, epoch, signPub) and a stored id that
    // does not re-derive is refused on load, so the second id is the real derived id for group 59 (same key bytes).
    const signPub = codec.base64ToBytes(rec.signPub);
    const otherId = await ids.deriveSenderKeyId(59, 1, 0, root, signPub);
    await s.bobDev.run(() => sk.storeReceivedSenderKey(s.bob, { senderKeyId: otherId, groupId: 59, ownerUserId: 1, epoch: 0, signPub }, root.slice()));
    root.fill(0);

    // control
    assert.equal(await open(s, JSON.stringify(env)), 'bound');

    await assert.rejects(() => open(s, JSON.stringify(env), 59), /authentication failed/i, 'same envelope presented as another group');
    await assert.rejects(() => open(s, JSON.stringify({ ...env, senderKeyId: otherId })), /authentication failed/i, 'senderKeyId swapped to another id holding the same key');
    await assert.rejects(() => open(s, JSON.stringify({ ...env, senderKeyId: otherId }), 59), /authentication failed/i, 'both swapped');
});

test('F3-d: message and attachment AADs are distinct contexts', () => {
    const iv = new Uint8Array(12);
    assert.notDeepEqual(mc.messageAad(1, 'k', 0, iv), mc.attachmentAad(1, 'k', 0, iv));
    assert.notDeepEqual(mc.messageAad(1, 'k', 0, iv), mc.messageAad(2, 'k', 0, iv));
    assert.notDeepEqual(mc.messageAad(1, 'k', 0, iv), mc.messageAad(1, 'k', 1, iv));
    assert.notDeepEqual(mc.messageAad(1, 'k', 0, iv), mc.messageAad(1, 'j', 0, iv));
});

// ---------------------------------------------------------------- F10

test('F10-a: the nonce prefix is random per process/unlock and is never stored with the key', async () => {
    const seen = new Set();
    for (let i = 0; i < 4; i++) {
        nl.resetNoncePrefix();
        seen.add(Array.from(nl.getNoncePrefix()).join(','));
    }
    assert.ok(seen.size >= 3, 'prefix must be redrawn after every reset (lock/unlock)');

    const s = await setup({ groupId: 60 });
    const rec = await s.aliceDev.run(() => store.getMySenderKeyForGroup(60, s.alice.userId));
    assert.ok(!JSON.stringify(rec).match(/prefix/i), 'no prefix in the persisted key record');

    // (helpers.useDeviceStorage models a device switch = a new process, so both
    // sends happen inside ONE run: one process.)
    const [x, y] = await s.aliceDev.run(async () => {
        nl.resetNoncePrefix();
        return [
            JSON.parse(await mc.encryptGroupMessage(s.alice, s.groupId, 'one')),
            JSON.parse(await mc.encryptGroupMessage(s.alice, s.groupId, 'two')),
        ];
    });
    assert.deepEqual(
        codec.base64ToBytes(x.iv).slice(0, 4),
        codec.base64ToBytes(y.iv).slice(0, 4),
        'one process keeps one prefix'
    );
    assert.equal(y.counter, x.counter + 1);
});

test('F10-b: cloned profile + rolled-back counter + two messages => nonces differ from the original run', async () => {
    const s = await setup({ groupId: 61 });

    // Original process sends two messages (counters 0 and 1).
    const original = await s.aliceDev.run(async () => {
        nl.resetNoncePrefix();
        return [
            JSON.parse(await mc.encryptGroupMessage(s.alice, s.groupId, 'o1')),
            JSON.parse(await mc.encryptGroupMessage(s.alice, s.groupId, 'o2')),
        ];
    });

    // The profile is cloned/restored: same key, counter back at its old value.
    const clone = await device(s.alice);
    const rec = await s.aliceDev.run(() => store.getSenderKeyRecord(s.senderKeyId));
    await clone.run(async () => {
        await store.putSenderKeyRecord(rec);
        await store.writeCounter(s.senderKeyId, 0);
    });
    const replayed = await clone.run(async () => {
        // a different process: empty caches and a fresh random prefix
        sk.clearSenderKeyCache();
        return [
            JSON.parse(await mc.encryptGroupMessage(s.alice, s.groupId, 'c1')),
            JSON.parse(await mc.encryptGroupMessage(s.alice, s.groupId, 'c2')),
        ];
    });

    // control: the counters really did repeat (that is the rollback)
    assert.deepEqual(replayed.map((e) => e.counter), original.map((e) => e.counter));
    assert.deepEqual(replayed.map((e) => e.senderKeyId), original.map((e) => e.senderKeyId));

    // the property: no (key, nonce) pair is reused
    const all = [...original, ...replayed].map((e) => `${e.senderKeyId}:${e.iv}`);
    assert.equal(new Set(all).size, all.length, `nonce reuse after counter rollback: ${JSON.stringify(all)}`);

    // and the clone's messages are still readable by Bob
    assert.equal(await open(s, JSON.stringify(replayed[0])), 'c1');
    assert.equal(await open(s, JSON.stringify(replayed[1])), 'c2');
});

test('F10-d (fault injection): crash between counter reserve and encrypt skips the counter, never reuses it', async () => {
    const s = await setup({ groupId: 62 });

    const first = JSON.parse(await send(s, 'm0'));

    // Process dies right after the counter was durably reserved but before encryption/sending.
    const lost = await s.aliceDev.run(() => nl.reserveNextCounter(s.senderKeyId));
    assert.equal(lost, first.counter + 1, 'control: the reserve consumed the next counter');

    // Relaunch: the next message never gets the lost counter, and none repeats.
    const next = JSON.parse(await send(s, 'm2'));
    assert.ok(next.counter > lost, `counter ${next.counter} must be past the reserved-but-unused ${lost}`);
    assert.equal(await open(s, JSON.stringify(next)), 'm2');
});
