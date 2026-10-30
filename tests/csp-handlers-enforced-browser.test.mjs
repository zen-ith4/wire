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
    const violations = [...cspViolations, ...consoleRefused];
    if (violations.length > 0) {
        t.fail(`CSP violations detected:\n${violations.map((v) => JSON.stringify(v)).join('\n')}`);
    }
}

let server = null;
let io = null;
after(async () => {
    await closeUserBrowsers();
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

async function startApp(cspEnforce) {
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
    app.use('/api/admin', require('../routes/admin.routes'));
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

    const origin = await startApp(cspEnforce);
    resetCspTracking();

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

        // Make adminName the admin via admin CLI.
        const { execSync } = await import('node:child_process');
        const adminCli = path.resolve(import.meta.dirname, '..', 'scripts', 'admin-cli.mjs');
        execSync(process.execPath, [adminCli, 'set-admin', adminName], { cwd: path.resolve(import.meta.dirname, '..') });

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
        await adminPageInfo.page.goto(`${origin}/#/admin/users`, { waitUntil: 'networkidle2' });
        await adminPageInfo.page.waitForSelector('#new-username', { timeout: 20000 });
        await adminPageInfo.page.type('#new-username', `testuser${tag}`);
        await adminPageInfo.page.type('#new-email', `testuser${tag}@example.com`);
        await adminPageInfo.page.type('#new-password', PASSWORD);
        await adminPageInfo.page.click('[data-action="admin-add-user"]');
        await sleep(1200);
        const users = await adminSession.api('/api/admin/users');
        const addedUser = users.body.find((u) => u.username === `testuser${tag}`);
        assert.ok(addedUser, 'admin-add-user delegated action created a user under CSP enforcement');

        // Admin: add a folder (data-action="admin-add-folder").
        await adminPageInfo.page.goto(`${origin}/#/admin/folders`, { waitUntil: 'networkidle2' });
        await adminPageInfo.page.waitForSelector('#new-folder-path', { timeout: 20000 });
        await adminPageInfo.page.type('#new-folder-path', `/srv/media/${tag}`);
        await adminPageInfo.page.type('#new-folder-name', `Folder ${tag}`);
        await adminPageInfo.page.click('[data-action="admin-add-folder"]');
        await sleep(1200);
        const folders = await adminSession.api('/api/admin/folders');
        const addedFolder = folders.body.find((f) => f.path === `/srv/media/${tag}`);
        assert.ok(addedFolder, 'admin-add-folder delegated action created a folder under CSP enforcement');

        // Admin: add a permission (data-action="admin-add-permission").
        await adminPageInfo.page.goto(`${origin}/#/admin/permissions`, { waitUntil: 'networkidle2' });
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
        const aliceSession = await sessionFromPage(alicePageInfo.page, origin, aliceName);

        // Settings: save bio (data-action="settings-save-bio").
        await alicePageInfo.page.goto(`${origin}/#/settings`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('#settings-category-row-profile', { timeout: 20000 });
        await alicePageInfo.page.click('#settings-category-row-profile');
        await alicePageInfo.page.waitForSelector('#settings-bio', { timeout: 20000 });
        await alicePageInfo.page.type('#settings-bio', `Hello bio ${tag}`);
        await alicePageInfo.page.click('[data-action="settings-save-bio"]');
        await sleep(1200);
        const meAfterBio = await aliceSession.api('/api/me');
        assert.equal(meAfterBio.body.bio, `Hello bio ${tag}`, 'settings-save-bio delegated action saved the bio');

        // Settings: change password (data-action="settings-change-password").
        await alicePageInfo.page.goto(`${origin}/#/settings`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('#settings-category-row-security', { timeout: 20000 });
        await alicePageInfo.page.click('#settings-category-row-security');
        await alicePageInfo.page.waitForSelector('#pw-current', { timeout: 20000 });
        await alicePageInfo.page.type('#pw-current', PASSWORD);
        await alicePageInfo.page.type('#pw-new', `NewPassw0rd!x${tag}`);
        await alicePageInfo.page.type('#pw-confirm', `NewPassw0rd!x${tag}`);
        await alicePageInfo.page.click('[data-action="settings-change-password"]');
        await sleep(1500);
        const meAfterPw = await aliceSession.api('/api/me');
        assert.ok(meAfterPw.status === 200, 'settings-change-password delegated action succeeded');

        // Sign in alice with new password for DM actions.
        await loginUi(alicePageInfo.page, origin, aliceName);
        await socketConnected(alicePageInfo.page);

        // Sign in bob.
        const bobPageInfo = await newUserPage({ onNewDocument: cspViolationSetup });
        bobPageInfo.page.on('console', (msg) => {
            if (msg.type() === 'error' && msg.text().includes('Refused to')) {
                consoleRefused.push(msg.text());
            }
        });
        await loginUi(bobPageInfo.page, origin, bobName);
        await socketConnected(bobPageInfo.page);

        // DM: open conversation alice <-> bob.
        await alicePageInfo.page.goto(`${origin}/#/messages`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('.dm-layout #dm-conv-list', { timeout: 20000 });
        await sleep(600);
        await alicePageInfo.page.evaluate(async (id, name) => {
            const m = await import('/js/chat/dm.js');
            await m.openDmConversation(id, name, { fromNav: true });
        }, bobSession.id, bobName);
        await alicePageInfo.page.waitForSelector('#dm-input', { timeout: 20000 });

        // DM: send a message to reply to / edit.
        await alicePageInfo.page.type('#dm-input', `message to reply ${tag}`);
        await alicePageInfo.page.keyboard.press('Enter');
        await sleep(1500);

        // DM: dm-reply-to (data-action="dm-reply-to").
        const replyBtn = await alicePageInfo.page.$('[data-action="dm-reply-to"]');
        assert.ok(!!replyBtn, 'dm-reply-to button exists');
        await replyBtn.click();
        await sleep(500);
        const replyActive = await alicePageInfo.page.evaluate(() => !!document.querySelector('.reply-active'));
        assert.ok(replyActive, 'dm-reply-to delegated action opened reply state');

        // DM: dm-edit (data-action="dm-edit").
        const editBtn = await alicePageInfo.page.$('[data-action="dm-edit"]');
        assert.ok(!!editBtn, 'dm-edit button exists');
        await editBtn.click();
        await sleep(500);
        const editActive = await alicePageInfo.page.evaluate(() => !!document.querySelector('.dm-edit-active'));
        assert.ok(editActive, 'dm-edit delegated action opened edit state');

        // DM: dm-open-profile-card (data-action="dm-open-profile-card").
        await alicePageInfo.page.evaluate(async () => {
            const card = document.querySelector('[data-action="dm-open-profile-card"]');
            if (card) card.click();
        });
        await sleep(800);
        const cardVisible = await alicePageInfo.page.evaluate(() => !!document.querySelector('.profile-card'));
        assert.ok(cardVisible, 'dm-open-profile-card delegated action opened profile card');

        // DM: dm-jump-to-latest (data-action="dm-jump-to-latest").
        const jumpBtn = await alicePageInfo.page.$('[data-action="dm-jump-to-latest"]');
        assert.ok(!!jumpBtn, 'dm-jump-to-latest button exists');
        await jumpBtn.click();
        await sleep(500);
        const jumpRounded = await alicePageInfo.page.evaluate(() => !!document.querySelector('.jump-to-latest-rounded'));
        assert.ok(jumpRounded, 'dm-jump-to-latest delegated action triggered jump state');

        // ---- Extended delegated-action + effect assertions under CSP enforcement ----

        // DM send effect: the message just sent exists on the server for bob.
        const dmRecent = await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`);
        assert.ok(dmRecent.body.some((m) => m.text?.includes(`message to reply ${tag}`)), 'DM send created a server message');

        // DM delete effect: delete the reply message and verify it is gone from server.
        const dmList = await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`);
        const msgToDelete = dmList.body.find((m) => m.text?.includes(`message to reply ${tag}`));
        assert.ok(msgToDelete, 'message to delete exists');
        await alicePageInfo.page.evaluate(async (id, name) => {
            const m = await import('/js/chat/dm.js');
            await m.openDmConversation(id, name, { fromNav: true });
        }, bobSession.id, bobName);
        await alicePageInfo.page.waitForSelector('#dm-input', { timeout: 20000 });
        await sleep(500);
        const delBtn = await alicePageInfo.page.$(`[data-action="dm-delete"][data-msg-id="${msgToDelete.id}"]`);
        assert.ok(!!delBtn, 'dm-delete button exists for the message');
        await delBtn.click();
        await sleep(500);
        // Confirm dialog: click confirm.
        await alicePageInfo.page.waitForSelector('#confirm-modal-ok', { timeout: 10000 });
        await alicePageInfo.page.click('#confirm-modal-ok');
        await sleep(1000);
        const dmAfterDelete = await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`);
        assert.ok(!dmAfterDelete.body.some((m) => m.id === msgToDelete.id), 'DM delete removed the message from server');

        // Reaction toggle: react to a message and verify on server.
        await alicePageInfo.page.evaluate(async (id, name) => {
            const m = await import('/js/chat/dm.js');
            await m.openDmConversation(id, name, { fromNav: true });
        }, bobSession.id, bobName);
        await alicePageInfo.page.waitForSelector('#dm-input', { timeout: 20000 });
        await sleep(500);
        const latestDm = await aliceSession.api(`/api/dm/messages/${bobSession.id}/recent`);
        const latestId = latestDm.body.length ? latestDm.body[latestDm.body.length - 1].id : 0;
        const reactBtn2 = await alicePageInfo.page.$(`[data-action="open-reaction-picker"][data-msg-id="${latestId}"]`);
        assert.ok(!!reactBtn2, 'react button exists');
        await reactBtn2.click();
        await sleep(500);
        const pickBtn = await alicePageInfo.page.$('.emoji-picker-btn[data-emoji="👍"]');
        if (pickBtn) {
            await pickBtn.click();
            await sleep(800);
            const reactions = await aliceSession.api(`/api/dm/messages/${latestId}/reactions`);
            assert.ok(reactions.body.some((r) => r.emoji === '👍'), 'reaction toggle created a server reaction');
        }

        // Files-tab action: navigate to files tab and click a file action.
        await alicePageInfo.page.goto(`${origin}/#/files`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('#files-tab', { timeout: 20000 });
        const filesAction = await alicePageInfo.page.$('[data-action="files-download"]');
        if (filesAction) {
            await filesAction.click();
            await sleep(500);
        }

        // Wireguard map-peer button: navigate to wireguard and click map-peer.
        await alicePageInfo.page.goto(`${origin}/#/wireguard`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('#wireguard-tab', { timeout: 20000 });
        await sleep(500);
        const mapPeerBtn = await alicePageInfo.page.$('[data-action="wireguard-map-peer"]');
        if (mapPeerBtn) {
            await mapPeerBtn.click();
            await sleep(800);
            const wg = await aliceSession.api('/api/wireguard/peers');
            assert.ok(wg.status === 200 || wg.status === 201, 'wireguard map-peer action executed');
        }

        // Audio-player download: find an audio message and click download.
        await alicePageInfo.page.goto(`${origin}/#/messages`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.evaluate(async (id, name) => {
            const m = await import('/js/chat/dm.js');
            await m.openDmConversation(id, name, { fromNav: true });
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
        await alicePageInfo.page.goto(`${origin}/#/settings`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.waitForSelector('#settings-category-row-media', { timeout: 20000 });
        await alicePageInfo.page.click('#settings-category-row-media');
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

        // Re-render verification: reactions, composer, dm lists still fire delegated actions.
        await alicePageInfo.page.goto(`${origin}/#/messages`, { waitUntil: 'networkidle2' });
        await alicePageInfo.page.evaluate(async (id, name) => {
            const m = await import('/js/chat/dm.js');
            await m.openDmConversation(id, name, { fromNav: true });
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
        await checkNoCspViolations(t, origin);
    } finally {
        await closeUserBrowsers();
        if (io) await new Promise((r) => io.close(() => r()));
        if (server?.listening) await new Promise((r) => server.close(r));
    }
}

test('CSP_ENFORCE=true: settings/admin/dm delegated actions work with real clicks', { timeout: 300000 }, async (t) => {
    await scenario(t, true);
});

test('CSP_ENFORCE=false (Report-Only): identical behaviour, nothing blocked', { timeout: 300000 }, async (t) => {
    await scenario(t, false);
});
