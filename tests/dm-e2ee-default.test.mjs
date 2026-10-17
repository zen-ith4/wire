// tests/dm-e2ee-default.test.mjs
//
// STEP 1C: DM v2 becomes the default for NEW accounts (registration only).
// Boot validation, ratchet triggers, upgrade script, default floor.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { Database, assertFixtureUntouched, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';
import { makeServerDirs, serverEnv } from './_acceptance-harness.mjs';
import { ROOT } from './_acceptance-harness.mjs';

const { runMigrations } = await import('../database/migrations.js');

function copyFixture(dest) {
    fs.copyFileSync(FIXTURE_DB, dest);
    for (const suf of ['-wal', '-shm']) {
        const s = FIXTURE_DB + suf;
        if (fs.existsSync(s)) fs.copyFileSync(s, dest + suf);
    }
}

// Boot a server and capture whether it started + its log.
async function tryBoot(env) {
    const dir = tmpDir();
    const dirs = makeServerDirs(dir);
    const port = 39000 + Math.floor(Math.random() * 900);
    const fullEnv = serverEnv({ dirs, port, nodeEnv: 'test', jwtSecret: 'x'.repeat(48), extraEnv: { DB_PATH: path.join(dirs.db, 't.db'), BCRYPT_ROUNDS: '4', ALLOWED_SUBNET: '127.0.0.0/8', ...env } });
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const started = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 15000);
        const iv = setInterval(() => { if (out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); resolve(true); } }, 50);
        child.once('exit', () => { clearTimeout(t); clearInterval(iv); resolve(out.includes('started successfully')); });
    });
    const stop = () => { if (child.exitCode === null) { child.kill('SIGTERM'); } };
    if (!started && child.exitCode === null) child.kill('SIGKILL');
    return { started, out, code: child.exitCode, stop, child };
}

// ---------------------------------------------------------------- boot validation
const BAD_VALUES = ['', 'abc', '0', '3', '2.5', ' 2', '02'];

for (const v of BAD_VALUES) {
    test(`boot validation: DM_E2EE_DEFAULT_MIN_VERSION=${JSON.stringify(v)} refuses to start`, async () => {
        const { started, out } = await tryBoot({ DM_E2EE_DEFAULT_MIN_VERSION: v });
        assert.equal(started, false, 'server must not start');
        assert.match(out, /DM_E2EE_DEFAULT_MIN_VERSION/);
        assert.match(out, /"1"|"2"|allowed/i);
    });
}

test('boot validation: unset -> server starts (default 2)', async () => {
    const { started, stop } = await tryBoot({});
    assert.equal(started, true);
    stop();
});

test('boot validation: "1" -> server starts', async () => {
    const { started, stop } = await tryBoot({ DM_E2EE_DEFAULT_MIN_VERSION: '1' });
    assert.equal(started, true);
    stop();
});

test('boot validation: "2" -> server starts', async () => {
    const { started, stop } = await tryBoot({ DM_E2EE_DEFAULT_MIN_VERSION: '2' });
    assert.equal(started, true);
    stop();
});

// ---------------------------------------------------------------- triggers
test('triggers: both exist after migrating a copy of legacy-x.db', () => {
    const dest = path.join(tmpDir(), 'trig.db');
    copyFixture(dest);
    const db = new Database(dest, { readonly: false });
    runMigrations(db);
    const trigs = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='users'").all().map((r) => r.name);
    assert.ok(trigs.includes('trg_users_dm_e2ee_min_version_upd'));
    assert.ok(trigs.includes('trg_users_dm_e2ee_min_version_ins'));
    db.close();
});

test('triggers: migrating twice does not duplicate or error', () => {
    const dest = path.join(tmpDir(), 'trig2.db');
    copyFixture(dest);
    const db = new Database(dest, { readonly: false });
    runMigrations(db);
    runMigrations(db);
    const trigs = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='users'").all();
    assert.equal(trigs.filter((t) => t.name === 'trg_users_dm_e2ee_min_version_upd').length, 1);
    db.close();
});

test('trigger: raising 1->2 works', () => {
    const dest = path.join(tmpDir(), 'raise.db');
    copyFixture(dest);
    const db = new Database(dest, { readonly: false });
    runMigrations(db);
    db.prepare('INSERT INTO users (username, password_hash, dm_e2ee_min_version) VALUES (?, ?, ?)').run('t', 'h', 1);
    const id = db.prepare('SELECT id FROM users WHERE username=?').get('t').id;
    db.prepare('UPDATE users SET dm_e2ee_min_version = 2 WHERE id = ?').run(id);
    assert.equal(db.prepare('SELECT dm_e2ee_min_version FROM users WHERE id=?').get(id).dm_e2ee_min_version, 2);
    db.close();
});

test('trigger: lowering 2->1 is refused', () => {
    const dest = path.join(tmpDir(), 'lower.db');
    copyFixture(dest);
    const db = new Database(dest, { readonly: false });
    runMigrations(db);
    db.prepare('INSERT INTO users (username, password_hash, dm_e2ee_min_version) VALUES (?, ?, ?)').run('t', 'h', 2);
    const id = db.prepare('SELECT id FROM users WHERE username=?').get('t').id;
    assert.throws(() => db.prepare('UPDATE users SET dm_e2ee_min_version = 1 WHERE id = ?').run(id));
    db.close();
});

test('trigger: invalid values refused on UPDATE', () => {
    const dest = path.join(tmpDir(), 'inv.db');
    copyFixture(dest);
    const db = new Database(dest, { readonly: false });
    runMigrations(db);
    db.prepare('INSERT INTO users (username, password_hash, dm_e2ee_min_version) VALUES (?, ?, ?)').run('t', 'h', 1);
    const id = db.prepare('SELECT id FROM users WHERE username=?').get('t').id;
    for (const v of [0, 3, -1, 'x', null]) {
        assert.throws(() => db.prepare('UPDATE users SET dm_e2ee_min_version = ? WHERE id = ?').run(v, id), `value ${JSON.stringify(v)} should be refused`);
    }
    db.close();
});

test('trigger: invalid values refused on INSERT', () => {
    const dest = path.join(tmpDir(), 'ins.db');
    copyFixture(dest);
    const db = new Database(dest, { readonly: false });
    runMigrations(db);
    for (const v of [0, 3, -1, 'x', null]) {
        assert.throws(() => db.prepare('INSERT INTO users (username, password_hash, dm_e2ee_min_version) VALUES (?, ?, ?)').run('t2', 'h', v), `value ${JSON.stringify(v)} should be refused`);
    }
    db.close();
});

test('admin script: running on a v2 user leaves the row at 2', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'scriptlower.db');
    copyFixture(dbPath);
    const db0 = new Database(dbPath, { readonly: false });
    runMigrations(db0);
    db0.prepare('INSERT INTO users (username, password_hash, dm_e2ee_min_version) VALUES (?, ?, ?)').run('lowertest', 'h', 2);
    db0.close();
    const script = path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs');
    const r = spawnSync(process.execPath, [script, 'lowertest'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already at 2/);
    const db = new Database(dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT dm_e2ee_min_version FROM users WHERE username = ?').get('lowertest').dm_e2ee_min_version, 2);
    db.close();
});

test('trigger: affinity: storing "2" (text) behaviour', () => {
    const dest = path.join(tmpDir(), 'aff.db');
    copyFixture(dest);
    const db = new Database(dest, { readonly: false });
    runMigrations(db);
    db.prepare('INSERT INTO users (username, password_hash, dm_e2ee_min_version) VALUES (?, ?, ?)').run('t', 'h', 1);
    const id = db.prepare('SELECT id FROM users WHERE username=?').get('t').id;
    let accepted = false;
    let storedType = null;
    let storedValue = null;
    try {
        db.prepare('UPDATE users SET dm_e2ee_min_version = ? WHERE id = ?').run('2', id);
        accepted = true;
        const row = db.prepare('SELECT dm_e2ee_min_version, typeof(dm_e2ee_min_version) AS t FROM users WHERE id=?').get(id);
        storedType = row.t;
        storedValue = row.dm_e2ee_min_version;
    } catch (e) {
        accepted = false;
    }
    // Report what happened; either outcome is acceptable as long as stored value is integer in {1,2}
    if (accepted) {
        assert.equal(storedType, 'integer', 'stored typeof must be integer');
        assert.ok(storedValue === 1 || storedValue === 2);
    }
    db.close();
});

// ---------------------------------------------------------------- default floor for new accounts
test('new account (env default 2) gets dm_e2ee_min_version = 2', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'new.db');
    copyFixture(dbPath);
    const db0 = new Database(dbPath, { readonly: false });
    runMigrations(db0);
    db0.close();
    // boot server with default env (unset)
    const dirs = makeServerDirs(dir);
    const port = 39100 + Math.floor(Math.random() * 100);
    const env = serverEnv({ dirs, port, nodeEnv: 'test', jwtSecret: 'x'.repeat(48), dmE2eeDefaultMinVersion: 2, extraEnv: { DB_PATH: dbPath, BCRYPT_ROUNDS: '4', ALLOWED_SUBNET: '127.0.0.0/8' } });
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const ok = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 30000);
        const iv = setInterval(() => { if (out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); resolve(true); } }, 50);
        child.once('exit', () => { clearTimeout(t); clearInterval(iv); resolve(out.includes('started successfully')); });
    });
    assert.equal(ok, true, out.slice(-400));
    const base = `http://127.0.0.1:${port}`;
    const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'newbie', email: 'n@x.invalid', password: 'Passw0rd!x' }) });
    assert.equal(reg.status, 201);
    const body = await reg.json();
    const uid = body.user?.id || body.id;
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT dm_e2ee_min_version FROM users WHERE id = ?').get(uid);
    assert.equal(row.dm_e2ee_min_version, 2);
    db.close();
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
});

test('new account (env=1) gets dm_e2ee_min_version = 1', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'new2.db');
    copyFixture(dbPath);
    const db0 = new Database(dbPath, { readonly: false });
    runMigrations(db0);
    db0.close();
    const dirs = makeServerDirs(dir);
    const port = 39200 + Math.floor(Math.random() * 100);
    const env = serverEnv({ dirs, port, nodeEnv: 'test', jwtSecret: 'x'.repeat(48), dmE2eeDefaultMinVersion: 1, extraEnv: { DB_PATH: dbPath, BCRYPT_ROUNDS: '4', ALLOWED_SUBNET: '127.0.0.0/8' } });
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const ok = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 30000);
        const iv = setInterval(() => { if (out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); resolve(true); } }, 50);
        child.once('exit', () => { clearTimeout(t); clearInterval(iv); resolve(out.includes('started successfully')); });
    });
    assert.equal(ok, true, out.slice(-400));
    const base = `http://127.0.0.1:${port}`;
    const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'newbie2', email: 'n2@x.invalid', password: 'Passw0rd!x' }) });
    assert.equal(reg.status, 201);
    const body = await reg.json();
    const uid = body.user?.id || body.id;
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT dm_e2ee_min_version FROM users WHERE id = ?').get(uid);
    assert.equal(row.dm_e2ee_min_version, 1);
    db.close();
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
});