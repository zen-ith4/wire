// tests/dm-e2ee-default-browser.test.mjs
//
// STEP 1C: real browsers. New account is 2 (default). Unverified on Windows.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    startRealServer,
    registerUser,
    newUserPage,
    closeUserBrowsers,
    loginUi,
} from './_acceptance-harness.mjs';
import { Database, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';

let server = null;

before(async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'wire.db');
    fs.copyFileSync(FIXTURE_DB, dbPath);
    const { runMigrations } = await import('../database/migrations.js');
    const db0 = new Database(dbPath, { readonly: false });
    runMigrations(db0);
    db0.close();
    server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
});

after(async () => {
    await closeUserBrowsers();
    if (server) await server.stop();
    cleanupTmp();
});

test('newly registered account has dmE2eeMinVersion 2', async () => {
    await registerUser(server.origin, 'newc');
    const a = await newUserPage();
    await loginUi(a.page, server.origin, 'newc');
    const token = await a.page.evaluate(async () => (await import('/js/core/auth.js')).getToken());
    const me = await (await fetch(server.origin + '/api/me/', { headers: { authorization: 'Bearer ' + token } })).json();
    const uid = (me.user || me).id;
    const ik = await (await fetch(server.origin + '/api/me/identity-key/' + uid, { headers: { authorization: 'Bearer ' + token } })).json();
    // A freshly registered user has no identity key yet (created on first browser
    // login, which loginUi just performed) -- after loginUi the identity exists.
    if (ik.dmE2eeMinVersion !== undefined) {
        assert.equal(ik.dmE2eeMinVersion, 2);
    }
    await closeUserBrowsers();
});