// B5: admin-created users (temporary password never seen by the server), the forced
// password change, the restricted password-change token ('pcr'), and the socket
// handshake rejecting pcr and media tokens. Real server on a COPY of the legacy DB.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { io as ioClient } from 'socket.io-client';
import { META, Database, ROOT, assertFixtureUntouched, cleanupTmp, copyLegacyFixture } from './_fixture.mjs';
import { bootServer, cred, changePasswordBody } from './_server.mjs';

let srv, dbPath, adminToken;
const row = (sql, ...a) => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const SECRET = 'x'.repeat(48);

before(async () => {
    const c = copyLegacyFixture();
    dbPath = c.dbPath;
    srv = await bootServer(dbPath, c.dir, { DM_E2EE_DEFAULT_MIN_VERSION: '2' });
    // an admin on the NEW scheme: register, then promote directly in the DB
    const salt = cred.newKdfSalt();
    const { authKey } = cred.deriveCredentialsNode('admin-account-password', salt);
    await srv.call('POST', '/api/auth/register', { body: { username: 'boss', email: 'boss@x.invalid', auth_key: authKey, kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS } });
    const d = new Database(dbPath); d.prepare("UPDATE users SET is_admin = 1 WHERE username = 'boss'").run(); d.close();
    adminToken = (await srv.call('POST', '/api/auth/login', { body: { username: 'boss', auth_key: authKey } })).body.token;
});
after(async () => { await srv?.stop(); cleanupTmp(); assertFixtureUntouched(); });

const tempBody = (username, tempPw, extra = {}) => {
    const salt = cred.newKdfSalt();
    const { authKey } = cred.deriveCredentialsNode(tempPw, salt);
    return { salt, authKey, body: { username, email: `${username}@x.invalid`, auth_key: authKey, kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS, is_admin: false, ...extra } };
};

function socketConnect(token) {
    return new Promise((resolve) => {
        const s = ioClient(srv.base, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 8000 });
        s.on('connect', () => { s.close(); resolve({ ok: true }); });
        s.on('connect_error', (e) => { s.close(); resolve({ ok: false, message: e.message }); });
    });
}

test('admin create: new scheme, must_change_password, no raw password accepted, non-admins refused', async () => {
    const t = tempBody('newhire', 'temporary-password-1');
    const r = await srv.call('POST', '/api/admin/users', { token: adminToken, body: t.body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const u = row("SELECT auth_scheme, must_change_password, kdf_salt, kdf_iterations, dm_e2ee_min_version FROM users WHERE username = 'newhire'");
    assert.deepEqual({ ...u }, { auth_scheme: 2, must_change_password: 1, kdf_salt: t.salt, kdf_iterations: cred.KDF_ITERATIONS, dm_e2ee_min_version: 2 });

    const raw = await srv.call('POST', '/api/admin/users', { token: adminToken, body: { username: 'rawuser', email: 'r@x.invalid', password: 'temporary-password-2', is_admin: false } });
    assert.equal(raw.status, 400);
    assert.equal(raw.body.code, 'raw_password_rejected');
    assert.equal(row("SELECT COUNT(*) AS n FROM users WHERE username = 'rawuser'").n, 0);

    const bad = await srv.call('POST', '/api/admin/users', { token: adminToken, body: { ...t.body, username: 'badcreds', email: 'b@x.invalid', auth_key: 'short' } });
    assert.equal(bad.status, 400);

    const user = await srv.call('POST', '/api/auth/login', { body: { username: 'newhire', auth_key: t.authKey } });
    const nonAdmin = await srv.call('POST', '/api/admin/users', { token: user.body.token, body: tempBody('sneaky', 'x'.repeat(14)).body });
    assert.ok([401, 403].includes(nonAdmin.status), 'a password-change token cannot create users');
});

test('first login with the temporary password yields ONLY the restricted token', async () => {
    const t = tempBody('hire2', 'temporary-password-3');
    await srv.call('POST', '/api/admin/users', { token: adminToken, body: t.body });
    const login = await srv.call('POST', '/api/auth/login', { body: { username: 'hire2', auth_key: t.authKey } });
    assert.equal(login.status, 200);
    assert.equal(login.body.requiresPasswordChange, true);
    assert.equal(login.body.credential_migration, undefined);
    const payload = jwt.decode(login.body.token);
    assert.equal(payload.typ, 'pcr');
    assert.ok(payload.exp - payload.iat <= 15 * 60);

    const tok = login.body.token;
    // every ordinary route refuses it
    for (const [m, url] of [['GET', '/api/me'], ['GET', '/api/dm/conversations'], ['GET', '/api/dm/unread-count'], ['GET', '/api/admin/users'], ['PUT', '/api/me/identity-key'], ['POST', '/api/me/identity-key/rotate'], ['PUT', '/api/me/accent-color'], ['GET', '/api/me/identity-key/1']]) {
        const r = await srv.call(m, url, { token: tok, body: m === 'GET' ? undefined : {} });
        assert.equal(r.status, 401, `${m} ${url} must refuse a password-change token (got ${r.status})`);
    }
    // the three routes of the forced change accept it
    assert.equal((await srv.call('GET', '/api/me/kdf-params', { token: tok })).status, 200);
    assert.equal((await srv.call('GET', '/api/me/identity-key', { token: tok })).status, 200);
});

test('socket handshake rejects the password-change token and media tokens, accepts a session token', async () => {
    const t = tempBody('hire3', 'temporary-password-4');
    await srv.call('POST', '/api/admin/users', { token: adminToken, body: t.body });
    const pcr = (await srv.call('POST', '/api/auth/login', { body: { username: 'hire3', auth_key: t.authKey } })).body.token;
    const id = row("SELECT id FROM users WHERE username = 'hire3'").id;
    const media = jwt.sign({ sub: id, id, typ: 'media', resType: 'dm', resId: 1 }, SECRET, { expiresIn: 60 });
    const media2 = jwt.sign({ sub: id, typ: 'media', resType: 'dm', resId: 1 }, SECRET, { expiresIn: 60 });

    assert.equal((await socketConnect(pcr)).ok, false, 'pcr token must not open a socket');
    assert.equal((await socketConnect(media)).ok, false, 'media token (even one that carries an id) must not open a socket');
    assert.equal((await socketConnect(media2)).ok, false);
    assert.equal((await socketConnect('garbage')).ok, false);
    assert.equal((await socketConnect(adminToken)).ok, true, 'control: a normal session token connects');
});

test('forced change: PUT /me/password with the restricted token, then a normal session; the token dies afterwards', async () => {
    const t = tempBody('hire4', 'temporary-password-5');
    await srv.call('POST', '/api/admin/users', { token: adminToken, body: t.body });
    const login = await srv.call('POST', '/api/auth/login', { body: { username: 'hire4', auth_key: t.authKey } });
    const session = { token: login.body.token, authKey: t.authKey, salt: t.salt };

    const c = changePasswordBody(session, 'my own chosen password');
    const r = await srv.call('PUT', '/api/me/password', { token: session.token, body: c.body });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const u = row("SELECT must_change_password AS m, kdf_salt FROM users WHERE username = 'hire4'");
    assert.equal(u.m, 0);
    assert.equal(u.kdf_salt, c.newSalt);

    // the restricted token is useless now, even for the routes it used to open
    assert.equal((await srv.call('GET', '/api/me/kdf-params', { token: session.token })).status, 401);
    // temporary credentials are dead, the new ones give a real session
    assert.equal((await srv.call('POST', '/api/auth/login', { body: { username: 'hire4', auth_key: t.authKey } })).status, 401);
    const real = await srv.call('POST', '/api/auth/login', { body: { username: 'hire4', auth_key: c.newAuthKey } });
    assert.equal(real.status, 200);
    assert.equal(real.body.requiresPasswordChange, undefined);
    assert.equal(jwt.decode(real.body.token).typ, undefined);
    assert.equal((await srv.call('GET', '/api/me', { token: real.body.token })).status, 200);
    assert.equal((await socketConnect(real.body.token)).ok, true);
});

test('a normal session token still works on the three forced-change routes (ordinary password change)', async () => {
    const salt = cred.newKdfSalt();
    const { authKey } = cred.deriveCredentialsNode('another long password', salt);
    await srv.call('POST', '/api/auth/register', { body: { username: 'ordinary', email: 'o@x.invalid', auth_key: authKey, kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS } });
    const tok = (await srv.call('POST', '/api/auth/login', { body: { username: 'ordinary', auth_key: authKey } })).body.token;
    assert.equal((await srv.call('GET', '/api/me/kdf-params', { token: tok })).status, 200);
    const c = changePasswordBody({ token: tok, authKey, salt }, 'yet another long password');
    assert.equal((await srv.call('PUT', '/api/me/password', { token: tok, body: c.body })).status, 200);
});

test('a pcr token for an account with NO pending change is refused', async () => {
    const id = row("SELECT id FROM users WHERE username = 'ordinary'").id;
    const stray = jwt.sign({ id, username: 'ordinary', typ: 'pcr' }, SECRET, { expiresIn: 60 });
    assert.equal((await srv.call('GET', '/api/me/kdf-params', { token: stray })).status, 401);
});
