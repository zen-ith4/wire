// tests/groups/group-hardening-f9-web-locks.test.mjs
//
// F9: Web Lock behaviour. Sending REQUIRES navigator.locks (nonce counters);
// minting a key falls back to unlocked (worst case: an extra key, never a
// nonce reuse). Real server + client; two tabs share one browser profile.

import './_env.mjs';

import { test, after, afterEach } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

const scenarios = [];
after(async () => { for (const s of scenarios) await s.stop(); });
afterEach(() => { shared?.retireExtras(); });

let shared = null;
async function scenario() {
    if (!shared) {
        shared = await createScenario(['alice', 'bob']);
        scenarios.push(shared);
    }
    return shared;
}

test('F9-a: two tabs sending concurrently never reuse a (senderKeyId, nonce) and every message is readable', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;
    const g = await S.createGroup(alice, 'f9a');
    await S.addMember(alice, g.id, bob);
    await S.mount(alice);
    await S.open(alice, g.id);
    await S.mount(bob);
    await S.open(bob, g.id);
    const tab2 = await S.addTab(alice);
    await S.open(tab2, g.id);

    const N = 6;
    await Promise.all([
        ...Array.from({ length: N }, (_, i) => S.send(alice, `tab1-${i}`)),
        ...Array.from({ length: N }, (_, i) => S.send(tab2, `tab2-${i}`)),
    ]);

    for (let i = 0; i < N; i++) {
        assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes(`tab1-${i}`)), `tab1-${i} unreadable`);
        assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes(`tab2-${i}`)), `tab2-${i} unreadable`);
    }

    const seen = new Set();
    for (const { env } of S.envelopes(g.id)) {
        const slot = `${env.senderKeyId}:${env.iv}`;
        assert.ok(!seen.has(slot), `nonce reuse across concurrent tabs: ${slot}`);
        seen.add(slot);
    }
});

test('F9-b: without navigator.locks sending is refused (never silently unlocked)', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;
    const g = await S.createGroup(alice, 'f9b');
    await S.addMember(alice, g.id, bob);
    await S.mount(alice);
    await S.open(alice, g.id);
    const tab2 = await S.addTab(alice);
    await S.open(tab2, g.id);
    await sleep(300);

    tab2.actor.use();
    tab2.actor.window.navigator.locks = undefined;      // a WebView without Web Locks
    const mod = await tab2.actor.importModule('crypto/messages/group-message-crypto.js');

    await assert.rejects(
        () => mod.encryptOutgoingGroupMessage(g.id, 'must not be encrypted without a lock'),
        /Web Locks/,
        'sending without Web Locks must throw'
    );

    const sent = await S.send(tab2, 'ui path without locks');
    assert.equal(sent, false, 'composer must not report success when the send was refused');
    assert.equal(S.envelopes(g.id).filter((e) => e.sender_id === alice.ident.id).length, 0, 'nothing was posted');
});

test('F9-c: key MINT without navigator.locks is allowed and can only produce extra keys, not nonce reuse', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;
    const g = await S.createGroup(alice, 'f9c');
    await S.addMember(alice, g.id, bob);
    await S.mount(alice);

    const tab2 = await S.addTab(alice);
    tab2.actor.use();
    tab2.actor.window.navigator.locks = undefined;
    const mod = await tab2.actor.importModule('crypto/messages/group-message-crypto.js');
    const epoch = S.server.db.prepare('SELECT key_epoch e FROM group_members WHERE group_id=? AND user_id=?').get(g.id, alice.ident.id).e;

    // Does not throw, and distributes a key.
    await mod.ensureSenderKeyForGroup(g.id, [alice.ident.id, bob.ident.id], epoch);
    const keys = S.server.db.prepare(
        'SELECT COUNT(*) c FROM group_key_distributions WHERE group_id=? AND from_user_id=? AND to_user_id=?'
    ).get(g.id, alice.ident.id, bob.ident.id).c;
    assert.ok(keys >= 1);
});
