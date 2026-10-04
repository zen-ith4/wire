// tests/groups/group-hardening-f5-removal-race.test.mjs
//
// F5: a KDM POST that was in flight when a member was removed must not land.
// Real Express + Socket.IO + SQLite; raw REST for the adversarial requests
// (a stale client is exactly "a request the UI no longer would send").

import './_env.mjs';

import { createRequire } from 'node:module';
import { test, after } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

const require = createRequire(import.meta.url);

const scenarios = [];
after(async () => { for (const s of scenarios) await s.stop(); });

let shared = null;
async function scenario() {
    if (!shared) {
        shared = await createScenario(['alice', 'bob', 'carol']);
        scenarios.push(shared);
    }
    return shared;
}

const OPAQUE = (tag) => JSON.stringify({ v: 2, alg: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: Buffer.from(tag).toString('base64') });

async function post(S, u, groupId, body) {
    const res = await globalThis.__nodeFetch(`${S.server.origin}/api/groups/${groupId}/kdms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.ident.token}`, 'X-Wire-Group-Proto': '2' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const epochOf = (S, g, uid) => S.server.db.prepare('SELECT key_epoch e FROM group_members WHERE group_id = ? AND user_id = ?').get(g, uid)?.e;
const rows = (S, g) => S.server.db.prepare('SELECT * FROM group_key_distributions WHERE group_id = ?').all(g);

async function groupOf3(name) {
    const S = await scenario();
    const { alice, bob, carol } = S.users;
    const g = await S.createGroup(alice, name);
    await S.addMember(alice, g.id, bob);
    await S.addMember(alice, g.id, carol);
    return { S, alice, bob, carol, g };
}

test('F5-a: POST naming a member who was removed meanwhile is rejected and writes nothing', async () => {
    const { S, alice, bob, carol, g } = await groupOf3('f5a');
    const staleEpoch = epochOf(S, g.id, alice.ident.id);

    // Alice built her fan-out for {alice, bob, carol} at staleEpoch, then Carol is removed.
    await S.removeMember(alice, g.id, carol);
    const r = await post(S, alice, g.id, {
        epoch: epochOf(S, g.id, alice.ident.id),
        recipients: [alice, bob, carol].map((u) => ({ user_id: u.ident.id, wrapped_key: OPAQUE(String(u.ident.id)) })),
    });
    assert.equal(r.status, 400, JSON.stringify(r));
    assert.equal(rows(S, g.id).length, 0, 'a rejected batch must not leave any row (all-or-nothing)');
    assert.ok(staleEpoch < epochOf(S, g.id, alice.ident.id), 'control: removal bumped the epoch');
});

test('F5-b: POST for a stale epoch is rejected even when all recipients are still members', async () => {
    const { S, alice, bob, carol, g } = await groupOf3('f5b');
    const staleEpoch = epochOf(S, g.id, alice.ident.id);
    await S.removeMember(alice, g.id, carol);

    const r = await post(S, alice, g.id, {
        epoch: staleEpoch,
        recipients: [alice, bob].map((u) => ({ user_id: u.ident.id, wrapped_key: OPAQUE('x') })),
    });
    assert.equal(r.status, 409, `a key tagged with a past epoch must not be accepted: ${JSON.stringify(r)}`);
    assert.equal(rows(S, g.id).length, 0);

    const ok = await post(S, alice, g.id, {
        epoch: epochOf(S, g.id, alice.ident.id),
        recipients: [alice, bob].map((u) => ({ user_id: u.ident.id, wrapped_key: OPAQUE('y') })),
    });
    assert.equal(ok.status, 201, 'control: the current epoch is accepted');
});

test('F5-c: a removed sender cannot POST at all', async () => {
    const { S, alice, bob, carol, g } = await groupOf3('f5c');
    await S.removeMember(alice, g.id, carol);

    const r = await post(S, carol, g.id, {
        epoch: epochOf(S, g.id, alice.ident.id),
        recipients: [{ user_id: bob.ident.id, wrapped_key: OPAQUE('z') }],
    });
    assert.equal(r.status, 403, JSON.stringify(r));
    assert.equal(rows(S, g.id).length, 0);
});

test('F5-d: a removed member never receives KDMs for the new epoch, and cannot drain the group', async () => {
    const { S, alice, bob, carol, g } = await groupOf3('f5d');
    await S.removeMember(alice, g.id, carol);

    const ok = await post(S, alice, g.id, {
        epoch: epochOf(S, g.id, alice.ident.id),
        recipients: [alice, bob].map((u) => ({ user_id: u.ident.id, wrapped_key: OPAQUE('k') })),
    });
    assert.equal(ok.status, 201);

    assert.equal(rows(S, g.id).filter((r) => r.to_user_id === carol.ident.id).length, 0, 'no row addressed to the removed member');

    const drain = await globalThis.__nodeFetch(`${S.server.origin}/api/groups/kdms?device_id=carolcarolcarol05`, { headers: { Authorization: `Bearer ${carol.ident.token}`, 'X-Wire-Group-Proto': '2' } });
    assert.deepEqual(await drain.json(), [], 'removed member drains nothing');
    const scoped = await globalThis.__nodeFetch(`${S.server.origin}/api/groups/kdms?group_id=${g.id}&device_id=carolcarolcarol05`, { headers: { Authorization: `Bearer ${carol.ident.token}`, 'X-Wire-Group-Proto': '2' } });
    assert.equal(scoped.status, 403);
});

test('F5-e: removal evicts the removed member\'s sockets from the group room', async () => {
    const { S, alice, bob, carol, g } = await groupOf3('f5e');
    await S.mount(carol);
    await S.open(carol, g.id);
    await sleep(300);

    const { getIo } = require('../../services/socket.service');
    const before = await getIo().in(`group:${g.id}`).fetchSockets();
    assert.ok(before.length >= 1, 'control: Carol\'s socket joined the group room');

    await S.removeMember(alice, g.id, carol);
    await sleep(200);

    const after = await getIo().in(`group:${g.id}`).fetchSockets();
    const carolSockets = after.filter((s) => s.rooms.has(`user:${carol.ident.id}`));
    assert.equal(carolSockets.length, 0, 'removed member\'s socket is still in the group room');
    void bob;
});

test('F5-f: validation happens at write time, inside the insert transaction (service level)', async () => {
    const { S, alice, bob, carol, g } = await groupOf3('f5f');
    const svc = require('../../services/groupKdm.service');
    const groups = require('../../services/groups.service');
    assert.equal(typeof svc.submitKdmBatchChecked, 'function', 'service must expose a validated, transactional insert');

    const epoch = epochOf(S, g.id, alice.ident.id);
    groups.removeMember(g.id, carol.ident.id); // membership changes behind the caller's stale view

    const result = svc.submitKdmBatchChecked(g.id, alice.ident.id, epoch, [
        { toUserId: bob.ident.id, wrappedKey: 'a' },
        { toUserId: carol.ident.id, wrappedKey: 'b' },
    ]);
    assert.equal(result.ok, false);
    assert.equal(rows(S, g.id).length, 0, 'nothing inserted for the member that was still valid');
});
