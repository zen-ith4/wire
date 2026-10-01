// tests/groups/group-multidevice.test.mjs
//
// Group/E2EE audit: multi-device and multi-tab behaviour of Sender Keys
// and the KDM mailbox. Real server + real Socket.IO + the unmodified
// client (see _scenario.mjs). Assertions read rendered DOM and the real
// database; nothing about app logic is mocked.
//
//   MD-1  two devices of one account never share a senderKeyId
//   MD-2  a second device does not make earlier messages unreadable
//   MD-3  two devices never encrypt under the same (key, nonce)
//         (proved with a keystream-reuse check on the stored ciphertexts)
//   MD-4  a second device can read what other members sent before it joined
//   MD-5  two tabs racing to create the first key do not corrupt each other
//   MD-6  a failed KDM POST is retried instead of leaving an orphan key
//
// See docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md for the protocol analysis.

import './_env.mjs';

import { test, after, afterEach } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

const scenarios = [];
after(async () => { for (const s of scenarios) await s.stop(); });
afterEach(() => { shared?.retireExtras(); });

// The sign-up rate limiter caps registrations per process (see
// _scenario.mjs), so every test here shares ONE server and one pair of
// accounts and isolates itself with a fresh group.
let shared = null;
async function scenario() {
    if (!shared) {
        shared = await createScenario(['alice', 'bob', 'dana']);
        scenarios.push(shared);
    }
    return shared;
}

const b64 = (s) => Buffer.from(s, 'base64');
const xor = (a, b) => Buffer.from(a.subarray(0, Math.min(a.length, b.length)).map((v, i) => v ^ b[i]));

// ---------------------------------------------------------------
// Shared setup: Alice (device 1) + Bob in one group, both open.
// ---------------------------------------------------------------
async function aliceBobGroup(name) {
    const S = await scenario();
    const { alice, bob } = S.users;
    const group = await S.createGroup(alice, name);
    await S.addMember(alice, group.id, bob);
    await S.mount(alice);
    await S.open(alice, group.id);
    await S.mount(bob);
    await S.open(bob, group.id);
    return { S, alice, bob, group };
}

test('MD-1: two devices of the same account never derive the same senderKeyId', async () => {
    const { S, alice, bob, group } = await aliceBobGroup('md1');

    await S.send(alice, 'from device one');
    const dev2 = await S.addDevice(alice);
    await S.open(dev2, group.id);
    await S.send(dev2, 'from device two');

    await S.waitFor(bob, () => S.bubbles(bob).includes('from device two'));

    const ids = new Set(S.envelopes(group.id).filter((e) => e.sender_id === alice.ident.id).map((e) => e.env.senderKeyId));
    assert.equal(
        ids.size, 2,
        `two physical devices produced ${ids.size} distinct senderKeyId(s): ${JSON.stringify([...ids])} ` +
        '(id must not be derivable from (group, owner, epoch) alone)'
    );
});

test('MD-2: adding a second device does not make earlier messages unreadable', async () => {
    const { S, alice, bob, group } = await aliceBobGroup('md2');

    const before = `sent before device two existed ${Date.now()}`;
    await S.send(alice, before);
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes(before)), 'control: Bob reads it initially');

    const dev2 = await S.addDevice(alice);
    await S.open(dev2, group.id);
    await sleep(600); // Bob reacts to device two's KDM fan-out over the real socket

    // Bob reloads the conversation from scratch: history must still be readable.
    bob.actor.use();
    bob.actor.window.dispatchEvent(new bob.actor.window.Event('wire:logout'));
    await S.open(bob, group.id);
    assert.ok(S.bubbles(bob).includes(before), `earlier message unreadable for Bob: ${JSON.stringify(S.bubbles(bob))}`);

    // ...and so must messages sent afterwards from EITHER device.
    await S.send(dev2, 'after, from device two');
    await S.send(alice, 'after, from device one');
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('after, from device two')), 'device two message unreadable');
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('after, from device one')), 'device one message unreadable');
});

test('MD-3: two devices never encrypt with the same (key, nonce) - keystream reuse check', async () => {
    const { S, alice, bob, group } = await aliceBobGroup('md3');

    // Equal-length plaintexts so a keystream-reuse check is exact.
    const d1 = ['AAAAAAAA-01', 'AAAAAAAA-02', 'AAAAAAAA-03'];
    const d2 = ['BBBBBBBB-01', 'BBBBBBBB-02'];

    await S.send(alice, d1[0]);
    const dev2 = await S.addDevice(alice);
    await S.open(dev2, group.id);
    await sleep(600);
    await S.send(dev2, d2[0]);
    await S.send(dev2, d2[1]);
    await S.send(alice, d1[1]);
    await S.send(alice, d1[2]);

    const rows = S.envelopes(group.id);
    assert.equal(rows.length, 5, 'control: five messages stored');

    const plaintextByCt = new Map();
    // (plaintexts are known to the test; map by insertion order sent)
    const sentOrder = [d1[0], d2[0], d2[1], d1[1], d1[2]];
    rows.forEach((r, i) => plaintextByCt.set(r.id, sentOrder[i]));

    const bySlot = new Map();
    for (const r of rows) {
        const slot = `${r.env.senderKeyId}:${r.env.iv}`;
        bySlot.set(slot, [...(bySlot.get(slot) || []), r]);
    }
    const collisions = [...bySlot.values()].filter((g) => g.length > 1);

    const proofs = collisions.map(([x, y]) => {
        const cx = b64(x.env.ciphertext), cy = b64(y.env.ciphertext);
        const px = Buffer.from(plaintextByCt.get(x.id)), py = Buffer.from(plaintextByCt.get(y.id));
        const n = Math.min(px.length, py.length);
        const leak = xor(cx.subarray(0, n), cy.subarray(0, n)).equals(xor(px, py));
        return leak
            ? `KEYSTREAM REUSE PROVEN (c1^c2 == p1^p2) for messages ${x.id}&${y.id} under senderKeyId ${x.env.senderKeyId.slice(0, 12)}...`
            : `same senderKeyId+iv for messages ${x.id}&${y.id} but different keys (collision without keystream reuse)`;
    });

    assert.deepEqual(proofs, [], `(senderKeyId, iv) collisions across devices: ${JSON.stringify(proofs, null, 2)}`);

    // and every message is still readable by Bob
    for (const text of sentOrder) {
        assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes(text)), `Bob cannot read ${text}`);
    }
});

test('MD-4: a second device can read messages other members sent before it existed', async () => {
    const { S, alice, bob, group } = await aliceBobGroup('md4');

    // Alice's first device is online and drains Bob's key.
    await S.send(bob, 'bob speaks first');
    assert.ok(await S.waitFor(alice, () => S.bubbles(alice).includes('bob speaks first')), 'control: Alice device one reads Bob');

    // Alice signs in on a phone afterwards.
    const dev2 = await S.addDevice(alice, 'phone');
    await S.open(dev2, group.id);

    assert.ok(
        S.bubbles(dev2).includes('bob speaks first'),
        `second device cannot read Bob's earlier message (its KDM was already consumed by device one): ${JSON.stringify(S.bubbles(dev2))}`
    );

    // ...and Bob's later messages (same key, no new KDM will ever be sent).
    await S.send(bob, 'bob speaks again');
    assert.ok(await S.waitFor(dev2, () => S.bubbles(dev2).includes('bob speaks again')), 'second device cannot read Bob live either');
});

test('MD-5: two tabs racing to create the first key do not corrupt each other', async () => {
    const S = await scenario();
    // Dana is NOT connected while the group is set up, so no event-driven
    // rotation pre-creates her key: the first key really is minted by the
    // two racing tabs below. (Alice's primary device is live in this shared
    // scenario and would create hers from the membership event, which would
    // make the race vanish and the test vacuous.)
    const { dana, bob } = S.users;
    const group = await S.createGroup(dana, 'md5');
    await S.addMember(dana, group.id, bob);
    await S.mount(bob);
    await S.open(bob, group.id);

    await S.mount(dana);
    const tab2 = await S.addTab(dana);

    // Both tabs open the group at the same moment: both see "no key yet".
    await Promise.all([S.open(dana, group.id), S.open(tab2, group.id)]);
    await sleep(500);

    await S.send(dana, 'tab one says hi');
    await S.send(tab2, 'tab two says hi');

    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('tab one says hi')), 'tab one message unreadable for Bob');
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('tab two says hi')), 'tab two message unreadable for Bob');

    // A shared profile has ONE local key store: nonces must never repeat.
    const seen = new Set();
    for (const { env } of S.envelopes(group.id)) {
        const slot = `${env.senderKeyId}:${env.iv}`;
        assert.ok(!seen.has(slot), `nonce reuse under one senderKeyId across tabs: ${slot}`);
        seen.add(slot);
    }

    // Fan-out hygiene: the race must not have produced two rotations.
    const fanouts = S.server.db.prepare(
        'SELECT COUNT(*) c FROM group_key_distributions WHERE group_id = ? AND from_user_id = ? AND to_user_id = ?'
    ).get(group.id, dana.ident.id, bob.ident.id).c;
    assert.equal(fanouts, 1, `tabs created ${fanouts} Sender Keys for one browser profile (duplicate key generation)`);
});

test('MD-6: a KDM POST that fails is retried; no orphan key is left behind', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;
    await S.mount(alice);
    await S.mount(bob);
    const group = await S.createGroup(alice, 'md6');

    // The network drops exactly once, during the key distribution that
    // Alice's (already connected) device performs when Bob is added.
    alice.actor.failNext('POST', /\/api\/groups\/\d+\/kdms$/);
    await S.addMember(alice, group.id, bob);
    await S.open(alice, group.id);
    await sleep(500);

    // The user re-opens the group later (network is back) and writes.
    await S.open(alice, group.id);
    await S.send(alice, 'written after the outage');

    await S.open(bob, group.id);
    assert.ok(
        await S.waitFor(bob, () => S.bubbles(bob).includes('written after the outage')),
        `Bob cannot read a message whose key was never distributed: ${JSON.stringify(S.bubbles(bob))} ` +
        '(Alice kept an undistributed key as her "current" key and never retried)'
    );

    // Control: the outage really happened -- Alice's client made a KDM POST
    // that never reached the server, then a later one that did.
    const kdmPosts = alice.actor.fetchLog.filter((f) => f.method === 'POST' && new RegExp(`/api/groups/${group.id}/kdms$`).test(f.url));
    assert.ok(kdmPosts.length >= 2, `expected a dropped POST plus a retry, saw ${kdmPosts.length} KDM POST(s)`);

    // Exactly one distributed key for Bob: the failed attempt left nothing behind.
    const forBob = S.server.db.prepare(
        'SELECT COUNT(*) c FROM group_key_distributions WHERE group_id = ? AND from_user_id = ? AND to_user_id = ?'
    ).get(group.id, alice.ident.id, bob.ident.id).c;
    assert.equal(forBob, 1, `expected exactly one successfully distributed key, found ${forBob}`);
});
