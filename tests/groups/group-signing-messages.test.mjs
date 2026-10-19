// Phase C3: per-message signatures on the crypto layer.
//   sign on send; verify BEFORE decrypting and BEFORE claiming the nonce; attribution by
//   the owner of the verified key; the SIGNED reply target is authoritative; fail closed on
//   every structural problem; a forged / re-posted / relabelled message never burns a nonce.
// Real WebCrypto, real fake-indexeddb; only the pairwise-session provider is in-memory.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    installWebLocksPolyfill,
    newDeviceStorage,
    useDeviceStorage,
    makeTestIdentity,
    makeSessionKeyProvider,
} from './helpers.mjs';

installWebLocksPolyfill();

const GROUP = 41;
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
const mc = await import('../../public/js/crypto/groups/message-crypto.js');
const signing = await import('../../public/js/crypto/groups/signing.js');
const codec = await import('../../public/js/crypto/groups/codec.js');
const { encryptBytes } = await import('../../public/js/crypto/groups/aead.js');

async function user(id) {
    if (!identities.has(id)) identities.set(id, await makeTestIdentity(id));
    return identities.get(id);
}

async function makeDevice(identity) {
    const storage = newDeviceStorage();
    return {
        identity,
        async run(fn) {
            useDeviceStorage(storage);
            sessionProvider.setCurrentActor(identity.userId);
            return fn();
        },
    };
}

function kdmRow(from, to, epoch, wrapped, group = GROUP) {
    return { id: 1, group_id: group, from_user_id: from, to_user_id: to, epoch, wrapped_key: wrapped };
}

async function rotateAndDeliver(owner, epoch, recipients, group = GROUP) {
    const pending = await owner.run(() =>
        rotateSenderKey(owner.identity, group, epoch, recipients.map((d) => d.identity.userId), { deferPersist: true })
    );
    await owner.run(() => pending.commit());
    for (const d of recipients) {
        const row = pending.recipients.find((r) => r.user_id === d.identity.userId);
        await d.run(() => kdm.receiveKdm(d.identity, kdmRow(owner.identity.userId, d.identity.userId, epoch, row.wrapped_key, group)));
    }
    return pending;
}

/** alice (1) with a group of alice, bob (2), mallory (3), all holding Alice's key. */
async function world() {
    const [alice, bob, mallory] = await Promise.all([user(1), user(2), user(3)]);
    const A = await makeDevice(alice);
    const B = await makeDevice(bob);
    const M = await makeDevice(mallory);
    const key = await rotateAndDeliver(A, 0, [A, B, M]);
    // Mallory and Bob also own sending keys (distributed to everybody)
    const mKey = await rotateAndDeliver(M, 0, [A, B, M]);
    return { alice, bob, mallory, A, B, M, aliceKeyId: key.senderKeyId, malloryKeyId: mKey.senderKeyId };
}

const send = (dev, text, opts) => dev.run(() => mc.encryptGroupMessage(dev.identity, GROUP, text, opts));
const open = (dev, env, id, expect = {}, group = GROUP) =>
    dev.run(() => mc.decryptGroupMessageDetailed(dev.identity, group, typeof env === 'string' ? env : JSON.stringify(env), id, expect));
const seen = (dev, keyId) => dev.run(() => store.countSeen(keyId));

async function countAesDecrypts(fn) {
    const subtle = crypto.subtle;
    const original = subtle.decrypt.bind(subtle);
    let n = 0;
    // only the MESSAGE decrypt (AAD label group-msg-v2), not the local key unwrap
    subtle.decrypt = (algo, ...rest) => {
        if (algo?.name === 'AES-GCM' && algo.additionalData && Buffer.from(algo.additionalData.buffer ?? algo.additionalData).includes('group-msg-v2')) n++;
        return original(algo, ...rest);
    };
    try {
        await fn();
    } finally {
        subtle.decrypt = original;
    }
    return n;
}

async function assertUnverified(promise, reason, label) {
    await assert.rejects(promise, (e) => e instanceof mc.UnverifiedMessageError && e.permanent === true && (!reason || e.reason === reason), label);
}

/** Mallory holds Alice's Sender Key: she can make GCM-valid ciphertext "from" Alice's key but cannot sign as Alice. */
async function forgeAsAlice(w, text, { counter = 9000, replyToId = null } = {}) {
    return w.M.run(async () => {
        const bundle = await sk.loadSenderKeyBundle(w.mallory, w.aliceKeyId);
        const mine = await sk.getMySenderKey(w.mallory, GROUP);
        const prefix = crypto.getRandomValues(new Uint8Array(4));
        const nonce = mc.nonceFromCounter(counter, prefix);
        const { iv, ciphertext } = await encryptBytes(bundle.cryptoKey, new TextEncoder().encode(text), nonce, mc.messageAad(GROUP, w.aliceKeyId, counter, nonce));
        const sig = await signing.signMessage(mine.signKey, {
            groupId: GROUP, senderKeyId: w.aliceKeyId, counter, iv: nonce, ciphertext: codec.base64ToBytes(ciphertext), replyToId, attachment: new Uint8Array(0),
        });
        return { v: 2, alg: 'AES-GCM', senderKeyId: w.aliceKeyId, counter, iv, ciphertext, reply_to_id: replyToId, sig: codec.bytesToBase64(sig) };
    });
}

/* ----------------------------------------------------------- sign & verify */

test('C3-1: every message is signed; the envelope carries sig (64 raw bytes) and reply_to_id; it verifies with the sender key\'s public key', async () => {
    const w = await world();
    const env = JSON.parse(await send(w.A, 'hello'));

    assert.equal(env.v, 2);
    assert.equal(codec.base64ToBytes(env.sig).length, 64);
    assert.equal(env.reply_to_id, null);
    assert.equal(JSON.parse(await send(w.A, 'reply', { replyToId: 17 })).reply_to_id, 17);

    const r = await open(w.B, env, 1);
    assert.equal(r.plaintext, 'hello');
    assert.equal(r.ownerUserId, 1, 'attributed to the owner of the verified key');
    assert.equal(r.replyToId, null);

    for (const bad of [0, -1, 1.5, '5', NaN, true]) {
        await assert.rejects(() => send(w.A, 'x', { replyToId: bad }), /Invalid reply_to_id/, String(bad));
    }
});

test('C3-2: a forged message (Alice\'s Sender Key, Mallory\'s signature) is rejected BEFORE decrypting and BEFORE claiming the nonce', async () => {
    const w = await world();
    const forged = await forgeAsAlice(w, 'alice would never say this');

    let result;
    const aesDecrypts = await countAesDecrypts(async () => {
        result = await open(w.B, forged, 1).then(() => 'accepted', (e) => e);
    });

    assert.ok(result instanceof mc.UnverifiedMessageError, `got ${result}`);
    assert.equal(result.reason, 'bad-signature');
    assert.equal(aesDecrypts, 0, 'the ciphertext was never decrypted');
    assert.equal(await seen(w.B, w.aliceKeyId), 0, 'no nonce was claimed');

    // and the genuine Alice is unaffected
    const genuine = await send(w.A, 'the real one');
    assert.equal((await open(w.B, genuine, 2)).plaintext, 'the real one');
    assert.equal(await seen(w.B, w.aliceKeyId), 1);
});

test('C3-3: changing ANY signed field of a genuine message fails verification and claims no nonce', async () => {
    const w = await world();
    const env = JSON.parse(await send(w.A, 'original', { replyToId: 5 }));
    const flipB64 = (b64, i) => { const u = codec.base64ToBytes(b64); u[i] ^= 1; return codec.bytesToBase64(u); };
    const nonceOf = (e) => codec.base64ToBytes(e.iv);

    // counter AND iv rewritten consistently, so only the signature (and the GCM AAD) can tell
    const iv2 = nonceOf(env); iv2[11] ^= 1;
    const counter2 = new DataView(iv2.buffer).getUint32(8);

    const variants = {
        'ciphertext': { ...env, ciphertext: flipB64(env.ciphertext, 0) },
        'ciphertext tag': { ...env, ciphertext: flipB64(env.ciphertext, codec.base64ToBytes(env.ciphertext).length - 1) },
        'iv + counter': { ...env, iv: codec.bytesToBase64(iv2), counter: counter2 },
        'reply_to_id': { ...env, reply_to_id: 6 },
        'reply_to_id removed to null': { ...env, reply_to_id: null },
        'signature bit': { ...env, sig: flipB64(env.sig, 10) },
        'signature of another message': { ...env, sig: JSON.parse(await send(w.A, 'other')).sig },
    };

    for (const [name, v] of Object.entries(variants)) {
        await assertUnverified(open(w.B, v, 77), 'bad-signature', name);
    }

    // senderKeyId -> another known key (Mallory's): different verify key, different bytes
    await assertUnverified(open(w.B, { ...env, senderKeyId: w.malloryKeyId }, 77), 'bad-signature', 'senderKeyId swapped');
    // another group
    await assert.rejects(() => open(w.B, env, 77, {}, GROUP + 1));

    assert.equal(await seen(w.B, w.aliceKeyId), 0, 'none of them claimed a nonce');
    assert.equal((await open(w.B, env, 78)).plaintext, 'original', 'the untouched envelope is still accepted afterwards');
});

test('C3-4 (G): every structural problem is "unverified" (permanent), never another exception, and claims nothing', async () => {
    const w = await world();
    const env = JSON.parse(await send(w.A, 'x', { replyToId: 3 }));
    const { sig, reply_to_id, ...rest } = env;

    const cases = {
        'no sig': [{ ...rest, reply_to_id }, 'no-signature'],
        'sig null': [{ ...env, sig: null }, 'no-signature'],
        'sig number': [{ ...env, sig: 5 }, 'no-signature'],
        'sig empty': [{ ...env, sig: '' }, 'no-signature'],
        'sig not base64': [{ ...env, sig: '***not base64***' }, 'no-signature'],
        'sig 63 bytes': [{ ...env, sig: codec.bytesToBase64(codec.base64ToBytes(sig).slice(0, 63)) }, 'no-signature'],
        'sig 65 bytes': [{ ...env, sig: codec.bytesToBase64(Uint8Array.from([...codec.base64ToBytes(sig), 0])) }, 'no-signature'],
        'reply_to_id missing': [{ ...rest, sig }, 'bad-reply-id'],
        'reply_to_id string': [{ ...env, reply_to_id: '3' }, 'bad-reply-id'],
        'reply_to_id 0': [{ ...env, reply_to_id: 0 }, 'bad-reply-id'],
        'reply_to_id negative': [{ ...env, reply_to_id: -3 }, 'bad-reply-id'],
        'reply_to_id fractional': [{ ...env, reply_to_id: 3.5 }, 'bad-reply-id'],
        'reply_to_id boolean': [{ ...env, reply_to_id: true }, 'bad-reply-id'],
        'reply_to_id object': [{ ...env, reply_to_id: {} }, 'bad-reply-id'],
        'unexpected attachment field "att"': [{ ...env, att: { iv: 'x' } }, 'attachment-not-bound'],
        'unexpected attachment field "attachment"': [{ ...env, attachment: 'x' }, 'attachment-not-bound'],
    };

    for (const [name, [e, reason]] of Object.entries(cases)) {
        await assertUnverified(open(w.B, e, 5), reason, name);
    }

    assert.equal(await seen(w.B, w.aliceKeyId), 0);
});

test('C3-5: the server\'s claims are checked against the VERIFIED envelope before the nonce is claimed (author, reply target)', async () => {
    const w = await world();
    const reply = await send(w.A, 'a reply', { replyToId: 5 });
    const plain = await send(w.A, 'a plain one');

    // author: the verified owner is Alice (1)
    await assertUnverified(open(w.B, plain, 1, { expectedSenderId: 2 }), 'sender-mismatch', 'server says Bob wrote it');
    await assertUnverified(open(w.B, plain, 1, { expectedSenderId: 3 }), 'sender-mismatch', 'server says Mallory wrote it');
    assert.equal(await seen(w.B, w.aliceKeyId), 0, 'a refused message does not burn the nonce');
    assert.equal((await open(w.B, plain, 1, { expectedSenderId: 1 })).ownerUserId, 1);

    // reply target: the SIGNED value is authoritative
    await assertUnverified(open(w.B, reply, 2, { serverReplyToId: 6 }), 'reply-mismatch', 'server re-points the reply');
    assert.equal(await seen(w.B, w.aliceKeyId), 1);
    const ok1 = await open(w.B, reply, 2, { serverReplyToId: 5 });
    assert.equal(ok1.replyToId, 5);
    const ok2 = await open(w.B, reply, 2, { serverReplyToId: null });
    assert.equal(ok2.replyToId, 5, 'server null while signed non-null: allowed (target deleted / other group)');
    const ok3 = await open(w.B, reply, 2, {});
    assert.equal(ok3.replyToId, 5);

    // signed "no reply" but the server claims one: swap
    await assertUnverified(open(w.B, plain, 1, { serverReplyToId: 5 }), 'reply-mismatch', 'server adds a reply');
});

test('C3-6: a member re-posting Alice\'s genuine signed message as her own is refused and cannot burn the original\'s nonce', async () => {
    const w = await world();
    const genuine = await send(w.A, 'genuine from alice');

    // Mallory posts the very same envelope as a NEW message (id 8, server sender = Mallory) first
    await assertUnverified(open(w.B, genuine, 8, { expectedSenderId: 3 }), 'sender-mismatch');
    assert.equal(await seen(w.B, w.aliceKeyId), 0);

    // the original (id 7, sender Alice) still lands afterwards
    assert.equal((await open(w.B, genuine, 7, { expectedSenderId: 1 })).plaintext, 'genuine from alice');
    // and a later re-post is a replay, not an accepted message
    await assert.rejects(() => open(w.B, genuine, 9, { expectedSenderId: 1 }), (e) => e.name === 'ReplayedMessageError');
});

test('C3-7: both devices of Alice sign with their own key and everybody verifies both, attributed to Alice', async () => {
    const [alice, bob] = await Promise.all([user(1), user(2)]);
    const A1 = await makeDevice(alice);
    const A2 = await makeDevice(alice);
    const B = await makeDevice(bob);

    const k1 = await rotateAndDeliver(A1, 0, [A1, A2, B]);
    const k2 = await rotateAndDeliver(A2, 0, [A1, A2, B]);
    assert.notEqual(k1.senderKeyId, k2.senderKeyId);

    const e1 = await send(A1, 'from device one');
    const e2 = await send(A2, 'from device two');

    for (const reader of [B, A1, A2]) {
        const r1 = await open(reader, e1, 101, { expectedSenderId: 1 });
        const r2 = await open(reader, e2, 102, { expectedSenderId: 1 });
        assert.deepEqual([r1.plaintext, r1.ownerUserId, r2.plaintext, r2.ownerUserId], ['from device one', 1, 'from device two', 1]);
    }

    // device 2's signature does not verify under device 1's key id and vice versa
    const env2 = JSON.parse(e2);
    await assertUnverified(open(B, { ...env2, senderKeyId: k1.senderKeyId }, 103), 'bad-signature');
});

/* ------------------------------------------------------ rotation & old data */

test('C3-8: a message signed before a rotation still verifies as that key\'s message after the rotation', async () => {
    const w = await world();
    const before = await send(w.A, 'before rotation');
    await rotateAndDeliver(w.A, 1, [w.A, w.B, w.M]);
    const after = await send(w.A, 'after rotation');

    assert.equal((await open(w.B, before, 1, { expectedSenderId: 1 })).plaintext, 'before rotation');
    assert.equal((await open(w.B, after, 2, { expectedSenderId: 1 })).plaintext, 'after rotation');
    assert.notEqual(JSON.parse(before).senderKeyId, JSON.parse(after).senderKeyId);
});

test('C3-9: pre-signing messages are unverified for good; a received row without signPub is unverified, kept, and logs ONE line per key id', async () => {
    const w = await world();

    // an old-format message (valid GCM, no signature fields at all)
    const legacyEnv = await w.A.run(async () => {
        const mine = await sk.getMySenderKey(w.alice, GROUP);
        const nonce = mc.nonceFromCounter(5000, crypto.getRandomValues(new Uint8Array(4)));
        const { iv, ciphertext } = await encryptBytes(mine.cryptoKey, new TextEncoder().encode('old'), nonce, mc.messageAad(GROUP, mine.senderKeyId, 5000, nonce));
        return { v: 2, alg: 'AES-GCM', senderKeyId: mine.senderKeyId, counter: 5000, iv, ciphertext };
    });
    await assertUnverified(open(w.B, legacyEnv, 1), 'no-signature', 'no signature at all');

    // Bob's copy of Alice's key loses its signPub (a received pre-signing row)
    await w.B.run(async () => {
        const rec = await store.getSenderKeyRecord(w.aliceKeyId);
        const { signPub, ...legacyRow } = rec;
        await store.putSenderKeyRecord(legacyRow);
        sk.clearSenderKeyCache();
    });

    const live = await send(w.A, 'alice, new format');
    const lines = [];
    const warn = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    try {
        // one session (the key cache lives as long as the page does)
        await w.B.run(async () => {
            for (let i = 0; i < 6; i++) {
                await assertUnverified(mc.decryptGroupMessageDetailed(w.bob, GROUP, live, 200 + i), 'key-unusable', `message ${i} under the legacy row`);
            }
        });
    } finally {
        console.warn = warn;
    }

    assert.equal(lines.length, 1, `ONE console line for six messages, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /unverified/);
    assert.ok(await w.B.run(() => store.getSenderKeyRecord(w.aliceKeyId)), 'the row is kept, not deleted (deleting would only create a "waiting for key" loop)');
    assert.equal(await seen(w.B, w.aliceKeyId), 0);
});

test('C3-10: a key whose row is missing is "waiting for key" (retryable), not unverified', async () => {
    const w = await world();
    const env = await send(w.A, 'x');
    await w.B.run(() => store.deleteSenderKeyRecord(w.aliceKeyId));
    await assert.rejects(() => open(w.B, env, 1), (e) => e.name === 'MissingSenderKeyError' && !e.permanent);
});

/* ------------------------------------------------ decision 1: cleanup eventually */

test('C3-11: a superseded own signing key left by NON-deferred generation is eventually removed by a later successful rotation', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);

    await dev.run(async () => {
        const a = await sk.generateSenderKey(alice, GROUP, 0); // non-deferred: never drops anything
        const b = await sk.generateSenderKey(alice, GROUP, 1);
        const has = async (id) => Boolean((await store.getSenderKeyRecord(id)).signKeyWrapped);
        assert.deepEqual([await has(a.senderKeyId), await has(b.senderKeyId)], [true, true], 'non-deferred generation keeps both');

        const c = await rotateSenderKey(alice, GROUP, 2, [1], { deferPersist: true });
        assert.deepEqual([await has(a.senderKeyId), await has(b.senderKeyId)], [true, true], 'nothing is dropped before the commit');
        await c.commit();
        assert.deepEqual([await has(a.senderKeyId), await has(b.senderKeyId), await has(c.senderKeyId)], [false, false, true], 'the later successful rotation cleans up both');
    });
});

/* ----------------------------------------------- condition E: no group attachments */

test('C3-12 (E): the attachment bytes ARE bound into the signature, and still no client path SENDS group attachments', () => {
    const root = path.resolve(import.meta.dirname, '../../public/js');
    const hits = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (p.endsWith('.js')) {
                const text = fs.readFileSync(p, 'utf8');
                if (/encryptAttachmentForGroup/.test(text) && !p.endsWith(path.join('crypto', 'messages', 'attachment-crypto.js'))) hits.push(path.relative(root, p));
            }
        }
    };
    walk(root);

    assert.deepEqual(hits, [],
        'A client path now calls encryptAttachmentForGroup. The signature binding now EXISTS (STEP 3B: the file bytes - iv, ciphertext hash and ' +
        'plaintext length - are bound into the message signature via buildAttachmentSlot and the attachment slot in signing.js), so the next step is ' +
        'the COMPOSER wiring, which is step 3C. Update this test then, and only then enable group attachment sending.');

    // STEP 3B: the binding must actually be ON the send path. If a future edit
    // removes it, this test fails instead of the binding silently disappearing.
    const messageCrypto = fs.readFileSync(path.join(root, 'crypto/groups/message-crypto.js'), 'utf8');
    assert.ok(/buildAttachmentSlot/.test(messageCrypto),
        'the send path must build the attachment slot (buildAttachmentSlot) - the binding was removed');
    const signing = fs.readFileSync(path.join(root, 'crypto/groups/signing.js'), 'utf8');
    assert.ok(/export async function buildAttachmentSlot/.test(signing),
        'signing.js must export buildAttachmentSlot');

    const groupJs = fs.readFileSync(path.join(root, 'chat/group.js'), 'utf8');
    assert.ok(!/uploadUrl\s*:/.test(groupJs), 'the group composer has no upload URL');
    assert.ok(/group attachments aren't supported/i.test(groupJs));
});
