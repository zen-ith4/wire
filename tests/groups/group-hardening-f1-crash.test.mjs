// tests/groups/group-hardening-f1-crash.test.mjs
//
// F1: MD-6 must also hold when the process DIES mid-distribution (Capacitor
// background kill, tab crash), not only when fetch() throws.
//
// Real server + Socket.IO + unmodified client. "Process death" is simulated by
// abandoning the actor (socket gone, in-flight request never answered, Web
// Locks released) and launching a fresh module graph over the SAME IndexedDB.

import './_env.mjs';

import { test, after, afterEach } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

const scenarios = [];
after(async () => { for (const s of scenarios) await s.stop(); });
afterEach(() => { shared?.retireExtras(); });

let shared = null;
async function scenario() {
    if (!shared) {
        shared = await createScenario(['alice', 'bob', 'carol']);
        scenarios.push(shared);
    }
    return shared;
}

const KDM_URL = (groupId) => new RegExp(`/api/groups/${groupId}/kdms$`);
const kdmCount = (S, g, from, to) => S.server.db.prepare(
    'SELECT COUNT(*) c FROM group_key_distributions WHERE group_id = ? AND from_user_id = ? AND to_user_id = ?'
).get(g, from, to).c;

test('F1-a: process killed DURING the KDM POST never leaves an undistributed key as "current"', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;
    await S.mount(alice);
    await S.mount(bob);
    const group = await S.createGroup(alice, 'f1a');
    await S.open(alice, group.id);

    // Alice's live device starts distributing its key for the new epoch and
    // the process dies before the request is answered (no exception thrown).
    alice.actor.hangNext('POST', KDM_URL(group.id));
    await S.addMember(alice, group.id, bob);
    await sleep(600);

    const posts = alice.actor.fetchLog.filter((f) => f.method === 'POST' && KDM_URL(group.id).test(f.url));
    assert.ok(posts.length >= 1, 'control: Alice attempted a KDM POST');
    assert.equal(kdmCount(S, group.id, alice.ident.id, bob.ident.id), 0, 'control: the hung POST never reached the server');

    const relaunched = await S.restartProcess(alice);
    await S.open(relaunched, group.id);
    await S.send(relaunched, 'sent after the crash');

    await S.open(bob, group.id);
    assert.ok(
        await S.waitFor(bob, () => S.bubbles(bob).includes('sent after the crash')),
        `Bob cannot read the message: the relaunched device kept an undistributed key as "current". bubbles=${JSON.stringify(S.bubbles(bob))}`
    );
    assert.equal(kdmCount(S, group.id, alice.ident.id, bob.ident.id), 1, 'exactly one key was distributed to Bob');
});

test('F1-b: POST succeeded but the process died before persisting: sender mints another key, group keeps working', async () => {
    const S = await scenario();
    const { carol: alice, bob } = S.users;
    await S.mount(alice);
    await S.mount(bob);
    const group = await S.createGroup(alice, 'f1b');
    await S.open(alice, group.id);

    alice.actor.dropResponseNext('POST', KDM_URL(group.id));
    await S.addMember(alice, group.id, bob);
    await sleep(600);

    // Recipients already hold the lost key (the server did store it).
    assert.equal(kdmCount(S, group.id, alice.ident.id, bob.ident.id), 1, 'control: the KDM reached the server');

    const relaunched = await S.restartProcess(alice);
    await S.open(relaunched, group.id);
    await S.send(relaunched, 'sent with a fresh key');

    await S.open(bob, group.id);
    assert.ok(
        await S.waitFor(bob, () => S.bubbles(bob).includes('sent with a fresh key')),
        `Bob cannot read the message. bubbles=${JSON.stringify(S.bubbles(bob))}`
    );

    // The key whose response was lost is never used to send: a second key exists.
    assert.equal(kdmCount(S, group.id, alice.ident.id, bob.ident.id), 2, 'sender minted and distributed a replacement key');

    // And (key, nonce) uniqueness holds across both keys.
    const seen = new Set();
    for (const { env } of S.envelopes(group.id)) {
        const slot = `${env.senderKeyId}:${env.iv}`;
        assert.ok(!seen.has(slot), `nonce reuse: ${slot}`);
        seen.add(slot);
    }
});
