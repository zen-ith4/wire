// tests/groups/group-hostile-browser.test.mjs
//
// Phase C4, item 5: REAL Chromium, real server, the unmodified client. A hostile server
// (the test, editing the database) fills EVERY field the client could render with markup:
//   - an UNVERIFIED message: every envelope field is a payload,
//   - the sender display data: username and accent colour (the role is schema-constrained),
//   - a reply quote: its author's name and its (unverified) content.
// Nothing may execute: window.__pwned must stay unset, no element may carry an event
// handler, no injected <img>/<svg>/<script> may exist; the hostile text may only appear
// as TEXT. Skips (never passes) when no Chromium can be launched.

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

const PAYLOADS = [
    '<img src=x onerror="window.__pwned=true">',
    '"><svg onload="window.__pwned=true">',
    "'><script>window.__pwned=true</script>",
    'javascript:window.__pwned=true//',
    'red" onmouseover="window.__pwned=true" x="',
];

test('hostile strings in an unverified message, the sender display data and a reply quote never execute (real Chromium)', async (t) => {
    const launched = await launchBrowser();
    if (!launched.browser) {
        t.skip(`BLOCKED: no Chromium available (${launched.reason})`);
        return;
    }
    browsers.push(launched.browser);
    const origin = await startRealApp();

    for (const u of ['alice', 'bob']) {
        const r = await fetch(`${origin}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, email: `${u}@example.com`, password: PASSWORD }),
        });
        assert.equal(r.status, 201, `register ${u}`);
    }

    async function signIn(user, first) {
        let b = launched.browser;
        if (!first) {
            const next = await launchBrowser();
            assert.ok(next.browser, `another Chromium launches (${next.reason})`);
            browsers.push(next.browser);
            b = next.browser;
        }
        const page = await b.newPage();
        page.setDefaultTimeout(25000);
        await page.setViewport({ width: 1280, height: 900 });
        // arm the canary BEFORE any page script runs, on every document of this tab
        await page.evaluateOnNewDocument(() => { window.__pwned = false; });
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#auth-username');
        await page.type('#auth-username', user);
        await page.type('#auth-password', PASSWORD);
        await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { timeout: 30000 })]);
        await sleep(800);
        return { user, page };
    }
    async function reload(page) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.nav-link, #unlock-password', { timeout: 40000 });
        if (!(await page.$('.nav-link'))) {
            await page.type('#unlock-password', PASSWORD);
            await Promise.all([page.click('#unlock-form button[type="submit"], #unlock-form button'), page.waitForSelector('.nav-link', { timeout: 30000 })]);
        }
        await sleep(800);
    }
    const waitBubble = (page, text) => page.waitForFunction(
        (tx) => [...document.querySelectorAll('#group-messages .chat-bubble')].some((e) => e.textContent.trim() === tx), { timeout: 20000 }, text
    );
    async function openGroup(page, name) {
        await page.click('.nav-link[data-view="groups"]');
        await page.waitForSelector('#group-list');
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

    const alice = await signIn('alice', true);
    const bob = await signIn('bob', false);

    // --- an honest conversation: create, add, send, reply with a quote
    await alice.page.click('.nav-link[data-view="groups"]');
    await alice.page.waitForSelector('#group-list');
    await alice.page.click('#new-chat-fab');
    await alice.page.click('[data-fab-action="group"]');
    await alice.page.waitForSelector('#new-group-name');
    await alice.page.waitForSelector('#new-group-create:not([disabled])');
    await alice.page.type('#new-group-name', 'hostile');
    await alice.page.click('#new-group-create');
    await alice.page.waitForSelector('#group-input');
    await alice.page.click('[data-action="group-settings"]');
    await alice.page.waitForSelector('#add-member-select');
    const bobOption = await alice.page.evaluate(() => [...document.querySelectorAll('#add-member-select option')].find((o) => o.textContent.trim() === 'bob')?.value);
    await alice.page.select('#add-member-select', bobOption);
    await alice.page.click('#add-member-btn');
    await alice.page.waitForFunction(() => [...document.querySelectorAll('.grp-member-row')].some((r) => r.textContent.includes('bob')), { timeout: 20000 });
    await alice.page.click('#group-settings-close');
    await sleep(300);

    await send(alice.page, 'quoted original');
    await openGroup(bob.page, 'hostile');
    await waitBubble(bob.page, 'quoted original');
    await bob.page.evaluate(() => {
        const b = [...document.querySelectorAll('#group-messages .chat-bubble')].find((e) => e.textContent.trim() === 'quoted original');
        b.closest('.chat-msg-content').querySelector('.chat-msg-reply').click();
    });
    await send(bob.page, 'bob quotes alice');
    await send(alice.page, 'message to be tampered with');
    await waitBubble(bob.page, 'message to be tampered with');
    await send(alice.page, 'second message to be tampered with');
    await waitBubble(bob.page, 'second message to be tampered with');

    // --- the hostile server edits everything the client could render
    const { getDb } = require('../../config/database');
    const db = getDb();
    const [H1, H2, H3, H4, H5] = PAYLOADS;
    const groupId = db.prepare("SELECT id FROM groups WHERE name = 'hostile'").get().id;
    const aliceId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
    const bobId = db.prepare("SELECT id FROM users WHERE username = 'bob'").get().id;
    const msgs = db.prepare('SELECT id, sender_id FROM group_messages WHERE group_id = ? ORDER BY id').all(groupId);
    const [original, , tamperTarget, tamperTarget2] = msgs;

    // an unverified message: every envelope field is a payload
    const hostileEnvelope = Object.fromEntries(['v', 'alg', 'senderKeyId', 'counter', 'iv', 'ciphertext', 'reply_to_id', 'sig', 'extra'].map((k, i) => [k, PAYLOADS[i % PAYLOADS.length]]));
    db.prepare('UPDATE group_messages SET content = ? WHERE id = ?').run(JSON.stringify(hostileEnvelope), tamperTarget.id);
    // a structurally VALID envelope with a zeroed signature and hostile extra fields
    const valid = JSON.parse(db.prepare('SELECT content FROM group_messages WHERE id = ?').get(tamperTarget2.id).content);
    db.prepare('UPDATE group_messages SET content = ? WHERE id = ?').run(
        JSON.stringify({ ...valid, sig: Buffer.alloc(64).toString('base64'), extra: H1, note: H2, unexpected: { deep: H3 } }), tamperTarget2.id);
    // the quoted message (also unverified): its quote shows no envelope data
    const validOriginal = JSON.parse(db.prepare('SELECT content FROM group_messages WHERE id = ?').get(original.id).content);
    db.prepare('UPDATE group_messages SET content = ? WHERE id = ?').run(
        JSON.stringify({ ...validOriginal, sig: Buffer.alloc(64).toString('base64'), extra: H3, note: H4 }), original.id);
    // sender display data
    db.prepare('UPDATE users SET username = ?, accent_color = ? WHERE id = ?').run(H1, H5, aliceId);
    db.prepare('UPDATE users SET username = ?, accent_color = ? WHERE id = ?').run(H2, H4, bobId);
    // (group_members.role is constrained by the schema to owner/admin/member, so a hostile ROLE cannot be stored;
    //  a server that answers the members API with a hostile role is NOT covered by this database-level test)

    const injected = (page) => page.evaluate(() => ({
        pwned: window.__pwned,
        // an event-handler ATTRIBUTE (name on*) carrying our payload, or an attribute named like the ones the payloads try to smuggle in.
        // (An attribute whose VALUE merely contains the payload text, e.g. a title, is inert data.)
        handlers: [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name) && /pwned/.test(a.value))).length,
        images: document.querySelectorAll('img[src="x"]').length,
        svgs: document.querySelectorAll('svg[onload]').length,
        scripts: [...document.querySelectorAll('script')].filter((s) => !s.src && /__pwned/.test(s.textContent)).length,
        mouseover: document.querySelectorAll('[onmouseover]').length,
    }));

    for (const [who, page] of [['bob', bob.page], ['alice', alice.page]]) {
        await reload(page);
        await openGroup(page, 'hostile');
        await page.waitForFunction(
            () => [...document.querySelectorAll('#group-messages .chat-bubble')].some((e) => e.textContent.includes('Message could not be verified')), { timeout: 20000 }
        );

        // hover and click around: handlers would fire here
        await page.evaluate(() => document.querySelectorAll('#group-messages *').forEach((e) => {
            e.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            e.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }));

        // the members dialog renders usernames and roles
        await page.click('[data-action="group-settings"]');
        await page.waitForSelector('.grp-member-row', { timeout: 20000 });
        await sleep(300);

        const state = await injected(page);
        assert.deepEqual(state, { pwned: false, handlers: 0, images: 0, svgs: 0, scripts: 0, mouseover: 0 }, `${who}: nothing executed or was injected`);

        // the hostile text is only ever TEXT
        const texts = await page.evaluate(() => ({
            senders: [...document.querySelectorAll('.chat-sender')].map((e) => e.textContent),
            body: document.body.innerText,
        }));
        assert.ok(texts.body.includes('Message could not be verified'), `${who}: static placeholder shown`);
        const placeholders = await page.evaluate(() => [...document.querySelectorAll('#group-messages .chat-bubble')].filter((e) => e.textContent.includes('Message could not be verified')).length);
        // the validly-shaped one and the quoted original (also tampered). The fully MALFORMED envelope is
        // dropped per message (existing contract, group-keys-contract K-2): not rendered at all.
        assert.equal(placeholders, 2, `${who}: every tampered, well-formed message is a placeholder`);
        const allBubbles = await page.evaluate(() => [...document.querySelectorAll('#group-messages .chat-bubble')].length);
        assert.equal(allBubbles, 3, `${who}: the malformed message is dropped, nothing else is lost (quoted original, tampered, own reply)`);
        const quoteText = await page.evaluate(() => {
            const bubble = [...document.querySelectorAll('#group-messages .chat-bubble')].find((e) => e.textContent.trim() === 'bob quotes alice');
            return bubble?.closest('.chat-msg-content')?.querySelector('.reply-quote-text')?.textContent ?? null;
        });
        assert.equal(quoteText, '⚠️ Unverified message', `${who}: the quote of an unverified message is the static label`);
        assert.ok(!texts.body.includes('"alg"') && !PAYLOADS.slice(0, 3).some((p) => texts.body.includes(`${p}x`)), `${who}: nothing of the unverified envelope is rendered`);
        await page.click('#group-settings-close').catch(() => {});
    }
});
