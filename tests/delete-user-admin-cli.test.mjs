// Real user-deletion tests for BOTH callers:
//   - the admin HTTP route (DELETE /api/admin/users/:id)
//   - the server-shell CLI (scripts/admin-cli.mjs delete-user <username>)
//
// Each caller's ACTUAL input handling is exercised:
//   - the route receives the id in req.params.id and must reject
//     non-canonical ids ('0x2', '2e0', '02', '-5', '0') instead of
//     Number()-coercing them onto a real user;
//   - the CLI takes a USERNAME, so the same strings are looked up as
//     names and must fail without deleting anyone.
//
// Also pinned: deleting a group OWNER transfers ownership (and bumps the
// remaining members' key_epoch), and a group whose owner was its only
// member is removed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-delete-callers-'));
const userRoot = path.join(tmp, 'user-data');
fs.mkdirSync(userRoot, { recursive: true });

process.env.DB_PATH = path.join(tmp, 'admin.db');
process.env.JWT_SECRET = 'b'.repeat(48);
process.env.USER_DATA_ROOT = userRoot;
process.env.CHAT_UPLOAD_DIR = path.join(tmp, 'chat');
process.env.DM_UPLOAD_DIR = path.join(tmp, 'dm');
process.env.GROUP_UPLOAD_DIR = path.join(tmp, 'group');
process.env.AVATAR_DIR = path.join(tmp, 'avatars');
process.env.BANNER_DIR = path.join(tmp, 'banners');
delete process.env.DEFAULT_ADMIN_USER;
delete process.env.DEFAULT_ADMIN_PASS;

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const R = (p) => require(path.join(ROOT, p));

const express = require(path.join(ROOT, 'node_modules/express'));
const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
const { initDatabase, getDb } = R('config/database');
const { deriveCredentialsNode, newKdfSalt, KDF_ITERATIONS } = R('utils/credentials');
const { hashPassword } = R('utils/password');
const { signToken } = R('utils/jwt');
const { errorHandler } = R('middleware/errorHandler');

const PASSWORD = 'admin-password-123';
const INVALID_IDS = ['0x2', '2e0', '02', '-5', '0'];

let server;
let io;
let base;
let db;
let boss;
const users = {};

const cliDbPath = path.join(tmp, 'cli.db');
const cliEnv = {
    ...process.env,
    DB_PATH: cliDbPath,
    NODE_ENV: 'development',
    JWT_SECRET: 'c'.repeat(48),
    EMAIL_VERIFICATION_SECRET: 'd'.repeat(48),
    USER_DATA_ROOT: path.join(tmp, 'cli-user-data'),
    CHAT_UPLOAD_DIR: path.join(tmp, 'cli-chat'),
    DM_UPLOAD_DIR: path.join(tmp, 'cli-dm'),
    GROUP_UPLOAD_DIR: path.join(tmp, 'cli-group'),
    AVATAR_DIR: path.join(tmp, 'cli-avatars'),
    BANNER_DIR: path.join(tmp, 'cli-banners'),
    TMPDIR: path.join(tmp, 'cli-tmp'),
};
delete cliEnv.DEFAULT_ADMIN_USER;
delete cliEnv.DEFAULT_ADMIN_PASS;
for (const v of ['USER_DATA_ROOT', 'CHAT_UPLOAD_DIR', 'DM_UPLOAD_DIR', 'GROUP_UPLOAD_DIR', 'AVATAR_DIR', 'BANNER_DIR', 'TMPDIR']) {
    fs.mkdirSync(cliEnv[v], { recursive: true });
}

function runCli(args) {
    // Spawn the real CLI entry point; it opens DB_PATH itself.
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts/admin-cli.mjs'), ...args], {
        cwd: ROOT,
        env: cliEnv,
        encoding: 'utf8',
        timeout: 30000,
    });
}

async function makeUser(name, isAdmin = false) {
    const salt = newKdfSalt();
    const { authKey } = deriveCredentialsNode(PASSWORD, salt, KDF_ITERATIONS);
    const hash = await hashPassword(authKey);
    const r = db.prepare(`
        INSERT INTO users (username, password_hash, is_admin, auth_scheme, kdf_salt, kdf_iterations, is_active, token_version)
        VALUES (?, ?, ?, 2, ?, ?, 1, 0)
    `).run(name, hash, isAdmin ? 1 : 0, salt, KDF_ITERATIONS);
    return { id: Number(r.lastInsertRowid), username: name, is_admin: isAdmin ? 1 : 0, token_version: 0, authKey };
}

function passwordBody(user, password = PASSWORD) {
    const salt = db.prepare('SELECT kdf_salt FROM users WHERE id = ?').get(user.id).kdf_salt;
    const { authKey } = deriveCredentialsNode(password, salt, KDF_ITERATIONS);
    return { current_auth_key: authKey };
}

async function del(id, token, body) {
    const res = await fetch(`${base}/api/admin/users/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
}

const userExists = (id) => !!db.prepare('SELECT 1 AS found FROM users WHERE id = ?').get(id);
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

function addGroup(name, ownerId, others = []) {
    const g = db.prepare("INSERT INTO groups (name, created_by) VALUES (?, ?)").run(name, ownerId);
    const groupId = Number(g.lastInsertRowid);
    db.prepare("INSERT INTO group_members (group_id, user_id, role, key_epoch) VALUES (?, ?, 'owner', 3)").run(groupId, ownerId);
    for (const o of others) {
        db.prepare("INSERT INTO group_members (group_id, user_id, role, key_epoch) VALUES (?, ?, ?, 3)").run(groupId, o.id, o.role);
    }
    return groupId;
}

before(async () => {
    initDatabase();
    db = getDb();

    boss = await makeUser('boss', true);
    users.victim = await makeUser('victim');
    users.owner = await makeUser('owner');
    users.bob = await makeUser('bob');
    users.solo = await makeUser('solo');

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/admin', R('routes/admin.routes'));
    app.use(errorHandler);

    server = http.createServer(app);
    io = R('config/socket').setupSocketIO(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    // Prepare the CLI database with a separate schema (via `list-users`),
    // then insert its users with raw better-sqlite3.
    const init = runCli(['list-users']);
    assert.equal(init.status, 0, `CLI init failed: ${init.stderr}`);

    const cliDb = new Database(cliDbPath);
    try {
        cliDb.pragma('foreign_keys = ON');
        const ins = cliDb.prepare(`
            INSERT INTO users (username, password_hash, is_admin, auth_scheme, kdf_salt, kdf_iterations, is_active, token_version)
            VALUES (?, 'hash', ?, 1, 'salt', 600000, 1, 0)
        `);
        cliDb.prepare('DELETE FROM users').run();
        ins.run('cliadm', 1);
        ins.run('target', 0);
        ins.run('bystander', 0);
    } finally {
        cliDb.close();
    }
});

after(async () => {
    if (io) await new Promise((resolve) => io.close(() => resolve()));
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------ admin route

test('admin route: non-canonical ids are rejected with 400 and delete nobody', async () => {
    const token = signToken(boss);
    for (const id of INVALID_IDS) {
        const r = await del(id, token, passwordBody(boss));
        assert.equal(r.status, 400, `DELETE /api/admin/users/${id} must be 400, got ${r.status} ${JSON.stringify(r.json)}`);
        assert.ok(userExists(users.victim.id), `user ${users.victim.id} must survive id=${id}`);
        assert.equal(userExists(users.owner.id), true, `owner must survive id=${id}`);
    }
    assert.equal(userCount(), 5);
});

test('admin route: deleting a group owner transfers ownership and bumps the epoch', async () => {
    const groupId = addGroup('owner-group', users.owner.id, [{ id: users.bob.id, role: 'member' }]);
    const token = signToken(boss);

    const r = await del(users.owner.id, token, passwordBody(boss));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(userExists(users.owner.id), false, 'owner row deleted');

    const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
    assert.ok(group, 'group must survive its owner being deleted');

    const members = db.prepare('SELECT user_id, role, key_epoch FROM group_members WHERE group_id = ? ORDER BY user_id').all(groupId);
    assert.deepEqual(members.map((m) => m.user_id), [users.bob.id], 'only bob remains');
    assert.equal(members[0].role, 'owner', 'ownership transferred to bob');
    assert.equal(members[0].key_epoch, 4, 'epoch bumped for the remaining member');
});

test('admin route: a group whose only member is its owner is removed', async () => {
    const groupId = addGroup('solo-group', users.solo.id);
    const token = signToken(boss);

    const r = await del(users.solo.id, token, passwordBody(boss));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(userExists(users.solo.id), false);
    assert.equal(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId), undefined, 'solo-owned group removed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(groupId).n, 0);
});

// ------------------------------------------------------------------- CLI

test('CLI: non-canonical ids do not delete anyone', () => {
    for (const id of INVALID_IDS) {
        const r = runCli(['delete-user', id]);
        assert.notEqual(r.status, 0, `CLI delete-user ${id} must fail`);
        assert.match(r.stderr, /No user named|Invalid user id/, `CLI delete-user ${id} stderr: ${r.stderr}`);

        const check = new Database(cliDbPath, { readonly: true });
        try {
            assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3, `CLI delete-user ${id} must not delete anyone`);
            assert.ok(check.prepare("SELECT 1 FROM users WHERE username = 'target'").get(), `target must survive CLI delete-user ${id}`);
        } finally {
            check.close();
        }
    }
});

test('CLI: a valid username deletes the account and records a CLI audit row', () => {
    const r = runCli(['delete-user', 'target']);
    assert.equal(r.status, 0, `CLI delete-user target failed: ${r.stderr}`);
    assert.match(r.stdout, /Deleted "target"/);

    const check = new Database(cliDbPath, { readonly: true });
    try {
        assert.equal(check.prepare("SELECT 1 FROM users WHERE username = 'target'").get(), undefined, 'target deleted');
        assert.ok(check.prepare("SELECT 1 FROM users WHERE username = 'bystander'").get(), 'bystander kept');

        const audit = check.prepare("SELECT admin_id, action, details_json FROM admin_audit_log WHERE action = 'delete_user'").get();
        assert.ok(audit, 'delete_user audit row written');
        assert.equal(audit.admin_id, null, 'CLI actions have admin_id NULL');
        assert.equal(JSON.parse(audit.details_json).source, 'cli');
    } finally {
        check.close();
    }
});
