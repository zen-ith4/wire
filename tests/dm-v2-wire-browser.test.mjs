// tests/dm-v2-wire-browser.test.mjs
//
// STEP 1B: real browsers, one process per account. v2 happy path.
// Planted-violation cases are Linux-only (see docs/DM_V2_WIRE.md).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    startRealServer,
    newUserPage,
    closeUserBrowsers,
    openDmUi,
} from './_acceptance-harness.mjs';
import { ROOT } from './_acceptance-harness.mjs';
import { Database, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';

const ALICE_NAME = 'alice';
const BOB_NAME = 'bob';
const ALICE_ID = 2;
const BOB_ID = 3;

let server = null;

function copyFixture(dest) {
    fs.copyFileSync(FIXTURE_DB, dest);
}

async function loginLegacy(page, origin, username, password) {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-username', { timeout: 30000 });
    await page.type('#auth-username', username);
    await page.type('#auth-password', password);
    await page.click('#auth-form button');
    await page.waitForSelector('.nav-link', { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 500));
}

before(async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'wire.db');
    copyFixture(dbPath);
    const { runMigrations } = await import('../database/migrations.js');
    const db0 = new Database(dbPath, { readonly: false });
    runMigrations(db0);
    db0.close();
    const script = path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs');
    spawnSync(process.execPath, [script, 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
    server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
});

after(async () => {
    await closeUserBrowsers();
    if (server) await server.stop();
    cleanupTmp();
});

test('v2 text end to end', async () => {
    const a = await newUserPage();
    const b = await newUserPage();
    await loginLegacy(a.page, server.origin, ALICE_NAME, 'alice-legacy-pass');
    await loginLegacy(b.page, server.origin, BOB_NAME, 'bob-legacy-pass');

    // alice opens DM to bob
    await openDmUi(a.page, BOB_ID, 'bob');
    await a.page.type('#dm-input', 'hello v2');
    await a.page.keyboard.press('Enter');
    await a.page.waitForFunction(() => document.querySelectorAll('#dm-thread .chat-msg').length > 0, { timeout: 30000 });

    // bob opens DM to alice and should see the decrypted text
    await openDmUi(b.page, ALICE_ID, 'alice');
    await b.page.waitForFunction(() => /hello v2/.test(document.body.innerText), { timeout: 30000 });

    await closeUserBrowsers();
});