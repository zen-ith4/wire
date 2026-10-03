// tests/groups/group-hardening-f7-version-gate.test.mjs
//
// F7: stale clients (old Capacitor bundles) must get an explicit "update
// required" answer instead of silently failing to parse v:2 KDMs, and a
// client that cannot parse a KDM must NEVER ack it.

import './_env.mjs';

import { test, after } from 'node:test';
import { createScenario, assert } from './_scenario.mjs';

const scenarios = [];
after(async () => { for (const s of scenarios) await s.stop(); });

let shared = null;
async function scenario() {
    if (!shared) {
        shared = await createScenario(['alice', 'bob']);
        scenarios.push(shared);
    }
    return shared;
}

async function raw(S, u, method, path, { body, proto } = {}) {
    const res = await globalThis.__nodeFetch(`${S.server.origin}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${u.ident.token}`,
            ...(proto != null ? { 'X-Wire-Group-Proto': String(proto) } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test('F7-a: a client that does not declare group protocol >= 2 gets 426 update_required on every KDM / message endpoint', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;
    const g = await S.createGroup(alice, 'f7a');
    await S.addMember(alice, g.id, bob);

    const calls = [
        ['GET', '/api/groups/kdms'],
        ['POST', '/api/groups/kdms/ack', { ids: [1] }],
        ['POST', `/api/groups/${g.id}/kdms`, { epoch: 0, recipients: [{ user_id: alice.ident.id, wrapped_key: 'x' }] }],
        ['GET', `/api/groups/${g.id}/messages/recent`],
        ['POST', `/api/groups/${g.id}/messages`, { content: '{}' }],
    ];

    for (const [method, path, body] of calls) {
        for (const proto of [undefined, 1]) {
            const r = await raw(S, bob, method, path, { body, proto });
            assert.equal(r.status, 426, `${method} ${path} proto=${proto}: ${JSON.stringify(r)}`);
            assert.equal(r.body.code, 'update_required');
            assert.equal(r.body.min_group_protocol, 2);
        }
    }

    // Group management (create/list/members) stays reachable so the stale app can still show an explanation.
    const list = await raw(S, bob, 'GET', '/api/groups');
    assert.equal(list.status, 200);
});

test('F7-b: a current client (protocol 2) is not gated', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;
    const g = await S.createGroup(alice, 'f7b');
    await S.addMember(alice, g.id, bob);
    const r = await raw(S, bob, 'GET', '/api/groups/kdms?device_id=bobbobbob0000001', { proto: 2 });
    assert.equal(r.status, 200);
    const m = await raw(S, bob, 'GET', `/api/groups/${g.id}/messages/recent`, { proto: 2 });
    assert.equal(m.status, 200);
});

test('F7-c (invariant): the real client never acks a KDM it cannot parse, but still acks the ones it stored', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;
    const g = await S.createGroup(alice, 'f7c');
    await S.addMember(alice, g.id, bob);
    const epoch = S.server.db.prepare('SELECT key_epoch e FROM group_members WHERE group_id=? AND user_id=?').get(g.id, bob.ident.id).e;

    const insert = S.server.db.prepare(
        'INSERT INTO group_key_distributions (group_id, from_user_id, to_user_id, wrapped_key, epoch) VALUES (?,?,?,?,?)'
    );
    const futureFormat = insert.run(g.id, alice.ident.id, bob.ident.id, JSON.stringify({ v: 3, alg: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' }), epoch).lastInsertRowid;
    const garbage = insert.run(g.id, alice.ident.id, bob.ident.id, 'not json at all', epoch).lastInsertRowid;

    await S.mount(alice);
    await S.open(alice, g.id);               // Alice mints and distributes a REAL key to Bob
    await S.mount(bob);

    bob.actor.use();
    const mod = await bob.actor.importModule('crypto/messages/group-message-crypto.js');
    const origError = console.error;
    console.error = () => {};
    try {
        await mod.drainGroupKdms(g.id);
    } finally {
        console.error = origError;
    }

    const acked = (id) => S.server.db.prepare('SELECT COUNT(*) c FROM group_kdm_receipts WHERE kdm_id = ?').get(id).c;

    assert.equal(acked(futureFormat), 0, 'a v:3 KDM this client cannot parse was acked');
    assert.equal(acked(garbage), 0, 'an unparseable KDM was acked');

    const real = S.server.db.prepare(
        'SELECT id FROM group_key_distributions WHERE group_id=? AND to_user_id=? AND id NOT IN (?, ?)'
    ).all(g.id, bob.ident.id, futureFormat, garbage);
    assert.ok(real.length >= 1, 'control: a real KDM exists');
    for (const { id } of real) assert.ok(acked(id) >= 1, `control: a KDM that WAS stored must be acked (${id})`);

    // The unparseable rows come back on the next drain (retry after an app update).
    const again = await raw(S, bob, 'GET', `/api/groups/kdms?group_id=${g.id}&device_id=${S.server.db.prepare('SELECT device_id d FROM group_kdm_receipts LIMIT 1').get().d}`, { proto: 2 });
    const ids = again.body.map((r) => r.id);
    assert.ok(ids.includes(Number(futureFormat)) && ids.includes(Number(garbage)), `unacked rows must be redelivered: ${ids}`);
});
