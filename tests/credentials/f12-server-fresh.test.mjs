// B2: the REAL server on a FRESH database: new accounts are scheme 2 from the start.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Database, assertFixtureUntouched, cleanupTmp, tmpDir } from './_fixture.mjs';
import { bootServer, cred } from './_server.mjs';

let srv, dbPath;
before(async () => {
    const dir = tmpDir();
    dbPath = path.join(dir, 'fresh.db');
    srv = await bootServer(dbPath, dir);
});
after(async () => { await srv?.stop(); cleanupTmp(); assertFixtureUntouched(); });

test('fresh DB: register with auth_key, kdf-params serves the real salt, login works, raw password never does', async () => {
    const salt = cred.newKdfSalt();
    const { authKey } = cred.deriveCredentialsNode('fresh-account-password', salt);
    const reg = await srv.call('POST', '/api/auth/register', { body: { username: 'freshy', email: 'f@x.invalid', auth_key: authKey, kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS } });
    assert.equal(reg.status, 201);
    assert.deepEqual((await srv.call('GET', '/api/auth/kdf-params?username=freshy')).body, { scheme: 2, salt, iterations: cred.KDF_ITERATIONS });
    const ok = await srv.call('POST', '/api/auth/login', { body: { username: 'freshy', auth_key: authKey } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.credential_migration, undefined);
    assert.equal((await srv.call('POST', '/api/auth/login', { body: { username: 'freshy', password: 'fresh-account-password' } })).status, 401);
    assert.equal((await srv.call('POST', '/api/auth/login', { body: { username: 'freshy', password: authKey } })).status, 401);
    // a scheme-2 account cannot use the migrate endpoint
    const m = await srv.call('POST', '/api/auth/migrate-credentials', { token: ok.body.token, body: { ticket: 'x'.repeat(43), auth_key: authKey, kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS } });
    assert.equal(m.status, 409);
});

test('fresh DB: unknown user and wrong auth_key give the same answer', async () => {
    const k = cred.deriveCredentialsNode('x'.repeat(12), cred.newKdfSalt()).authKey;
    const a = await srv.call('POST', '/api/auth/login', { body: { username: 'freshy', auth_key: k } });
    const b = await srv.call('POST', '/api/auth/login', { body: { username: 'ghost', auth_key: k } });
    assert.equal(a.status, 401);
    assert.deepEqual(a, b);
});

test('fresh DB: schema has no legacy rows and no tickets', () => {
    const d = new Database(dbPath, { readonly: true });
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM users WHERE auth_scheme = 1').get().n, 0);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM auth_migration_tickets').get().n, 0);
    d.close();
});
