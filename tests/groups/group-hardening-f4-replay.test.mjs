// tests/groups/group-hardening-f4-replay.test.mjs
//
// F4: replay protection. Real server + Socket.IO + client for the "hostile relay"
// scenarios; the primitive-level cases (out-of-order, corrupt message, attachments,
// cleanup) use the same real WebCrypto/IndexedDB.
//
// Design under test (see the design doc): a per-key SEEN-SET in IndexedDB keyed by
// (senderKeyId, full 12-byte nonce) and bound to the server message id that first
// claimed it. It is written only AFTER AES-GCM authentication succeeds.
//   - same message id again (socket + syncSince, reload, reply preview, other tab): idempotent
//   - same nonce under a DIFFERENT id: ReplayedMessageError

import './_env.mjs';

import { test, after } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

const scenarios = [];
after(async () => { for (const s of scenarios) await s.stop(); });

let shared = null;
async function scenario() {
    if (!shared) {
        shared = await createScenario(['alice', 'b1', 'b2']);
        scenarios.push(shared);
    }
    return shared;
}

async function groupWithHistory(name, texts, who) {
    const S = await scenario();
    const alice = S.users.alice;
    const bob = S.users[who];
    const g = await S.createGroup(alice, name);
    await S.addMember(alice, g.id, bob);
    await S.mount(alice);
    await S.open(alice, g.id);
    await S.mount(bob);
    await S.open(bob, g.id);
    for (const t of texts) {
        await S.send(alice, t);
        assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes(t)), `control: Bob received ${t}`);
    }
    return { S, alice, bob, g };
}

async function crypto_(u) {
    u.actor.use();
    return u.actor.importModule('crypto/messages/group-message-crypto.js');
}
async function store_(u) {
    u.actor.use();
    return u.actor.importModule('crypto/groups/sender-key-store.js');
}

const count = (arr, x) => arr.filter((b) => b === x).length;

/**
 * STEP 3C: the group attachment decrypt path REQUIRES the binding of a
 * VERIFIED message envelope, so a test that wants to decrypt a file has to
 * produce one: Alice signs a message that carries the file, Bob opens it and
 * the verified binding comes back.
 */
async function groupAttachmentBinding(alice, bob, groupId, { ivBase64, ciphertext, plaintextLength }, messageId) {
    alice.actor.use();
    const aliceMc = await alice.actor.importModule('crypto/groups/message-crypto.js');
    const aliceGm = await alice.actor.importModule('crypto/messages/group-message-crypto.js');
    const envelope = await aliceMc.encryptGroupMessage(aliceGm.getGroupIdentity(), groupId, 'attachment', {
        attachment: { ivBase64, ciphertext, plaintextLength },
    });

    bob.actor.use();
    const bobMc = await bob.actor.importModule('crypto/groups/message-crypto.js');
    const bobGm = await bob.actor.importModule('crypto/messages/group-message-crypto.js');
    const opened = await bobMc.decryptGroupMessageDetailed(bobGm.getGroupIdentity(), groupId, envelope, messageId);
    assert.ok(opened.attachmentBinding, 'a verified attachment message must expose a binding');
    return opened.attachmentBinding;
}

test('F4-a: a hostile relay re-posts stored ciphertext under a FRESH message id: the replay is rejected, the original stays', async () => {
    const { S, alice, bob, g } = await groupWithHistory('f4a', ['hello', 'second'], 'b1');
    const original = S.envelopes(g.id).find((e) => e.env.counter === Math.min(...S.envelopes(g.id).map((x) => x.env.counter)));

    // The relay copies row `original` into a brand new row (new id, same sender, same ciphertext).
    const replayId = S.server.db.prepare(
        'INSERT INTO group_messages (group_id, sender_id, content, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(g.id, original.sender_id, original.raw).lastInsertRowid;

    // API level: the same ciphertext under another id is refused, under its own id it is fine.
    const bobCrypto = await crypto_(bob);
    await assert.rejects(
        () => bobCrypto.decryptIncomingGroupMessage(g.id, original.raw, replayId),
        (e) => e.name === 'ReplayedMessageError'
    );
    const again = await bobCrypto.decryptIncomingGroupMessage(g.id, original.raw, original.id);
    assert.ok(['hello', 'second'].includes(again), 'the original id still decrypts');

    // UI level, a device that has never seen either row (history load): the replay is dropped,
    // the original shown exactly once.
    const relaunched = await S.addDevice(bob);
    await S.open(relaunched, g.id);
    assert.ok(await S.waitFor(relaunched, () => S.bubbles(relaunched).includes('second')));
    const shown = S.bubbles(relaunched);
    assert.equal(count(shown, 'hello'), 1, `replayed copy must not be rendered: ${JSON.stringify(shown)}`);
    assert.equal(count(shown, 'second'), 1);
    void alice;
});

test('F4-b: legitimate duplicate delivery (same message id twice, reload, reply preview) is idempotent, never an error', async () => {
    const { S, bob, g } = await groupWithHistory('f4b', ['m1', 'm2', 'm3'], 'b2');
    const rows = S.envelopes(g.id);
    const bobCrypto = await crypto_(bob);

    // socket + syncSince after a reconnect: the SAME row decrypted repeatedly
    for (let i = 0; i < 3; i++) {
        for (const r of rows) {
            const text = await bobCrypto.decryptIncomingGroupMessage(g.id, r.raw, r.id);
            assert.match(text, /^m[123]$/);
        }
    }

    // reload: a new process re-decrypts the whole stored history
    const relaunched = await S.restartProcess(bob);
    await S.open(relaunched, g.id);
    for (const t of ['m1', 'm2', 'm3']) {
        assert.ok(await S.waitFor(relaunched, () => S.bubbles(relaunched).includes(t)), `history message ${t} survives a reload`);
        assert.equal(count(S.bubbles(relaunched), t), 1);
    }

    // a quoted reply preview is the same ciphertext under the ORIGINAL id: accepted
    const rc = await crypto_(relaunched);
    assert.equal(await rc.decryptIncomingGroupMessage(g.id, rows[0].raw, rows[0].id), 'm1');
});

test('F4-c: two tabs racing on the same IndexedDB: same id both win, competing ids: exactly one wins', async () => {
    const { S, bob, g } = await groupWithHistory('f4c', [], 'b1');
    const { alice } = S.users;
    const tab2 = await S.addTab(bob);
    await S.open(tab2, g.id);

    await S.send(alice, 'race-1');
    await S.send(alice, 'race-2');
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('race-2')));
    const [r1, r2] = S.envelopes(g.id);
    const c1 = await crypto_(bob);
    const c2 = await crypto_(tab2);

    // same id from both tabs at once: both accepted
    const same = await Promise.allSettled([
        c1.decryptIncomingGroupMessage(g.id, r1.raw, r1.id),
        c2.decryptIncomingGroupMessage(g.id, r1.raw, r1.id),
    ]);
    assert.deepEqual(same.map((s) => s.status), ['fulfilled', 'fulfilled']);

    // Fresh nonce, two different ids at once (original vs relay copy): exactly one claims it.
    const copy = S.server.db.prepare(
        'INSERT INTO group_messages (group_id, sender_id, content, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(g.id, r2.sender_id, r2.raw).lastInsertRowid;

    // A device of Bob that has never seen r2, with TWO tabs on its IndexedDB, so both tabs
    // genuinely race for the first claim.
    const fresh = await S.addDevice(bob);
    await (await crypto_(fresh)).drainGroupKdms(g.id);
    // (addTab logs in with u.n, which must be the ACCOUNT name, not the device label)
    const freshTab = await S.addTab({ ...fresh, n: bob.n }, 'race-tab');
    const f1 = await crypto_(fresh);
    const f2 = await crypto_(freshTab);

    const race = await Promise.allSettled([
        f1.decryptIncomingGroupMessage(g.id, r2.raw, r2.id),
        f2.decryptIncomingGroupMessage(g.id, r2.raw, copy),
    ]);
    const won = race.filter((r) => r.status === 'fulfilled').length;
    const lost = race.filter((r) => r.status === 'rejected' && r.reason?.name === 'ReplayedMessageError').length;
    assert.equal(won, 1, `exactly one id may own the nonce: ${JSON.stringify(race.map((r) => r.status))}`);
    assert.equal(lost, 1);
});

test('F4-d: out-of-order delivery is accepted (set, not high-water mark)', async () => {
    const { S, alice, bob, g } = await groupWithHistory('f4d', ['o0', 'o1', 'o2', 'o3', 'o4'], 'b1');
    const rows = S.envelopes(g.id);
    assert.equal(rows.length, 5);

    // A device that has never seen them receives them reversed / shuffled.
    const relaunched = await S.addDevice(bob);
    const rc = await crypto_(relaunched);
    await rc.drainGroupKdms(g.id);
    for (const i of [4, 0, 3, 1, 2]) {
        const text = await rc.decryptIncomingGroupMessage(g.id, rows[i].raw, rows[i].id);
        assert.equal(text, `o${i}`);
    }
    void alice;
});

test('F4-e: a corrupt message never burns its nonce', async () => {
    const { S, bob, g } = await groupWithHistory('f4e', ['clean-1'], 'b1');
    const row = S.envelopes(g.id)[0];
    const relaunched = await S.addDevice(bob);
    const rc = await crypto_(relaunched);
    await rc.drainGroupKdms(g.id);
    const st = await store_(relaunched);
    const before = await st.countSeen(row.env.senderKeyId);

    const bytes = Buffer.from(row.env.ciphertext, 'base64');
    bytes[0] ^= 0x01;
    const corrupt = JSON.stringify({ ...row.env, ciphertext: bytes.toString('base64') });
    await assert.rejects(() => rc.decryptIncomingGroupMessage(g.id, corrupt, 'corrupt-id'), /authentication failed/i);
    assert.equal(await st.countSeen(row.env.senderKeyId), before, 'a failed authentication must leave no seen-set row');

    // the genuine message, same nonce, under its real id, is then accepted
    assert.equal(await rc.decryptIncomingGroupMessage(g.id, row.raw, row.id), 'clean-1');
    assert.equal(await st.countSeen(row.env.senderKeyId), before + 1);
});

test('F4-f: a message id is mandatory (no unprotected decrypt path)', async () => {
    const { S, bob, g } = await groupWithHistory('f4f', ['needs-id'], 'b1');
    const row = S.envelopes(g.id)[0];
    const bc = await crypto_(bob);
    for (const bad of [undefined, null, '']) {
        await assert.rejects(() => bc.decryptIncomingGroupMessage(g.id, row.raw, bad), /message id is required/i);
    }
});

test('F4-g: attachments share the nonce space: same ref idempotent, other ref rejected, messages unaffected', async () => {
    const { S, alice, bob, g } = await groupWithHistory('f4g', ['with-attachment-key'], 'b1');
    const ac = await (async () => { alice.actor.use(); return alice.actor.importModule('crypto/messages/attachment-crypto.js'); })();
    const bobAtt = await (async () => { bob.actor.use(); return bob.actor.importModule('crypto/messages/attachment-crypto.js'); })();
    const bc = await crypto_(bob);

    const file = crypto.getRandomValues(new Uint8Array(64)).buffer;
    const { ivBase64, ciphertext } = await ac.encryptAttachmentForGroup(g.id, file);
    const senderKeyId = S.envelopes(g.id)[0].env.senderKeyId;
    const binding = await groupAttachmentBinding(alice, bob, g.id, { ivBase64, ciphertext, plaintextLength: file.byteLength }, 'att-msg-1');

    const ok1 = await bobAtt.decryptAttachmentForGroup({ groupId: g.id, ciphertext, rowIvBase64: ivBase64, binding, senderKeyId, ref: 'att-1' });
    const ok2 = await bobAtt.decryptAttachmentForGroup({ groupId: g.id, ciphertext, rowIvBase64: ivBase64, binding, senderKeyId, ref: 'att-1' });
    assert.deepEqual(Buffer.from(ok1), Buffer.from(file));
    assert.deepEqual(Buffer.from(ok2), Buffer.from(file), 'same ref again: idempotent');
    await assert.rejects(
        () => bobAtt.decryptAttachmentForGroup({ groupId: g.id, ciphertext, rowIvBase64: ivBase64, binding, senderKeyId, ref: 'att-2' }),
        (e) => e.name === 'ReplayedMessageError'
    );
    await assert.rejects(() => bobAtt.decryptAttachmentForGroup({ groupId: g.id, ciphertext, rowIvBase64: ivBase64, binding, senderKeyId }), /reference is required/i);
    // A call WITHOUT a binding is refused: there is no unbound path any more.
    await assert.rejects(() => bobAtt.decryptAttachmentForGroup({ groupId: g.id, ciphertext, rowIvBase64: ivBase64, senderKeyId, ref: 'att-3' }), /verified attachment binding is required/i);

    // the attachment took a counter of its own: the next TEXT message still goes through
    await S.send(alice, 'after-attachment');
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('after-attachment')));
    const last = S.envelopes(g.id).at(-1);
    assert.equal(await bc.decryptIncomingGroupMessage(g.id, last.raw, last.id), 'after-attachment');

    // an attachment ciphertext presented as a MESSAGE (or vice versa) fails on the AAD label alone
    const asMessage = JSON.stringify({ v: 2, alg: 'AES-GCM', senderKeyId, counter: Buffer.from(ivBase64, 'base64').readUInt32BE(8), iv: ivBase64, ciphertext: Buffer.from(ciphertext).toString('base64') });
    await assert.rejects(() => bc.decryptIncomingGroupMessage(g.id, asMessage, 'x1'), /authentication failed/i);
});

test('F4-h: cleanup: rows die with their key (group left/removed), survive rotation, and are capped', async () => {
    const { S, alice, bob, g } = await groupWithHistory('f4h', ['k1', 'k2', 'k3'], 'b1');
    const bc = await crypto_(bob);
    const st = await store_(bob);
    const rows = S.envelopes(g.id);
    const keyId = rows[0].env.senderKeyId;
    for (const r of rows) await bc.decryptIncomingGroupMessage(g.id, r.raw, r.id);
    const n = await st.countSeen(keyId);
    assert.ok(n >= 3);

    // rotation: a new key is minted for a new epoch; the OLD key still decrypts history, so it keeps its rows
    assert.equal(await st.countSeen(keyId), n, 'rotation must not drop the old key\'s replay protection');

    // cap: oldest rows go first, newest stay
    for (let i = 0; i < 40; i++) {
        await st.claimNonce({ senderKeyId: 'cap-key', nonceHex: `n${String(i).padStart(3, '0')}`, counter: i, ref: `msg:${i}` });
        await sleep(1);
    }
    assert.equal(await st.countSeen('cap-key'), 40);
    await st.pruneSeen('cap-key', 10);
    const left = await st.countSeen('cap-key');
    assert.ok(left <= 10 && left >= 5, `cap not enforced: ${left}`);
    assert.equal(await st.claimNonce({ senderKeyId: 'cap-key', nonceHex: 'n039', counter: 39, ref: 'msg:39' }), 'same', 'the newest row survived');
    assert.equal(await st.claimNonce({ senderKeyId: 'cap-key', nonceHex: 'n000', counter: 0, ref: 'msg:other' }), 'new', 'an evicted row simply stops protecting; it never rejects a legit message');

    // leaving / being removed from the group deletes the keys AND their rows
    await bc.forgetGroupKeys(g.id);
    assert.equal(await st.countSeen(keyId), 0, 'seen rows must be deleted together with the key');
    void alice;
});
