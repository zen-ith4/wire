// B9: username rules for NEW accounts, case-insensitive lookup for existing ones,
// startup warning, admin audit endpoint, read-only audit script. Real server on a COPY
// of the legacy DB (which contains the mixed-case accounts 'Admin' and 'MixedCase').

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { META, Database, ROOT, assertFixtureUntouched, cleanupTmp, copyLegacyFixture, sha256File } from './_fixture.mjs';
import { bootServer, cred } from './_server.mjs';

const require = createRequire(import.meta.url);
const { validateNewUsername, usernameProblems } = require(path.join(ROOT, 'utils', 'username.js'));

test('rules: accepted names are normalized (trim + lowercase)', () => {
    for (const [raw, want] of [['  Alice  ', 'alice'], ['a.b-c_d', 'a.b-c_d'], ['USER42', 'user42'], ['abc', 'abc'], ['a'.repeat(32), 'a'.repeat(32)], ['a1b', 'a1b']]) {
        const r = validateNewUsername(raw);
        assert.equal(r.ok, true, raw);
        assert.equal(r.username, want);
    }
});

test('rules: rejected names', () => {
    const bad = ['', '  ', 'ab', 'a'.repeat(33), 'has space', 'tab\tname', 'émile', 'name!', 'a@b.c', '.leading', 'trailing.', '-lead', 'trail-', '_lead', 'trail_',
        'a..b', 'a__b', 'a--b', 'admin', 'ADMIN', ' Root ', 'system', 'support', 'wire', 'null', 'undefined', 'ab\u0000c', 'ａｄｍｉｎ'];
    for (const raw of bad) assert.equal(validateNewUsername(raw).ok, false, JSON.stringify(raw));
    assert.equal(validateNewUsername(undefined).ok, false);
    assert.equal(validateNewUsername(null).ok, false);
    assert.equal(validateNewUsername(42).ok, false); // coerced to "42": too short
});

test('rules: classifier reports why an existing name breaks them', () => {
    assert.deepEqual(usernameProblems('Admin'), ['uppercase', 'reserved']);
    assert.deepEqual(usernameProblems('MixedCase'), ['uppercase']);
    assert.deepEqual(usernameProblems('good.name'), []);
    assert.ok(usernameProblems('x y').includes('bad_characters'));
});

let srv, dbPath, adminToken, dir;
const row = (sql, ...a) => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const login = (username, password) => srv.call('POST', '/api/auth/login', { body: { username, password } });
const regBody = (username) => {
    const salt = cred.newKdfSalt();
    const { authKey } = cred.deriveCredentialsNode('a-long-enough-password', salt);
    return { authKey, body: { username, email: `${String(username).replace(/\W/g, '') || 'x'}@x.invalid`, auth_key: authKey, kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS } };
};

before(async () => {
    const c = copyLegacyFixture();
    dbPath = c.dbPath; dir = c.dir;
    srv = await bootServer(dbPath, c.dir);
    const d = new Database(dbPath); d.prepare("UPDATE users SET is_admin = 1 WHERE username = 'alice'").run(); d.close();
    adminToken = (await login('alice', META.passwords.alice)).body.token;
});
after(async () => { await srv?.stop(); cleanupTmp(); assertFixtureUntouched(); });

test('existing mixed-case accounts log in with any casing (legacy login)', async () => {
    for (const typed of ['Admin', 'admin', 'ADMIN', ' Admin ']) {
        const r = await login(typed, META.passwords.Admin);
        assert.equal(r.status, 200, `${typed}: ${JSON.stringify(r.body)}`);
        assert.ok(r.body.token);
    }
    for (const typed of ['MixedCase', 'mixedcase', 'MIXEDCASE']) {
        assert.equal((await login(typed, META.passwords.MixedCase)).status, 200, typed);
    }
    assert.equal((await login('Admin', 'wrong-password-here')).status, 401);
    assert.equal(row("SELECT username FROM users WHERE id = ?", META.ids.Admin).username, 'Admin', 'stored name untouched');
});

test('kdf-params resolves mixed-case accounts case-insensitively and still hides unknown ones', async () => {
    const a = await srv.call('GET', '/api/auth/kdf-params?username=Admin');
    const b = await srv.call('GET', '/api/auth/kdf-params?username=ADMIN');
    assert.deepEqual(a.body, { scheme: 1 });
    assert.deepEqual(b.body, a.body);
    const unknown = await srv.call('GET', '/api/auth/kdf-params?username=nobody-here');
    assert.equal(unknown.body.scheme, 2);
    assert.equal(unknown.body.salt, cred.fakeKdfSalt('nobody-here'));
});

test('registration: invalid names rejected, valid names stored lowercase, case-variant duplicates refused', async () => {
    // POST /register is limited to 5 attempts per IP, so only three bad names go through it here
    // (the full list runs through the admin route below, which uses the same rules)
    for (const name of ['ab', 'a..b', 'Admin']) {
        const r = await srv.call('POST', '/api/auth/register', { body: regBody(name).body });
        assert.equal(r.status, 400, `${name} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    const ok = await srv.call('POST', '/api/auth/register', { body: regBody('New.User-1').body });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.ok(row("SELECT id FROM users WHERE username = 'new.user-1'"));
    assert.equal(row("SELECT COUNT(*) AS n FROM users WHERE username = 'New.User-1'").n, 0);

    // 'MIXEDCASE' must not become a second account next to the existing 'MixedCase'
    const dup = await srv.call('POST', '/api/auth/register', { body: { ...regBody('MIXEDCASE').body, email: 'other@x.invalid' } });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(row("SELECT COUNT(*) AS n FROM users WHERE username = 'mixedcase' COLLATE NOCASE").n, 1);
});

test('admin creation uses the same rules and the same duplicate check', async () => {
    const mk = (username) => ({ ...regBody(username).body, username, is_admin: false });
    for (const name of ['a b', 'Support', 'ab', '-bad', 'x'.repeat(40), 'with space', 'a__b', 'trail.']) {
        const bad = await srv.call('POST', '/api/admin/users', { token: adminToken, body: mk(name) });
        assert.equal(bad.status, 400, name);
    }
    const dup = await srv.call('POST', '/api/admin/users', { token: adminToken, body: { ...mk('ADMIN2'), username: 'Mixedcase' } });
    assert.equal(dup.status, 409);
    const ok = await srv.call('POST', '/api/admin/users', { token: adminToken, body: mk('Fresh.Hire') });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.ok(row("SELECT id FROM users WHERE username = 'fresh.hire'"));
});

test('audit endpoint reports existing accounts that break the rules; admins only; changes nothing', async () => {
    const before = row('SELECT COUNT(*) AS n FROM users').n;
    const r = await srv.call('GET', '/api/admin/usernames/audit', { token: adminToken });
    assert.equal(r.status, 200);
    const byName = Object.fromEntries(r.body.invalid.map((u) => [u.username, u.problems]));
    assert.deepEqual(byName.Admin, ['uppercase', 'reserved']);
    assert.deepEqual(byName.MixedCase, ['uppercase']);
    assert.equal(byName.alice, undefined);
    assert.deepEqual(r.body.case_collisions, []);
    assert.equal(row('SELECT COUNT(*) AS n FROM users').n, before);

    const carol = (await login('carol', META.passwords.carol)).body.token;
    for (const token of [carol, undefined]) {
        const x = await srv.call('GET', '/api/admin/usernames/audit', { token });
        assert.ok([401, 403].includes(x.status));
    }
});

test('startup logs a warning that names the audit endpoint and the script, without usernames', async () => {
    const log = srv.log();
    assert.match(log, /\[usernames\] \d+ existing account\(s\) do not meet the current username rules/);
    assert.match(log, /audit-usernames\.mjs/);
    assert.ok(!/\[usernames\].*MixedCase/.test(log));
});

test('case collision: the exact lowercase account wins at login, both are reported', async () => {
    const d = new Database(dbPath);
    const alice = d.prepare("SELECT * FROM users WHERE username = 'alice'").get();
    // a legacy-era clone that differs only by case ('ALICE'), as an older build could have created
    d.prepare(`INSERT INTO users (username, email, password_hash, is_admin, is_active) VALUES ('ALICE', 'alice2@x.invalid', ?, 0, 1)`).run(alice.password_hash);
    d.close();

    const r = await srv.call('GET', '/api/admin/usernames/audit', { token: adminToken });
    assert.equal(r.body.case_collisions.length, 1);
    assert.deepEqual(r.body.case_collisions[0].map((x) => x.username).sort(), ['ALICE', 'alice']);

    const l = await login('ALICE', META.passwords.alice);
    assert.equal(l.status, 200);
    const who = await srv.call('GET', '/api/me', { token: l.body.token });
    assert.equal(who.body.username ?? who.body.user?.username, 'alice');
});

test('audit script: read-only, reports the same accounts, does not modify the database', async () => {
    const before = sha256File(dbPath);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'audit-usernames.mjs'), dbPath], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"Admin".*uppercase, reserved/);
    assert.match(r.stdout, /"MixedCase".*uppercase/);
    assert.match(r.stdout, /COLLISION/);
    assert.equal(sha256File(dbPath), before, 'script must not change the file');
});
