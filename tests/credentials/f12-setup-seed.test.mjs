// B6: the two places where the SERVER HOST is handed a plaintext password by its operator
// (DEFAULT_ADMIN_PASS seed, first-run setup wizard) must create ordinary scheme-2 accounts.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { META, Database, ROOT, assertFixtureUntouched, cleanupTmp, copyLegacyFixture, tmpDir } from './_fixture.mjs';
import { bootServer, cred } from './_server.mjs';

after(() => { cleanupTmp(); assertFixtureUntouched(); });

const row = (p, sql, ...a) => { const d = new Database(p, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const count = (p, sql, ...a) => row(p, sql, ...a).n;

test('seed on a fresh DB: scheme-2 admin (lowercased) that logs in with the derived authKey', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'seed.db');
    const pw = 'operator supplied password';
    const srv = await bootServer(dbPath, dir, { DEFAULT_ADMIN_USER: 'SeedAdmin', DEFAULT_ADMIN_PASS: pw });
    try {
        const u = row(dbPath, "SELECT username, auth_scheme, kdf_salt, kdf_iterations, is_admin FROM users");
        assert.equal(u.username, 'seedadmin');
        assert.equal(u.auth_scheme, 2);
        assert.equal(u.is_admin, 1);
        assert.equal(u.kdf_iterations, cred.KDF_ITERATIONS);
        assert.ok(cred.isValidKdfSalt(u.kdf_salt));

        const params = await srv.call('GET', '/api/auth/kdf-params?username=SeedAdmin');
        assert.deepEqual(params.body, { scheme: 2, salt: u.kdf_salt, iterations: cred.KDF_ITERATIONS });
        const ok = await srv.call('POST', '/api/auth/login', { body: { username: 'seedadmin', auth_key: cred.deriveCredentialsNode(pw, u.kdf_salt).authKey } });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.is_admin, true);
        assert.equal((await srv.call('POST', '/api/auth/login', { body: { username: 'seedadmin', password: pw } })).status, 401, 'raw password never accepted for the seeded admin');
    } finally { await srv.stop(); }
});

test('seed on the legacy copy: an existing mixed-case "Admin" is kept as is, no second admin appears (any case)', async () => {
    for (const seedName of ['Admin', 'admin', 'ADMIN']) {
        const { dir, dbPath } = copyLegacyFixture();
        const srv = await bootServer(dbPath, dir, { DEFAULT_ADMIN_USER: seedName, DEFAULT_ADMIN_PASS: 'another operator password' });
        await srv.stop();
        assert.equal(count(dbPath, "SELECT COUNT(*) AS n FROM users WHERE lower(username) = 'admin'"), 1, `seed name ${seedName}`);
        const a = row(dbPath, "SELECT username, auth_scheme FROM users WHERE lower(username) = 'admin'");
        assert.deepEqual({ ...a }, { username: 'Admin', auth_scheme: 1 }, 'the legacy account is untouched');
        assert.equal(count(dbPath, 'SELECT COUNT(*) AS n FROM users'), Object.keys(META.passwords).length);
    }
});

test('setup wizard (real prompts, copied tree): creates a scheme-2 admin; refuses < 12 characters', async () => {
    // The wizard writes .env next to the sources, so run it in a throw-away copy of the tree.
    const dir = tmpDir('wire-wizard-');
    const tree = path.join(dir, 'app');
    fs.mkdirSync(tree);
    for (const entry of fs.readdirSync(ROOT)) {
        if (['node_modules', '.git', 'tests', 'data.db'].includes(entry) || entry.endsWith('.db')) continue;
        fs.cpSync(path.join(ROOT, entry), path.join(tree, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'));
    const dbPath = path.join(dir, 'wizard.db');

    const env = { ...process.env, DB_PATH: dbPath, USER_DATA_ROOT: path.join(dir, 'ud'), JWT_SECRET: 'x'.repeat(48), NODE_ENV: 'test', EMAIL_ENABLED: 'false', BCRYPT_ROUNDS: '4', ALLOWED_SUBNET: '127.0.0.0/8', HOST: '127.0.0.1', PORT: String(39000 + Math.floor(Math.random() * 900)) };
    delete env.SETUP_COMPLETED;
    delete env.DEFAULT_ADMIN_USER; delete env.DEFAULT_ADMIN_PASS;

    const child = spawn(process.execPath, ['server.js'], { cwd: tree, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const goodPw = 'wizard admin password';
    // Prompts are answered strictly in order (one answer per prompt).
    const steps = [
        [/Choice \[1\/2\]: $/, '2'],
        [/WireGuard IP Address \[[^\]]*\]: $/, '127.0.0.1'],
        [/Port \[[^\]]*\]: $/, env.PORT],
        [/Enable HTTPS\? \[Y\/n\]: $/, 'n'],
        [/Admin username: $/, 'WizAdmin'],
        [/Admin email: $/, 'wiz@x.invalid'],
        [/Admin password: $/, 'short-pw'],
        [/Confirm admin password: $/, 'short-pw'],
        [/Admin password: $/, goodPw],
        [/Confirm admin password: $/, goodPw],
        [/Apply configuration and continue\? \[y\/N\]: $/, 'y'],
    ];
    let step = 0;
    const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    child.stdout.on('data', (d) => {
        out += d;
        if (step < steps.length && steps[step][0].test(plain().trimEnd() + ' ')) {
            const answer = steps[step][1];
            step++;
            child.stdin.write(answer + '\n');
        }
    });
    child.stderr.on('data', (d) => { out += d; });

    try {
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('wizard/server did not finish:\n' + plain().slice(-1500))), 90000);
        const iv = setInterval(() => { if (out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); resolve(); } }, 100);
        child.once('exit', () => { if (!out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); reject(new Error('exited early:\n' + out.slice(-1500))); } });
    });
    } finally { child.kill('SIGKILL'); }

    assert.match(plain(), /at least 12 characters/, 'a short password is refused by the wizard');
    const u = row(dbPath, "SELECT username, auth_scheme, kdf_salt, kdf_iterations, is_admin, password_hash FROM users");
    assert.equal(u.username, 'wizadmin');
    assert.equal(u.auth_scheme, 2);
    assert.equal(u.is_admin, 1);
    assert.equal(u.kdf_iterations, cred.KDF_ITERATIONS);
    const { authKey } = cred.deriveCredentialsNode(goodPw, u.kdf_salt);
    const bcrypt = (await import('node:module')).createRequire(import.meta.url)('bcrypt');
    assert.equal(await bcrypt.compare(authKey, u.password_hash), true);
    assert.equal(await bcrypt.compare(goodPw, u.password_hash), false, 'the raw password is not what is stored');
});
