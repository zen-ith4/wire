// B2: the REAL server on a COPY of the base-built legacy database.
// Login (both schemes), kdf-params shapes, migration (atomic, CAS, single-use ticket),
// anti-downgrade, closed legacy login, same private key after migration.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { META, Database, assertFixtureUntouched, cleanupTmp, copyLegacyFixture } from './_fixture.mjs';
import { bootServer, cred, wrapIdentityV2, unwrapIdentityV2 } from './_server.mjs';

let srv, dir, dbPath;
const raw = () => new Database(dbPath, { readonly: true });
const rawW = () => new Database(dbPath);
const row = (sql, ...a) => { const d = raw(); try { return d.prepare(sql).get(...a); } finally { d.close(); } };

before(async () => {
    ({ dir, dbPath } = copyLegacyFixture());
    srv = await bootServer(dbPath, dir);
});
after(async () => { await srv?.stop(); cleanupTmp(); assertFixtureUntouched(); });

const legacyLogin = (u) => srv.call('POST', '/api/auth/login', { body: { username: u, password: META.passwords[u] } });

function migrationBody(user, ticket, { password = META.passwords[user], withIdentity = true, iterations = cred.KDF_ITERATIONS, salt = cred.newKdfSalt() } = {}) {
    const w = wrapIdentityV2(META.private_keys_pkcs8[user], META.public_keys[user], password, salt, iterations);
    return {
        salt, iterations, authKey: w.authKey, identity: w.identity,
        body: { ticket, auth_key: w.authKey, kdf_salt: salt, kdf_iterations: iterations, ...(withIdentity ? { identity: w.identity } : {}) },
    };
}

test('kdf-params: legacy -> {scheme:1}; unknown/inactive -> deterministic fake scheme-2 salt', async () => {
    const a = await srv.call('GET', '/api/auth/kdf-params?username=alice');
    assert.deepEqual(a.body, { scheme: 1 });
    const upper = await srv.call('GET', '/api/auth/kdf-params?username=ALICE');
    assert.deepEqual(upper.body, { scheme: 1 });

    const u1 = await srv.call('GET', '/api/auth/kdf-params?username=nobody-here');
    const u2 = await srv.call('GET', '/api/auth/kdf-params?username=nobody-here');
    assert.equal(u1.body.scheme, 2);
    assert.ok(cred.isValidKdfSalt(u1.body.salt));
    assert.equal(u1.body.iterations, cred.KDF_ITERATIONS);
    assert.deepEqual(u1.body, u2.body);
    const other = await srv.call('GET', '/api/auth/kdf-params?username=nobody-else');
    assert.notEqual(other.body.salt, u1.body.salt);

    const erin = await srv.call('GET', '/api/auth/kdf-params?username=erin'); // inactive
    assert.equal(erin.body.scheme, 2);
    assert.equal(erin.body.salt, cred.fakeKdfSalt('erin'));

    assert.equal((await srv.call('GET', '/api/auth/kdf-params')).status, 400);
});

test('legacy login: raw password works for scheme 1, hands out a ticket, records legacy_last_login_at', async () => {
    assert.equal(row('SELECT legacy_last_login_at AS t FROM users WHERE username = ?', 'frank').t, null);
    const r = await legacyLogin('frank');
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
    assert.equal(r.body.auth_scheme, 1);
    assert.ok(r.body.credential_migration.ticket.length >= 40);
    assert.ok(row('SELECT legacy_last_login_at AS t FROM users WHERE username = ?', 'frank').t);
    // only the hash is stored
    const t = row('SELECT ticket_hash FROM auth_migration_tickets WHERE user_id = ?', META.ids.frank);
    assert.equal(t.ticket_hash, crypto.createHash('sha256').update(r.body.credential_migration.ticket).digest('hex'));
    assert.ok(!JSON.stringify(row('SELECT * FROM auth_migration_tickets WHERE user_id = ?', META.ids.frank)).includes(r.body.credential_migration.ticket));

    const bad = await srv.call('POST', '/api/auth/login', { body: { username: 'frank', password: 'nope-nope-nope' } });
    assert.equal(bad.status, 401);
});

test('login forms: auth_key is refused for scheme 1; password+auth_key together is a 400', async () => {
    const authKey = cred.deriveCredentialsNode('whatever-whatever', cred.newKdfSalt()).authKey;
    const r = await srv.call('POST', '/api/auth/login', { body: { username: 'alice', auth_key: authKey } });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'Invalid credentials' });
    const both = await srv.call('POST', '/api/auth/login', { body: { username: 'alice', password: META.passwords.alice, auth_key: authKey } });
    assert.equal(both.status, 400);
});

test('migration validation failures change NOTHING and do not burn the ticket', async () => {
    const login = await legacyLogin('bob');
    const { token } = login.body;
    const { ticket } = login.body.credential_migration;
    const before = JSON.stringify(row('SELECT * FROM identity_keys WHERE user_id = ?', META.ids.bob));
    const userBefore = JSON.stringify(row('SELECT * FROM users WHERE id = ?', META.ids.bob));
    const post = (body) => srv.call('POST', '/api/auth/migrate-credentials', { token, body });

    // no token at all
    assert.equal((await srv.call('POST', '/api/auth/migrate-credentials', { body: {} })).status, 401);

    const ok = migrationBody('bob', ticket);
    assert.equal((await post({ ...ok.body, auth_key: 'short' })).status, 400);
    assert.equal((await post({ ...ok.body, kdf_salt: 'AAAA' })).status, 400);
    assert.equal((await post({ ...ok.body, kdf_iterations: 1000 })).status, 400);
    assert.equal((await post({ ...ok.body, identity: undefined })).status, 400, 'a v1 identity must be re-wrapped, not dropped');
    assert.equal((await post({ ...ok.body, identity: { ...ok.identity, salt: cred.newKdfSalt() } })).status, 400);
    assert.equal((await post({ ...ok.body, identity: { ...ok.identity, version: 1 } })).status, 400);
    assert.equal((await post({ ...ok.body, identity: { ...ok.identity, kdf: 'PBKDF2-SHA-256' } })).status, 400);
    const otherKey = crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x;
    const otherPub = Buffer.from(otherKey, 'base64url').toString('base64');
    const mism = await post({ ...ok.body, identity: { ...ok.identity, publicKey: otherPub } });
    assert.equal(mism.status, 409);
    assert.equal(mism.body.code, 'public_key_mismatch');
    const wrongTicket = await post({ ...ok.body, ticket: 'x'.repeat(43) });
    assert.equal(wrongTicket.status, 401);

    assert.equal(JSON.stringify(row('SELECT * FROM identity_keys WHERE user_id = ?', META.ids.bob)), before);
    assert.equal(JSON.stringify(row('SELECT * FROM users WHERE id = ?', META.ids.bob)), userBefore);
    assert.ok(row('SELECT 1 AS x FROM auth_migration_tickets WHERE user_id = ?', META.ids.bob), 'ticket survives validation failures');

    // expired ticket
    const d = rawW();
    d.prepare('UPDATE auth_migration_tickets SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, META.ids.bob);
    d.close();
    assert.equal((await post(ok.body)).status, 401);
    assert.equal(row('SELECT auth_scheme AS s FROM users WHERE id = ?', META.ids.bob).s, 1);
});

test('migration (alice, 100k-iteration v1 identity): scheme 2, same private key, v2 wrapper, ticket single-use, raw login dead', async () => {
    const login = await legacyLogin('alice');
    const { token } = login.body;
    const { ticket } = login.body.credential_migration;
    const m = migrationBody('alice', ticket);

    const r = await srv.call('POST', '/api/auth/migrate-credentials', { token, body: m.body });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const u = row('SELECT auth_scheme, kdf_salt, kdf_iterations, scheme_migrated_at, password_hash FROM users WHERE id = ?', META.ids.alice);
    assert.equal(u.auth_scheme, 2);
    assert.equal(u.kdf_salt, m.salt);
    assert.equal(u.kdf_iterations, cred.KDF_ITERATIONS);
    assert.ok(u.scheme_migrated_at);
    assert.ok(u.password_hash.startsWith('$2'));
    assert.notEqual(u.password_hash, '', 'hash is of the authKey');

    const id = row('SELECT * FROM identity_keys WHERE user_id = ?', META.ids.alice);
    assert.equal(id.version, 2);
    assert.equal(id.public_key, META.public_keys.alice, 'public key never changes');
    assert.equal(id.salt, m.salt);
    // same private key survives the re-wrap
    const restored = unwrapIdentityV2({
        encryptedPrivateKey: id.encrypted_private_key, iv: id.iv, salt: id.salt, kdfParams: JSON.parse(id.kdf_params),
    }, META.passwords.alice);
    assert.equal(restored, META.private_keys_pkcs8.alice);

    // nothing raw-verifiable is kept: the stored hash only verifies the authKey, not the password
    const bcrypt = (await import('node:module')).createRequire(import.meta.url)('bcrypt');
    assert.equal(await bcrypt.compare(META.passwords.alice, u.password_hash), false);
    assert.equal(await bcrypt.compare(m.authKey, u.password_hash), true);

    // single-use ticket
    assert.equal(row('SELECT COUNT(*) AS n FROM auth_migration_tickets WHERE user_id = ?', META.ids.alice).n, 0);
    const again = await srv.call('POST', '/api/auth/migrate-credentials', { token, body: m.body });
    assert.equal(again.status, 409);

    // anti-downgrade
    const rawLogin = await srv.call('POST', '/api/auth/login', { body: { username: 'alice', password: META.passwords.alice } });
    assert.equal(rawLogin.status, 401);
    const kdf = await srv.call('GET', '/api/auth/kdf-params?username=alice');
    assert.deepEqual(kdf.body, { scheme: 2, salt: m.salt, iterations: cred.KDF_ITERATIONS });
    const good = await srv.call('POST', '/api/auth/login', { body: { username: 'alice', auth_key: m.authKey } });
    assert.equal(good.status, 200);
    assert.equal(good.body.credential_migration, undefined);
    assert.equal(good.body.auth_scheme, 2);
    const wrongKey = cred.deriveCredentialsNode('another-password-123', m.salt).authKey;
    assert.equal((await srv.call('POST', '/api/auth/login', { body: { username: 'alice', auth_key: wrongKey } })).status, 401);
    // the authKey cannot be replayed as a raw password either
    assert.equal((await srv.call('POST', '/api/auth/login', { body: { username: 'alice', password: m.authKey } })).status, 401);

    // the DB trigger also forbids going back
    const d = rawW();
    assert.throws(() => d.prepare('UPDATE users SET auth_scheme = 1 WHERE id = ?').run(META.ids.alice));
    d.close();
});

test('concurrent migrations with the same ticket: exactly one wins, state stays consistent', async () => {
    const login = await legacyLogin('dave');
    const { token } = login.body;
    const { ticket } = login.body.credential_migration;
    const a = migrationBody('dave', ticket);
    const b = migrationBody('dave', ticket);
    const [ra, rb] = await Promise.all([
        srv.call('POST', '/api/auth/migrate-credentials', { token, body: a.body }),
        srv.call('POST', '/api/auth/migrate-credentials', { token, body: b.body }),
    ]);
    assert.equal([ra, rb].filter((x) => x.status === 200).length, 1);
    const winner = ra.status === 200 ? a : b;
    const u = row('SELECT auth_scheme, kdf_salt FROM users WHERE id = ?', META.ids.dave);
    assert.equal(u.auth_scheme, 2);
    assert.equal(u.kdf_salt, winner.salt);
    assert.equal(row('SELECT salt FROM identity_keys WHERE user_id = ?', META.ids.dave).salt, winner.salt, 'password and identity always from the same request');
});

test('account without identity (carol): migrates to (2,none); identity may be created once during migration', async () => {
    const login = await legacyLogin('carol');
    const { token } = login.body;
    const { ticket } = login.body.credential_migration;
    const salt = cred.newKdfSalt();
    const { authKey } = cred.deriveCredentialsNode(META.passwords.carol, salt);
    const r = await srv.call('POST', '/api/auth/migrate-credentials', {
        token, body: { ticket, auth_key: authKey, kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS },
    });
    assert.equal(r.status, 200);
    assert.equal(row('SELECT auth_scheme AS s FROM users WHERE id = ?', META.ids.carol).s, 2);
    assert.equal(row('SELECT COUNT(*) AS n FROM identity_keys WHERE user_id = ?', META.ids.carol).n, 0);
});

test('closed legacy login: indistinguishable from a wrong password, kdf-params unchanged', async () => {
    const d = rawW();
    d.prepare("UPDATE users SET legacy_login_closed = 1, legacy_login_closed_at = CURRENT_TIMESTAMP WHERE username = 'MixedCase'").run();
    d.prepare("UPDATE users SET legacy_login_closed = 1 WHERE username = 'bob'").run();
    d.close();
    const closed = await srv.call('POST', '/api/auth/login', { body: { username: 'bob', password: META.passwords.bob } });
    const wrong = await srv.call('POST', '/api/auth/login', { body: { username: 'bob', password: 'definitely-wrong' } });
    assert.equal(closed.status, 401);
    assert.deepEqual(closed.body, wrong.body);
    assert.deepEqual((await srv.call('GET', '/api/auth/kdf-params?username=bob')).body, { scheme: 1 });
});

test('register: auth_key path creates a scheme-2 account (server never sees the password); raw path creates scheme 1', async () => {
    const salt = cred.newKdfSalt();
    const { authKey } = cred.deriveCredentialsNode('a-long-new-password', salt);
    const bad = await srv.call('POST', '/api/auth/register', { body: { username: 'newuser', email: 'new@x.invalid', auth_key: 'short', kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS } });
    assert.equal(bad.status, 400);
    const both = await srv.call('POST', '/api/auth/register', { body: { username: 'newuser', email: 'new@x.invalid', auth_key: authKey, password: 'abcdefgh', kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS } });
    assert.equal(both.status, 400);
    const ok = await srv.call('POST', '/api/auth/register', { body: { username: 'newuser', email: 'new@x.invalid', auth_key: authKey, kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const u = row("SELECT auth_scheme, kdf_salt, kdf_iterations FROM users WHERE username = 'newuser'");
    assert.deepEqual({ ...u }, { auth_scheme: 2, kdf_salt: salt, kdf_iterations: cred.KDF_ITERATIONS });
    const login = await srv.call('POST', '/api/auth/login', { body: { username: 'newuser', auth_key: authKey } });
    assert.equal(login.status, 200);

    const legacy = await srv.call('POST', '/api/auth/register', { body: { username: 'olduser', email: 'old@x.invalid', password: 'legacy-client-pass' } });
    assert.equal(legacy.status, 201);
    assert.equal(row("SELECT auth_scheme AS s FROM users WHERE username = 'olduser'").s, 1);
});

test('a scheme-1 account whose raw password looks like an authKey still cannot log in via auth_key', async () => {
    const lookalike = 'A'.repeat(43);
    const reg = await srv.call('POST', '/api/auth/register', { body: { username: 'lookalike', email: 'l@x.invalid', password: lookalike } });
    assert.equal(reg.status, 201);
    const viaKey = await srv.call('POST', '/api/auth/login', { body: { username: 'lookalike', auth_key: lookalike } });
    assert.equal(viaKey.status, 401, 'the two login forms are never interchangeable');
    const viaRaw = await srv.call('POST', '/api/auth/login', { body: { username: 'lookalike', password: lookalike } });
    assert.equal(viaRaw.status, 200);
});
