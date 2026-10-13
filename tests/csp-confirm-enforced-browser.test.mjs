// tests/csp-confirm-enforced-browser.test.mjs
//
// REAL Chromium. Regression for: under CSP_ENFORCE=true the OK / Cancel buttons
// of #confirm-modal were inline onclick="..." handlers, which `script-src 'self'`
// blocks, so EVERY showConfirm() caller (group message Delete, Remove member,
// DM delete) silently did nothing. Under Report-Only they worked, so nothing
// noticed. group-confirm-in-dialog-browser serves public/ WITHOUT app.use(csp),
// so it could never see this.
//
// What is served: the real public/ behind the real middleware/csp.js, plus the
// real auth, me, dm, groups routes and socket.io (same order as server.js for
// what these flows use). CSP_ENFORCE is switched per run: 'true' (enforced) and
// 'false' (Report-Only control).
//
// What is exercised for real:
//   * users registered through POST /api/auth/register, signed in through the
//     real login form in Chromium (that creates their identity keys), and
//     authenticated through POST /api/auth/login for REST calls;
//   * the group is created with POST /api/groups and the member added with
//     POST /api/groups/:id/members using alice's real session token (the
//     official routes, no SQLite writes);
//   * the group message is typed and sent through the real composer (E2EE in
//     the browser); the DM is typed and sent through the real DM composer;
//   * the clicks on [thread-delete], [data-remove-user] and #confirm-modal-ok
//     are REAL mouse clicks. The outcome is read from the SERVER (REST as the
//     other member), not from the DOM.
// What is NOT exercised through the UI (setup shortcuts, stated honestly):
//   * opening the DM thread: after clicking the real nav tab the test calls
//     window.openDmConversation (what the DM list row calls). The group IS opened
//     by a real click on its list row, selected by data-group-id only, so the test
//     does not depend on data-action="group-new" or .conv-name.
//
// Stable selectors used (if the group UI changes, update here):
//   Group list row      .group-row[data-group-id="<id>"]                    public/js/chat/group.js:339 (click :350)
//   Delete (group msg)  button.chat-msg-delete[data-action="thread-delete"]  public/js/chat/thread.js:238
//   Manage group        [data-action="group-settings"]                       public/js/chat/group.js:489 (handler :745)
//   Remove member       [data-remove-user]                                   public/js/chat/group.js:784 (listener :808)
//   Confirm OK          #confirm-modal-ok                                    public/index.html (confirm-modal)
//   Group send          [data-action="group-send"]                          public/js/chat/group.js:498 (handler :739)
//   DM delete button    #dm-thread .chat-msg-delete                          public/js/chat/dm.js:2095
//   (DM send button is also an inline onclick, dm.js:1503, same gap)
//
// KNOWN GAP (documented expected failure, not ours to fix here): the DM delete
// BUTTON itself is rendered with an inline onclick="window.deleteDmMessage(..)"
// (dm.js:2095, agent B's file). Under enforcement the click on that button is
// blocked before showConfirm() is ever reached. This file therefore proves the
// DM delete CONFIRM path by calling window.deleteDmMessage(id) (what the button
// would have called) and asserts the button path as a `todo` test.

import './groups/_env.mjs';

/**
 * A page in its OWN browser context. browser.newPage() uses the browser
 * default context, where every page shares localStorage - so when two users
 * each sign in through the real form, the second login clears and overwrites
 * the first user's storage and any later read from the first page returns the
 * wrong session. An isolated context per user is also what two real devices
 * look like. createBrowserContext() is the current name;
 * createIncognitoBrowserContext() is the older one and puppeteer-core is
 * installed outside the repo, so detect instead of assuming a version.
 */
const openUserPage = async (browser, opts = {}) => {
    const context = typeof browser.createBrowserContext === 'function'
        ? await browser.createBrowserContext()
        : await browser.createIncognitoBrowserContext();
    const page = await context.newPage();
    page.setDefaultTimeout(opts.defaultTimeout ?? 30000);
    if (opts.viewport) await page.setViewport(opts.viewport);
    return page;
};


import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const CHROMIUM_DIR = process.env.CHROMIUM_DIR || '/tmp/browser-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trace = (m) => { if (process.env.TRACE) console.log('TRACE', m); };
const PASSWORD = 'Passw0rd!x';

let browser = null;
let server = null;
let io = null;
after(async () => {
    await browser?.close().catch(() => {});
    if (io) await new Promise((r) => io.close(() => r()));
    if (server?.listening) await new Promise((r) => server.close(r));
});

async function launchBrowser() {
    try {
        const req = createRequire(path.join(CHROMIUM_DIR, 'noop.js'));
        const chromium = (await import(pathToFileURL(req.resolve('@sparticuz/chromium')).href)).default;
        const puppeteer = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
        const b = await puppeteer.launch({ args: [...chromium.args, '--no-sandbox'], executablePath: await chromium.executablePath(), headless: 'shell', protocolTimeout: 60000 });
        return { browser: b, reason: null };
    } catch (e) {
        return { browser: null, reason: e.message };
    }
}

async function startApp() {
    const express = require('express');
    const { initDatabase } = require('../config/database');
    const { setupSocketIO } = require('../config/socket');
    const { errorHandler } = require('../middleware/errorHandler');
    const { csp } = require('../middleware/csp');
    initDatabase();
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(csp); // the REAL header middleware, before static, as in server.js
    app.use(express.static(path.resolve(import.meta.dirname, '../public')));
    app.use('/api/version', require('../routes/version.routes'));
    app.use('/api/auth', require('../routes/auth.routes'));
    app.use('/api/me', require('../routes/me.routes'));
    app.use('/api/dm', require('../routes/dm.routes'));
    app.use('/api/groups', require('../routes/groups.routes'));
    app.use('/api/share', require('../routes/share.routes'));
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    app.use(errorHandler);
    server = http.createServer(app);
    io = setupSocketIO(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}`;
}

const json = (origin, token) => async (p, opts = {}) => {
    const res = await fetch(`${origin}${p}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
};

async function waitFor(fn, ms, step = 250) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) return false;
        await sleep(step);
    }
}

let seq = 0;

/** One full run of the three flows with CSP enforced (true) or Report-Only (false). */
async function runFlows(origin, enforce) {
    process.env.CSP_ENFORCE = enforce ? 'true' : 'false';
    const out = { enforce };
    const n = `${enforce ? 'e' : 'r'}${Date.now().toString(36).slice(-5)}${seq++}`;
    const names = { alice: `al${n}`, bob: `bo${n}` };

    // --- header on the REAL response ---
    const idx = await fetch(`${origin}/`);
    out.cspHeader = idx.headers.get('content-security-policy');
    out.cspReportOnly = idx.headers.get('content-security-policy-report-only');

    // --- users via the official register route ---
    for (const u of Object.values(names)) {
        const r = await json(origin)('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: u, email: `${u}@example.com`, password: PASSWORD }) });
        assert.equal(r.status, 201, `register ${u}: ${JSON.stringify(r.body)}`);
    }

    /**
     * The REST session this page already holds after a real form login.
     *
     * Reads the token from the page's LIVE module graph, not from
     * localStorage: both pages here share one origin, so the next login()'s
     * localStorage.clear() plus its own setToken() would otherwise replace it
     * and hand back the wrong user. getToken() is a module-level variable in
     * public/js/core/auth.js and is therefore per page.
     *
     * A second raw-password login is not an option at all: the form login
     * already migrated the account to login scheme 2, and
     * services/auth.service.js refuses a raw password for such an account.
     */
    const sessionFromPage = async (page, user) => {
        const token = await page.evaluate(async () => (await import('/js/core/auth.js')).getToken());
        if (!token) throw new Error(`no session token in this page after UI login for ${user}`);
        const api = json(origin, token);
        const me = await api('/api/me/');
        if (me.status !== 200) throw new Error(`/api/me/ for ${user}: ${me.status} ${JSON.stringify(me.body)}`);
        const u = me.body.user || me.body;
        if (u.username && u.username !== user) throw new Error(`page session is ${u.username}, expected ${user}`);
        return { token, id: u.id, api };
    };

    const login = async (page, user) => {
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#auth-username');
        await page.type('#auth-username', user);
        await page.type('#auth-password', PASSWORD);
        await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { timeout: 30000 })]);
        // .nav-link can only appear after initializeIdentity() has settled, and
        // initializeIdentity() awaits the credential migration before it renders,
        // so observing the nav plus the token is enough. No fixed sleep.
        await page.waitForFunction(() => !!localStorage.getItem('token'), { timeout: 15000 });
    };
    // bob signs in once so his identity key exists (needed to add him to a group)
    const bobPage = await openUserPage(browser, { defaultTimeout: 25000 });
    await login(bobPage, names.bob);
    const page = await openUserPage(browser, { defaultTimeout: 25000 });
    await page.setViewport({ width: 1280, height: 900 });
    await login(page, names.alice);

    // --- real REST sessions ---
    // Both accounts signed in through the real form above, so each is already
    // on login scheme 2 and a second raw-password login is refused by the
    // anti-downgrade rule. Reuse each page's own session instead.
    const sess = {};
    sess.bob = await sessionFromPage(bobPage, origin, names.bob);
    sess.alice = await sessionFromPage(page, origin, names.alice);
    for (const [k, u] of Object.entries(names)) {
        if (!sess[k]) throw new Error(`no session captured for ${u}`);
    }
    assert.ok(sess.alice.id && sess.bob.id, 'user ids known');

    // alice's client only reacts to membership events while her socket is connected, so make
    // sure it is before the REST calls below (otherwise the first run races a cold browser).
    assert.ok(await waitFor(() => page.evaluate(async () => (await import('/js/core/socket.js')).getSocket()?.connected === true), 20000, 300), 'alice socket connected');
    await sleep(1000);

    // --- group + member through the OFFICIAL routes ---
    const g = await sess.alice.api('/api/groups', { method: 'POST', body: JSON.stringify({ name: `confirm ${n}` }) });
    assert.equal(g.status, 201, `create group: ${JSON.stringify(g.body)}`);
    const gid = g.body.id;
    const add = await sess.alice.api(`/api/groups/${gid}/members`, { method: 'POST', body: JSON.stringify({ user_id: sess.bob.id }) });
    assert.equal(add.status, 200, `add member: ${JSON.stringify(add.body)}`);

    const ids = (r) => (Array.isArray(r.body) ? r.body : r.body?.messages || []).map((m) => Number(m.id));
    out.confirmStuckOpen = [];
    const clickConfirmOk = async (label) => {
        await page.waitForSelector('#confirm-modal.active', { timeout: 8000 });
        await sleep(250);
        await page.click('#confirm-modal-ok'); // real mouse click on the real button
        // If the click was swallowed (CSP-blocked inline handler) the modal never closes. Record
        // that, then force it shut so the next flow is judged on its own, not on this one's debris.
        const closed = await waitFor(() => page.$eval('#confirm-modal', (m) => !m.classList.contains('active')), 2500, 100);
        if (!closed) {
            out.confirmStuckOpen.push(label);
            await page.evaluate(() => document.getElementById('confirm-modal').classList.remove('active'));
        }
    };

    trace('flow3 start');
    // =============== 3. DM delete ===============
    await page.click('.nav-link[data-view="messages"]');
    await sleep(600);
    await page.evaluate((id, name) => window.openDmConversation(id, name, { fromNav: true }), sess.bob.id, names.bob);
    await page.waitForSelector('#dm-input', { timeout: 15000 });
    await page.type('#dm-input', `ZXQ-dm-${n}`);
    // The DM send BUTTON is an inline onclick too (dm.js:1503, blocked when enforced),
    // so send with Enter; if the textarea still holds the text, call what the button calls.
    await page.keyboard.press('Enter');
    if (await waitFor(async () => (await page.$eval('#dm-input', (e) => e.value)) !== '', 1500, 150)) await page.evaluate(() => window.sendDm());
    await page.waitForSelector('#dm-thread .chat-msg-delete', { timeout: 15000 });
    const dmIds = async () => ids(await sess.bob.api(`/api/dm/messages/${sess.alice.id}/recent?limit=50`));
    const dmId = (await dmIds())[0];
    assert.ok(dmId, 'the DM reached the server');

    trace('flow3a click button');
    // 3a. the REAL delete button (inline onclick, dm.js:2095)
    // the icon only shows on hover: real hover + real click; if the layout still hides it,
    // dispatch the click event on it (inline handlers are CSP-blocked the same either way).
    await page.hover('#dm-thread .chat-msg').catch(() => {});
    await sleep(300);
    await page.click('#dm-thread .chat-msg-delete').catch(() => page.$eval('#dm-thread .chat-msg-delete', (b) => b.click()));
    out.dmButtonOpensConfirm = !!(await page.waitForSelector('#confirm-modal.active', { timeout: 2500 }).catch(() => null));
    if (out.dmButtonOpensConfirm) {
        await clickConfirmOk('dm delete (button)');
    } else {
        // 3b. what the button would have called; proves the CONFIRM path itself
        await page.evaluate((id) => { window.deleteDmMessage(id); }, dmId);
        await clickConfirmOk('dm delete (window.deleteDmMessage)');
    }
    trace('flow3 wait server');
    out.dmDeleted = await waitFor(async () => !(await dmIds()).includes(dmId), 7000);

    trace('flow1 start');
    // (order: DM first, group delete, Remove member LAST. In a failing run a confirm that never
    // settles leaves #confirm-modal parented inside the group-settings <dialog>, which would
    // corrupt anything that ran after it.)
    // =============== 1. group message Delete ===============
    await page.click('.nav-link[data-view="groups"]');
    await page.waitForSelector('#group-list', { timeout: 15000 });
    await page.waitForSelector(`.group-row[data-group-id="${gid}"]`, { timeout: 15000 }); // group.js:339
    await page.click(`.group-row[data-group-id="${gid}"]`); // real click, handler group.js:350
    await page.waitForSelector('#group-input', { timeout: 15000 });
    // SETUP SHORTCUT (stated honestly): the group and member were created over REST, not by the
    // UI's own create/add dialogs, so alice's client mints + distributes her sender key on its
    // own schedule (membership-event handlers race openGroup(); until then the composer reports
    // "No Sender Key to send with yet"). Call the app's own ensureSenderKeyForGroup() (idempotent,
    // same call openGroup() makes) with the epoch the server reports, and keep pressing the REAL
    // Send button until the message lands. Crypto is not under test here; message send, delete,
    // member removal and every confirm click below are real UI.
    const sentOk = await waitFor(async () => {
        if (await page.$('.chat-msg-delete[data-action="thread-delete"]')) return true;
        const epoch = (await sess.alice.api('/api/groups')).body.find((x) => x.id === gid)?.key_epoch;
        await page.evaluate(async (g, memberIds, ep) => {
            const m = await import('/js/crypto/messages/group-message-crypto.js');
            await m.ensureSenderKeyForGroup(g, memberIds, ep);
        }, gid, [sess.alice.id, sess.bob.id], epoch).catch(() => {});
        if (!(await page.$eval('#group-input', (e) => e.value))) await page.type('#group-input', `ZXQ-confirm-${n}`);
        await page.click('[data-action="group-send"]'); // delegated listener, group.js:498 / :739
        await sleep(1500);
        return !!(await page.$('.chat-msg-delete[data-action="thread-delete"]'));
    }, 45000, 100);
    assert.ok(sentOk, 'group message was sent through the real composer and rendered');
    const gmsgId = Number(await page.$eval('.chat-msg-delete[data-action="thread-delete"]', (b) => b.dataset.msgId));
    out.groupMsgVisibleToBobBefore = ids(await sess.bob.api(`/api/groups/${gid}/messages/recent`)).includes(gmsgId);
    await page.click('.chat-msg-delete[data-action="thread-delete"]');
    await clickConfirmOk('group message delete');
    out.groupMsgGoneForBob = await waitFor(async () => !ids(await sess.bob.api(`/api/groups/${gid}/messages/recent`)).includes(gmsgId), 7000);

    trace('flow2 start');
    // =============== 2. Remove member ===============
    await page.click('[data-action="group-settings"]');
    await page.waitForSelector('[data-remove-user]', { timeout: 15000 });
    out.memberBefore = (await sess.alice.api(`/api/groups/${gid}/members`)).body.some((m) => Number(m.user_id) === sess.bob.id);
    await page.click('[data-remove-user]');
    await clickConfirmOk('remove member');
    out.memberRemoved = await waitFor(async () => !(await sess.alice.api(`/api/groups/${gid}/members`)).body.some((m) => Number(m.user_id) === sess.bob.id), 7000);
    out.bobLostAccess = (await sess.bob.api(`/api/groups/${gid}/messages/recent`)).status >= 400;
    await page.evaluate(() => document.querySelector('dialog[open]')?.close());

    await bobPage.close().catch(() => {}); await page.close().catch(() => {});
    return out;
}

let origin = null;
const results = {};

async function ensureEnv(t) {
    if (browser) return true;
    const launched = await launchBrowser();
    if (!launched.browser) { t.skip(`BLOCKED: no Chromium available (${launched.reason})`); return false; }
    browser = launched.browser;
    origin = await startApp();
    return true;
}

// The Report-Only control runs FIRST on purpose: a failing enforced run leaves a stuck confirm,
// sockets and keys behind, and that debris must not be able to fail the control.
test('control, Report-Only: the same flows complete, and the DM delete button works', async (t) => {
    if (!(await ensureEnv(t))) return;
    const r = (results.reportOnly = await runFlows(origin, false));
    assert.equal(r.cspHeader, null, 'control run is NOT enforcing');
    assert.match(r.cspReportOnly || '', /script-src 'self'/);
    assert.equal(r.groupMsgGoneForBob, true, 'group message delete');
    assert.equal(r.memberRemoved, true, 'remove member');
    assert.equal(r.dmDeleted, true, 'dm delete');
    assert.equal(r.dmButtonOpensConfirm, true, 'under Report-Only the DM delete button itself works');
    assert.deepEqual(r.confirmStuckOpen, [], 'no confirm got stuck under Report-Only');
});

test('CSP_ENFORCE=true: real response carries the ENFORCED header, and confirm flows complete on the server', async (t) => {
    if (!(await ensureEnv(t))) return;
    const r = (results.enforced = await runFlows(origin, true));
    await t.test('header: enforced Content-Security-Policy is on the real response, Report-Only is not', () => {
        assert.match(r.cspHeader || '', /script-src 'self'/);
        assert.equal(r.cspReportOnly, null);
    });
    await t.test('group message Delete: confirm OK completes, message is gone for the other member', () => {
        assert.equal(r.groupMsgVisibleToBobBefore, true, 'control: bob saw the message before');
        assert.equal(r.groupMsgGoneForBob, true, `message still on the server after clicking OK; confirm stuck open: ${r.confirmStuckOpen.includes('group message delete')}`);
    });
    await t.test('Remove member: confirm OK completes, membership removed on the server', () => {
        assert.equal(r.memberBefore, true, 'control: bob was a member before');
        assert.equal(r.memberRemoved, true, `bob is still a member after clicking OK; confirm stuck open: ${r.confirmStuckOpen.includes('remove member')}`);
        assert.equal(r.bobLostAccess, true, 'removed member can no longer read the group');
    });
    await t.test('DM delete: confirm OK completes, message deleted on the server', () => {
        assert.equal(r.dmDeleted, true, `DM message still on the server after clicking OK; confirm stuck open: ${r.confirmStuckOpen.some((x) => x.startsWith('dm delete'))}`);
    });
    // KNOWN GAP, expected failure until dm.js:2095 drops its inline onclick (agent B).
    await t.test('DM delete BUTTON opens the confirm under enforcement', { todo: 'dm.js:2095 inline onclick="window.deleteDmMessage()" is blocked by CSP (agent B)' }, () => {
        assert.equal(r.dmButtonOpensConfirm, true);
    });
});
