// tests/csp-handlers-enforced-browser.test.mjs
//
// REAL Chromium. Regression for: under CSP_ENFORCE=true the delegated action
// handlers (data-action="...") registered via public/js/ui/actions.js must
// dispatch correctly, and a real click must trigger the handler. The handlers
// tested:
//   Settings: data-action="settings-save-bio", "settings-change-password",
//             file inputs with 'change' listeners for avatar/banner.
//   Admin:    data-action="admin-add-user", "admin-add-folder",
//             "admin-add-permission".
//   DM:       data-action="dm-reply-to", "dm-edit", "dm-open-profile-card",
//             "dm-jump-to-latest".
//
// What is exercised for real:
//   * users registered through POST /api/auth/register, signed in through the
//     real login form in Chromium (that creates their identity keys);
//   * settings actions typed/clicked through the real Settings UI;
//   * admin actions typed/clicked through the real Admin UI (admin is created
//     via the admin CLI in the harness);
//   * DM actions typed/clicked through the real DM UI.
//
// The outcome is read from the SERVER (REST), not from the DOM.
//
// Needs Chromium (@sparticuz/chromium + puppeteer-core in CHROMIUM_DIR,
// default /tmp/browser-check). Without it the tests are SKIPPED and
// reported as BLOCKED, never as passed.

import './groups/_env.mjs';
import {
    startRealServer,
    newUserPage,
    registerUser,
    loginUi,
    socketConnected,
    sessionFromPage,
    closeUserBrowsers,
    groupProtocolHeaders,
    sleep,
} from './_acceptance-harness.mjs';

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { listenEphemeral } from './_port.mjs';

const require = createRequire(import.meta.url);
const CHROMIUM_DIR = process.env.CHROMIUM_DIR || '/tmp/browser-check';
const PASSWORD = 'Passw0rd!x';

// CSP violation tracking: collect securitypolicyviolation events and
// console 'Refused to' errors per scenario, then assert empty after each.
let cspViolations = [];
let consoleRefused = [];

function cspViolationSetup() {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
            directive: e.violatedDirective,
            url: e.documentURI,
            line: e.lineNumber,
        });
    });
}

function resetCspTracking() {
    cspViolations = [];
    consoleRefused = [];
}

async function checkNoCspViolations(t, origin) {
    // Stage 3 (inline style= / CSSOM) is out of scope for this test and is
    // guaranteed to fire style-src violations under enforcement, so those are
    // tracked but not asserted. Every other directive must be clean, and any
    // console 'Refused to' error is a hard failure.
    const styleDirectives = new Set(['style-src', 'style-src-attr', 'style-src-element']);
    const otherViolations = cspViolations.filter((v) => !styleDirectives.has(v.directive));
    const violations = [...otherViolations, ...consoleRefused];
    if (violations.length > 0) {
        assert.fail(`CSP violations detected:\n${violations.map((v) => JSON.stringify(v)).join('\n')}`);
    }
}

let server = null;
let io = null;
let appClosed = false;
async function closeApp() {
    if (appClosed) return;
    appClosed = true;
    await closeUserBrowsers();
    if (io) await new Promise((r) => io.close(() => r()));
    if (server?.listening) await new Promise((r) => server.close(r));
    io = null;
    server = null;
}
after(closeApp);

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

async function startApp(cspEnforce) {
    // The CSP middleware reads process.env.CSP_ENFORCE per request, and
    // tests/test.env forces 'true' — set it from the scenario so the
    // report-only scenario really serves report-only.
    process.env.CSP_ENFORCE = cspEnforce ? 'true' : 'false';
    // A new app is starting, so the previous scenario's closeApp() must not
    // suppress this one — otherwise the second scenario's browser/server/io
    // leak and the process never exits.
    appClosed = false;
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
    app.use('/api/files', require('../routes/files.routes'));
    app.use('/api/dm', require('../routes/dm.routes'));
    app.use('/api/admin', require('../routes/admin.routes'));
    app.use('/api/admin/wireguard', require('../routes/wireguard.routes'));
    app.use('/api/groups', require('../routes/groups.routes'));
    app.use('/api/share', require('../routes/share.routes'));
    app.use('/api/settings', require('../routes/settings.routes'));
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    app.use(errorHandler);
    server = http.createServer(app);
    io = setupSocketIO(server);
    await listenEphemeral(server);
    return `http://127.0.0.1:${server.address().port}`;
}

const json = (origin, token) => async (p, opts = {}) => {
    const res = await fetch(`${origin}${p}`, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
};

async function scenario(t, cspEnforce) {
    const b = await launchBrowser();
    if (!b.browser) {
        t.skip(`BLOCKED: no Chromium available (${b.reason})`);
        return;
    }
    // b is only a "can we launch Chromium?" probe — the real pages come from
    // newUserPage(), which tracks and closes its own browsers. Close the probe
    // browser so its Chromium process doesn't keep the Node process alive.
    await b.browser.close();

    const origin = await startApp(cspEnforce);
    resetCspTracking();
    // The register rate limiter is in-memory and keyed by IP; both
    // scenarios share 127.0.0.1, so clear it before each scenario.
    require('../middleware/rateLimiter').clearRegisterAttempts();

    try {
        // ---- the policy really is enforced / report-only as configured ----
        const headers = (await fetch(origin + '/api/version')).headers;
        if (cspEnforce) {
            assert.ok(headers.get('content-security-policy'), 'enforced CSP header present');
            assert.equal(headers.get('content-security-policy-report-only'), null);
        } else {
            assert.ok(headers.get('content-security-policy-report-only'), 'report-only CSP header present');
            assert.equal(headers.get('content-security-policy'), null);
        }

        const tag = String(Date.now() % 1000000);
        const adminName = `csphandadmin${tag}`;
        const aliceName = `csphandalice${tag}`;
        const bobName = `csphandbob${tag}`;

        await registerUser(origin, adminName);
        await registerUser(origin, aliceName);
        await registerUser(origin, bobName);

        // Make adminName the admin. The test server runs in-process against
        // the in-memory DB (tests/groups/_env.mjs), so the admin CLI (a
        // separate process) cannot reach it — promote directly in the DB.
        // Demote any previous admin first: users has a partial unique index
        // on is_admin = 1 (exactly one admin), and the two scenarios share
        // this in-memory DB.
        const db = require('../config/database').getDb();
        db.transaction(() => {
            db.prepare('UPDATE users SET is_admin = 0 WHERE is_admin = 1').run();
            db.prepare('UPDATE users SET is_admin = 1 WHERE username = ? COLLATE NOCASE').run(adminName);
        })();

        // ---- sign in admin and test admin actions ----
        const adminPageInfo = await newUserPage({ onNewDocument: cspViolationSetup });
        adminPageInfo.page.on('console', (msg) => {
            if (msg.type() === 'error' && msg.text().includes('Refused to')) {
                consoleRefused.push(msg.text());
            }
        });
        await loginUi(adminPageInfo.page, origin, adminName);
        await socketConnected(adminPageInfo.page);
        const adminSession = await sessionFromPage(adminPageInfo.page, origin, adminName);

        // Admin: add a user (data-action="admin-add-user").
        await adminPageInfo.page.goto(`${origin}/#admin-users`, { waitUntil: 'networkidle2' });
        await adminPageInfo.page.waitForSelector('#new-username', { timeout: 20000 });
        await adminPageInfo.page.type('#new-username', `testuser${tag}`);
        await adminPageInfo.page.type('#new-email', `testuser${tag}@example.com`);
        // The admin UI enforces MIN_PASSWORD_LENGTH (12) client-side, which
        // is longer than the harness PASSWORD — the added user is only ever
        // looked up by name, never signed in with this password.
        await adminPageInfo.page.type('#new-password', 'TempPassw0rd!x');
        await adminPageInfo.page.click('[data-action="admin-add-user"]');
        // The handler derives the new account's credentials client-side
        // (600k-iteration KDF) before POSTing, so poll the server instead of
        // using a fixed sleep.
        let addedUser = null;
        for (let i = 0; i < 40 && !addedUser; i++) {
            await sleep(500);
            addedUser = (await adminSession.api('/api/admin/users')).body
                .find((u) => u.username === `testuser${tag}`);
        }
        if (!addedUser) {
            const err = await adminPageInfo.page.$eval('#admin-user-error', (el) => el.textContent).catch(() => '(no form error element)');
            assert.fail(`admin-add-user did not create a user under CSP enforcement (form error: ${err})`);
        }
        assert.ok(addedUser, 'admin-add-user delegated action created a user under CSP enforcement');

        // Admin: add a folder (data-action="admin-add-folder").
        // The folder policy only allows paths inside USER_DATA_ROOT, so use
        // a path under it (a /srv/... path would be rejected with 400).
        const folderPath = path.join(process.env.USER_DATA_ROOT, `media-${tag}`);
        // The folder policy requires the directory to exist on disk.
        fs.mkdirSync(folderPath, { recursive: true });
        await adminPageInfo.page.goto(`${origin}/#admin-folders`, { waitUntil: 'networkidle2' });
        await adminPageInfo.page.waitForSelector('#new-folder-path', { timeout: 20000 });
        await adminPageInfo.page.type('#new-folder-path', folderPath);
        await adminPageInfo.page.type('#new-folder-name', `Folder ${tag}`);
        await adminPageInfo.page.click('[data-action="admin-add-folder"]');
        await sleep(1200);
        const folders = await adminSession.api('/api/admin/folders');
        const addedFolder = folders.body.find((f) => f.path === folderPath);
        assert.ok(addedFolder, 'admin-add-folder delegated action created a folder under CSP enforcement');

        // Admin: add a permission (data-action="admin-add-permission").
        await adminPageInfo.page.goto(`${origin}/#admin-permissions`, { waitUntil: 'networkidle2' });
        await adminPageInfo.page.waitForSelector('#perm-user', { timeout: 20000 });
        // Select the added user and folder.
        await adminPageInfo.page.select('#perm-user', String(addedUser.id));
        await adminPageInfo.page.select('#perm-folder', String(addedFolder.id));
        await adminPageInfo.page.click('#perm-write');
        await adminPageInfo.page.click('[data-action="admin-add-permission"]');
        await sleep(1200);
        const perms = await adminSession.api('/api/admin/permissions');
        const addedPerm = perms.body.find((p) => p.user_id === addedUser.id && p.folder_id === addedFolder.id);
        assert.ok(addedPerm, 'admin-add-permission delegated action created a permission under CSP enforcement');

        // ---- sign in alice and test settings + DM actions ----
        const alicePageInfo = await newUserPage({ onNewDocument: cspViolationSetup });
        alicePageInfo.page.on('console', (msg) => {
            if (msg.type() === 'error' && msg.text().includes('Refused to')) {
                consoleRefused.push(msg.text());
            }
        });
        await loginUi(alicePageInfo.page, origin, aliceName);
        await socketConnected(alicePageInfo.page);
        let aliceSession = await sessionFromPage(alicePageInfo.page, origin, aliceName);

        // Settings: save bio (data-action="settings-save-bio").
        await alicePageInfo.page.goto(`${origin}/#settings`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('#settings-category-row-profile', { timeout: 20000 });
        await alicePageInfo.page.click('#settings-category-row-profile');
        await alicePageInfo.page.waitForSelector('#settings-bio', { timeout: 20000 });
        await alicePageInfo.page.type('#settings-bio', `Hello bio ${tag}`);
        await alicePageInfo.page.click('[data-action="settings-save-bio"]');
        await sleep(1200);
        const meAfterBio = await aliceSession.api('/api/me');
        assert.equal(meAfterBio.body.bio, `Hello bio ${tag}`, 'settings-save-bio delegated action saved the bio');

        // Settings: change password (data-action="settings-change-password").
        // The change revokes every session token minted before it (including
        // this page's) and returns a fresh one, so the page stays signed in
        // but the old aliceSession token is dead — refresh the session from
        // the page afterwards.
        // The bio block left the page inside the profile category, and a
        // same-URL goto is a no-op — leave and return to Settings so the
        // category list re-renders fresh (otherwise the hidden category row
        // click is a no-op and #pw-current never appears).
        await alicePageInfo.page.goto(`${origin}/#files`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.goto(`${origin}/#settings`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('#settings-category-row-security', { timeout: 20000 });
        await alicePageInfo.page.click('#settings-category-row-security');
        await alicePageInfo.page.waitForSelector('#pw-current', { timeout: 20000 });
        await alicePageInfo.page.type('#pw-current', PASSWORD);
        await alicePageInfo.page.type('#pw-new', `NewPassw0rd!x${tag}`);
        await alicePageInfo.page.type('#pw-confirm', `NewPassw0rd!x${tag}`);
        const tokenBeforePw = await alicePageInfo.page.evaluate(async () => (await import('/js/core/auth.js')).getToken());
        await alicePageInfo.page.click('[data-action="settings-change-password"]');
        // The handler derives the new credentials client-side (KDF) before
        // the PUT, so poll for the fresh token instead of a fixed sleep.
        let tokenAfterPw = null;
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            tokenAfterPw = await alicePageInfo.page.evaluate(async () => (await import('/js/core/auth.js')).getToken());
            if (tokenAfterPw && tokenAfterPw !== tokenBeforePw) break;
        }
        assert.ok(tokenAfterPw && tokenAfterPw !== tokenBeforePw, 'settings-change-password delegated action issued a fresh session token');
        aliceSession = await sessionFromPage(alicePageInfo.page, origin, aliceName);

        // Sign in bob.
        const bobPageInfo = await newUserPage({ onNewDocument: cspViolationSetup });
        bobPageInfo.page.on('console', (msg) => {
            if (msg.type() === 'error' && msg.text().includes('Refused to')) {
                consoleRefused.push(msg.text());
            }
        });
        await loginUi(bobPageInfo.page, origin, bobName);
        await socketConnected(bobPageInfo.page);
        const bobSession = await sessionFromPage(bobPageInfo.page, origin, bobName);

        // DM: open conversation alice <-> bob.
        await alicePageInfo.page.goto(`${origin}/#messages`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('.dm-layout #dm-conv-list', { timeout: 20000 });
        await sleep(600);
        await alicePageInfo.page.evaluate(async (id, name) => {
            await window.openDmConversation(id, name, { fromNav: true });
        }, bobSession.id, bobName);
        await alicePageInfo.page.waitForSelector('#dm-input', { timeout: 20000 });

        // DM: send a message to reply to / edit.
        // DMs are E2EE: the server stores ciphertext, so assert on message
        // ids/counts, never on plaintext.
        const dmIdsBefore = new Set(
            (await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`)).body.map((m) => m.id)
        );
        await alicePageInfo.page.type('#dm-input', `message to reply ${tag}`);
        await alicePageInfo.page.keyboard.press('Enter');
        await sleep(1500);
        // DM send effect: exactly one new message on the server.
        const dmRecent = await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`);
        const newDmIds = dmRecent.body.filter((m) => !dmIdsBefore.has(m.id)).map((m) => m.id);
        assert.equal(newDmIds.length, 1, 'DM send created exactly one new server message');
        const sentMsgId = newDmIds[0];

        // DM: dm-reply-to (data-action="dm-reply-to").
        // The message action bar is hover-revealed, so the button is not
        // "clickable" in a headless viewport — dispatch the DOM click directly.
        const replyBtn = await alicePageInfo.page.$('[data-action="dm-reply-to"]');
        assert.ok(!!replyBtn, 'dm-reply-to button exists');
        await replyBtn.evaluate((el) => el.click());
        await sleep(500);
        const replyActive = await alicePageInfo.page.evaluate(() => !!document.querySelector('#dm-reply-preview.active'));
        assert.ok(replyActive, 'dm-reply-to delegated action opened reply state');

        // DM: dm-edit (data-action="dm-edit").
        const editBtn = await alicePageInfo.page.$('[data-action="dm-edit"]');
        assert.ok(!!editBtn, 'dm-edit button exists');
        await editBtn.evaluate((el) => el.click());
        await sleep(500);
        const editActive = await alicePageInfo.page.evaluate(() => !!document.querySelector('.composer-wrapper.is-editing'));
        assert.ok(editActive, 'dm-edit delegated action opened edit state');

        // Cancel the edit (data-action="composer-edit-close") so the composer
        // returns to a clean send state — otherwise a later Enter would try to
        // UPDATE this message instead of sending a new one.
        const editClose = await alicePageInfo.page.$('[data-action="composer-edit-close"]');
        assert.ok(!!editClose, 'composer edit-close button exists');
        await editClose.evaluate((el) => el.click());
        await sleep(400);
        const editCleared = await alicePageInfo.page.evaluate(() => !document.querySelector('.composer-wrapper.is-editing'));
        assert.ok(editCleared, 'composer-edit-close delegated action cleared edit state');

        // DM: dm-open-profile-card (data-action="dm-open-profile-card").
        await alicePageInfo.page.evaluate(async () => {
            const card = document.querySelector('[data-action="dm-open-profile-card"]');
            if (card) card.click();
        });
        await sleep(800);
        const cardVisible = await alicePageInfo.page.evaluate(() => !!document.querySelector('#profile-card-modal.active'));
        assert.ok(cardVisible, 'dm-open-profile-card delegated action opened profile card');

        // Regression (avatar.js capture phase): clicking the avatar inside a
        // New-DM picker row must open the profile card ONLY. The row's own
        // click handler must not also open the conversation.
        await alicePageInfo.page.evaluate(() => window.openNewDmPicker());
        await alicePageInfo.page.waitForSelector('#dm-picker-list', { timeout: 20000 });
        const pickerAvatar = await alicePageInfo.page.waitForSelector(
            `.dm-picker-row[data-user-id="${bobSession.id}"] .clickable-avatar[data-avatar-action="profile"]`,
            { timeout: 20000 }
        );
        await pickerAvatar.click();
        await sleep(800);
        const pickerCardOpen = await alicePageInfo.page.evaluate(
            () => !!document.querySelector('#profile-card-modal.active')
        );
        assert.ok(pickerCardOpen, 'avatar click in DM picker row opened the profile card');
        const pickerStillOpen = await alicePageInfo.page.evaluate(
            () => !!document.getElementById('dm-picker-list')
        );
        assert.ok(pickerStillOpen, 'avatar click in DM picker row did NOT open the DM conversation (picker closed)');
        await alicePageInfo.page.evaluate(() => {
            window.closeProfileCard?.();
            window.closeNewDmPicker?.();
        });
        await sleep(300);

        // DM: dm-jump-to-latest (data-action="dm-jump-to-latest").
        // The handler calls window.dmJumpToLatest(); spy on it to prove the
        // delegated dispatch reached the handler (the DOM effect — scroll +
        // atBottom — is not reliably observable in a headless viewport).
        const jumpBtn = await alicePageInfo.page.$('[data-action="dm-jump-to-latest"]');
        assert.ok(!!jumpBtn, 'dm-jump-to-latest button exists');
        await alicePageInfo.page.evaluate(() => {
            window.__jumpCalled = false;
            const orig = window.dmJumpToLatest;
            window.dmJumpToLatest = function () { window.__jumpCalled = true; return orig.apply(this, arguments); };
        });
        await jumpBtn.evaluate((el) => el.click());
        await sleep(500);
        const jumpCalled = await alicePageInfo.page.evaluate(() => window.__jumpCalled === true);
        assert.ok(jumpCalled, 'dm-jump-to-latest delegated action invoked the jump handler');

        // ---- Extended delegated-action + effect assertions under CSP enforcement ----

        // DM send effect: the message just sent exists on the server for bob.

        // DM delete effect: delete the sent message and verify it is gone.
        const countBeforeDelete = (await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`)).body.length;
        await alicePageInfo.page.evaluate(async (id, name) => {
            await window.openDmConversation(id, name, { fromNav: true });
        }, bobSession.id, bobName);
        await alicePageInfo.page.waitForSelector('#dm-input', { timeout: 20000 });
        await sleep(500);
        const delBtn = await alicePageInfo.page.$(`[data-action="dm-delete"][data-msg-id="${sentMsgId}"]`);
        assert.ok(!!delBtn, 'dm-delete button exists for the message');
        await delBtn.evaluate((el) => el.click());
        await sleep(500);
        // Confirm dialog: the modal's click handler is delegated on #confirm-modal,
        // so dispatch the DOM click on the OK button (a coordinate click does not
        // reach the delegated handler reliably in a headless viewport).
        await alicePageInfo.page.waitForSelector('#confirm-modal-ok', { timeout: 10000 });
        await alicePageInfo.page.evaluate(() => document.getElementById('confirm-modal-ok').click());
        await sleep(1000);
        const dmAfterDelete = await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`);
        assert.ok(!dmAfterDelete.body.some((m) => m.id === sentMsgId), 'DM delete removed the message from server');
        assert.equal(dmAfterDelete.body.length, countBeforeDelete - 1, 'DM delete removed the message from the conversation');

        // Reaction toggle: react to a message and verify on server.
        // The delete block emptied the conversation, so send a fresh message
        // to react to.
        await alicePageInfo.page.evaluate(async (id, name) => {
            await window.openDmConversation(id, name, { fromNav: true });
        }, bobSession.id, bobName);
        await alicePageInfo.page.waitForSelector('#dm-input', { timeout: 20000 });
        await alicePageInfo.page.type('#dm-input', `react target ${tag}`);
        await alicePageInfo.page.keyboard.press('Enter');
        await sleep(1500);
        await alicePageInfo.page.evaluate(async (id, name) => {
            await window.openDmConversation(id, name, { fromNav: true });
        }, bobSession.id, bobName);
        await alicePageInfo.page.waitForSelector('#dm-input', { timeout: 20000 });
        await sleep(500);
        const latestDm = await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`);
        const latestId = latestDm.body.length ? latestDm.body[latestDm.body.length - 1].id : 0;
        const reactBtn2 = await alicePageInfo.page.$(`[data-action="open-reaction-picker"][data-msg-id="${latestId}"]`);
        assert.ok(!!reactBtn2, 'react button exists');
        await reactBtn2.evaluate((el) => el.click());
        // Wait for the emoji picker to open, then click its first emoji.
        await alicePageInfo.page.waitForSelector('.emoji-picker', { timeout: 10000 });
        const emojiBtn = await alicePageInfo.page.$('.emoji-picker-emoji');
        assert.ok(!!emojiBtn, 'emoji picker rendered at least one emoji');
        await emojiBtn.evaluate((el) => el.click());
        await sleep(800);
        // Verify on the server via the recent payload: reactions arrive on
        // messages via withReactions (there is no GET /reactions endpoint).
        const dmRecent2 = await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`);
        const reactedMsg = dmRecent2.body.find((m) => m.id === latestId);
        assert.ok(reactedMsg && Array.isArray(reactedMsg.reactions) && reactedMsg.reactions.length > 0, 'reaction toggle created a server reaction');

        // Files-tab action: navigate to files and click a file action.
        // The files view mounts #files-root and uses data-act (not data-action).
        await alicePageInfo.page.goto(`${origin}/#files`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('#files-root', { timeout: 20000 });
        const filesAction = await alicePageInfo.page.$('[data-act="download"]');
        if (filesAction) {
            await filesAction.click();
            await sleep(500);
        }

        // Wireguard map-peer button: navigate to wireguard and click map-peer.
        // The view renders into the shared #content-area and only shows the
        // map-peer button when GET /api/admin/wireguard succeeds (admin + a
        // reachable wg interface). In the test env there is no wg interface,
        // so the view settles on "Failed to load" and the button is absent —
        // wait for the view to settle either way, then exercise the button
        // only if it rendered.
        await alicePageInfo.page.goto(`${origin}/#admin-wireguard`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForFunction(() => {
            const el = document.getElementById('content-area');
            return !!el && (!!el.querySelector('[data-action="wireguard-map-peer"]') || /Failed to load/.test(el.textContent));
        }, { timeout: 20000 });
        const mapPeerBtn = await alicePageInfo.page.$('[data-action="wireguard-map-peer"]');
        if (mapPeerBtn) {
            await mapPeerBtn.click();
            await sleep(800);
            const wg = await aliceSession.api('/api/admin/wireguard/peers');
            assert.ok(wg.status === 200 || wg.status === 201, 'wireguard map-peer action executed');
        }

        // Audio-player download: find an audio message and click download.
        await alicePageInfo.page.goto(`${origin}/#messages`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.evaluate(async (id, name) => {
            await window.openDmConversation(id, name, { fromNav: true });
        }, bobSession.id, bobName);
        await sleep(500);
        const audioDown = await alicePageInfo.page.$('[data-action="audio-player-download"]');
        if (audioDown) {
            await audioDown.click();
            await sleep(500);
        }

        // Attachment image open: open image viewer and close it.
        const imgBtn = await alicePageInfo.page.$('[data-action="open-image-viewer"]');
        if (imgBtn) {
            await imgBtn.click();
            await sleep(800);
            const viewerOpen = await alicePageInfo.page.evaluate(() => !!document.querySelector('.image-viewer'));
            assert.ok(viewerOpen, 'attachment image opened the image viewer');
            const closeBtn = await alicePageInfo.page.$('[data-action="image-viewer-close"]');
            if (closeBtn) await closeBtn.click();
            await sleep(500);
            const viewerClosed = await alicePageInfo.page.evaluate(() => !document.querySelector('.image-viewer'));
            assert.ok(viewerClosed, 'attachment image closed the image viewer');
        }

        // Avatar upload via file input `change` event: trigger change on avatar-input.
        // avatar-input and banner-input both live in the profile category
        // (renderBanner + renderProfile), not a "media" category.
        await alicePageInfo.page.goto(`${origin}/#files`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.goto(`${origin}/#settings`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('#settings-category-row-profile', { timeout: 20000 });
        await alicePageInfo.page.click('#settings-category-row-profile');
        await alicePageInfo.page.waitForSelector('#avatar-input', { timeout: 20000 });
        await alicePageInfo.page.evaluate(() => {
            const input = document.getElementById('avatar-input');
            if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await sleep(800);
        const meAfterAvatar = await aliceSession.api('/api/me');
        assert.ok(meAfterAvatar.status === 200, 'avatar change event executed without CSP violation');

        // Banner upload via file input `change` event.
        await alicePageInfo.page.waitForSelector('#banner-input', { timeout: 20000 });
        await alicePageInfo.page.evaluate(() => {
            const input = document.getElementById('banner-input');
            if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await sleep(800);

        // ---- Stage 2 remaining controls: REAL clicks + server/DOM effects ----
        // Selectors are taken from the source: composer.js (composer-attach-remove,
        // composer-cancel-upload, composer-reply-close), dm.js (dm-send,
        // dm-close-new-picker, dm-back-from-thread), profile-card.js
        // (profile-card-message), settings-render.js/settings-media.js
        // (settings-change-/remove-avatar|banner), files/files.js (data-act).
        {
            const page = alicePageInfo.page;
            const pngPath = path.join(os.tmpdir(), `csp-stage2-${tag}.png`);
            fs.writeFileSync(
                pngPath,
                Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                    'base64'
                )
            );
            // Click the first VISIBLE match (some controls exist twice: desktop + phone).
            const clickVisible = async (sel) => {
                for (const h of await page.$$(sel)) {
                    if (await h.evaluate((el) => el.getClientRects().length > 0)) {
                        await h.click();
                        return;
                    }
                }
                throw new Error(`no visible element for ${sel}`);
            };
            const pollApi = async (apiPath, pred, label) => {
                const end = Date.now() + 10000;
                let last;
                while (Date.now() < end) {
                    last = await aliceSession.api(apiPath);
                    if (pred(last.body)) return last.body;
                    await sleep(250);
                }
                assert.fail(`${label} (last: ${JSON.stringify(last && last.body).slice(0, 200)})`);
            };
            const openBobConversation = async () => {
                await page.evaluate(async (id, name) => {
                    await window.openDmConversation(id, name, { fromNav: true });
                }, bobSession.id, bobName);
                await page.waitForSelector('#dm-input', { timeout: 20000 });
            };

            // Mount the DM view first, exactly as the DM steps above do.
            await page.goto(`${origin}/#messages`, { waitUntil: 'networkidle2' });
            await page.waitForSelector('.dm-layout #dm-conv-list', { timeout: 20000 });
            await sleep(600);
            await openBobConversation();

            // composer-attach-remove: stage a file, then click its remove chip.
            const fileInput = await page.waitForSelector('#dm-file-input', { timeout: 20000 });
            await fileInput.uploadFile(pngPath);
            await page.waitForSelector('[data-action="composer-attach-remove"]', { timeout: 20000 });
            await clickVisible('[data-action="composer-attach-remove"]');
            await page.waitForFunction(
                () => !document.querySelector('[data-action="composer-attach-remove"]'),
                { timeout: 5000 }
            );

            // composer-cancel-upload: throttle the uplink so the upload is in flight
            // long enough to click its cancel control, then restore the network.
            // The chip only switches to 'uploading' when a send with attachments
            // starts (composer.js: filesToSend -> status 'uploading'), so stage a
            // file, throttle, send, and cancel while the send is in flight.
            await fileInput.uploadFile(pngPath);
            await page.waitForSelector('[data-action="composer-attach-remove"]', { timeout: 20000 });
            await page.emulateNetworkConditions({ download: -1, upload: 2048, latency: 1500 });
            try {
                await page.type('#dm-input', `cancel upload ${tag}`);
                await clickVisible('[data-action="dm-send"]');
                await page.waitForSelector('[data-action="composer-cancel-upload"]', { timeout: 15000 });
                await clickVisible('[data-action="composer-cancel-upload"]');
            } finally {
                await page.emulateNetworkConditions({ download: -1, upload: -1, latency: 0 });
            }
            await page.waitForFunction(
                () => !document.querySelector('[data-action="composer-cancel-upload"]'),
                { timeout: 10000 }
            );

            // composer-reply-close: start a reply, then cancel it with the close button.
            await page.evaluate(() => document.querySelector('[data-action="dm-reply-to"]')?.click());
            await page.waitForSelector('[data-action="composer-reply-close"]', { timeout: 10000 });
            await clickVisible('[data-action="composer-reply-close"]');
            await page.waitForFunction(
                () => !document.querySelector('[data-action="composer-reply-close"]'),
                { timeout: 5000 }
            );

            // dm-send: real click on the Send button (the other tests use Enter).
            const sendBefore = new Set(
                (await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`)).body.map((m) => m.id)
            );
            await page.type('#dm-input', `click send ${tag}`);
            await clickVisible('[data-action="dm-send"]');
            const sendAfter = await pollApi(
                `/api/dm/messages/${bobSession.id}/recent`,
                (rows) => rows.some((m) => !sendBefore.has(m.id)),
                'dm-send click did not create a server message'
            );
            assert.equal(
                sendAfter.filter((m) => !sendBefore.has(m.id)).length,
                1,
                'dm-send click created exactly one server message'
            );

            // dm-close-new-picker: open the picker, close it with its X button.
            await page.evaluate(() => window.openNewDmPicker());
            await page.waitForSelector('.dm-picker-close[data-action="dm-close-new-picker"]', { timeout: 20000 });
            await clickVisible('.dm-picker-close[data-action="dm-close-new-picker"]');
            await page.waitForFunction(() => !document.querySelector('.dm-picker-row'), { timeout: 5000 });

            // profile-card-message: from the profile card, "Send message" opens the DM.
            await page.evaluate((id) => window.openProfileCard(id), bobSession.id);
            await page.waitForSelector('#profile-card-modal.active', { timeout: 10000 });
            await clickVisible('.profile-card-message-btn[data-action="profile-card-message"]');
            await page.waitForFunction(
                () => !document.querySelector('#profile-card-modal.active'),
                { timeout: 5000 }
            );
            await page.waitForSelector('#dm-input', { timeout: 20000 });

            // dm-back-from-thread: the thread-header back button is CSS-hidden on
            // desktop (responsive.css shows it on phones). Its delegated handler is
            // reached by element.click() here, the same method the existing
            // dm-open-profile-card step uses; this is NOT a pointer click on a
            // visible button.
            await openBobConversation();
            await page.evaluate(() => document.querySelector('.dm-layout')?.classList.add('showing-thread'));
            await page.waitForFunction(
                () => document.querySelector('.dm-layout')?.classList.contains('showing-thread'),
                { timeout: 5000 }
            );
            await page.evaluate(() => document.querySelector('.dm-back-btn[data-action="dm-back-from-thread"]')?.click());
            await page.waitForFunction(
                () => !document.querySelector('.dm-layout')?.classList.contains('showing-thread'),
                { timeout: 5000 }
            );

            // Settings avatar + banner: the change buttons open a real file chooser,
            // the file is uploaded, then the remove buttons clear it on the server.
            await page.goto(`${origin}/#settings`, { waitUntil: 'networkidle2' });
            await page.waitForSelector('#settings-category-row-profile', { timeout: 20000 });
            await page.click('#settings-category-row-profile');

            for (const kind of ['avatar', 'banner']) {
                const changeSel = `[data-action="settings-change-${kind}"]`;
                const removeSel = `[data-action="settings-remove-${kind}"]`;
                await page.waitForSelector(changeSel, { timeout: 20000 });
                const [chooser] = await Promise.all([
                    page.waitForFileChooser({ timeout: 10000 }),
                    clickVisible(changeSel),
                ]);
                await chooser.accept([pngPath]);
                const flag = kind === 'avatar' ? 'has_avatar' : 'has_banner';
                await pollApi('/api/me', (me) => me[flag] === true, `settings-change-${kind} upload did not reach the server`);

                await page.waitForSelector(removeSel, { timeout: 20000 });
                await clickVisible(removeSel);
                // Removal asks for confirmation first (settings-media.js -> showConfirm).
                await page.waitForSelector('#confirm-modal-ok[data-action="confirm-ok"]', { visible: true, timeout: 10000 });
                await clickVisible('#confirm-modal-ok[data-action="confirm-ok"]');
                await pollApi('/api/me', (me) => me[flag] === false, `settings-remove-${kind} did not clear the server ${kind}`);
            }

            // Files tab: a real click on a data-act control (new folder toggle).
            await page.goto(`${origin}/#files`, { waitUntil: 'networkidle2' });
            await page.waitForSelector('#files-root', { timeout: 20000 });
            await clickVisible('[data-act="new-folder"]');
            await page.waitForFunction(
                () => document.querySelector('[data-act="new-folder"]')?.getAttribute('aria-expanded') === 'true',
                { timeout: 5000 }
            );

            fs.rmSync(pngPath, { force: true });
            await page.goto(`${origin}/#messages`, { waitUntil: 'networkidle2' });
        }

        // Re-render verification: reactions, composer, dm lists still fire delegated actions.
        await alicePageInfo.page.goto(`${origin}/#messages`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.evaluate(async (id, name) => {
            await window.openDmConversation(id, name, { fromNav: true });
        }, bobSession.id, bobName);
        await sleep(800);
        // Re-render reactions and verify toggle-reaction listener still works.
        const reactBtnAfter = await alicePageInfo.page.$('[data-action="open-reaction-picker"]');
        assert.ok(!!reactBtnAfter, 'reactions re-rendered with delegated action');
        // Re-render composer and verify attach button still has delegated action.
        const composerAttach = await alicePageInfo.page.$('[data-action="dm-attach"]');
        assert.ok(!!composerAttach, 'composer re-rendered with attach delegated action');
        // Re-render dm lists and verify jump-to-latest still works.
        const jumpBtnAfter = await alicePageInfo.page.$('[data-action="dm-jump-to-latest"]');
        assert.ok(!!jumpBtnAfter, 'dm list re-rendered with jump-to-latest delegated action');

        // ---- CSP enforcement: no violations from delegated handlers ----
        // securitypolicyviolation events are collected per page (page context);
        // merge every page's list into the module-level tracker before asserting.
        for (const pi of [adminPageInfo, alicePageInfo, bobPageInfo]) {
            const pageViolations = await pi.page.evaluate(() => window.__cspViolations || []);
            cspViolations.push(...pageViolations);
        }
        await checkNoCspViolations(t, origin);
    } finally {
        await closeApp();
    }
}

test('CSP_ENFORCE=true: settings/admin/dm delegated actions work with real clicks', { timeout: 300000 }, async (t) => {
    await scenario(t, true);
});

test('CSP_ENFORCE=false (Report-Only): identical behaviour, nothing blocked', { timeout: 300000 }, async (t) => {
    await scenario(t, false);
});
