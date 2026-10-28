// B8: admin tools for the credential migration (status, close/reopen the legacy login,
// bulk-close of inactive unmigrated accounts). Real server on a COPY of the legacy DB.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { META, Database, assertFixtureUntouched, cleanupTmp, copyLegacyFixture } from './_fixture.mjs';
import { bootServer, migrateLegacyUser } from './_server.mjs';

let srv, dbPath, adminToken;
const row = (sql, ...a) => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const exec = (sql, ...a) => { const d = new Database(dbPath); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const legacyLogin = (username, password) => srv.call('POST', '/api/auth/login', { body: { username, password } });

before(async () => {
    const c = copyLegacyFixture();
    dbPath = c.dbPath;
    srv = await bootServer(dbPath, c.dir);
    // The fixture's own admin is mixed-case ('Admin'); login of mixed-case accounts is B9's
    // job (NOCASE lookup), so promote the lowercase account 'alice' in the copy instead.
    exec("UPDATE users SET is_admin = CASE WHEN username = 'alice' THEN 1 ELSE 0 END");
    const r = await legacyLogin('alice', 'alice-legacy-pass');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    adminToken = r.body.token;
});
after(async () => { await srv?.stop(); cleanupTmp(); assertFixtureUntouched(); });

const call = (m, url, body, token = adminToken) => srv.call(m, url, { token, body });

test('status: summary and per-user scheme; users list carries the new fields', async () => {
    const r = await call('GET', '/api/admin/credentials/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.total, 8);
    assert.equal(r.body.summary.migrated, 0);
    assert.equal(r.body.summary.legacy_open, 8);
    assert.equal(r.body.summary.legacy_closed, 0);
    const list = await call('GET', '/api/admin/users');
    const frank = list.body.find((u) => u.username === 'frank');
    assert.equal(frank.auth_scheme, 1);
    assert.equal(frank.legacy_login_closed, 0);
    assert.equal(frank.must_change_password, 0);
    // no secrets in either output
    for (const body of [r.body, list.body]) {
        const s = JSON.stringify(body);
        assert.ok(!/password|auth_key|kdf_salt|ticket/i.test(s.replace(/must_change_password/g, '')), 'no credential material in admin output');
    }
});

test('non-admins and anonymous callers cannot use any of the tools', async () => {
    const alice = (await legacyLogin('carol', 'carol-legacy-pass')).body.token; // ordinary user
    for (const [m, url, body] of [
        ['GET', '/api/admin/credentials/status'],
        ['GET', '/api/admin/credentials/legacy-login/inactive'],
        ['POST', '/api/admin/credentials/legacy-login/close-inactive', { days: 90, confirm_count: 0 }],
        ['PUT', `/api/admin/users/${META.ids.bob}/legacy-login`, { closed: true }],
    ]) {
        for (const token of [alice, undefined]) {
            const r = await srv.call(m, url, { token, body });
            assert.ok([401, 403].includes(r.status), `${m} ${url} -> ${r.status}`);
        }
    }
    assert.equal(row('SELECT legacy_login_closed AS c FROM users WHERE id = ?', META.ids.bob).c, 0);
});

test('preview: only dormant unmigrated non-admin active accounts; changes nothing', async () => {
    const r = await call('GET', '/api/admin/credentials/legacy-login/inactive?days=90');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.users.map((u) => u.username), ['frank']); // admin, erin (inactive) and recent accounts excluded
    assert.equal(r.body.count, 1);
    assert.equal(row('SELECT legacy_login_closed AS c FROM users WHERE username = ?', 'frank').c, 0);
    for (const days of ['0', '-1', 'abc', '99999', '1.5']) {
        assert.equal((await call('GET', `/api/admin/credentials/legacy-login/inactive?days=${days}`)).status, 400, days);
    }
});

test('bulk close needs the exact count; mismatch changes nothing', async () => {
    for (const confirm_count of [0, 2, '1', undefined, null]) {
        const r = await call('POST', '/api/admin/credentials/legacy-login/close-inactive', { days: 90, confirm_count });
        assert.equal(r.status, 409, String(confirm_count));
        assert.equal(r.body.code, 'count_mismatch');
        assert.equal(r.body.count, 1);
    }
    assert.equal(row('SELECT legacy_login_closed AS c FROM users WHERE username = ?', 'frank').c, 0);
});

test('bulk close: frank closed (ticket dropped), others untouched, closed login = generic 401', async () => {
    const ticketLogin = await legacyLogin('frank', 'frank-legacy-pass'); // gets a ticket
    assert.equal(ticketLogin.status, 200);
    assert.ok(row('SELECT COUNT(*) AS n FROM auth_migration_tickets WHERE user_id = ?', META.ids.frank).n > 0);
    exec("UPDATE users SET legacy_last_login_at = NULL WHERE username = 'frank'"); // stay dormant for the test

    const r = await call('POST', '/api/admin/credentials/legacy-login/close-inactive', { days: 90, confirm_count: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.closed, 1);
    assert.equal(row('SELECT COUNT(*) AS n FROM auth_migration_tickets WHERE user_id = ?', META.ids.frank).n, 0);
    assert.equal(row('SELECT COUNT(*) AS n FROM users WHERE legacy_login_closed = 1').n, 1);

    const wrong = await legacyLogin('frank', 'not-the-password');
    const closed = await legacyLogin('frank', 'frank-legacy-pass');
    assert.equal(closed.status, 401);
    assert.deepEqual(closed.body, wrong.body, 'closed account answers exactly like a wrong password');

    const status = await call('GET', '/api/admin/credentials/status');
    assert.equal(status.body.summary.legacy_closed, 1);
    assert.equal(status.body.summary.legacy_open, 7);
});

test('reopen restores the legacy login', async () => {
    const r = await call('PUT', `/api/admin/users/${META.ids.frank}/legacy-login`, { closed: false });
    assert.equal(r.status, 200);
    assert.equal(row('SELECT legacy_login_closed AS c, legacy_login_closed_at AS t FROM users WHERE id = ?', META.ids.frank).t, null);
    assert.equal((await legacyLogin('frank', 'frank-legacy-pass')).status, 200);
});

test('single close/reopen: validation, self refused, unknown user, migrated account refused', async () => {
    const id = META.ids.bob;
    assert.equal((await call('PUT', `/api/admin/users/${id}/legacy-login`, {})).status, 400);
    assert.equal((await call('PUT', `/api/admin/users/${id}/legacy-login`, { closed: 'yes' })).status, 400);
    assert.equal((await call('PUT', `/api/admin/users/${META.ids.alice}/legacy-login`, { closed: true })).status, 400);
    assert.equal((await call('PUT', '/api/admin/users/99999/legacy-login', { closed: true })).status, 404);
    assert.equal((await call('PUT', '/api/admin/users/abc/legacy-login', { closed: true })).status, 400);

    const ok = await call('PUT', `/api/admin/users/${id}/legacy-login`, { closed: true });
    assert.equal(ok.status, 200);
    assert.equal((await legacyLogin('bob', 'bob-legacy-pass')).status, 401);
    await call('PUT', `/api/admin/users/${id}/legacy-login`, { closed: false });

    // an account that has migrated (through the real path) has nothing to close
    await migrateLegacyUser(srv, META, 'bob');
    const refused = await call('PUT', `/api/admin/users/${id}/legacy-login`, { closed: true });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'not_legacy');
});
