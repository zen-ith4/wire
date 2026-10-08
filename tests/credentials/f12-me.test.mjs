// B3: change password (scheme 2 only, fresh salt, atomic with the identity re-wrap),
// write-once identity creation, explicit CAS-protected key rotation.
// Real server on a COPY of the base-built legacy database.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { META, Database, assertFixtureUntouched, cleanupTmp, copyLegacyFixture } from './_fixture.mjs';
import { bootServer, cred, wrapIdentityV2, unwrapIdentityV2, migrateLegacyUser, changePasswordBody } from './_server.mjs';

let srv, dir, dbPath;
const rawW = () => new Database(dbPath);
const row = (sql, ...a) => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const all = (sql, ...a) => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };

before(async () => {
    ({ dir, dbPath } = copyLegacyFixture());
    srv = await bootServer(dbPath, dir);
});
after(async () => { await srv?.stop(); cleanupTmp(); assertFixtureUntouched(); });

const putPw = (s, body) => srv.call('PUT', '/api/me/password', { token: s.token, body });
const login = (u, authKey) => srv.call('POST', '/api/auth/login', { body: { username: u, auth_key: authKey } });
const newX25519 = () => {
    const kp = crypto.generateKeyPairSync('x25519');
    return {
        pkcs8: kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        pub: Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
    };
};

test('change password: success re-wraps the SAME private key under a fresh salt; old credentials die', async () => {
    const s = await migrateLegacyUser(srv, META, 'alice');
    const before = row('SELECT * FROM identity_keys WHERE user_id = ?', META.ids.alice);
    const c = changePasswordBody(s, 'alice-brand-new-password', META.private_keys_pkcs8.alice, META.public_keys.alice);
    const r = await putPw(s, c.body);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const u = row('SELECT kdf_salt, kdf_iterations, auth_scheme FROM users WHERE id = ?', META.ids.alice);
    assert.equal(u.kdf_salt, c.newSalt);
    assert.notEqual(u.kdf_salt, s.salt);
    assert.equal(u.auth_scheme, 2);

    const id = row('SELECT * FROM identity_keys WHERE user_id = ?', META.ids.alice);
    assert.equal(id.public_key, before.public_key, 'public key unchanged');
    assert.equal(id.salt, c.newSalt, 'identity wrapped under the account salt');
    const wrapped = { encryptedPrivateKey: id.encrypted_private_key, iv: id.iv, salt: id.salt, kdfParams: JSON.parse(id.kdf_params) };
    assert.equal(unwrapIdentityV2(wrapped, 'alice-brand-new-password'), META.private_keys_pkcs8.alice);
    assert.throws(() => unwrapIdentityV2(wrapped, META.passwords.alice), 'old password must not unwrap the new wrapper');

    assert.equal((await login('alice', s.authKey)).status, 401, 'old authKey is dead');
    assert.equal((await login('alice', c.newAuthKey)).status, 200);
    const kdf = await srv.call('GET', '/api/auth/kdf-params?username=alice');
    assert.equal(kdf.body.salt, c.newSalt);
});

test('change password: rejects raw passwords, wrong current key, salt reuse, missing/misbound identity', async () => {
    const s = await migrateLegacyUser(srv, META, 'bob');
    const ok = changePasswordBody(s, 'bob-brand-new-password', META.private_keys_pkcs8.bob, META.public_keys.bob);
    const snap = () => JSON.stringify([row('SELECT * FROM users WHERE id = ?', META.ids.bob), row('SELECT * FROM identity_keys WHERE user_id = ?', META.ids.bob)]);
    const before = snap();

    const raw = await putPw(s, { current_password: META.passwords.bob, new_password: 'whatever-whatever' });
    assert.equal(raw.status, 400);
    assert.equal(raw.body.code, 'raw_password_rejected');

    assert.equal((await putPw(s, { ...ok.body, current_auth_key: cred.deriveCredentialsNode('not-the-password', s.salt).authKey })).status, 401);
    assert.equal((await putPw(s, { ...ok.body, new_auth_key: 'short' })).status, 400);
    assert.equal((await putPw(s, changePasswordBody(s, 'x-x-x-x-x-x-x-x', META.private_keys_pkcs8.bob, META.public_keys.bob, { keepSalt: true }).body)).status, 400, 'salt must be fresh');
    assert.equal((await putPw(s, { ...ok.body, identity: undefined })).status, 400, 'identity required when the account has one');
    assert.equal((await putPw(s, { ...ok.body, identity: { ...ok.identity, salt: s.salt } })).status, 400, 'identity must use the NEW salt');
    assert.equal((await putPw(s, { ...ok.body, identity: { ...ok.identity, version: 1 } })).status, 400);
    assert.equal(snap(), before, 'every rejection left the database untouched');

    // atomicity: identity update failing rolls the password change back
    const d = rawW();
    d.exec("CREATE TRIGGER t_boom BEFORE UPDATE ON identity_keys BEGIN SELECT RAISE(ABORT, 'boom'); END");
    d.close();
    const boom = await putPw(s, ok.body);
    assert.equal(boom.status, 500);
    const d2 = rawW(); d2.exec('DROP TRIGGER t_boom'); d2.close();
    assert.equal(snap(), before, 'password not changed when the identity could not be re-wrapped');
    assert.equal((await login('bob', s.authKey)).status, 200);
    assert.equal((await putPw(s, ok.body)).status, 200, 'and it works once the failure is gone');
});

test('change password: a legacy (scheme 1) account must migrate first', async () => {
    const l = await srv.call('POST', '/api/auth/login', { body: { username: 'frank', password: META.passwords.frank } });
    const body = changePasswordBody({ authKey: cred.deriveCredentialsNode('x'.repeat(12), cred.newKdfSalt()).authKey, salt: cred.newKdfSalt() }, 'frank-new-pass-123', META.private_keys_pkcs8.frank, META.public_keys.frank).body;
    const r = await srv.call('PUT', '/api/me/password', { token: l.body.token, body });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'migrate_first');
});

test('change password without an identity (carol): works; inventing an identity here is refused', async () => {
    const s = await migrateLegacyUser(srv, META, 'carol', { withIdentity: false });
    const k = newX25519();
    const withId = changePasswordBody(s, 'carol-new-password-1', k.pkcs8, k.pub);
    assert.equal((await putPw(s, withId.body)).status, 400);
    const plain = changePasswordBody(s, 'carol-new-password-2');
    assert.equal((await putPw(s, plain.body)).status, 200);
    assert.equal(row('SELECT COUNT(*) AS n FROM identity_keys WHERE user_id = ?', META.ids.carol).n, 0);
    s.authKey = plain.newAuthKey; s.salt = plain.newSalt;
});

test('migration without an identity is refused for an account that HAS a v1 identity (dave); nothing is deleted', async () => {
    await assert.rejects(migrateLegacyUser(srv, META, 'dave', { withIdentity: false }), /400/);
    assert.equal(row('SELECT auth_scheme AS s FROM users WHERE id = ?', META.ids.dave).s, 1);
    assert.equal(row('SELECT version FROM identity_keys WHERE user_id = ?', META.ids.dave).version, 1);
});

test('write-once creation on an account with no identity (carol), refusing a second write and wrong wrappers', async () => {
    // carol: scheme 2, no identity. She logs in with her new key.
    const salt = row('SELECT kdf_salt FROM users WHERE id = ?', META.ids.carol).kdf_salt;
    const l = await login('carol', cred.deriveCredentialsNode('carol-new-password-2', salt).authKey);
    assert.equal(l.status, 200);
    const token = l.body.token;
    const k = newX25519();
    const w = wrapIdentityV2(k.pkcs8, k.pub, 'carol-new-password-2', salt);
    const put = (body) => srv.call('PUT', '/api/me/identity-key', { token, body });

    assert.equal((await put({ ...w.identity, version: 1, kdf: 'PBKDF2-SHA-256' })).status, 400, 'v1 wrapper refused for a scheme-2 account');
    assert.equal((await put({ ...w.identity, salt: cred.newKdfSalt() })).status, 400, 'wrapper must use the account salt');
    assert.equal((await put({ ...w.identity, publicKey: 'AAAA' })).status, 400);
    assert.equal((await put(w.identity)).status, 200);

    const k2 = newX25519();
    const w2 = wrapIdentityV2(k2.pkcs8, k2.pub, 'carol-new-password-2', salt);
    const again = await put(w2.identity);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'identity_exists');
    assert.equal(row('SELECT public_key FROM identity_keys WHERE user_id = ?', META.ids.carol).public_key, k.pub, 'first key stays');

    const g = await srv.call('GET', '/api/me/identity-key', { token });
    assert.equal(g.body.version, 2);
    assert.ok(g.body.updatedAt);
});

test('PUT /me/identity-key on a legacy (scheme 1) account: only the v1 wrapper, still write-once', async () => {
    const reg = await srv.call('POST', '/api/auth/register', { body: { username: 'legacynew', email: 'ln@x.invalid', password: 'legacy-new-password' } });
    const token = reg.body.token;
    const k = newX25519();
    const v2 = wrapIdentityV2(k.pkcs8, k.pub, 'legacy-new-password', cred.newKdfSalt());
    assert.equal((await srv.call('PUT', '/api/me/identity-key', { token, body: v2.identity })).status, 400, '(scheme 1, v2) is not a legal state');
    const v1 = { publicKey: k.pub, encryptedPrivateKey: v2.identity.encryptedPrivateKey, kdf: 'PBKDF2-SHA-256', kdfParams: { iterations: 600000, hash: 'SHA-256' }, salt: cred.newKdfSalt(), iv: v2.identity.iv, version: 1 };
    assert.equal((await srv.call('PUT', '/api/me/identity-key', { token, body: v1 })).status, 200);
    assert.equal((await srv.call('PUT', '/api/me/identity-key', { token, body: v1 })).status, 409);
});

test('rotation: needs the password, CAS on key + updated_at, logs every rotation, no UI needed', async () => {
    const s = await migrateLegacyUser(srv, META, 'frank');
    const cur = await srv.call('GET', '/api/me/identity-key', { token: s.token });
    const k = newX25519();
    const w = wrapIdentityV2(k.pkcs8, k.pub, s.password, s.salt);
    const body = { current_auth_key: s.authKey, expected_public_key: cur.body.publicKey, expected_updated_at: cur.body.updatedAt, identity: w.identity };
    const rot = (b) => srv.call('POST', '/api/me/identity-key/rotate', { token: s.token, body: b });

    assert.equal((await srv.call('POST', '/api/me/identity-key/rotate', { body })).status, 401, 'needs a session');
    assert.equal((await rot({ ...body, current_auth_key: undefined })).status, 400);
    assert.equal((await rot({ ...body, current_auth_key: cred.deriveCredentialsNode('nope-nope-nope', s.salt).authKey })).status, 401);
    assert.equal((await rot({ ...body, expected_public_key: META.public_keys.alice })).status, 409);
    assert.equal((await rot({ ...body, expected_updated_at: '2000-01-01 00:00:00' })).status, 409);
    assert.equal((await rot({ ...body, identity: { ...w.identity, salt: cred.newKdfSalt() } })).status, 400);
    assert.equal((await rot({ ...body, identity: { ...w.identity, publicKey: cur.body.publicKey } })).status, 400, 'same key is not a rotation');
    assert.equal(row('SELECT public_key FROM identity_keys WHERE user_id = ?', META.ids.frank).public_key, META.public_keys.frank, 'rejections changed nothing');
    assert.equal(all('SELECT * FROM identity_key_rotations WHERE user_id = ?', META.ids.frank).length, 0);

    const ok = await rot(body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const id = row('SELECT * FROM identity_keys WHERE user_id = ?', META.ids.frank);
    assert.equal(id.public_key, k.pub);
    assert.equal(id.version, 2);
    const log = all('SELECT old_public_key, new_public_key FROM identity_key_rotations WHERE user_id = ?', META.ids.frank);
    assert.deepEqual(log.map((r) => ({ ...r })), [{ old_public_key: META.public_keys.frank, new_public_key: k.pub }]);
    assert.equal(unwrapIdentityV2({ encryptedPrivateKey: id.encrypted_private_key, iv: id.iv, salt: id.salt, kdfParams: JSON.parse(id.kdf_params) }, s.password), k.pkcs8);

    // a second rotation with the now-stale expectation is refused
    const stale = await rot({ ...body, identity: wrapIdentityV2(newX25519().pkcs8, newX25519().pub, s.password, s.salt).identity });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'conflict');
});

test('rotation is refused for a legacy (scheme 1) account', async () => {
    const reg = await srv.call('POST', '/api/auth/register', { body: { username: 'legacyrot', email: 'lr@x.invalid', password: 'legacy-rot-password' } });
    const k = newX25519();
    const r = await srv.call('POST', '/api/me/identity-key/rotate', {
        token: reg.body.token,
        body: { current_auth_key: 'A'.repeat(43), expected_public_key: k.pub, expected_updated_at: 'x', identity: wrapIdentityV2(k.pkcs8, k.pub, 'p', cred.newKdfSalt()).identity },
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'migrate_first');
});

test('concurrent password changes: exactly one wins and identity + password stay in step', async () => {
    // bob was already migrated and changed above; log in with his current key and race two changes
    const salt = row('SELECT kdf_salt FROM users WHERE id = ?', META.ids.bob).kdf_salt;
    const session = { authKey: cred.deriveCredentialsNode('bob-brand-new-password', salt).authKey, salt };
    const l = await login('bob', session.authKey);
    assert.equal(l.status, 200);
    session.token = l.body.token;
    const a = changePasswordBody(session, 'race-password-aaaa', META.private_keys_pkcs8.bob, META.public_keys.bob);
    const b = changePasswordBody(session, 'race-password-bbbb', META.private_keys_pkcs8.bob, META.public_keys.bob);
    const [ra, rb] = await Promise.all([putPw(session, a.body), putPw(session, b.body)]);
    assert.equal([ra, rb].filter((x) => x.status === 200).length, 1, JSON.stringify([ra.body, rb.body]));
    const winner = ra.status === 200 ? a : b;
    assert.equal(row('SELECT kdf_salt FROM users WHERE id = ?', META.ids.bob).kdf_salt, winner.newSalt);
    assert.equal(row('SELECT salt FROM identity_keys WHERE user_id = ?', META.ids.bob).salt, winner.newSalt);
});
