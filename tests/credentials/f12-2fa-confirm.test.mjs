// B7: "confirm your password" steps (email 2FA enable/disable) take the derived
// current_auth_key, never the password. Real server on a COPY of the legacy DB.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { META, Database, assertFixtureUntouched, cleanupTmp, copyLegacyFixture } from './_fixture.mjs';
import { bootServer, cred, migrateLegacyUser } from './_server.mjs';

let srv, dbPath;
const row = (sql, ...a) => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };

before(async () => { const c = copyLegacyFixture(); dbPath = c.dbPath; srv = await bootServer(dbPath, c.dir); });
after(async () => { await srv?.stop(); cleanupTmp(); assertFixtureUntouched(); });

test('disable email 2FA: needs the right authKey; raw password refused; legacy account must migrate first', async () => {
    const s = await migrateLegacyUser(srv, META, 'dave'); // dave has email 2FA enabled in the fixture
    assert.equal(row('SELECT email_2fa_enabled AS e FROM users WHERE id = ?', META.ids.dave).e, 1);
    const url = '/api/settings/2fa/email/disable';

    const raw = await srv.call('POST', url, { token: s.token, body: { current_password: META.passwords.dave } });
    assert.equal(raw.status, 400);
    assert.equal(raw.body.code, 'raw_password_rejected');

    assert.equal((await srv.call('POST', url, { token: s.token, body: {} })).status, 400);
    assert.equal((await srv.call('POST', url, { token: s.token, body: { current_auth_key: 'short' } })).status, 400);

    const wrong = cred.deriveCredentialsNode('not the password', s.salt).authKey;
    assert.equal((await srv.call('POST', url, { token: s.token, body: { current_auth_key: wrong } })).status, 401);
    assert.equal(row('SELECT email_2fa_enabled AS e FROM users WHERE id = ?', META.ids.dave).e, 1, 'wrong key changed nothing');

    // the stored credential cannot be replayed as a raw password either
    assert.equal((await srv.call('POST', url, { token: s.token, body: { current_password: s.authKey } })).status, 400);

    const ok = await srv.call('POST', url, { token: s.token, body: { current_auth_key: s.authKey } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(row('SELECT email_2fa_enabled AS e FROM users WHERE id = ?', META.ids.dave).e, 0);

    // a legacy account (not migrated) is told to upgrade first
    const l = await srv.call('POST', '/api/auth/login', { body: { username: 'frank', password: META.passwords.frank } });
    const legacy = await srv.call('POST', url, { token: l.body.token, body: { current_auth_key: s.authKey } });
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.code, 'migrate_first');
});

test('enable email 2FA: same credential rules (the sandbox has email disabled, so a valid request ends in the normal 409)', async () => {
    const s = await migrateLegacyUser(srv, META, 'bob');
    const url = '/api/settings/2fa/email/enable';
    assert.equal((await srv.call('POST', url, { token: s.token, body: { current_password: META.passwords.bob } })).status, 400);
    assert.equal((await srv.call('POST', url, { token: s.token, body: {} })).status, 400);
    const valid = await srv.call('POST', url, { token: s.token, body: { current_auth_key: s.authKey } });
    assert.equal(valid.status, 409, 'email feature disabled in this environment');
    assert.match(valid.body.error, /email feature is disabled/);
});
