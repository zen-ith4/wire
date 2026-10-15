// tests/groups/group-dialog-create-settled-browser.test.mjs
//
// Regression for the known-flaky group-confirm-in-dialog-browser test (Phase B, B11).
// The New-group dialog renders its people list as a loading state, then replaces it with
// the loaded list; the dialog is vertically centred on desktop, so the Create button
// moves while that happens. A click aimed at the old position landed on the <dialog>
// backdrop and closed it (files/dialog.js), so #group-input never appeared.
//
// Fix under test: Create is disabled until the list is painted (or failed to load).
// REAL Chromium; skips like the other browser tests when Chromium is missing.

import './_env.mjs';

import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { listenEphemeral } from '../_port.mjs';

const require = createRequire(import.meta.url);
const CHROMIUM_DIR = process.env.CHROMIUM_DIR || '/tmp/browser-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

test('New group dialog: Create stays disabled until the people list is painted, and then does not move (real Chromium)', async (t) => {
    const launched = await launchBrowser();
    if (!launched.browser) {
        t.skip(`BLOCKED: no Chromium available (${launched.reason})`);
        return;
    }
    browser = launched.browser;
    const origin = await startRealApp();

    const r = await fetch(`${origin}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', email: 'alice@example.com', password: 'Passw0rd!x' }),
    });
    assert.equal(r.status, 201, 'register alice');

    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    await page.setViewport({ width: 1280, height: 900 });

    // hold /api/share/users back so the loading state is observable, then answer with
    // 8 people (the loaded list is taller than the loading state: the worst shift)
    let release = null;
    const gate = new Promise((res) => { release = res; });
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
        if (req.url().endsWith('/api/share/users')) {
            await gate;
            const users = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, username: `person${i}` }));
            return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(users) });
        }
        req.continue();
    });

    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-username');
    await page.type('#auth-username', 'alice');
    await page.type('#auth-password', 'Passw0rd!x');
    await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { timeout: 30000 })]);
    await sleep(800);

    await page.click('.nav-link[data-view="groups"]');
    await page.waitForSelector('#group-list');
    await page.click('#new-chat-fab');
    await page.click('[data-fab-action="group"]');
    await page.waitForSelector('#new-group-create');

    // 1. while the list is loading the button is disabled, and a click on it does nothing
    const loading = await page.evaluate(() => ({
        disabled: document.getElementById('new-group-create').disabled,
        loadingShown: !document.querySelector('#new-group-list .grp-picker-row'),
    }));
    assert.equal(loading.loadingShown, true, 'control: the list is still loading');
    assert.equal(loading.disabled, true, 'Create is disabled while the list loads');
    const yLoading = await page.evaluate(() => document.getElementById('new-group-create').getBoundingClientRect().top);
    const box = await page.evaluate(() => { const r = document.getElementById('new-group-create').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(box.x, box.y); // a click on the disabled button does nothing
    await sleep(100);
    assert.equal(await page.evaluate(() => !!document.querySelector('dialog[open] #new-group-create')), true, 'dialog still open after clicking the disabled button');

    // 2. release the list; the button enables only after the rows exist
    release();
    await page.waitForSelector('#new-group-create:not([disabled])');
    const painted = await page.evaluate(() => document.querySelectorAll('#new-group-list .grp-picker-row').length);
    assert.equal(painted, 8, 'the list is painted by the time Create is enabled');

    // 3. the layout shift DID happen while loading (control: this is why the guard exists) ...
    const ys = await page.evaluate(async () => {
        const out = [];
        const end = performance.now() + 1000;
        while (performance.now() < end) {
            out.push(Math.round(document.getElementById('new-group-create').getBoundingClientRect().top * 10) / 10);
            await new Promise((res) => setTimeout(res, 40));
        }
        return out;
    });
    // ... and once enabled the button never moves again
    assert.equal(new Set(ys).size, 1, `Create moved after it was enabled: ${[...new Set(ys)].join(', ')}`);
    assert.notEqual(ys[0], Math.round(yLoading * 10) / 10, 'control: the button did move between loading and loaded');

    // 4. a real click on the settled button creates the group (the dialog is still open)
    assert.equal(await page.evaluate(() => !!document.querySelector('dialog[open] #new-group-create')), true, 'dialog still open');
    await page.type('#new-group-name', 'settled');
    await page.click('#new-group-create');
    await page.waitForSelector('#group-input');
});
