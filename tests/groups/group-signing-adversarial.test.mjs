// Phase C4 (crypto layer): adversarial tests for per-message signatures.
// Attackers: a member who holds the victim's Sender Key (Mallory), a removed member, a hostile
// server (it can relabel, withhold, reorder and replay anything it stores, but holds no key).
// Every test names the rule it pins; tests that pin a KNOWN, ACCEPTED limitation say so.

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

const G1 = 51;
const G2 = 52;
const G3 = 53;
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

const kdmRow = (from, to, epoch, wrapped, group, id = 1) => ({ id, group_id: group, from_user_id: from, to_user_id: to, epoch, wrapped_key: wrapped });

async function rotateAndDeliver(owner, epoch, recipients, group) {
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

/** Alice (1), Bob (2), Mallory (3): everyone has everyone's key in G1. */
async function world(group = G1) {
    const [alice, bob, mallory] = await Promise.all([user(1), user(2), user(3)]);
    const A = await makeDevice(alice);
    const B = await makeDevice(bob);
    const M = await makeDevice(mallory);
    const all = [A, B, M];
    const aKey = await rotateAndDeliver(A, 0, all, group);
    const mKey = await rotateAndDeliver(M, 0, all, group);
    await rotateAndDeliver(B, 0, all, group);
    return { alice, bob, mallory, A, B, M, aliceKeyId: aKey.senderKeyId, malloryKeyId: mKey.senderKeyId };
}

const send = (dev, group, text, opts) => dev.run(() => mc.encryptGroupMessage(dev.identity, group, text, opts));
const open = (dev, group, env, id, expect = {}) =>
    dev.run(() => mc.decryptGroupMessageDetailed(dev.identity, group, typeof env === 'string' ? env : JSON.stringify(env), id, expect));
const seen = (dev, keyId) => dev.run(() => store.countSeen(keyId));

async function assertUnverified(promise, reason, label) {
    await assert.rejects(promise, (e) => e instanceof mc.UnverifiedMessageError && e.permanent === true && (!reason || e.reason === reason), label);
}

/** Mallory forges "from Alice": Alice's Sender Key (she holds it), her OWN signature. */
async function forgeWithKey(forger, keyId, group, text, { counter = 9000, replyToId = null } = {}) {
    return forger.run(async () => {
        const bundle = await sk.loadSenderKeyBundle(forger.identity, keyId);
        const mine = await sk.getMySenderKey(forger.identity, group);
        const nonce = mc.nonceFromCounter(counter, crypto.getRandomValues(new Uint8Array(4)));
        const { iv, ciphertext } = await encryptBytes(bundle.cryptoKey, new TextEncoder().encode(text), nonce, mc.messageAad(group, keyId, counter, nonce));
        const sig = await signing.signMessage(mine.signKey, {
            groupId: group, senderKeyId: keyId, counter, iv: nonce, ciphertext: codec.base64ToBytes(ciphertext), replyToId, attachment: new Uint8Array(0),
        });
        return { v: 2, alg: 'AES-GCM', senderKeyId: keyId, counter, iv, ciphertext, reply_to_id: replyToId, sig: codec.bytesToBase64(sig) };
    });
}

/* ================================================================= 1. seen-set */

test('C4-1: a forged, relabelled, re-pointed or re-posted message never burns a nonce: claims happen only after verification AND the server\'s claims', async () => {
    const w = await world();
    const genuine = await send(w.A, G1, 'the genuine message', { replyToId: 4 });
    const forged = await forgeWithKey(w.M, w.aliceKeyId, G1, 'forged as alice');

    const attacks = [
        ['forged by a key holder', () => open(w.B, G1, forged, 11, { expectedSenderId: 1 }), 'bad-signature'],
        ['genuine envelope, server says Mallory sent it', () => open(w.B, G1, genuine, 12, { expectedSenderId: 3 }), 'sender-mismatch'],
        ['genuine envelope, server says Bob sent it', () => open(w.B, G1, genuine, 13, { expectedSenderId: 2 }), 'sender-mismatch'],
        ['genuine envelope, server re-points the reply', () => open(w.B, G1, genuine, 14, { expectedSenderId: 1, serverReplyToId: 9 }), 'reply-mismatch'],
        ['genuine envelope replayed into another group', () => open(w.B, G2, genuine, 15, { expectedSenderId: 1 }), null],
    ];

    for (const [name, attack, reason] of attacks) {
        if (reason) await assertUnverified(attack(), reason, name);
        else await assert.rejects(attack(), name);
        assert.equal(await seen(w.B, w.aliceKeyId), 0, `${name}: no nonce claimed`);
    }

    // every attack was refused, and the genuine message still lands afterwards, exactly once
    assert.equal((await open(w.B, G1, genuine, 20, { expectedSenderId: 1, serverReplyToId: 4 })).plaintext, 'the genuine message');
    assert.equal(await seen(w.B, w.aliceKeyId), 1);
});

test('C4-2: KNOWN, ACCEPTED LIMITATION (documented): after the seen-set evicted a nonce, a hostile SERVER can replay the stored message under the ORIGINAL sender_id once; a MEMBER replaying it under his own id is still rejected', async () => {
    const w = await world();

    // Alice sends 30 messages, Bob accepts them all (30 nonces claimed)
    const envs = [];
    for (let i = 0; i < 30; i++) {
        const env = await send(w.A, G1, `message ${i}`);
        envs.push(env);
        await open(w.B, G1, env, 100 + i, { expectedSenderId: 1 });
    }
    assert.equal(await seen(w.B, w.aliceKeyId), 30);

    // the soft cap evicts the OLDEST claims (here forced with a tiny cap)
    await w.B.run(() => store.pruneSeen(w.aliceKeyId, 10));
    assert.ok((await seen(w.B, w.aliceKeyId)) < 30, 'control: the oldest rows were evicted');

    // message 0 is evicted, message 29 is retained
    // (a) while retained: any other ref conflicts, the same ref is idempotent
    await assert.rejects(() => open(w.B, G1, envs[29], 999, { expectedSenderId: 1 }), (e) => e.name === 'ReplayedMessageError', 'retained nonce: replay rejected');
    assert.equal((await open(w.B, G1, envs[29], 129, { expectedSenderId: 1 })).plaintext, 'message 29');

    // (b) a MEMBER (Mallory) re-posting the evicted message under HER OWN sender_id: rejected,
    //     because the verified owner (Alice) differs. The evicted nonce is NOT consumed.
    await assertUnverified(open(w.B, G1, envs[0], 777, { expectedSenderId: 3 }), 'sender-mismatch', 'member replay after eviction');

    // (c) RESIDUAL WINDOW: the hostile server replays the stored ciphertext under the original
    //     sender_id (it controls sender_id). The nonce was forgotten, so it is accepted ONCE.
    const replay = await open(w.B, G1, envs[0], 888, { expectedSenderId: 1 });
    assert.equal(replay.plaintext, 'message 0', 'KNOWN LIMITATION: an evicted nonce replayed by the server under the original sender_id is accepted once');

    // ... and only once: it was re-claimed, a further replay is rejected again
    await assert.rejects(() => open(w.B, G1, envs[0], 889, { expectedSenderId: 1 }), (e) => e.name === 'ReplayedMessageError');
});

/* ======================================================= 2. swapped KDM rows */

test('C4-3: the server swaps, reorders, duplicates or relabels KDM rows: ownership follows the pairwise unwrap, never the row\'s claims', async () => {
    const [alice, bob, mallory] = await Promise.all([user(1), user(2), user(3)]);
    const A = await makeDevice(alice);
    const B = await makeDevice(bob);
    const M = await makeDevice(mallory);

    // Alice and Mallory each mint a key and wrap it for Bob (rows as the server stores them)
    const aPending = await A.run(() => rotateSenderKey(alice, G1, 0, [1, 2, 3], { deferPersist: true }));
    await A.run(() => aPending.commit());
    const mPending = await M.run(() => rotateSenderKey(mallory, G1, 0, [1, 2, 3], { deferPersist: true }));
    await M.run(() => mPending.commit());
    const aForBob = aPending.recipients.find((r) => r.user_id === 2).wrapped_key;
    const mForBob = mPending.recipients.find((r) => r.user_id === 2).wrapped_key;

    const aliceMsg = await send(A, G1, 'alice speaking');
    const malloryMsg = await send(M, G1, 'mallory speaking');

    // (a) relabelled: Mallory's valid KDM presented as from Alice, and Alice's as from Mallory
    for (const row of [kdmRow(1, 2, 0, mForBob, G1, 5), kdmRow(3, 2, 0, aForBob, G1, 6)]) {
        await B.run(async () => {
            await assert.rejects(() => kdm.receiveKdm(bob, row), 'the pairwise key of the CLAIMED sender cannot unwrap it');
            assert.deepEqual(await store.getAllSenderKeysForGroup(G1), [], 'nothing stored');
        });
    }

    // (b) the server withholds Alice's row and shows only Mallory's (unmodified): the owner is Mallory,
    //     and Alice's message stays "waiting for key" instead of being attributed to anyone
    await B.run(async () => {
        await kdm.receiveKdm(bob, kdmRow(3, 2, 0, mForBob, G1, 7));
        const rows = await store.getAllSenderKeysForGroup(G1);
        assert.deepEqual(rows.map((r) => r.ownerUserId), [3]);
    });
    await assert.rejects(() => open(B, G1, aliceMsg, 1, { expectedSenderId: 1 }), (e) => e.name === 'MissingSenderKeyError' && !e.permanent);
    const m = await open(B, G1, malloryMsg, 2, { expectedSenderId: 3 });
    assert.equal(m.ownerUserId, 3);
    // a message signed by Mallory but presented by the server as Alice's is refused
    await assertUnverified(open(B, G1, malloryMsg, 3, { expectedSenderId: 1 }), 'sender-mismatch', 'Mallory\'s message labelled as Alice');

    // (c) reordered + duplicated delivery of both rows: the final state is the same
    await B.run(async () => {
        for (const row of [kdmRow(1, 2, 0, aForBob, G1, 9), kdmRow(3, 2, 0, mForBob, G1, 8), kdmRow(1, 2, 0, aForBob, G1, 9), kdmRow(3, 2, 0, mForBob, G1, 8)]) {
            await kdm.receiveKdm(bob, row);
        }
        const rows = (await store.getAllSenderKeysForGroup(G1)).sort((x, y) => x.ownerUserId - y.ownerUserId);
        assert.deepEqual(rows.map((r) => [r.ownerUserId, r.isMine]), [[1, 0], [3, 0]]);
    });
    assert.equal((await open(B, G1, aliceMsg, 11, { expectedSenderId: 1 })).ownerUserId, 1);
    assert.equal((await open(B, G1, malloryMsg, 2, { expectedSenderId: 3 })).ownerUserId, 3); // same message id: idempotent

    // (d) Mallory forwarding Alice's unwrapped root + public key in her OWN KDM yields her own owner
    const stolen = await M.run(async () => kdm.unwrapKdmDetailed(
        aPending.recipients.find((r) => r.user_id === 3).wrapped_key, { groupId: G1, fromUserId: 1, toUserId: 3, epoch: 0 }));
    sessionProvider.setCurrentActor(3);
    const key = await sessionProvider.getOrCreateGroupKdmKey(2);
    const env = await encryptBytes(key, Uint8Array.from([...stolen.rawBytes, ...stolen.signPub]), undefined, kdm.kdmAad({ groupId: G1, fromUserId: 3, toUserId: 2, epoch: 0 }));
    const forwarded = JSON.stringify({ v: 2, alg: 'AES-GCM', iv: env.iv, ciphertext: env.ciphertext });
    const { senderKeyId: forwardedId } = await B.run(() => kdm.receiveKdm(bob, kdmRow(3, 2, 0, forwarded, G1, 13)));
    assert.notEqual(forwardedId, w0(aliceMsg).senderKeyId);
    assert.equal((await B.run(() => store.getSenderKeyRecord(forwardedId))).ownerUserId, 3);
});

function w0(env) { return JSON.parse(env); }

/* ====================================== 3. removed / rejoined members, rotation */

test('C4-4: a removed member cannot forge messages from the members\' keys, not before and not after the rotation that follows her removal', async () => {
    const w = await world();
    const oldEnv = await send(w.A, G1, 'before removal');

    // Mallory is removed: Alice rotates (epoch 1) and distributes ONLY to Alice and Bob
    const next = await rotateAndDeliver(w.A, 1, [w.A, w.B], G1);
    const afterEnv = await send(w.A, G1, 'after removal');

    // she can neither read the new key's messages ...
    await assert.rejects(() => open(w.M, G1, afterEnv, 1, { expectedSenderId: 1 }), (e) => e.name === 'MissingSenderKeyError');

    // ... nor forge as Alice with the old key she still holds (she cannot sign as Alice)
    const forgedOld = await forgeWithKey(w.M, w.aliceKeyId, G1, 'forged with the old key');
    await assertUnverified(open(w.B, G1, forgedOld, 2, { expectedSenderId: 1 }), 'bad-signature', 'forged under the OLD key id');
    // ... nor under the NEW key id (she has no root; any guess fails the signature check)
    const guess = forgedOld;
    await assertUnverified(open(w.B, G1, { ...guess, senderKeyId: next.senderKeyId }, 3, { expectedSenderId: 1 }), 'bad-signature', 'forged under the NEW key id');

    // her signature on Bob's key ids cannot be passed off either
    const bobKey = (await w.B.run(() => sk.getMySenderKey(w.bob, G1))).senderKeyId;
    const forgedAsBob = await forgeWithKey(w.M, bobKey, G1, 'forged as bob');
    await assertUnverified(open(w.A, G1, forgedAsBob, 4, { expectedSenderId: 2 }), 'bad-signature', 'forged as Bob');

    assert.equal(await seen(w.B, w.aliceKeyId), 0);
    assert.equal((await open(w.B, G1, oldEnv, 5, { expectedSenderId: 1 })).plaintext, 'before removal', 'history under the old key still verifies');
});

test('C4-5: KNOWN rule (existing, documented): the client has no membership/epoch cut-off, so a message that is validly signed by a removed member\'s OWN key is attributed to HER (never to someone else); the server is the membership gate', async () => {
    const w = await world();
    await rotateAndDeliver(w.A, 1, [w.A, w.B], G1); // Mallory removed

    // a hostile server inserts a message from the removed Mallory, signed with her own (old) key
    const fromRemoved = await send(w.M, G1, 'i was removed but my key still signs');
    const r = await open(w.B, G1, fromRemoved, 1, { expectedSenderId: 3 });
    assert.equal(r.ownerUserId, 3, 'attributed to Mallory, the true author');

    // it can never be passed off as a member's message
    await assertUnverified(open(w.B, G1, fromRemoved, 2, { expectedSenderId: 1 }), 'sender-mismatch');
    await assertUnverified(open(w.B, G1, fromRemoved, 3, { expectedSenderId: 2 }), 'sender-mismatch');
});

test('C4-6: a member who left and rejoined (epoch change): old forgeries stay forgeries, her old and new keys both verify as hers, and she reads only what was distributed to her', async () => {
    const w = await world();
    const before = await send(w.M, G1, 'mallory, first stay');
    await rotateAndDeliver(w.A, 1, [w.A, w.B], G1);        // she leaves
    const whileAway = await send(w.A, G1, 'while mallory is away');
    const rejoin = await rotateAndDeliver(w.A, 2, [w.A, w.B, w.M], G1); // she rejoins: new epoch for everyone
    const afterRejoin = await send(w.A, G1, 'after the rejoin');
    const mNew = await rotateAndDeliver(w.M, 1, [w.A, w.B, w.M], G1);
    const mAfter = await send(w.M, G1, 'mallory, second stay');

    // she reads the post-rejoin message, but not the one sent while she was away
    assert.equal((await open(w.M, G1, afterRejoin, 20, { expectedSenderId: 1 })).plaintext, 'after the rejoin');
    await assert.rejects(() => open(w.M, G1, whileAway, 21, { expectedSenderId: 1 }), (e) => e.name === 'MissingSenderKeyError');

    // her messages under BOTH of her keys verify as hers
    assert.equal((await open(w.B, G1, before, 30, { expectedSenderId: 3 })).ownerUserId, 3);
    assert.equal((await open(w.B, G1, mAfter, 31, { expectedSenderId: 3 })).ownerUserId, 3);
    assert.notEqual(JSON.parse(before).senderKeyId, JSON.parse(mAfter).senderKeyId);

    // forging as Alice stays impossible: with the old key she kept, and with the key she was given again
    for (const keyId of [w.aliceKeyId, rejoin.senderKeyId]) {
        const forged = await forgeWithKey(w.M, keyId, G1, 'forged after rejoining', { counter: 7000 });
        await assertUnverified(open(w.B, G1, forged, 40, { expectedSenderId: 1 }), 'bad-signature', `forged under ${keyId.slice(0, 6)}`);
    }
    assert.ok(mNew.senderKeyId);
});

test('C4-7: rotation rules, stated: old keys keep verifying their own messages (even a late in-flight one); nothing can be signed with an old key once its private key is dropped; a forger holding only the old ROOT cannot', async () => {
    const w = await world();

    // an in-flight send captured the old key before the rotation
    const inFlight = await w.A.run(() => sk.getMySenderKey(w.alice, G1));
    await rotateAndDeliver(w.A, 1, [w.A, w.B, w.M], G1);

    // RULE 1: the rotation dropped the old PRIVATE signing key from disk (and from the cache) ...
    const oldRow = await w.A.run(() => store.getSenderKeyRecord(inFlight.senderKeyId));
    assert.equal(oldRow.signKeyWrapped, undefined);
    assert.equal((await w.A.run(() => sk.getMySenderKey(w.alice, G1))).senderKeyId !== inFlight.senderKeyId, true);

    // RULE 2: ... but the handle the in-flight send already holds still signs, and the late message is
    // accepted as Alice's: there is NO epoch cut-off on receive (scheduled rotation / a cut-off is a C5 proposal)
    const nonce = mc.nonceFromCounter(4242, crypto.getRandomValues(new Uint8Array(4)));
    const late = await w.A.run(async () => {
        const { iv, ciphertext } = await encryptBytes(inFlight.cryptoKey, new TextEncoder().encode('late, old key'), nonce, mc.messageAad(G1, inFlight.senderKeyId, 4242, nonce));
        const sig = await signing.signMessage(inFlight.signKey, {
            groupId: G1, senderKeyId: inFlight.senderKeyId, counter: 4242, iv: nonce, ciphertext: codec.base64ToBytes(ciphertext), replyToId: null, attachment: new Uint8Array(0),
        });
        return { v: 2, alg: 'AES-GCM', senderKeyId: inFlight.senderKeyId, counter: 4242, iv, ciphertext, reply_to_id: null, sig: codec.bytesToBase64(sig) };
    });
    const r = await open(w.B, G1, late, 1, { expectedSenderId: 1 });
    assert.deepEqual([r.plaintext, r.ownerUserId], ['late, old key', 1]);

    // RULE 3: the old key's history still verifies after the rotation
    // RULE 4: whoever holds only the old ROOT (Mallory) cannot produce a message under it
    const forged = await forgeWithKey(w.M, inFlight.senderKeyId, G1, 'forged under the rotated key', { counter: 8000 });
    await assertUnverified(open(w.B, G1, forged, 2, { expectedSenderId: 1 }), 'bad-signature');
});

/* ===================================================== 4. cross-group replay */

test('C4-8: a valid signed envelope replayed into another group the same sender belongs to, or into one he does not belong to, fails (groupId and senderKeyId are signed) and claims nothing', async () => {
    // Alice, Bob, Mallory share G1 and G2; G3 has Bob and Mallory only (Alice is not a member)
    const [alice, bob, mallory] = await Promise.all([user(1), user(2), user(3)]);
    const A = await makeDevice(alice);
    const B = await makeDevice(bob);
    const M = await makeDevice(mallory);
    const k1 = await rotateAndDeliver(A, 0, [A, B, M], G1);
    const k2 = await rotateAndDeliver(A, 0, [A, B, M], G2);
    await rotateAndDeliver(M, 0, [A, B, M], G3);
    await rotateAndDeliver(B, 0, [A, B, M], G3);

    const inG1 = await send(A, G1, 'said in group one');
    const inG2 = await send(A, G2, 'said in group two');
    assert.notEqual(k1.senderKeyId, k2.senderKeyId, 'a key is per group');

    const env1 = JSON.parse(inG1);
    const attempts = {
        'G1 envelope into G2 (same sender, both groups)': [G2, env1],
        'G1 envelope into G3 (sender not a member)': [G3, env1],
        'G1 envelope into G2 with the G2 key id substituted': [G2, { ...env1, senderKeyId: k2.senderKeyId }],
        'G2 envelope into G1 with the G1 key id substituted': [G1, { ...JSON.parse(inG2), senderKeyId: k1.senderKeyId }],
    };

    for (const [name, [group, env]] of Object.entries(attempts)) {
        await assertUnverified(open(B, group, env, 50, { expectedSenderId: 1 }), 'bad-signature', name);
    }

    assert.equal(await seen(B, k1.senderKeyId), 0);
    assert.equal(await seen(B, k2.senderKeyId), 0);

    // control: each envelope is accepted in its OWN group
    assert.equal((await open(B, G1, inG1, 60, { expectedSenderId: 1 })).plaintext, 'said in group one');
    assert.equal((await open(B, G2, inG2, 61, { expectedSenderId: 1 })).plaintext, 'said in group two');
});
