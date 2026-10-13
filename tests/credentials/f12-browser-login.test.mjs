// B4, REAL Chromium + the REAL server (server.js) on a COPY of the base-built legacy database.
//
//  1. a legacy account logs in through the real login form (raw password, once), is migrated
//     in the background, and keeps its key pair, its DM history and its public key;
//  2. every later request carries only the derived authKey (the password never appears again);
//  3. a second login goes through the authKey path with no migration call;
//  4. a hostile server answering "scheme 1" for an upgraded account makes the browser refuse
//     to send a raw password (no login request is sent at all);
//  5. registration through the real form sends auth_key + salt and no password, and refuses
//     passwords shorter than 12 characters client-side.
//
// Skips (like the other Chromium tests) when no Chromium is available.

import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { META, Database, assertFixtureUntouched, cleanupTmp, copyLegacyFixture } from './_fixture.mjs';
import { bootServer, cred, unwrapIdentityV2 } from './_server.mjs';

const CHROMIUM_DIR = process.env.CHROMIUM_DIR || '/tmp/browser-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null, srv = null, dbPath = null, skipReason = null;

async function launch() {
    try {
        const req = createRequire(path.join(CHROMIUM_DIR, 'noop.js'));
        const chromium = (await import(pathToFileURL(req.resolve('@sparticuz/chromium')).href)).default;
        const puppeteer = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
        return await puppeteer.launch({ args: [...chromium.args, '--no-sandbox'], executablePath: await chromium.executablePath(), headless: 'shell' });
    } catch (e) { skipReason = e.message; return null; }
}

before(async () => {
    browser = await launch();
    if (!browser) return;
    const c = copyLegacyFixture();
    dbPath = c.dbPath;
    srv = await bootServer(dbPath, c.dir);
});
after(async () => { await browser?.close().catch(() => {}); await srv?.stop(); cleanupTmp(); assertFixtureUntouched(); });

const row = (sql, ...a) => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };

async function newPage() {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1100, height: 800 });
    const log = [];
    page.on('request', (r) => log.push({ method: r.method(), url: r.url().replace(srv.base, ''), body: r.postData() || '' }));
    return { page, log };
}

async function uiLogin(page, user, password) {
    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-username');
    await page.type('#auth-username', user);
    await page.type('#auth-password', password);
    await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { timeout: 40000 })]);
    await sleep(500);
}

const bodies = (log, url) => log.filter((r) => r.method === 'POST' && r.url.startsWith(url)).map((r) => r.body);

test('legacy account: real login form -> background migration, key pair and DM history intact', async (t) => {
    if (!browser) return t.skip(`BLOCKED: no Chromium (${skipReason})`);
    const { page, log } = await newPage();
    const pw = META.passwords.bob;
    await uiLogin(page, 'bob', pw);

    // 1. the one legacy login: raw password, preceded by the scheme lookup
    const logins = bodies(log, '/api/auth/login');
    assert.equal(logins.length, 1);
    assert.equal(JSON.parse(logins[0]).password, pw);
    assert.ok(log.some((r) => r.url.startsWith('/api/auth/kdf-params?username=bob')));

    // 2. exactly one migration request, carrying authKey + re-wrapped identity and no password
    await page.waitForFunction(() => true);
    for (let i = 0; i < 40 && bodies(log, '/api/auth/migrate-credentials').length === 0; i++) await sleep(250);
    const mig = bodies(log, '/api/auth/migrate-credentials');
    assert.equal(mig.length, 1);
    assert.ok(!mig[0].includes(pw), 'the migration request must not contain the password');
    const migBody = JSON.parse(mig[0]);
    assert.ok(cred.isValidAuthKey(migBody.auth_key));
    assert.equal(migBody.identity.version, 2);

    // database: scheme 2, v2 wrapper, SAME public key, SAME private key
    const u = row('SELECT auth_scheme, kdf_salt FROM users WHERE id = ?', META.ids.bob);
    assert.equal(u.auth_scheme, 2);
    const id = row('SELECT * FROM identity_keys WHERE user_id = ?', META.ids.bob);
    assert.equal(id.version, 2);
    assert.equal(id.public_key, META.public_keys.bob);
    assert.equal(id.salt, u.kdf_salt);
    assert.equal(unwrapIdentityV2({ encryptedPrivateKey: id.encrypted_private_key, iv: id.iv, salt: id.salt, kdfParams: JSON.parse(id.kdf_params) }, pw), META.private_keys_pkcs8.bob);

    // 3. the DM written by the BASE code before the migration still decrypts in the browser
    const plain = await page.evaluate(async (alice) => {
        const { decryptMessage } = await import('/js/crypto/messages/decrypt.js');
        const res = await fetch(`/api/dm/messages/${alice}/recent`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.messages || []);
        const out = [];
        for (const m of list) out.push(await decryptMessage(JSON.parse(m.content), alice));
        return out;
    }, META.ids.alice);
    assert.ok(plain.includes(META.dm.plaintext), `DM history must still decrypt, got ${JSON.stringify(plain)}`);

    // 4. no request after the login ever contained the raw password
    const loginIdx = log.findIndex((r) => r.url.startsWith('/api/auth/login') && r.method === 'POST');
    assert.ok(!log.slice(loginIdx + 1).some((r) => r.body.includes(pw)));
    await page.close();
});

test('second login of the upgraded account: authKey only, no migration, same identity; downgrade is refused', async (t) => {
    if (!browser) return t.skip(`BLOCKED: no Chromium (${skipReason})`);
    const pw = META.passwords.bob;
    const { page, log } = await newPage();
    // keep the pin from the first login: uiLogin clears localStorage, so re-create it the way the app does
    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-username');
    await page.type('#auth-username', 'bob');
    await page.type('#auth-password', pw);
    await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { timeout: 40000 })]);
    await sleep(500);

    const logins = bodies(log, '/api/auth/login');
    assert.equal(logins.length, 1);
    const sent = JSON.parse(logins[0]);
    assert.ok(cred.isValidAuthKey(sent.auth_key));
    assert.equal('password' in sent, false, 'an upgraded account never sends a raw password');
    assert.equal(bodies(log, '/api/auth/migrate-credentials').length, 0);
    assert.ok(!log.some((r) => r.body.includes(pw)), 'the password appears in no request at all');
    const pins = await page.evaluate(() => localStorage.getItem('wire.auth.scheme2.pins'));
    assert.ok(pins && pins.includes('bob'), 'the browser pinned the account as upgraded');

    // hostile server: a fresh page that keeps ONLY the pin and is told {scheme:1} for kdf-params
    const pinValue = pins;
    await page.close();
    const hostile = await newPage();
    const hp = hostile.page;
    await hp.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await hp.evaluate((v) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('wire.auth.scheme2.pins', v); }, pinValue);
    await hp.setRequestInterception(true);
    hp.on('request', (r) => {
        if (r.url().includes('/api/auth/kdf-params')) {
            return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ scheme: 1 }) });
        }
        r.continue();
    });
    await hp.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await hp.waitForSelector('#auth-username');
    await hp.type('#auth-username', 'bob');
    await hp.type('#auth-password', pw);
    await hp.click('#auth-form button');
    await hp.waitForFunction(() => /refus|downgrade/i.test(document.body.innerText), { timeout: 20000 });
    assert.equal(hostile.log.filter((r) => r.method === 'POST' && r.url.startsWith('/api/auth/login')).length, 0, 'no login request may be sent');
    assert.ok(!hostile.log.some((r) => r.body.includes(pw)), 'the raw password was not sent anywhere');
    await hp.close();
});

test('registration through the real form: auth_key + salt, no password; < 12 characters refused in the browser', async (t) => {
    if (!browser) return t.skip(`BLOCKED: no Chromium (${skipReason})`);
    const { page, log } = await newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-username');
    // switch to the register form
    await page.evaluate(() => {
        const el = [...document.querySelectorAll('a,button,span')].find((e) => /create|register|sign up/i.test(e.textContent || '') && e.id !== 'auth-submit');
        el?.click();
    });
    await page.waitForSelector('#auth-password-confirm');
    const emailSel = await page.$('#auth-email');
    assert.ok(emailSel, 'register form has an email field');

    const fill = async (pw) => {
        for (const sel of ['#auth-username', '#auth-email', '#auth-password', '#auth-password-confirm']) {
            await page.$eval(sel, (e) => { e.value = ''; });
        }
        await page.type('#auth-username', 'brandnew');
        await page.type('#auth-email', 'brandnew@x.invalid');
        await page.type('#auth-password', pw);
        await page.type('#auth-password-confirm', pw);
    };

    await fill('short-pass1');
    const n0 = log.length;
    await page.click('#auth-form button');
    await page.waitForFunction(() => /at least 12/.test(document.body.innerText), { timeout: 10000 });
    assert.equal(log.slice(n0).filter((r) => r.url.startsWith('/api/auth/register')).length, 0, 'nothing sent for a short password');

    const longPw = 'a long enough password!';
    await fill(longPw);
    await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { timeout: 40000 })]);
    const regs = bodies(log, '/api/auth/register');
    assert.equal(regs.length, 1);
    const reg = JSON.parse(regs[0]);
    assert.ok(cred.isValidAuthKey(reg.auth_key));
    assert.ok(cred.isValidKdfSalt(reg.kdf_salt));
    assert.equal(reg.kdf_iterations, 600000);
    assert.equal('password' in reg, false);
    assert.ok(!log.some((r) => r.body.includes(longPw)));
    await sleep(500);
    assert.equal(row("SELECT auth_scheme AS s FROM users WHERE username = 'brandnew'").s, 2);
    const ident = row("SELECT version FROM identity_keys WHERE user_id = (SELECT id FROM users WHERE username = 'brandnew')");
    assert.equal(ident?.version, 2, 'identity created as v2, wrapped under the account salt');
    await page.close();
});

test('change password in the browser: fresh salt, same identity, DM history still decrypts, old password dead, new one works', async (t) => {
    if (!browser) return t.skip(`BLOCKED: no Chromium (${skipReason})`);
    const oldPw = META.passwords.bob;
    const newPw = 'bob has a brand new password';
    const { page, log } = await newPage();
    await uiLogin(page, 'bob', oldPw);
    const saltBefore = row('SELECT kdf_salt FROM users WHERE id = ?', META.ids.bob).kdf_salt;

    const status = await page.evaluate(async (o, n) => {
        const { prepareCredentialChange } = await import('/js/crypto/identity-service.js');
        const { api } = await import('/js/core/api.js');
        const change = await prepareCredentialChange(o, n, localStorage.getItem('token'));
        await api('/api/me/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
        return 'ok';
    }, oldPw, newPw);
    assert.equal(status, 'ok');

    const u = row('SELECT kdf_salt FROM users WHERE id = ?', META.ids.bob);
    assert.notEqual(u.kdf_salt, saltBefore, 'a fresh salt on every change');
    const id = row('SELECT * FROM identity_keys WHERE user_id = ?', META.ids.bob);
    assert.equal(id.public_key, META.public_keys.bob);
    assert.equal(id.salt, u.kdf_salt);
    assert.equal(unwrapIdentityV2({ encryptedPrivateKey: id.encrypted_private_key, iv: id.iv, salt: id.salt, kdfParams: JSON.parse(id.kdf_params) }, newPw), META.private_keys_pkcs8.bob);
    assert.ok(!log.some((r) => r.body.includes(newPw) || (r.url.startsWith('/api/me/password') && r.body.includes(oldPw))), 'no password in the change request');
    await page.close();

    // the new password opens the account and the old DM history; the old one does not
    const again = await newPage();
    await uiLogin(again.page, 'bob', newPw);
    const plain = await again.page.evaluate(async (alice) => {
        const { decryptMessage } = await import('/js/crypto/messages/decrypt.js');
        const res = await fetch(`/api/dm/messages/${alice}/recent`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.messages || []);
        const out = [];
        for (const m of list) out.push(await decryptMessage(JSON.parse(m.content), alice));
        return out;
    }, META.ids.alice);
    assert.ok(plain.includes(META.dm.plaintext));
    await again.page.close();

    const old = await newPage();
    await old.page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await old.page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await old.page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await old.page.waitForSelector('#auth-username');
    await old.page.type('#auth-username', 'bob');
    await old.page.type('#auth-password', oldPw);
    await old.page.click('#auth-form button');
    await old.page.waitForFunction(() => /invalid|incorrect/i.test(document.body.innerText), { timeout: 20000 });
    assert.equal(await old.page.$('.nav-link'), null, 'old password must not open the app');
    await old.page.close();
});

test('admin-created account: first login in the browser shows the forced-change step, then a normal session with a new identity', async (t) => {
    if (!browser) return t.skip(`BLOCKED: no Chromium (${skipReason})`);
    // admin on the new scheme, promoted directly in the DB
    const aSalt = cred.newKdfSalt();
    const { authKey: aKey } = cred.deriveCredentialsNode('the admin account password', aSalt);
    await srv.call('POST', '/api/auth/register', { body: { username: 'bossman', email: 'boss@x.invalid', auth_key: aKey, kdf_salt: aSalt, kdf_iterations: cred.KDF_ITERATIONS } });
    const w = new Database(dbPath); w.prepare("UPDATE users SET is_admin = 1 WHERE username = 'bossman'").run(); w.close();
    const adminTok = (await srv.call('POST', '/api/auth/login', { body: { username: 'bossman', auth_key: aKey } })).body.token;

    const tempPw = 'temporary password 1';
    const tSalt = cred.newKdfSalt();
    const { authKey: tKey } = cred.deriveCredentialsNode(tempPw, tSalt);
    const created = await srv.call('POST', '/api/admin/users', { token: adminTok, body: { username: 'freshhire', email: 'fh@x.invalid', auth_key: tKey, kdf_salt: tSalt, kdf_iterations: cred.KDF_ITERATIONS, is_admin: false } });
    assert.equal(created.status, 201);

    const { page, log } = await newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-username');
    await page.type('#auth-username', 'freshhire');
    await page.type('#auth-password', tempPw);
    await page.click('#auth-form button');
    await page.waitForSelector('#forced-new-password', { timeout: 30000 });
    assert.equal(await page.$('.nav-link'), null, 'no app before the password is changed');

    const newPw = 'my own chosen password';
    // too short / same as temporary are refused in the browser
    await page.type('#forced-new-password', 'short');
    await page.type('#forced-new-password-confirm', 'short');
    await page.click('#forced-change-form button');
    await page.waitForFunction(() => /at least 12/.test(document.body.innerText));
    await page.$eval('#forced-new-password', (e) => { e.value = ''; });
    await page.$eval('#forced-new-password-confirm', (e) => { e.value = ''; });
    await page.type('#forced-new-password', newPw);
    await page.type('#forced-new-password-confirm', newPw);
    await Promise.all([page.click('#forced-change-form button'), page.waitForSelector('.nav-link', { timeout: 45000 })]);
    await sleep(600);

    const u = row("SELECT must_change_password AS m, auth_scheme AS s FROM users WHERE username = 'freshhire'");
    assert.deepEqual({ ...u }, { m: 0, s: 2 });
    const id = row("SELECT version FROM identity_keys WHERE user_id = (SELECT id FROM users WHERE username = 'freshhire')");
    assert.equal(id?.version, 2, 'identity created after the change, wrapped under the new salt');
    assert.ok(!log.some((r) => r.body.includes(tempPw) || r.body.includes(newPw)), 'neither password appears in any request');
    const pcrCalls = log.filter((r) => r.method !== 'GET' || /\/api\/me\//.test(r.url)).map((r) => `${r.method} ${r.url.split('?')[0]}`);
    assert.ok(pcrCalls.includes('PUT /api/me/password'));
    await page.close();
});

test('admin UI "Add user": the temporary password is derived in the browser (auth_key + salt only), < 12 refused', async (t) => {
    if (!browser) return t.skip(`BLOCKED: no Chromium (${skipReason})`);
    const { page, log } = await newPage();
    await uiLogin(page, 'bossman', 'the admin account password');
    await page.evaluate(async () => {
        (await import('/js/core/router.js')).navigate('admin-users');
    });
    await page.waitForSelector('#new-username', { timeout: 8000 }).catch(async (e) => { throw new Error(e.message + ' :: ' + (await page.evaluate(() => (document.getElementById('content-area')?.innerText || 'NO CONTENT AREA').slice(0, 300)))); });
    const fill = async (user, pw) => {
        await page.$eval('#new-username', (e, v) => { e.value = v; }, user);
        await page.$eval('#new-email', (e, v) => { e.value = v; }, `${user}@x.invalid`);
        await page.$eval('#new-password', (e, v) => { e.value = v; }, pw);
    };

    await fill('uihire', 'too short');
    const n0 = log.length;
    await page.evaluate(() => window.addUser());
    await page.waitForFunction(() => /at least 12/.test(document.getElementById('admin-user-error').textContent));
    assert.equal(log.slice(n0).filter((r) => r.url.startsWith('/api/admin/users') && r.method === 'POST').length, 0);

    const tempPw = 'ui temporary password';
    await fill('uihire', tempPw);
    await page.evaluate(() => window.addUser());
    for (let i = 0; i < 60 && !row("SELECT 1 AS x FROM users WHERE username = 'uihire'"); i++) await sleep(250);
    const u = row("SELECT auth_scheme AS s, must_change_password AS m, kdf_salt FROM users WHERE username = 'uihire'");
    assert.deepEqual({ s: u.s, m: u.m }, { s: 2, m: 1 });
    const posts = log.filter((r) => r.method === 'POST' && r.url.startsWith('/api/admin/users'));
    assert.equal(posts.length, 1);
    const sent = JSON.parse(posts[0].body);
    assert.equal('password' in sent, false);
    assert.ok(cred.isValidAuthKey(sent.auth_key));
    assert.ok(!posts[0].body.includes(tempPw));
    // and the temporary password really works as that account's first login
    const login = await srv.call('POST', '/api/auth/login', { body: { username: 'uihire', auth_key: cred.deriveCredentialsNode(tempPw, u.kdf_salt).authKey } });
    assert.equal(login.body.requiresPasswordChange, true);
    await page.close();
});
