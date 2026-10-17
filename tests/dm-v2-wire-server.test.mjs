// tests/dm-v2-wire-server.test.mjs
//
// STEP 1B: real server, no browser. Migration, the identity-key response field,
// the server rule with teeth, verbatim storage, and the opt-in script.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Database, assertFixtureUntouched, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';
import { bootServer } from './credentials/_server.mjs';
import { ROOT } from './_acceptance-harness.mjs';

const { runMigrations } = await import('../database/migrations.js');

// fixture ids: Admin=1, alice=2, bob=3, carol=4, dave=5, erin=6, frank=7, MixedCase=8
const ALICE = 2;   // min_version stays 1 (rejection tests)
const BOB = 3;     // pre-opted to 2 (verbatim test)

function copyFixture(dest) {
    fs.copyFileSync(FIXTURE_DB, dest);
    for (const suf of ['-wal', '-shm']) {
        const s = FIXTURE_DB + suf;
        if (fs.existsSync(s)) fs.copyFileSync(s, dest + suf);
    }
}

function v2Envelope(from, to, msgId = '0123456789abcdef') {
    return JSON.stringify({
        encryption: {
            version: 2,
            algorithm: 'AES-GCM',
            iv: Buffer.alloc(12).toString('base64'),
            ciphertext: Buffer.from('aabbcc', 'hex').toString('base64'),
            senderFp: Buffer.alloc(32).toString('base64'),
            msgId
        },
        senderId: from,
        recipientId: to
    });
}

function v1Envelope(from, to) {
    return JSON.stringify({
        encryption: {
            version: 1,
            algorithm: 'AES-GCM',
            iv: Buffer.alloc(12).toString('base64'),
            ciphertext: Buffer.from('aabbcc', 'hex').toString('base64')
        },
        senderId: from,
        recipientId: to
    });
}

let srv, dbPath, dir;

before(async () => {
    dir = tmpDir();
    dbPath = path.join(dir, 'wire.db');
    copyFixture(dbPath);
    // Add the column before opt-in.
    const db0 = new Database(dbPath, { readonly: false });
    runMigrations(db0);
    db0.close();
    // Pre-opt-in bob (id 3) so the server sees him at 2 from the start.
    const script = path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs');
    const r = spawnSync(process.execPath, [script, 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('pre-opt-in failed: ' + r.stderr + r.stdout);
    srv = await bootServer(dbPath, dir);
});

after(async () => {
    await srv?.stop();
    cleanupTmp();
    assertFixtureUntouched();
});

test('migration on a FRESH copy: idempotent and rows = 1', () => {
    const fresh = path.join(dir, 'fresh.db');
    copyFixture(fresh);
    const db = new Database(fresh, { readonly: false });
    runMigrations(db);
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    assert.ok(cols.includes('dm_e2ee_min_version'));
    const rows = db.prepare('SELECT dm_e2ee_min_version FROM users').all();
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.dm_e2ee_min_version === 1));
    db.close();
});

test('identity-key response carries dmE2eeMinVersion', async () => {
    const login = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
    let token = login.body?.token;
    if (!token) {
        const reg = await srv.call('POST', '/api/auth/register', { body: { username: 'sender1', email: 's@x.invalid', password: 'Passw0rd!x' } });
        assert.equal(reg.status, 201);
        const l2 = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
        assert.equal(l2.status, 200);
        token = l2.body.token;
    }
    // alice (id 2) has a v1 identity key
    const r = await srv.call('GET', '/api/me/identity-key/2', { token });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.publicKey, 'string');
    assert.equal(typeof r.body.dmE2eeMinVersion, 'number');
    assert.equal(r.body.dmE2eeMinVersion, 1);
});

test('server rule: v2 for a min-1 recipient is rejected on send', async () => {
    const login = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
    let token = login.body?.token;
    if (!token) {
        const reg = await srv.call('POST', '/api/auth/register', { body: { username: 'sender1', email: 's@x.invalid', password: 'Passw0rd!x' } });
        const l2 = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
        token = l2.body.token;
    }
    const r = await srv.call('POST', '/api/dm/messages', { token, body: { recipient_id: ALICE, content: v2Envelope(2, ALICE) } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not enabled for DM v2/i);
});

test('server rule: v2 for a min-1 recipient is rejected on edit', async () => {
    const login = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
    let token = login.body?.token;
    if (!token) {
        const reg = await srv.call('POST', '/api/auth/register', { body: { username: 'sender1', email: 's@x.invalid', password: 'Passw0rd!x' } });
        const l2 = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
        token = l2.body.token;
    }
    const sent = await srv.call('POST', '/api/dm/messages', { token, body: { recipient_id: ALICE, content: v1Envelope(2, ALICE) } });
    assert.equal(sent.status, 200);
    const id = sent.body.id;
    const r = await srv.call('PATCH', `/api/dm/messages/${id}`, { token, body: { content: v2Envelope(2, ALICE) } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not enabled for DM v2/i);
});

test('v1 for anyone is untouched', async () => {
    const login = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
    let token = login.body?.token;
    if (!token) {
        const reg = await srv.call('POST', '/api/auth/register', { body: { username: 'sender1', email: 's@x.invalid', password: 'Passw0rd!x' } });
        const l2 = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
        token = l2.body.token;
    }
    const env = v1Envelope(2, ALICE);
    const sent = await srv.call('POST', '/api/dm/messages', { token, body: { recipient_id: ALICE, content: env } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.content, env);
});

test('v2 for a min-2 recipient is stored verbatim', async () => {
    const env = v2Envelope(2, BOB);
    const login = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
    let token = login.body?.token;
    if (!token) {
        const reg = await srv.call('POST', '/api/auth/register', { body: { username: 'sender1', email: 's@x.invalid', password: 'Passw0rd!x' } });
        const l2 = await srv.call('POST', '/api/auth/login', { body: { username: 'sender1', password: 'Passw0rd!x' } });
        token = l2.body.token;
    }
    const sent = await srv.call('POST', '/api/dm/messages', { token, body: { recipient_id: BOB, content: env } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.content, env, 'server must not alter a stored v2 content byte');
});

test('opt-in script: dry-run changes nothing, real run raises, second run = 0, never lowers', () => {
    const script = path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs');
    const optDb = path.join(dir, 'optin.db');
    copyFixture(optDb);
    const dbm = new Database(optDb, { readonly: false });
    runMigrations(dbm);
    dbm.close();

    const dry = spawnSync(process.execPath, [script, '--dry-run', 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: optDb }, encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would go 1 -> 2/);
    const db = new Database(optDb, { readonly: true });
    assert.equal(db.prepare('SELECT dm_e2ee_min_version FROM users WHERE username = ?').get('bob').dm_e2ee_min_version, 1);
    db.close();

    const real = spawnSync(process.execPath, [script, 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: optDb }, encoding: 'utf8' });
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, /changed 1 of 1 rows/);
    const db2 = new Database(optDb, { readonly: true });
    assert.equal(db2.prepare('SELECT dm_e2ee_min_version FROM users WHERE username = ?').get('bob').dm_e2ee_min_version, 2);
    db2.close();

    const second = spawnSync(process.execPath, [script, 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: optDb }, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /changed 0 of 1 rows/);

    const third = spawnSync(process.execPath, [script, 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: optDb }, encoding: 'utf8' });
    assert.match(third.stdout, /already at 2/);
});