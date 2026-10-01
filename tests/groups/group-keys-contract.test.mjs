// tests/groups/group-keys-contract.test.mjs
//
// Group/E2EE audit sections 4 and 6 (+ legacy compatibility for the
// scheme-2 change). Real server, real Socket.IO, unmodified client.
//
//   K-1  every decorated message exposes senderKeyId = id of the key that
//        actually decrypted it: multiple senders, across rotation, old msgs
//   K-2  unknown / missing / malformed senderKeyId are handled per message
//        and never break unrelated messages nor expose a bogus id
//   M-1  membership: late joiner reads existing senders' NEW messages,
//        removed member gets nothing after removal
//   L-1  legacy records: never used to send, never overwritten

import './_env.mjs';

import { test, after, afterEach } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

let S = null;
async function scenario() {
    if (!S) S = await createScenario(['alice', 'bob', 'carol']);
    return S;
}
after(async () => { await S?.stop(); });
afterEach(() => { S?.retireExtras(); });

async function openBoth(name) {
    const s = await scenario();
    const { alice, bob } = s.users;
    const group = await s.createGroup(alice, name);
    await s.addMember(alice, group.id, bob);
    await s.mount(alice); await s.open(alice, group.id);
    await s.mount(bob); await s.open(bob, group.id);
    await sleep(300);
    return { s, alice, bob, group };
}

/** The REAL server rows, decorated by the REAL decorate callback. */
async function decorated(s, u, groupId, opts = { live: false }) {
    const rows = await s.api(u, `/api/groups/${groupId}/messages/recent?limit=50`);
    u.actor.use();
    return { rows, out: await u.group.decorateGroupMessages(groupId, rows, opts) };
}

test('K-1: senderKeyId is exposed, non-empty, and is the id of the key that decrypted (senders, rotation, old messages)', async () => {
    const { s, alice, bob, group } = await openBoth('k1');

    await s.send(alice, 'alice epoch0');
    await s.send(bob, 'bob epoch0');
    assert.ok(await s.waitFor(bob, () => s.bubbles(bob).includes('alice epoch0')));
    assert.ok(await s.waitFor(alice, () => s.bubbles(alice).includes('bob epoch0')));

    // Membership change => epoch bump => both rotate.
    const carol = s.users.carol;
    await s.addMember(alice, group.id, carol);
    await sleep(800);
    await s.send(alice, 'alice epoch1');
    await s.send(bob, 'bob epoch1');
    assert.ok(await s.waitFor(bob, () => s.bubbles(bob).includes('alice epoch1')));

    const { out } = await decorated(s, bob, group.id);
    const byText = Object.fromEntries(out.map((m) => [m.content, m]));
    for (const t of ['alice epoch0', 'bob epoch0', 'alice epoch1', 'bob epoch1']) {
        assert.ok(byText[t], `${t} decorated`);
        assert.equal(typeof byText[t].senderKeyId, 'string', `${t}: senderKeyId is a string`);
        assert.ok(byText[t].senderKeyId.length > 0, `${t}: senderKeyId non-empty`);
    }

    // It is the id of the stored key that authenticated the message, per sender and epoch.
    const envs = Object.fromEntries(s.envelopes(group.id).map((e) => [e.id, e.env.senderKeyId]));
    for (const m of out) assert.equal(m.senderKeyId, envs[m.id], `id ${m.id}: exposed id matches the envelope key id`);

    assert.notEqual(byText['alice epoch0'].senderKeyId, byText['bob epoch0'].senderKeyId, 'different senders => different keys');
    assert.notEqual(byText['alice epoch0'].senderKeyId, byText['alice epoch1'].senderKeyId, 'rotation => new key id');

    // Old messages keep their ORIGINAL id and stay readable after rotation.
    const again = await decorated(s, bob, group.id);
    const old = again.out.find((m) => m.content === 'alice epoch0');
    assert.equal(old.senderKeyId, byText['alice epoch0'].senderKeyId, 'old message id stable across rotation');

    // ...and the id names a key Bob really holds (not merely an envelope field).
    bob.actor.use();
    const store = await bob.actor.importModule('crypto/groups/sender-key-store.js');
    for (const m of again.out) {
        assert.ok(await store.getSenderKeyRecord(m.senderKeyId), `Bob holds the key ${m.senderKeyId.slice(0, 10)}...`);
    }
});

test('K-2: unknown, missing and malformed senderKeyId are handled per message', async () => {
    const { s, alice, bob, group } = await openBoth('k2');
    await s.send(alice, 'good one');
    await s.send(alice, 'good two');
    assert.ok(await s.waitFor(bob, () => s.bubbles(bob).includes('good two')));

    const rows = await s.api(bob, `/api/groups/${group.id}/messages/recent?limit=50`);
    const good = rows[0];
    const env = JSON.parse(good.content);
    const variants = {
        unknown: { ...env, senderKeyId: 'f'.repeat(64) },
        missing: (() => { const e = { ...env }; delete e.senderKeyId; return e; })(),
        empty: { ...env, senderKeyId: '' },
        number: { ...env, senderKeyId: 12345 },
        object: { ...env, senderKeyId: { a: 1 } },
        array: { ...env, senderKeyId: ['x'] },
        huge: { ...env, senderKeyId: 'z'.repeat(100000) },
        proto: { ...env, senderKeyId: '__proto__' },
        wrongVersion: { ...env, v: 99 },
    };
    const bad = Object.entries(variants).map(([name, e], i) => ({
        ...good, id: 900000 + i, content: JSON.stringify(e), _name: name,
    }));
    bad.push({ ...good, id: 900100, content: 'not json at all' });
    bad.push({ ...good, id: 900101, content: '' });
    bad.push({ ...good, id: 900102, content: 'null' });

    // Bulk (history) path: every bad row is skipped, every good row survives.
    bob.actor.use();
    const mixed = [bad[0], rows[0], bad[1], ...bad.slice(2), rows[1]];
    const bulk = await bob.group.decorateGroupMessages(group.id, mixed, { live: false });
    assert.deepEqual(bulk.map((m) => m.content).sort(), ['good one', 'good two'], 'only the genuine messages survive, none lost');
    for (const m of bulk) assert.ok(m.senderKeyId && typeof m.senderKeyId === 'string');

    // Live path, through the REAL pipeline: the hostile envelopes are POSTed via the
    // real send API, so the server emits real `new-group-message` Socket.IO events to
    // Bob's real handler -> addLiveMessage -> decorate -> placeholder-or-drop.
    // Genuine messages sent before, between and after must all still render.
    const post = (content) => s.api(alice, `/api/groups/${group.id}/messages`, {
        method: 'POST', body: JSON.stringify({ content }),
    });
    const liveBad = [
        variants.unknown, variants.missing, variants.empty, variants.number, variants.object,
        variants.array, variants.proto, variants.wrongVersion,
    ].map((e) => JSON.stringify(e));
    liveBad.push('not json at all', 'null');

    await s.send(alice, 'live before');
    for (const c of liveBad) await post(c);
    await s.send(alice, 'live after');

    assert.ok(await s.waitFor(bob, () => s.bubbles(bob).includes('live before')), 'unrelated message before the bad ones renders');
    assert.ok(await s.waitFor(bob, () => s.bubbles(bob).includes('live after')), 'unrelated message after the bad ones renders');

    bob.actor.use();
    const dom = bob.actor.window.document.getElementById('group-messages');
    const html = dom.innerHTML;
    assert.ok(!/ciphertext|senderKeyId|"alg"/.test(html), 'no raw envelope ever reaches the DOM');
    // Exactly: 4 genuine messages ('good one/two', 'live before/after') plus 2
    // placeholders -- the two WELL-FORMED envelopes whose key is simply not held
    // (an unknown id, and the string "__proto__" which must be treated as just
    // another unknown id). Every structurally invalid envelope is dropped.
    const bubbles = [...dom.querySelectorAll('.chat-msg .chat-bubble')].map((e) => e.textContent.trim());
    const genuine = ['good one', 'good two', 'live before', 'live after'];
    for (const g of genuine) assert.ok(bubbles.includes(g), `${g} rendered`);
    assert.equal(bubbles.length, genuine.length + 2, `expected 4 messages + 2 key-waiting placeholders, got ${JSON.stringify(bubbles)}`);
    const others = bubbles.filter((b) => !genuine.includes(b));
    assert.ok(others.every((b) => /key|encrypt|wait/i.test(b)), `non-genuine bubbles must be key-waiting placeholders: ${JSON.stringify(others)}`);
});

test('M-1: late joiner reads existing senders\' new messages; a removed member gets nothing after removal', async () => {
    const { s, alice, bob, group } = await openBoth('m1');
    const carol = s.users.carol;

    await s.send(alice, 'before carol');
    assert.ok(await s.waitFor(bob, () => s.bubbles(bob).includes('before carol')));

    // Carol is added AFTER messages and Sender Keys already exist.
    await s.addMember(alice, group.id, carol);
    await s.mount(carol);
    await s.open(carol, group.id);
    await sleep(800);                       // existing members rotate and distribute to Carol
    await s.send(alice, 'alice after join');
    await s.send(bob, 'bob after join');

    assert.ok(await s.waitFor(carol, () => s.bubbles(carol).includes('alice after join')), 'Carol reads Alice (existing sender)');
    assert.ok(await s.waitFor(carol, () => s.bubbles(carol).includes('bob after join')), 'Carol reads Bob (existing sender)');
    assert.ok(!s.bubbles(carol).includes('before carol'), 'no backfill: pre-join history stays unreadable (by design)');

    // Remove Carol; remaining members rotate; then a message is sent.
    const removedAt = new Date().toISOString();
    await s.removeMember(alice, group.id, carol);
    await sleep(800);
    const carolBubblesAtRemoval = s.bubbles(carol).slice();
    await s.send(alice, 'secret after removal');
    assert.ok(await s.waitFor(bob, () => s.bubbles(bob).includes('secret after removal')), 'remaining member still reads');
    await sleep(600);

    assert.ok(!s.bubbles(carol).includes('secret after removal'), 'removed member must not receive future messages');
    assert.deepEqual(s.bubbles(carol), carolBubblesAtRemoval, 'Carol\'s screen did not change after removal');

    const kdmsToCarolAfter = s.server.db.prepare(
        'SELECT COUNT(*) c FROM group_key_distributions WHERE group_id = ? AND to_user_id = ? AND created_at >= ?'
    ).get(group.id, carol.ident.id, removedAt).c;
    assert.equal(kdmsToCarolAfter, 0, 'no Sender Key was distributed to Carol after removal');

    await assert.rejects(
        () => s.api(carol, `/api/groups/${group.id}/messages/recent?limit=50`),
        'removed member can no longer fetch ciphertext'
    );
    const drained = await s.api(carol, '/api/groups/kdms');
    assert.deepEqual(drained.filter((r) => r.group_id === group.id), [], 'and cannot drain keys for the group');
});

test('L-1: legacy own records are never used to send, and a received key never overwrites an existing id', async () => {
    const { s, alice, group } = await openBoth('l1');
    await s.send(alice, 'creates the scheme-2 key');

    alice.actor.use();
    const ident = (await alice.actor.importModule('crypto/identity-service.js')).getCurrentIdentity();
    const sk = await alice.actor.importModule('crypto/groups/sender-key.js');
    const store = await alice.actor.importModule('crypto/groups/sender-key-store.js');
    const idmod = await alice.actor.importModule('crypto/groups/sender-key-id.js');

    const mine = await sk.getMySenderKey(ident, group.id);
    assert.ok(mine?.senderKeyId, 'control: Alice has a current sending key');

    // A legacy-shaped own record (isMine=1, no scheme) at a HIGHER epoch: the old
    // selection rule would have picked it and encrypted with it (nonce reuse risk).
    const template = await store.getSenderKeyRecord(mine.senderKeyId);
    await store.putSenderKeyRecord({ ...template, senderKeyId: 'legacy-own-record', epoch: template.epoch + 5, scheme: undefined });
    const stillMine = await sk.getMySenderKey(ident, group.id);
    assert.equal(stillMine.senderKeyId, mine.senderKeyId, 'legacy record must not be selected for sending');

    // Receiving a DIFFERENT key for an id that already exists keeps the existing key.
    const legacyId = await idmod.deriveSenderKeyId(group.id, 4242, 3);
    const rawA = crypto.getRandomValues(new Uint8Array(32));
    const rawB = crypto.getRandomValues(new Uint8Array(32));
    const p = { senderKeyId: legacyId, groupId: group.id, ownerUserId: 4242, epoch: 3, scheme: 1 };
    await sk.storeReceivedSenderKey(ident, p, rawA);
    const first = await store.getSenderKeyRecord(legacyId);
    await sk.storeReceivedSenderKey(ident, p, rawB);
    const second = await store.getSenderKeyRecord(legacyId);
    assert.deepEqual(second.wrappedKey, first.wrappedKey, 'colliding legacy id must not overwrite the existing key');
    assert.equal(second.isMine, 0, 'received keys are decrypt-only');

    // The v2 derivation is a function of the key: same inputs, different key => different id.
    const a = await idmod.deriveSenderKeyIdV2(group.id, 1, 0, rawA);
    const b = await idmod.deriveSenderKeyIdV2(group.id, 1, 0, rawB);
    const a2 = await idmod.deriveSenderKeyIdV2(group.id, 1, 0, rawA);
    assert.notEqual(a, b);
    assert.equal(a, a2, 'deterministic for the same key');
    assert.match(a, /^[0-9a-f]{64}$/);
});
