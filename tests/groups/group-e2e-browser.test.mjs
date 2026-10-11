// tests/groups/group-e2e-browser.test.mjs
//
// REAL Chromium, real server, real socket.io, the unmodified client: the whole group
// lifecycle with TWO signed-in accounts (plus a third that is only added and removed):
//   create group, send, receive, reply (with quote), delete, add member, remove member,
//   a message after the removal (key rotation), and two tabs of one account.
// Added in Phase C2 so that every step that touches key distribution (the KDM now carries
// the per-Sender-Key signing public key) is exercised end to end in a real browser.
//
// Each account gets its OWN browser context (own localStorage and IndexedDB), like two
// real browsers. Skips (never passes) when no Chromium can be launched.

import './_env.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const CHROMIUM_DIR = process.env.CHROMIUM_DIR || '/tmp/browser-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'Passw0rd!x-long';

const browsers = [];
let server = null;
let io = null;
after(async () => {
    for (const b of browsers) await b.close().catch(() => {});
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
            // a private profile per browser process: two accounts must never share storage
            userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wire-e2e-profile-')),
        });
        return { browser: b, reason: null };
    } catch (e) {
        return { browser: null, reason: e.message };
    }
}

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
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}`;
}

test('group lifecycle in real Chromium: create, send, receive, reply, delete, add/remove member, rotation, two tabs', async (t) => {
    const launched = await launchBrowser();
    if (!launched.browser) {
        t.skip(`BLOCKED: no Chromium available (${launched.reason})`);
        return;
    }
    browsers.push(launched.browser);
    const origin = await startRealApp();

    for (const u of ['alice', 'bob', 'carol']) {
        const r = await fetch(`${origin}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, email: `${u}@example.com`, password: PASSWORD }),
        });
        assert.equal(r.status, 201, `register ${u}`);
    }

    const problems = [];
    const track = (page, label) => {
        page.setDefaultTimeout(25000);
        page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
        page.on('console', (m) => {
            const text = m.text();
            if (/Failed to consume|could not be verified|Uncaught|KDM\(s\) could not/i.test(text)) problems.push(`${label} console: ${text}`);
        });
    };

    // One browser PROCESS per account (own profile: localStorage + IndexedDB), like two real browsers.
    async function signIn(user) {
        let ctx = launched.browser;
        if (browsers.length > 1 || user !== 'carol') {
            const next = await launchBrowser();
            assert.ok(next.browser, `another Chromium launches (${next.reason})`);
            browsers.push(next.browser);
            ctx = next.browser;
        }
        const page = await ctx.newPage();
        track(page, user);
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#auth-username');
        await page.type('#auth-username', user);
        await page.type('#auth-password', PASSWORD);
        await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { timeout: 30000 })]);
        await sleep(800);
        return { user, ctx, page };
    }

    const bubbles = (page) => page.evaluate(() => [...document.querySelectorAll('#group-messages .chat-bubble')].map((e) => e.textContent.trim()));
    const waitBubble = (page, text, ms = 20000) => page.waitForFunction(
        (tx) => [...document.querySelectorAll('#group-messages .chat-bubble')].some((e) => e.textContent.trim() === tx), { timeout: ms }, text
    );
    const waitGone = (page, text) => page.waitForFunction(
        (tx) => ![...document.querySelectorAll('#group-messages .chat-bubble')].some((e) => e.textContent.trim() === tx), { timeout: 20000 }, text
    );
    async function openGroupsTab(page) {
        await page.click('.nav-link[data-view="groups"]');
        await page.waitForSelector('#group-list');
    }
    async function openGroup(page, name) {
        await openGroupsTab(page);
        await page.waitForFunction((n) => [...document.querySelectorAll('#group-list .group-row')].some((r) => r.textContent.includes(n)), { timeout: 20000 }, name);
        await page.evaluate((n) => [...document.querySelectorAll('#group-list .group-row')].find((r) => r.textContent.includes(n)).click(), name);
        await page.waitForSelector('#group-input');
    }
    async function send(page, text) {
        await page.click('#group-input');
        await page.type('#group-input', text);
        await page.click('[data-action="group-send"]');
        await waitBubble(page, text);
    }
    async function clickInMessage(page, text, selector) {
        const ok = await page.evaluate((tx, sel) => {
            const bubble = [...document.querySelectorAll('#group-messages .chat-bubble')].find((e) => e.textContent.trim() === tx);
            const btn = bubble?.closest('.chat-msg-content')?.querySelector(sel);
            if (!btn) return false;
            btn.click();
            return true;
        }, text, selector);
        assert.ok(ok, `"${selector}" exists on the message "${text}"`);
    }
    async function openSettings(page) {
        await page.click('[data-action="group-settings"]');
        await page.waitForSelector('#add-member-select');
    }
    async function addMember(page, name) {
        await openSettings(page);
        const value = await page.evaluate((n) => [...document.querySelectorAll('#add-member-select option')].find((o) => o.textContent.trim() === n)?.value, name);
        assert.ok(value, `${name} is offered as an addable member`);
        await page.select('#add-member-select', value);
        await page.click('#add-member-btn');
        await page.waitForFunction((n) => [...document.querySelectorAll('.grp-member-row')].some((r) => r.textContent.includes(n)), { timeout: 20000 }, name);
        await page.click('#group-settings-close');
        await sleep(300);
    }
    async function removeMember(page, name) {
        await openSettings(page);
        const rows = await page.evaluate(() => document.querySelectorAll('.grp-member-row').length);
        await page.evaluate((n) => [...document.querySelectorAll('.grp-member-row')].find((r) => r.textContent.includes(n)).querySelector('[data-remove-user]').click(), name);
        await page.waitForSelector('#confirm-modal.active');
        await sleep(300);
        await page.click('#confirm-modal-ok');
        await page.waitForFunction((n) => document.querySelectorAll('.grp-member-row').length < n, { timeout: 20000 }, rows);
        await page.click('#group-settings-close');
        await sleep(300);
    }

    // carol and bob sign in once so their identity keys exist (needed to add them to a group)
    const carol = await signIn('carol');
    const bob = await signIn('bob');
    const alice = await signIn('alice');

    // --- create the group (Alice)
    await openGroupsTab(alice.page);
    await alice.page.click('#new-chat-fab');
    await alice.page.click('[data-fab-action="group"]');
    await alice.page.waitForSelector('#new-group-name');
    await alice.page.waitForSelector('#new-group-create:not([disabled])');
    await alice.page.type('#new-group-name', 'lifecycle');
    await alice.page.click('#new-group-create');
    await alice.page.waitForSelector('#group-input');

    // --- add Bob, send, receive
    await addMember(alice.page, 'bob');
    await send(alice.page, 'hello from alice');
    await openGroup(bob.page, 'lifecycle');
    await waitBubble(bob.page, 'hello from alice');

    // --- Bob replies, Alice sees the reply and its quote
    await clickInMessage(bob.page, 'hello from alice', '.chat-msg-reply');
    await send(bob.page, 'bob replies');
    await waitBubble(alice.page, 'bob replies');
    const quote = await alice.page.evaluate(() => {
        const bubble = [...document.querySelectorAll('#group-messages .chat-bubble')].find((e) => e.textContent.trim() === 'bob replies');
        return bubble?.closest('.chat-msg-content')?.querySelector('.reply-quote-text')?.textContent.trim() ?? null;
    });
    assert.equal(quote, 'hello from alice', 'the reply shows the decrypted quote of the original');

    // --- Bob deletes his own message; it disappears for Alice
    await send(bob.page, 'bob will delete this');
    await waitBubble(alice.page, 'bob will delete this');
    await clickInMessage(bob.page, 'bob will delete this', '.chat-msg-delete');
    await bob.page.waitForSelector('#confirm-modal.active');
    await sleep(300);
    await bob.page.click('#confirm-modal-ok');
    await waitGone(bob.page, 'bob will delete this');
    await waitGone(alice.page, 'bob will delete this');

    // --- add Carol, then remove her: the key rotates for the remaining members
    await addMember(alice.page, 'carol');
    await send(alice.page, 'carol is in');
    await openGroup(carol.page, 'lifecycle');
    await waitBubble(carol.page, 'carol is in');
    await removeMember(alice.page, 'carol');
    await send(alice.page, 'after removal');
    await waitBubble(bob.page, 'after removal');
    await send(bob.page, 'bob after removal');
    await waitBubble(alice.page, 'bob after removal');

    // --- two tabs of one account (same browser profile)
    const tab2 = await alice.ctx.newPage();
    track(tab2, 'alice-tab2');
    await tab2.setViewport({ width: 1280, height: 900 });
    await tab2.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await tab2.waitForSelector('.nav-link, #unlock-password', { timeout: 40000 }).catch(async (e) => {
        const dump = await tab2.evaluate(() => ({ url: location.href, text: document.body?.innerText?.slice(0, 300), ids: [...document.querySelectorAll('[id]')].slice(0, 25).map((x) => x.id) })).catch((x) => String(x));
        throw new Error(`tab 2 shows neither the app nor a login: ${JSON.stringify(dump)}`);
    });
    if (!(await tab2.$('.nav-link'))) {
        // a second tab of a signed-in profile shows the real "Welcome back" unlock screen
        await tab2.type('#unlock-password', PASSWORD);
        await Promise.all([tab2.click('#unlock-form button[type="submit"], #unlock-form button'), tab2.waitForSelector('.nav-link', { timeout: 30000 })]);
    }
    await sleep(800);
    await openGroup(tab2, 'lifecycle');
    await waitBubble(tab2, 'bob after removal');
    await send(tab2, 'from alice tab 2');
    await waitBubble(bob.page, 'from alice tab 2');
    await send(alice.page, 'from alice tab 1');
    await waitBubble(bob.page, 'from alice tab 1');
    await waitBubble(tab2, 'from alice tab 1');
    await waitBubble(alice.page, 'from alice tab 2');

    // everyone who is still a member reads the complete conversation
    for (const [name, page] of [['alice', alice.page], ['bob', bob.page]]) {
        const seen = await bubbles(page);
        for (const expected of ['hello from alice', 'bob replies', 'carol is in', 'after removal', 'bob after removal', 'from alice tab 1', 'from alice tab 2']) {
            assert.ok(seen.includes(expected), `${name} sees "${expected}"; saw ${JSON.stringify(seen)}`);
        }
        assert.ok(!seen.includes('bob will delete this'), `${name}: the deleted message is gone`);
    }

    assert.deepEqual(problems, [], `no page errors or KDM/verification problems: ${JSON.stringify(problems)}`);
});
