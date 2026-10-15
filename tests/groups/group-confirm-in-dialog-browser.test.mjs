// tests/groups/group-confirm-in-dialog-browser.test.mjs
//
// NEW test written for the X port (not from the source tree). REAL Chromium.
//
// Regression for a bug the jsdom tests could not see: group settings open in a
// native modal <dialog> (files/dialog.js -> showModal()), which makes the rest
// of the page inert and puts the dialog in the top layer. showConfirm() renders
// #confirm-modal as a plain page element, so called from inside that dialog it
// was buried and unclickable, its promise never settled, and "Remove member" /
// "Leave group" silently did nothing (no request was ever sent).
//
// Drives the real app (real public/ + real server + real socket.io) in Chromium:
// create a group, add a member, press Remove, and require that the confirmation
// is genuinely the topmost clickable thing and that a REAL mouse click on it
// removes the member. Skips (like group-csp-browser) when Chromium is missing.

import './_env.mjs';

import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { listenEphemeral } from '../_port.mjs';
import { newUserPage, closeUserBrowsers } from '../_acceptance-harness.mjs';

const require = createRequire(import.meta.url);
const CHROMIUM_DIR = process.env.CHROMIUM_DIR || '/tmp/browser-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        const b = await puppeteer.launch({
            args: [...chromium.args, '--no-sandbox'],
            executablePath: await chromium.executablePath(),
            headless: 'shell',
        });
        return { browser: b, reason: null };
    } catch (e) {
        return { browser: null, reason: e.message };
    }
}

// The real app, same middleware order as server.js for what group settings use.
async function startRealApp() {
    const express = require('express');
    const { initDatabase } = require('../../config/database');
    const { setupSocketIO } = require('../../config/socket');
    const { errorHandler } = require('../../middleware/errorHandler');
    initDatabase();
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.static(path.resolve(import.meta.dirname, '../../public')));
    app.use('/api/version', require('../../routes/version.routes'));
    app.use('/api/auth', require('../../routes/auth.routes'));
    app.use('/api/me', require('../../routes/me.routes'));
    app.use('/api/share', require('../../routes/share.routes'));
    app.use('/api/groups', require('../../routes/groups.routes'));
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    app.use(errorHandler);
    server = http.createServer(app);
    io = setupSocketIO(server);
    await listenEphemeral(server);
    return `http://127.0.0.1:${server.address().port}`;
}

test('group settings: the Remove-member confirmation is visible, topmost and works (real Chromium)', async (t) => {
    const launched = await launchBrowser();
    if (!launched.browser) {
        t.skip(`BLOCKED: no Chromium available (${launched.reason})`);
        return;
    }
    // Only a probe: bob and alice each get their own process via newUserPage(),
    // which registers it with closeUserBrowsers() for the after() hook.
    await launched.browser.close().catch(() => {});
    const origin = await startRealApp();

    for (const u of ['alice', 'bob']) {
        const r = await fetch(`${origin}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'Passw0rd!x' }),
        });
        assert.equal(r.status, 201, `register ${u}`);
    }

    // bob signs in once so his identity key exists (needed to add him to a group)
    const login = async (page, user) => {
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        // Defensive: each page has its own browser process (and profile) now, so
        // this cannot leak, but if anyone ever shares one again the second user
        // would get the first user's "Welcome back / unlock" screen.
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#auth-username');
        await page.type('#auth-username', user);
        await page.type('#auth-password', 'Passw0rd!x');
        await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { timeout: 30000 })]);
        await sleep(800);
    };
    // newUserPage(), not browser.newPage(): bob and alice are different accounts,
    // and pages of one browser context share one IndexedDB ("wire-group-crypto").
    const { page: bobPage } = await newUserPage({ timeout: 25000 });
    await login(bobPage, 'bob');

    const { page } = await newUserPage({ timeout: 25000 });
    await login(page, 'alice');

    await page.click('.nav-link[data-view="groups"]');
    await page.waitForSelector('#group-list');
    await page.click('#new-chat-fab');
    await page.click('[data-fab-action="group"]');
    await page.waitForSelector('#new-group-name');
    // The Create button moves when the people list finishes loading and is disabled until
    // then (see group-dialog-create-settled-browser.test.mjs): wait for it, or a click
    // aimed at the old position lands on the backdrop and closes the dialog.
    await page.waitForSelector('#new-group-create:not([disabled])');
    await page.type('#new-group-name', 'confirm regression');
    await page.click('#new-group-create');
    await page.waitForSelector('#group-input');

    await page.click('[data-action="group-settings"]');
    await page.waitForSelector('#add-member-select');
    const bobOption = await page.evaluate(() => [...document.querySelectorAll('#add-member-select option')].find((o) => o.textContent.trim() === 'bob')?.value);
    assert.ok(bobOption, 'bob is offered as an addable member');
    await page.select('#add-member-select', bobOption);
    await page.click('#add-member-btn');
    await page.waitForFunction(() => [...document.querySelectorAll('.grp-member-row')].some((r) => r.textContent.includes('bob')));

    await page.click('[data-remove-user]');
    await page.waitForSelector('#confirm-modal.active');
    await sleep(300);

    const probe = await page.evaluate(() => {
        const ok = document.getElementById('confirm-modal-ok');
        const r = ok.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const dialog = document.querySelector('dialog[open]');
        return {
            nativeModalOpen: !!dialog && dialog.matches(':modal'),
            okIsTopmost: top === ok,
            elementAtOk: top ? (top.id || top.className || top.tagName) : null,
            cx: r.left + r.width / 2,
            cy: r.top + r.height / 2,
            rows: document.querySelectorAll('.grp-member-row').length,
        };
    });
    assert.equal(probe.nativeModalOpen, true, 'control: the settings really are in a native modal <dialog>');
    assert.equal(probe.okIsTopmost, true, `confirm OK must be the topmost element, but "${probe.elementAtOk}" covers it`);

    await page.mouse.click(probe.cx, probe.cy);
    await page.waitForFunction((n) => document.querySelectorAll('.grp-member-row').length < n, { timeout: 15000 }, probe.rows);

    const after = await page.evaluate(() => ({
        bobStillListed: [...document.querySelectorAll('.grp-member-row')].some((r) => r.textContent.includes('bob')),
        modalBackInBody: document.getElementById('confirm-modal').parentNode === document.body,
        modalClosed: !document.getElementById('confirm-modal').classList.contains('active'),
    }));
    assert.equal(after.bobStillListed, false, 'a real click on OK removed the member');
    assert.equal(after.modalBackInBody, true, '#confirm-modal is returned to <body> afterwards');
    assert.equal(after.modalClosed, true, 'the confirmation closed');
});
