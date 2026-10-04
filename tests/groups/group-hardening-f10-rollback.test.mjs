// tests/groups/group-hardening-f10-rollback.test.mjs
//
// F10 end to end (real server + Socket.IO + client): a restored/cloned profile whose
// counter went backwards must never reuse a (senderKeyId, nonce) pair, because every
// process draws a fresh random nonce prefix. Also the crash window "encrypted, counter
// not yet persisted" cannot produce a repeat.

import './_env.mjs';

import { test, after } from 'node:test';
import { createScenario, assert } from './_scenario.mjs';

const scenarios = [];
after(async () => { for (const s of scenarios) await s.stop(); });

test('F10-c: counter rolled back in a restored profile, two messages, nonces differ and Bob reads everything', async () => {
    const S = await createScenario(['alice', 'bob']);
    scenarios.push(S);
    const { alice, bob } = S.users;
    const g = await S.createGroup(alice, 'f10c');
    await S.addMember(alice, g.id, bob);
    await S.mount(alice);
    await S.open(alice, g.id);
    await S.mount(bob);
    await S.open(bob, g.id);

    await S.send(alice, 'before-1');
    await S.send(alice, 'before-2');
    for (const m of ['before-1', 'before-2']) assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes(m)), m);

    // Restore: same IndexedDB, but the counter store is rolled back to 0 (an old backup / a cloned profile).
    alice.actor.use();
    const store = await alice.actor.importModule('crypto/groups/sender-key-store.js');
    const mine = (await store.getAllSenderKeysForGroup(g.id)).find((r) => r.isMine);
    assert.ok(mine, 'control: Alice has a sending key');
    assert.ok((await store.readCounter(mine.senderKeyId)) >= 2, 'control: counter advanced');
    await store.writeCounter(mine.senderKeyId, 0);

    // The app is relaunched (new process: new module graph, fresh nonce prefix).
    const relaunched = await S.restartProcess(alice);
    await S.open(relaunched, g.id);
    await S.send(relaunched, 'after-1');
    await S.send(relaunched, 'after-2');
    for (const m of ['after-1', 'after-2']) assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes(m)), `${m} unreadable: ${JSON.stringify(S.bubbles(bob))}`);

    const envs = S.envelopes(g.id).map((e) => e.env);
    const mineEnvs = envs.filter((e) => e.senderKeyId === mine.senderKeyId);
    assert.equal(mineEnvs.length, 4, 'all four messages used the same key');
    const counters = mineEnvs.map((e) => e.counter);
    assert.ok(new Set(counters).size < counters.length, `control: the counter really repeated after the rollback: ${counters}`);

    const slots = mineEnvs.map((e) => `${e.senderKeyId}:${e.iv}`);
    assert.equal(new Set(slots).size, slots.length, `(key, nonce) reused after rollback: ${JSON.stringify(slots)}`);
});
