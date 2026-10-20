// tests/groups/group-attachment-browser.test.mjs
//
// STEP 3C item 5 (real Chromium): group attachments end to end.
//
//   1. an honest send and receive: an image renders INLINE, a PDF is a
//      DOWNLOAD;
//   2. a hostile relay swaps the stored blob -> that row shows
//      "Attachment unavailable" and the other rows still render;
//   3. a hostile relay serves file A under message B -> same;
//   4. no key / iv / hash / ciphertext material reaches the DOM, not even in
//      a quote;
//   5. with the flag OFF the group composer has no attach control at all.
//
// The group attachment UI is behind GROUP_ATTACHMENTS_UI_ENABLED, which ships
// false; these tests turn it on through the test-only setter (gated on a hook
// global that only the test sets).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
    rand,
    sleep,
    waitFor,
    startRealServer,
    sessionFromPage,
    newUserPage,
    closeUserBrowsers,
    loginUi,
    openGroupUi,
    registerUser,
} from '../_acceptance-harness.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

let server = null;
let fixtureDir = null;

after(async () => {
    await closeUserBrowsers();
    // The teardown must not hold the file open: the server child can take a
    // while to die, and the file-level test would wait for it.
    await Promise.race([server?.stop().catch(() => {}), sleep(8000)]);
    for (const d of [server?.work, fixtureDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
    // Same pattern as tests/dm-attachments/dm-attachments-server-cap.test.mjs:
    // the server child can keep the event loop alive, so leave it deliberately.
    setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

/** The group attachment UI is behind a flag: turn it on in a page. */
async function enableFlag(page) {
    await page.evaluate(async () => {
        globalThis.__WIRE_TEST_HOOK_GROUP_ATTACHMENTS__ = true;
        const m = await import('/js/chat/group-attachments-flag.js');
        m.setGroupAttachmentsUiEnabledForTests(true);
    });
}

/** A file on disk for the composer to upload. */
function fixture(name, bytes) {
    if (!fixtureDir) fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-3c-'));
    const p = path.join(fixtureDir, name);
    fs.writeFileSync(p, bytes);
    return p;
}

/** A click on an element. The DOM click is used (not puppeteer's mouse
 *  click) because the thread repaints can replace the element between the
 *  hit test and the click; the delegated handler is what is under test. */
async function clickIn(page, selector) {
    await page.waitForSelector(selector, { timeout: 15000 });
    await page.$eval(selector, (el) => el.click());
}

/** The whole world for one scenario. */
async function world() {
    server = await startRealServer();
    const { origin } = server;
    const n = rand();
    const names = { alice: `al${n}`, bob: `bo${n}` };
    for (const u of Object.values(names)) await registerUser(origin, u);

    const { page: alicePage } = await newUserPage();
    await loginUi(alicePage, origin, names.alice);
    const { page: bobPage } = await newUserPage();
    await loginUi(bobPage, origin, names.bob);

    const sess = {};
    sess.alice = await sessionFromPage(alicePage, origin, names.alice);
    sess.bob = await sessionFromPage(bobPage, origin, names.bob);

    const g = await sess.alice.api('/api/groups', { method: 'POST', body: JSON.stringify({ name: `3c ${n}` }) });
    const gid = g.body.id;
    const add = await sess.alice.api(`/api/groups/${gid}/members`, { method: 'POST', body: JSON.stringify({ user_id: sess.bob.id }) });
    assert.equal(add.status, 200, JSON.stringify(add.body));

    return { origin, names, alicePage, bobPage, sess, gid };

}

/** Alice sends a file (with a caption) into the group through the real composer. */
async function sendFile(page, gid, filePath, caption) {
    await openGroupUi(page, gid);
    const input = await page.$('#group-file-input');
    assert.ok(input, 'the attach control must exist when the flag is on');
    await input.uploadFile(filePath);
    await page.waitForSelector('#group-staging-area .attach-chip', { timeout: 10000 });
    if (caption) await page.type('#group-input', caption);
    const before = await page.$$eval('#group-messages .chat-msg', (e) => e.length);
    await page.evaluate(() => window.sendGroupMessage());
    await page.waitForFunction((n0) => document.querySelectorAll('#group-messages .chat-msg').length > n0, { timeout: 30000 }, before);
    await sleep(500);
}

/** Bob opens the group and waits until the attachment shows up. */
async function bobSees(bobPage, gid, selector, timeout = 25000) {
    await openGroupUi(bobPage, gid);
    return waitFor(async () => bobPage.$(selector), timeout, 250);
}

function db() {
    return new Database(server.dbPath, { readonly: true, fileMustExist: true });
}

/** A WRITABLE handle: the hostile relay edits the stored rows. */
function dbWrite() {
    return new Database(server.dbPath, { fileMustExist: true });
}

/** A FRESH page for the recipient (the old one caches the decrypted message). */
async function freshRecipient(w) {
    const { page } = await newUserPage();
    await loginUi(page, w.origin, w.names.bob);
    await enableFlag(page);
    return page;
}

test('1 honest send and receive: an image renders inline, a PDF is a download', async (t) => {
    const w = await world();
    await enableFlag(w.alicePage);
    await enableFlag(w.bobPage);

    const png = fixture('photo.png', PNG);
    const pdf = fixture('doc.pdf', PDF);

    await sendFile(w.alicePage, w.gid, png, 'a picture');
    await sendFile(w.alicePage, w.gid, pdf, 'a document');

    // The image renders INLINE (a blob URL of the decrypted bytes). It is
    // auto-loaded because the row is visible and the file is a small image
    // (STEP 3D item 2).
    const img = await bobSees(w.bobPage, w.gid, '#group-messages .chat-attachment-image');
    assert.ok(img, 'the image must render inline for the recipient');
    const src = await w.bobPage.$eval('#group-messages .chat-attachment-image', (e) => e.getAttribute('src'));
    assert.ok(src && src.startsWith('blob:'), `the inline image must be a blob URL, got ${src}`);

    // The PDF is NOT auto-loaded: a non-image waits for an explicit click.
    const btn = await bobSees(w.bobPage, w.gid, '#group-messages button.chat-attachment-download');
    assert.ok(btn, 'the PDF row must offer a download button');
    const label = await w.bobPage.$eval('#group-messages button.chat-attachment-download', (e) => e.textContent);
    assert.match(label, /Download \(.*\)/, `the button must name the size, got ${label}`);
    await clickIn(w.bobPage, '#group-messages button.chat-attachment-download');

    const link = await bobSees(w.bobPage, w.gid, '#group-messages a.chat-attachment-download');
    assert.ok(link, 'a non-image must be a download link after the click');
    const dl = await w.bobPage.$eval('#group-messages a.chat-attachment-download', (e) => ({
        href: e.getAttribute('href') || '',
        download: e.getAttribute('download') || '',
    }));
    assert.ok(dl.href.startsWith('blob:'), `the download must be a blob URL, got ${dl.href}`);
    assert.equal(dl.download, 'doc.pdf', 'the download carries the sanitised file name');

    // The name is shown as text, and the caption came from the encrypted plaintext.
    const threadText = await w.bobPage.$eval('#group-messages', (e) => e.innerText);
    assert.match(threadText, /a picture/);
    assert.match(threadText, /a document/);
    assert.match(threadText, /photo\.png|doc\.pdf/);
});

test('2 a hostile relay swaps the stored blob: that row shows "Attachment unavailable", the others still render', async (t) => {
    const w = await world();
    await enableFlag(w.alicePage);
    await enableFlag(w.bobPage);

    const png = fixture('photo.png', PNG);
    await sendFile(w.alicePage, w.gid, png, 'the picture');
    // A plain text message too, so there is another row that must survive.
    await openGroupUi(w.alicePage, w.gid);
    await w.alicePage.type('#group-input', 'just text');
    await w.alicePage.evaluate(() => window.sendGroupMessage());
    await sleep(500);

    await bobSees(w.bobPage, w.gid, '#group-messages .chat-attachment-image');
    assert.ok(await w.bobPage.$('#group-messages .chat-attachment-image'), 'the image renders before the swap');

    // The relay swaps the stored bytes.
    const d = db();
    const row = d.prepare('SELECT id, attachment_path FROM group_messages WHERE group_id = ? AND attachment_path IS NOT NULL ORDER BY id DESC LIMIT 1').get(w.gid);
    d.close();
    const stored = path.join(server.dirs.group, row.attachment_path);
    fs.writeFileSync(stored, Buffer.from('tampered bytes, not the real file'));

    // A fresh recipient page: the file no longer matches what the sender signed.
    const bob2 = await freshRecipient(w);
    const placeholder = await bobSees(bob2, w.gid, '#group-messages .chat-attachment-unsupported');
    assert.ok(placeholder, 'the tampered row must show the placeholder');
    const text = await bob2.$eval('#group-messages', (e) => e.innerText);
    assert.match(text, /Attachment unavailable/);
    assert.match(text, /just text/, 'the other row must still render');
});

test('3 a hostile relay serves file A under message B: the row shows "Attachment unavailable"', async (t) => {
    const w = await world();
    await enableFlag(w.alicePage);
    await enableFlag(w.bobPage);

    const png = fixture('photo.png', PNG);
    const pdf = fixture('doc.pdf', PDF);
    await sendFile(w.alicePage, w.gid, png, 'picture row');
    await sendFile(w.alicePage, w.gid, pdf, 'document row');
    await bobSees(w.bobPage, w.gid, '#group-messages .chat-attachment-download');

    // The relay points the DOCUMENT row at the IMAGE's stored bytes.
    const d = db();
    const rows = d.prepare('SELECT id, attachment_path FROM group_messages WHERE group_id = ? AND attachment_path IS NOT NULL ORDER BY id').all(w.gid);
    d.close();
    assert.equal(rows.length, 2, 'two attachment rows');
    const d2 = dbWrite();
    const swapped = d2.prepare('UPDATE group_messages SET attachment_path = ? WHERE id = ?').run(rows[0].attachment_path, rows[1].id);
    d2.close();
    assert.equal(swapped.changes, 1);

    const bob2 = await freshRecipient(w);
    // The document row is not auto-loaded: the download needs an explicit
    // click (STEP 3D item 2), and only then is the swap noticed.
    const btn = await bobSees(bob2, w.gid, '#group-messages button.chat-attachment-download');
    assert.ok(btn, 'the row must offer a download button');
    await clickIn(bob2, '#group-messages button.chat-attachment-download');
    await sleep(2500);
    const placeholder = await bobSees(bob2, w.gid, '#group-messages .chat-attachment-unsupported');
    assert.ok(placeholder, 'the row whose file was swapped must show the placeholder');
});

test('4 no key / iv / hash / ciphertext material reaches the DOM, not even in a quote', async (t) => {
    const w = await world();
    await enableFlag(w.alicePage);
    await enableFlag(w.bobPage);

    const png = fixture('photo.png', PNG);
    await sendFile(w.alicePage, w.gid, png, 'a picture');
    await bobSees(w.bobPage, w.gid, '#group-messages .chat-attachment-image');

    // The signed values of the stored envelope.
    const d = db();
    const row = d.prepare('SELECT content FROM group_messages WHERE group_id = ? AND attachment_path IS NOT NULL ORDER BY id DESC LIMIT 1').get(w.gid);
    d.close();
    const env = JSON.parse(row.content);
    const secrets = [env.att_iv, env.att_ct_hash, env.ciphertext, env.sig].filter(Boolean);

    const html = await w.bobPage.evaluate(() => document.body.innerHTML);
    for (const secret of secrets) {
        assert.ok(!html.includes(secret), `the DOM must not contain ${secret.slice(0, 12)}...`);
    }
    assert.ok(!/attachment_meta|att_ct_hash/.test(html), 'the DOM must not name the binding fields');

    // A quote of the attachment message: it shows the file name, and still no
    // key material.
    await openGroupUi(w.alicePage, w.gid);
    const d3 = db();
    const msgId = d3.prepare('SELECT id FROM group_messages WHERE group_id = ? AND attachment_path IS NOT NULL ORDER BY id DESC LIMIT 1').get(w.gid).id;
    d3.close();
    assert.ok(msgId, 'the message must have an id');
    await w.alicePage.evaluate((id) => { window.replyToGroupMessage && window.replyToGroupMessage(id); }, msgId);
    await sleep(300);
    await w.alicePage.type('#group-input', 'a reply');
    await w.alicePage.evaluate(() => window.sendGroupMessage());
    await sleep(800);

    const aliceHtml = await w.alicePage.evaluate(() => document.body.innerHTML);
    for (const secret of secrets) {
        assert.ok(!aliceHtml.includes(secret), 'the quote must not contain key material');
    }
    const quoteText = await w.alicePage.$eval('#group-messages', (e) => e.innerText);
    assert.match(quoteText, /photo\.png|a picture/, 'the quote shows the file name or the caption');
});

test('5 with the flag OFF the group composer has NO attach control and NO file input', async (t) => {
    const w = await world();
    // The flag is NEVER turned on here: this is the shipped state.
    await openGroupUi(w.alicePage, w.gid);
    const state = await w.alicePage.evaluate(() => ({
        fileInput: !!document.getElementById('group-file-input'),
        staging: !!document.getElementById('group-staging-area'),
        attachButtons: [...document.querySelectorAll('#group-input-area button')].filter((b) => (b.getAttribute('title') || '') === 'Attach').length,
    }));
    assert.equal(state.fileInput, false, 'there must be no file input');
    assert.equal(state.staging, false, 'there must be no staging area');
    assert.equal(state.attachButtons, 0, 'there must be no attach button');
});

test('6 the sanitised name is used for BOTH the visible text and the download attribute, and the raw name never reaches the DOM', async (t) => {
    const w = await world();
    await enableFlag(w.alicePage);
    await enableFlag(w.bobPage);

    // A name with a leading dot and a bidi override: the receiver must strip
    // both (STEP 3D item 1).
    const rawName = '.bashrc\u202Egnp.pdf';
    const pdf = fixture(rawName, PDF);
    await sendFile(w.alicePage, w.gid, pdf, 'a document');

    const link = await bobSees(w.bobPage, w.gid, '#group-messages button.chat-attachment-download');
    assert.ok(link, 'a non-image must offer a download button');

    // The download needs an explicit click (a non-image is never auto-loaded).
    await clickIn(w.bobPage, '#group-messages button.chat-attachment-download');
    const a = await bobSees(w.bobPage, w.gid, '#group-messages a.chat-attachment-download');
    assert.ok(a, 'the download link must appear after the click');

    const view = await w.bobPage.evaluate(() => {
        const a = document.querySelector('#group-messages a.chat-attachment-download');
        const span = document.querySelector('#group-messages .chat-attachment-name');
        return {
            download: a ? a.getAttribute('download') : null,
            text: span ? span.textContent : null,
            html: document.body.innerHTML,
        };
    });

    // The sanitised name: the leading dot and the bidi override are gone.
    const expected = 'bashrcgnp.pdf';
    assert.equal(view.text, expected, `the visible text must be the sanitised name, got ${JSON.stringify(view.text)}`);
    assert.equal(view.download, expected, `the download attribute must be the same name, got ${JSON.stringify(view.download)}`);
    assert.equal(view.download, view.text, 'the visible text and the download attribute must be identical');

    // The RAW name (with the bidi override) never reaches the DOM.
    assert.ok(!view.html.includes(rawName), 'the raw name must not reach the DOM');
    assert.ok(!view.html.includes('\u202E'), 'the bidi override must not reach the DOM');
});

test('7 the file is NOT fetched while the thread is decorated: the fetch happens only after the placeholder is in the DOM', async (t) => {
    const w = await world();
    await enableFlag(w.alicePage);
    await enableFlag(w.bobPage);

    await sendFile(w.alicePage, w.gid, fixture('photo.png', PNG), 'a picture');

    // Log every attachment fetch with what the DOM looked like at that moment.
    await w.bobPage.evaluate(() => {
        globalThis.__fetchLog = [];
        const orig = window.fetch;
        window.fetch = async (...args) => {
            const url = String(args[0]);
            if (url.includes('/attachments/')) {
                globalThis.__fetchLog.push({
                    placeholderPresent: !!document.querySelector('[data-group-attachment-id]'),
                    imagePresent: !!document.querySelector('.chat-attachment-image'),
                });
            }
            return orig(...args);
        };
    });

    await bobSees(w.bobPage, w.gid, '#group-messages .chat-attachment-image');
    const log = await w.bobPage.evaluate(() => globalThis.__fetchLog);
    assert.ok(log.length >= 1, 'the attachment must have been fetched');
    assert.equal(log[0].placeholderPresent, true, 'the fetch must not happen during the decorate: the placeholder row was not in the DOM yet');
    assert.equal(log[0].imagePresent, false, 'the fetch must happen before the image exists');
});

test('8 the download queue never has more than 2 downloads in flight', async (t) => {
    const w = await world();
    await enableFlag(w.alicePage);
    await enableFlag(w.bobPage);

    // The attachments are fetched slowly, so the downloads really overlap
    // and the cap is observable. The counter lives in the page (the service
    // worker serves the requests, so puppeteer's page-level request events
    // do not see them).
    await w.bobPage.evaluate(() => {
        globalThis.__conc = { inflight: 0, max: 0, started: 0 };
        const orig = window.fetch;
        window.fetch = async (...args) => {
            const url = String(args[0]);
            const isAtt = url.includes('/attachments/');
            if (!isAtt) return orig(...args);
            globalThis.__conc.inflight++;
            globalThis.__conc.started++;
            globalThis.__conc.max = Math.max(globalThis.__conc.max, globalThis.__conc.inflight);
            try {
                await new Promise((r) => setTimeout(r, 400));
                return await orig(...args);
            } finally {
                globalThis.__conc.inflight--;
            }
        };
    });

    // Five small images: all of them want to be auto-loaded at once.
    for (let i = 0; i < 5; i++) {
        await sendFile(w.alicePage, w.gid, fixture(`photo${i}.png`, PNG), `picture ${i}`);
    }

    // Bob opens the group: the rows become visible and want to be loaded.
    await openGroupUi(w.bobPage, w.gid);

    // Wait for all five to be rendered.
    await waitFor(async () => {
        const n = await w.bobPage.$$eval('#group-messages .chat-attachment-image', (e) => e.length);
        return n >= 5;
    }, 60000, 250);

    const conc = await w.bobPage.evaluate(() => globalThis.__conc);
    assert.ok(conc.started >= 5, `all five files must have been fetched, saw ${conc.started}`);
    assert.ok(conc.max >= 1, 'at least one download must have run');
    assert.ok(conc.max <= 2, `at most 2 downloads may be in flight, saw ${conc.max}`);
});

test('10 a hostile relay answers with a 100 MB body for a 1 KB file: the row shows "Attachment unavailable" and almost nothing is read', async (t) => {
    const w = await world();
    await enableFlag(w.alicePage);
    await enableFlag(w.bobPage);

    // 1 KB of honest content.
    const png = fixture('photo.png', PNG);
    await sendFile(w.alicePage, w.gid, png, 'a picture');

    // The relay replaces the stored bytes with a 100 MB body. The server
    // serves it with its real Content-Length, so the client must see a
    // length that is not the signed one and abort BEFORE reading the body.
    const d = db();
    const row = d.prepare('SELECT id, attachment_path FROM group_messages WHERE group_id = ? AND attachment_path IS NOT NULL ORDER BY id DESC LIMIT 1').get(w.gid);
    d.close();
    const stored = path.join(server.dirs.group, row.attachment_path);
    const block = Buffer.alloc(1024 * 1024, 0x41);
    const fd = fs.openSync(stored, 'w');
    try {
        for (let i = 0; i < 100; i++) fs.writeSync(fd, block);
    } finally {
        fs.closeSync(fd);
    }

    const bob2 = await freshRecipient(w);

    // Count the bytes the client actually reads off the wire.
    await bob2.evaluate(() => {
        globalThis.__bytesRead = 0;
        const orig = window.fetch;
        window.fetch = async (...args) => {
            const res = await orig(...args);
            const url = String(args[0]);
            if (!url.includes('/attachments/') || !res.body) return res;
            const reader = res.body.getReader();
            const counted = {
                getReader: () => ({
                    read: async () => {
                        const r = await reader.read();
                        if (r.value) globalThis.__bytesRead += r.value.length;
                        return r;
                    },
                    cancel: () => reader.cancel(),
                }),
            };
            return new Proxy(res, { get: (t, k) => (k === 'body' ? counted : t[k]) });
        };
    });
    const placeholder = await bobSees(bob2, w.gid, '#group-messages .chat-attachment-unsupported');
    assert.ok(placeholder, 'the row must show the placeholder');

    const read = await bob2.evaluate(() => globalThis.__bytesRead);
    assert.ok(read < 1024 * 1024, `the client must not read the 100 MB body, it read ${read} bytes`);
});

test('9 a file over the auto-load limit waits for an explicit click', async (t) => {    const w = await world();
    await enableFlag(w.alicePage);
    await enableFlag(w.bobPage);

    // 6 MB: over GROUP_ATTACHMENT_AUTO_LOAD_MAX_BYTES (5 MB).
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024, 3)]);
    await sendFile(w.alicePage, w.gid, fixture('big.png', big), 'a big picture');

    const btn = await bobSees(w.bobPage, w.gid, '#group-messages button.chat-attachment-download');
    assert.ok(btn, 'the row must offer a download button');
    const label = await w.bobPage.$eval('#group-messages button.chat-attachment-download', (e) => e.textContent);
    assert.match(label, /Download \(6\.0 MB\)/, `the button must name the size, got ${label}`);

    // It must NOT have been auto-loaded.
    await sleep(1500);
    assert.equal(
        await w.bobPage.$$eval('#group-messages .chat-attachment-image', (e) => e.length),
        0,
        'a file over the auto-load limit must not be fetched automatically'
    );

    // The explicit click loads it.
    await clickIn(w.bobPage, '#group-messages button.chat-attachment-download');
    await sleep(3000);
    const img = await bobSees(w.bobPage, w.gid, '#group-messages .chat-attachment-image');
    assert.ok(img, 'the click must load the file');
});
