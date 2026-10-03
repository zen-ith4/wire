// tests/groups/group-hardening-f6-device-id.test.mjs
//
// F6: device_id is a mailbox cursor, not a credential, but it must still be
// bounded: validated, capped per user, rate-limited on creation, and its
// receipts pruned. Real server + SQLite.

import './_env.mjs';

import { createRequire } from 'node:module';
import { test, after } from 'node:test';
import { createScenario, assert } from './_scenario.mjs';

const require = createRequire(import.meta.url);

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

const dev = (n) => `dev${String(n).padStart(6, '0')}abcdef`;
const OPAQUE = (t) => JSON.stringify({ v: 2, alg: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: Buffer.from(t).toString('base64') });

async function http(S, u, method, path, body) {
    const res = await globalThis.__nodeFetch(`${S.server.origin}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.ident.token}`, 'X-Wire-Group-Proto': '2' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

async function groupWithMail(name) {
    const S = await scenario();
    const { alice, bob } = S.users;
    const g = await S.createGroup(alice, name);
    await S.addMember(alice, g.id, bob);
    const epoch = S.server.db.prepare('SELECT key_epoch e FROM group_members WHERE group_id=? AND user_id=?').get(g.id, alice.ident.id).e;
    const r = await http(S, alice, 'POST', `/api/groups/${g.id}/kdms`, {
        epoch,
        recipients: [alice, bob].map((u) => ({ user_id: u.ident.id, wrapped_key: OPAQUE(name + u.ident.id) })),
    });
    assert.equal(r.status, 201, JSON.stringify(r));
    return { S, alice, bob, g };
}

const receiptCount = (S) => S.server.db.prepare('SELECT COUNT(*) c FROM group_kdm_receipts').get().c;

test('F6-a: a malformed device_id is rejected, not silently downgraded to account-wide delivery', async () => {
    const { S, bob } = await groupWithMail('f6a');
    const bad = await http(S, bob, 'GET', '/api/groups/kdms?device_id=%3Cscript%3E');
    assert.equal(bad.status, 400, JSON.stringify(bad));
    const badAck = await http(S, bob, 'POST', '/api/groups/kdms/ack', { ids: [1], device_id: 'x' });
    assert.equal(badAck.status, 400);
});

test('F6-b: creation of new device ids is rate-limited per user (HTTP 429 + Retry-After), but a normal user is never locked out', async () => {
    const { S, bob } = await groupWithMail('f6b');

    // A normal user: 6 browsers (6 ids), each with several tabs (same id, many requests).
    for (let d = 0; d < 6; d++) {
        for (let tab = 0; tab < 4; tab++) {
            const r = await http(S, bob, 'GET', `/api/groups/kdms?device_id=${dev(10 + d)}`);
            assert.equal(r.status, 200, `normal multi-browser/multi-tab use was refused (device ${d}, tab ${tab})`);
        }
    }

    // A flood of brand-new ids is throttled.
    const statuses = [];
    let retryAfter = null;
    for (let i = 0; i < 40; i++) {
        const res = await globalThis.__nodeFetch(`${S.server.origin}/api/groups/kdms?device_id=${dev(100 + i)}`, {
            headers: { Authorization: `Bearer ${bob.ident.token}`, 'X-Wire-Group-Proto': '2' },
        });
        statuses.push(res.status);
        if (res.status === 429) retryAfter = res.headers.get('retry-after');
    }
    assert.ok(statuses.includes(429), `no rate limit on new device ids: ${statuses}`);
    assert.ok(Number(retryAfter) >= 1, `429 must carry Retry-After: ${retryAfter}`);

    // An already-known device is never throttled, even while the limit is hit.
    const known = await http(S, bob, 'GET', `/api/groups/kdms?device_id=${dev(10)}`);
    assert.equal(known.status, 200);
});

test('F6-c: distinct device ids per user are capped; the least recently seen is evicted with its receipts', async () => {
    const { S, bob, g } = await groupWithMail('f6c');
    const svc = require('../../services/groupKdm.service');
    assert.equal(typeof svc.touchDevice, 'function');

    const now = Date.now();
    const opts = { cap: 3, newPerHour: 1000, grace: 1000 };
    for (let i = 0; i < 3; i++) {
        assert.equal(svc.touchDevice(bob.ident.id, dev(200 + i), { ...opts, now: now + i * 1000 }).ok, true);
    }
    const mail = svc.getUndeliveredForUser(bob.ident.id, g.id, dev(200));
    svc.markDelivered(mail.map((m) => m.id), bob.ident.id, dev(200));
    assert.ok(S.server.db.prepare('SELECT COUNT(*) c FROM group_kdm_receipts WHERE device_id = ?').get(dev(200)).c >= 1, 'control: receipt exists');

    assert.equal(svc.touchDevice(bob.ident.id, dev(299), { ...opts, now: now + 10_000 }).ok, true);

    const n = S.server.db.prepare('SELECT COUNT(*) c FROM group_devices WHERE user_id = ?').get(bob.ident.id).c;
    assert.ok(n <= 3, `cap not enforced: ${n} device ids registered`);
    assert.equal(S.server.db.prepare('SELECT COUNT(*) c FROM group_kdm_receipts WHERE device_id = ?').get(dev(200)).c, 0, 'evicted device keeps no receipts');
});

test('F6-d: receipts are deleted together with their KDM rows (purge on removal)', async () => {
    const { S, alice, bob, g } = await groupWithMail('f6d');
    const d = dev(300);
    const mail = await http(S, bob, 'GET', `/api/groups/kdms?group_id=${g.id}&device_id=${d}`);
    assert.equal(mail.status, 200);
    assert.ok(mail.body.length >= 1);
    await http(S, bob, 'POST', '/api/groups/kdms/ack', { ids: mail.body.map((m) => m.id), device_id: d });
    const before = receiptCount(S);
    assert.ok(before >= 1, 'control: receipts written');

    await S.removeMember(alice, g.id, bob);
    const left = S.server.db.prepare(
        'SELECT COUNT(*) c FROM group_kdm_receipts r LEFT JOIN group_key_distributions k ON k.id = r.kdm_id WHERE k.id IS NULL'
    ).get().c;
    assert.equal(left, 0, 'orphan receipts remain after the KDM rows were purged');
    assert.ok(receiptCount(S) < before);
});

test('F6-e: receipts of devices not seen for the TTL are pruned', async () => {
    const { S, bob, g } = await groupWithMail('f6e');
    const svc = require('../../services/groupKdm.service');
    assert.equal(typeof svc.pruneStaleDevices, 'function');

    const old = dev(400);
    const mail = svc.getUndeliveredForUser(bob.ident.id, g.id, old);
    svc.touchDevice(bob.ident.id, old, { cap: 20, newPerHour: 1000, grace: 1000, now: Date.now() - 200 * 86400_000 });
    svc.markDelivered(mail.map((m) => m.id), bob.ident.id, old);
    assert.ok(S.server.db.prepare('SELECT COUNT(*) c FROM group_kdm_receipts WHERE device_id = ?').get(old).c >= 1);

    svc.pruneStaleDevices({ maxAgeMs: 90 * 86400_000, now: Date.now() });
    assert.equal(S.server.db.prepare('SELECT COUNT(*) c FROM group_kdm_receipts WHERE device_id = ?').get(old).c, 0);
    assert.equal(S.server.db.prepare('SELECT COUNT(*) c FROM group_devices WHERE device_id = ?').get(old).c, 0);
});

test('F6-f: device_id is mandatory: drain and ack without it are rejected, nothing is consumed', async () => {
    const { S, bob, g } = await groupWithMail('f6f');
    const receiptsBefore = receiptCount(S);
    const devicesBefore = S.server.db.prepare('SELECT COUNT(*) c FROM group_devices').get().c;

    const drain = await http(S, bob, 'GET', `/api/groups/kdms?group_id=${g.id}`);
    assert.equal(drain.status, 400, JSON.stringify(drain));

    const ack = await http(S, bob, 'POST', '/api/groups/kdms/ack', { ids: [1, 2, 3] });
    assert.equal(ack.status, 400, JSON.stringify(ack));

    assert.equal(receiptCount(S), receiptsBefore);
    assert.equal(S.server.db.prepare('SELECT COUNT(*) c FROM group_devices').get().c, devicesBefore);
    const cols = S.server.db.prepare("PRAGMA table_info('group_key_distributions')").all().map((c) => c.name);
    assert.ok(!cols.includes('delivered_at'), 'the account-wide delivered_at column no longer exists');
});
