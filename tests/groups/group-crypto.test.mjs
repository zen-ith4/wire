// tests/groups/group-crypto.test.mjs
//
// Run with:
//   node --experimental-test-module-mocks --test tests/groups/*.test.mjs
//
// Exercises the actual public/js/crypto/groups/* modules (real
// X25519/HKDF/AES-GCM via Node's WebCrypto, real Web-Locks-shaped
// mutual exclusion, real fake-indexeddb persistence) against the
// acceptance checklist in plan_prompt.md section 6, to the extent
// Phase 2 (crypto core, no UI/server) can validate it standalone.

import { test, mock, before, beforeEach } from 'node:test';
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

const identities = new Map(); // userId -> identity
const sessionProvider = makeSessionKeyProvider(identities);

mock.module('../../public/js/crypto/keys/session.js', {
    namedExports: {
        getOrCreateSessionKey: (peerUserId) => sessionProvider.getOrCreateSessionKey(peerUserId),
    },
});

// Imported *after* the mock is registered, per node:test's module
// mocking contract — dynamic import so this file can stay ESM
// top-level-await-free.
const { generateSenderKey, getMySenderKey } =
    await import('../../public/js/crypto/groups/sender-key.js');
const { rotateSenderKey } =
    await import('../../public/js/crypto/groups/rotation.js');
const { receiveKdm } =
    await import('../../public/js/crypto/groups/kdm.js');
const { encryptGroupMessage, decryptGroupMessage, MissingSenderKeyError } =
    await import('../../public/js/crypto/groups/message-crypto.js');
const { reserveNextCounter } =
    await import('../../public/js/crypto/groups/nonce-lock.js');

/**
 * A "device": its own storage (own IndexedDB), and an identity it's
 * logged in as. Multiple devices can share the same identity
 * (self-KDM / multi-device tests) or each have their own (normal
 * multi-user tests).
 */
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

async function ensureUsers(...userIds) {
    for (const id of userIds) {
        if (!identities.has(id)) {
            identities.set(id, await makeTestIdentity(id));
        }
    }
    return userIds.map((id) => identities.get(id));
}

/**
 * Rotates a Sender Key as `ownerDevice` and lands the resulting
 * KDMs on every device in `recipientDevices` (which must include
 * ownerDevice itself for a faithful self-KDM — callers pass it
 * explicitly, same as the real recipient list would).
 */
async function rotateAndDistribute(ownerDevice, epoch, recipientDevices) {
    const recipientUserIds = recipientDevices.map((d) => d.identity.userId);

    const { recipients } = await ownerDevice.run(() =>
        rotateSenderKey(ownerDevice.identity, GROUP_ID, epoch, recipientUserIds)
    );

    for (const device of recipientDevices) {
        const mine = recipients.find(
            (r) => r.user_id === device.identity.userId
        );
        assert.ok(mine, 'every recipient device gets a KDM row');

        await device.run(() =>
            receiveKdm(device.identity, {
                group_id: GROUP_ID,
                from_user_id: ownerDevice.identity.userId,
                epoch,
                wrapped_key: mine.wrapped_key,
            })
        );
    }
}

test('encrypt/decrypt round trip: recipient decrypts what the sender sent', async () => {
    const [alice, bob] = await ensureUsers(1, 2);
    const aliceDevice = await makeDevice(alice);
    const bobDevice = await makeDevice(bob);

    await rotateAndDistribute(aliceDevice, 0, [aliceDevice, bobDevice]);

    const envelope = await aliceDevice.run(() =>
        encryptGroupMessage(alice, GROUP_ID, 'hello group')
    );

    const plaintext = await bobDevice.run(() =>
        decryptGroupMessage(bob, envelope)
    );

    assert.equal(plaintext, 'hello group');
});

test('wrong Sender Key / tampered ciphertext fails authentication, does not throw a decodable wrong answer', async () => {
    const [alice, bob, mallory] = await ensureUsers(11, 12, 13);
    const aliceDevice = await makeDevice(alice);
    const bobDevice = await makeDevice(bob);
    const malloryDevice = await makeDevice(mallory);

    // Mallory gets her OWN unrelated Sender Key for the same group id
    // (as if she were in a different group that happens to share the
    // numeric id in this synthetic test) — the point is she never
    // received Alice's KDM.
    await rotateAndDistribute(aliceDevice, 0, [aliceDevice, bobDevice]);
    await rotateAndDistribute(malloryDevice, 0, [malloryDevice]);

    const envelope = await aliceDevice.run(() =>
        encryptGroupMessage(alice, GROUP_ID, 'secret')
    );

    await assert.rejects(
        () => malloryDevice.run(() => decryptGroupMessage(mallory, envelope)),
        MissingSenderKeyError,
        'Mallory never got a KDM for this senderKeyId at all'
    );

    // Bob (who *does* have the key) still can't be fooled by a
    // bit-flipped ciphertext.
    const tampered = JSON.parse(envelope);
    tampered.ciphertext = tampered.ciphertext.slice(0, -4) + 'AAAA';

    await assert.rejects(
        () => bobDevice.run(() => decryptGroupMessage(bob, JSON.stringify(tampered))),
        /authentication failed/
    );
});

test('self-KDM: a second device of the same user decrypts messages that OTHER device sent', async () => {
    const [alice] = await ensureUsers(21);

    const deviceA = await makeDevice(alice);
    const deviceB = await makeDevice(alice); // same identity, separate storage

    // Device A is the one that first sends in this group — it
    // generates the Sender Key and, per plan_prompt.md 2.1, must
    // include its own user_id in the recipient list (there's no
    // device dimension anywhere in this protocol — a KDM addressed
    // to "alice" is one row that every device alice unlocks her
    // identity on can independently decrypt).
    const { recipients } = await deviceA.run(() =>
        rotateSenderKey(alice, GROUP_ID, 0, [alice.userId])
    );

    const selfKdm = recipients.find((r) => r.user_id === alice.userId);
    assert.ok(selfKdm, 'rotation produced a self-addressed KDM');

    // Both devices are "alice" as far as the protocol is concerned,
    // so both independently consume the exact same KDM row — this
    // is the whole point of 2.1: no device-specific fan-out needed.
    await deviceA.run(() =>
        receiveKdm(alice, {
            group_id: GROUP_ID,
            from_user_id: alice.userId,
            epoch: 0,
            wrapped_key: selfKdm.wrapped_key,
        })
    );

    await deviceB.run(() =>
        receiveKdm(alice, {
            group_id: GROUP_ID,
            from_user_id: alice.userId,
            epoch: 0,
            wrapped_key: selfKdm.wrapped_key,
        })
    );

    const envelope = await deviceA.run(() =>
        encryptGroupMessage(alice, GROUP_ID, 'from my laptop')
    );

    // Device B never generated anything itself — everything it knows
    // about this Sender Key came from consuming that one KDM row
    // above, into its own separate storage.
    const plaintext = await deviceB.run(() =>
        decryptGroupMessage(alice, envelope)
    );

    assert.equal(plaintext, 'from my laptop');
});

test('removed member cannot decrypt messages sent after rotation; remaining members can', async () => {
    const [alice, bob, carol] = await ensureUsers(31, 32, 33);
    const aliceDevice = await makeDevice(alice);
    const bobDevice = await makeDevice(bob);
    const carolDevice = await makeDevice(carol);

    // epoch 0: everyone in.
    await rotateAndDistribute(aliceDevice, 0, [aliceDevice, bobDevice, carolDevice]);

    const beforeRemoval = await aliceDevice.run(() =>
        encryptGroupMessage(alice, GROUP_ID, 'while carol was still here')
    );

    assert.equal(
        await carolDevice.run(() => decryptGroupMessage(carol, beforeRemoval)),
        'while carol was still here'
    );

    // Carol is removed -> every remaining member rotates to epoch 1
    // and redistributes to {alice, bob} only (Carol is deliberately
    // excluded from the recipient list here — that's the server's
    // job in reality, enforced by group_members; this test asserts
    // the crypto-layer consequence of that exclusion).
    await rotateAndDistribute(aliceDevice, 1, [aliceDevice, bobDevice]);

    const afterRemoval = await aliceDevice.run(() =>
        encryptGroupMessage(alice, GROUP_ID, 'carol should not see this')
    );

    assert.equal(
        await bobDevice.run(() => decryptGroupMessage(bob, afterRemoval)),
        'carol should not see this'
    );

    await assert.rejects(
        () => carolDevice.run(() => decryptGroupMessage(carol, afterRemoval)),
        MissingSenderKeyError,
        'Carol never received a KDM for epoch 1, so she has no way to decrypt it'
    );
});

test('a newly added member gets no history: cannot decrypt pre-join messages, can decrypt post-join ones', async () => {
    const [alice, bob, dave] = await ensureUsers(41, 42, 43);
    const aliceDevice = await makeDevice(alice);
    const bobDevice = await makeDevice(bob);
    const daveDevice = await makeDevice(dave);

    await rotateAndDistribute(aliceDevice, 0, [aliceDevice, bobDevice]);

    const beforeDaveJoined = await aliceDevice.run(() =>
        encryptGroupMessage(alice, GROUP_ID, 'old message, no backfill for dave')
    );

    await assert.rejects(
        () => daveDevice.run(() => decryptGroupMessage(dave, beforeDaveJoined)),
        MissingSenderKeyError
    );

    // Dave joins. plan_prompt.md Section 3 step 5 says existing
    // members hand a newcomer a KDM for the *current* key only, with
    // no new rotation needed for a pure add. Doing that without a
    // rotation requires the distributing member to re-wrap from the
    // still-in-scope raw bytes at generation/receipt time (Sender
    // Keys are kept non-extractable once imported — 2.3 — so there's
    // no way to re-export raw bytes from a CryptoKey later). That
    // "hand the raw bytes to kdm.js again for one more recipient
    // before they go out of scope" orchestration is exactly what
    // rotation.js's rawBytes-then-zero flow already supports; wiring
    // *when* to call it for a plain add (vs. a full rotation) is a
    // client orchestration decision that belongs with the rest of
    // Phase 3's membership-change handling, not a new crypto
    // primitive. What this test validates at the crypto-core level
    // is the property Phase 3 depends on: a member added to the
    // recipient list of a rotation gets the key, a member who isn't
    // in a message's Sender Key epoch never does — proven twice over
    // already (no-backfill above, and the "removed member" test's
    // mirror image below). Confirm the forward direction here too,
    // via the same rotation machinery a plain add would reuse:
    await rotateAndDistribute(aliceDevice, 1, [aliceDevice, bobDevice, daveDevice]);

    const afterDaveJoined = await aliceDevice.run(() =>
        encryptGroupMessage(alice, GROUP_ID, 'new message, dave should see this')
    );

    assert.equal(
        await daveDevice.run(() => decryptGroupMessage(dave, afterDaveJoined)),
        'new message, dave should see this'
    );

    assert.equal(
        await bobDevice.run(() => decryptGroupMessage(bob, afterDaveJoined)),
        'new message, dave should see this'
    );
});

test('nonce-lock: concurrent reservations on the same Sender Key never collide or skip', async () => {
    const [alice] = await ensureUsers(51);
    const device = await makeDevice(alice);

    await device.run(() => rotateSenderKey(alice, GROUP_ID, 0, [alice.userId]));
    const mine = await device.run(() => getMySenderKey(alice, GROUP_ID));

    const CONCURRENT_SENDS = 25;

    // Simulate N tabs of the same device all calling
    // reserveNextCounter at once for the SAME Sender Key — the exact
    // scenario plan_prompt.md 2.2 calls out.
    const reserved = await device.run(() =>
        Promise.all(
            Array.from({ length: CONCURRENT_SENDS }, () =>
                reserveNextCounter(mine.senderKeyId)
            )
        )
    );

    const unique = new Set(reserved);
    assert.equal(unique.size, CONCURRENT_SENDS, 'no two concurrent sends got the same counter value');

    const sorted = [...reserved].sort((a, b) => a - b);
    assert.deepEqual(
        sorted,
        Array.from({ length: CONCURRENT_SENDS }, (_, i) => i),
        'counters are a contiguous 0..N-1 range with no gaps despite the race'
    );
});

test('rotation starts a fresh counter at 0 under the new key\'s own lock — no continuity with the old key', async () => {
    const [alice] = await ensureUsers(61);
    const device = await makeDevice(alice);

    await device.run(() => rotateSenderKey(alice, GROUP_ID, 0, [alice.userId]));
    const keyEpoch0 = await device.run(() => getMySenderKey(alice, GROUP_ID));

    // Send a few messages under epoch 0 so its counter moves past 0.
    await device.run(async () => {
        for (let i = 0; i < 5; i++) {
            await reserveNextCounter(keyEpoch0.senderKeyId);
        }
    });

    // Rotate — new epoch, new (deterministic-but-different) senderKeyId.
    await device.run(() => rotateSenderKey(alice, GROUP_ID, 1, [alice.userId]));
    const keyEpoch1 = await device.run(() => getMySenderKey(alice, GROUP_ID));

    assert.notEqual(keyEpoch1.senderKeyId, keyEpoch0.senderKeyId);

    const firstCounterUnderNewKey = await device.run(() =>
        reserveNextCounter(keyEpoch1.senderKeyId)
    );

    assert.equal(firstCounterUnderNewKey, 0, 'new key starts its own counter at 0');
});

test('encrypted message envelope never contains the plaintext as a substring (sanity check on the ciphertext, not just round-trip)', async () => {
    const [alice, bob] = await ensureUsers(71, 72);
    const aliceDevice = await makeDevice(alice);
    const bobDevice = await makeDevice(bob);

    await rotateAndDistribute(aliceDevice, 0, [aliceDevice, bobDevice]);

    const secret = 'the eagle flies at midnight';
    const envelope = await aliceDevice.run(() =>
        encryptGroupMessage(alice, GROUP_ID, secret)
    );

    assert.ok(!envelope.includes(secret), 'plaintext must not leak into the stored envelope');

    const plaintext = await bobDevice.run(() => decryptGroupMessage(bob, envelope));
    assert.equal(plaintext, secret);
});
