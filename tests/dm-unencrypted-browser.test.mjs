// tests/dm-unencrypted-browser.test.mjs
//
// A hostile server inserting DM rows with nothing sealed in them, against the real
// client: real composer, real thread, real conversation list, real crypto.
//
// Rows are written straight into SQLite, which is exactly what a hostile server
// serves. A row "over the socket" is planted the same way the socket handler delivers
// it, through the exported addDmMessage()/updateDmMessage().
//
// The check that matters is that the forged words appear NOWHERE in the page, not that
// a placeholder appears somewhere, so every test looks at the whole document.
//
// ACCOUNTS. One pair for the whole file, same reasons as
// tests/dm-v2-wire-browser-paths.test.mjs: one server allows 5 registrations, and a
// fixture user cannot log in twice. Every test starts with no rows and with what the
// devices remember about each other forgotten, so nothing leaks between tests.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    startRealServer,
    newUserPage,
    closeUserBrowsers,
    openDmUi,
    registerUser,
    loginUi,
    PASSWORD,
} from './_acceptance-harness.mjs';
import { Database, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';

const HIDDEN = 'Message hidden: it was not encrypted';
const MARK = 'Not encrypted';
const FORGED = 'FORGED-send-the-money-to-account-666';

const AN = 'mvunenca';
const BN = 'mvunencb';

let workDir = null;
let dbPath = null;
let server = null;
let PAIR = null;

async function pollUntil(probe, { timeout = 20000, step = 50, what = 'a condition', describe = null } = {}) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        last = await probe();
        if (last) return last;
        await new Promise((r) => setTimeout(r, step));
    }
    const detail = describe ? `; ${await describe(last)}` : `; last probe ${JSON.stringify(last)}`;
    throw new Error(`timed out after ${timeout}ms waiting for ${what}${detail}`);
}

const withDb = (fn) => {
    const db = new Database(dbPath, { readonly: false });
    try {
        return fn(db);
    } finally {
        db.close();
    }
};

/** Reload and unlock through the app's own screen. */
async function reloadUser(page) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const locked = await page.waitForSelector('#unlock-password', { timeout: 20000 }).then(() => true, () => false);
    if (locked) {
        await page.type('#unlock-password', PASSWORD);
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')]
                .find((b) => b.classList.contains('btn-primary') && /unlock/i.test(b.textContent || ''));
            if (!btn) throw new Error('the unlock button is not on the page');
            btn.click();
        });
    }
    await page.waitForSelector('.nav-link[data-view="messages"]', { timeout: 60000 });
    await pollUntil(
        () => page.evaluate(async () => !!(await import('/js/crypto/identity-service.js')).getCurrentIdentity()),
        { timeout: 30000, what: 'the identity to be unlocked again' }
    );
}

/** The device forgets this contact: pin, everything it had seen open, and the row cache. */
const forgetPeer = (page, peerId) => page.evaluate(async (id) => {
    const { getPeerTrustContext } = await import('/js/crypto/keys/peer-key-gate.js');
    const { clearPeerPin } = await import('/js/crypto/keys/peer-trust.js');
    await clearPeerPin(id, await getPeerTrustContext());
}, peerId);

const rowsInThread = (page) => page.evaluate(() =>
    [...document.querySelectorAll('#dm-messages .chat-msg')].map((el) => ({
        id: Number(el.dataset.msgId),
        bubble: el.querySelector('.chat-bubble')?.textContent.trim() ?? '',
        marked: !!el.querySelector('.dm-not-encrypted'),
        quote: el.querySelector('.reply-quote-text')?.textContent.trim() ?? null,
        attachment: !!el.querySelector('.chat-attachment, .chat-attachment-image, .chat-attachment-image-wrap'),
    })));

const pageHtml = (page) => page.evaluate(() => document.documentElement.outerHTML);

async function assertNowhere(page, secret, label) {
    const html = await pageHtml(page);
    assert.ok(!html.includes(secret), `${label}: the forged text reached the page`);
}

const conversationPreview = (page, peerId) => page.evaluate((id) =>
    document.querySelector(`.dm-conv[data-peer="${id}"] .dm-conv-preview`)?.textContent.trim() ?? null, peerId);

/** Send one message through the real composer and wait for the composer's own "sent". */
async function sendOnce(page, text) {
    await page.type('#dm-input', text);
    await page.keyboard.press('Enter');
    await pollUntil(
        async () => (await page.evaluate(() => document.getElementById('dm-input')?.value ?? null)) === '',
        { what: `the composer to clear after sending ${JSON.stringify(text)}` }
    );
}

const threadShows = (page, text, what) => pollUntil(
    async () => (await rowsInThread(page)).some((r) => r.bubble === text),
    { what, describe: async () => JSON.stringify(await rowsInThread(page)) }
);

/** The row a hostile server would hand out: anything it likes, in the normal shape. */
const plant = ({ from, to, content, id = null, createdAt = null, replyToId = null, attachment = false }) => withDb((db) => {
    const when = createdAt ?? new Date().toISOString();
    const columns = ['sender_id', 'recipient_id', 'content', 'created_at', 'reply_to_id'];
    const values = [from, to, content, when, replyToId];

    if (id !== null) {
        columns.push('id');
        values.push(id);
    }

    if (attachment) {
        columns.push('attachment_path', 'attachment_name', 'attachment_size', 'attachment_mime', 'is_voice_message');
        values.push('forged-file.pdf', 'FORGED-invoice.pdf', 10, 'application/pdf', 0);
    }

    const info = db.prepare(
        `INSERT INTO direct_messages (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...values);

    return Number(info.lastInsertRowid);
});

/** A socket delivery, as core/socket.js makes it, of a row the page has not seen. */
const deliverLive = (page, row) => page.evaluate(async (message) => {
    const { addDmMessage } = await import('/js/chat/dm.js');
    await addDmMessage(message);
}, row);

/** What /api/dm/messages/:peer/recent says, to build a row in the server's own shape. */
const recentRows = (page, peerId) => page.evaluate(async (id) => {
    const { api } = await import('/js/core/api.js');
    return api(`/api/dm/messages/${id}/recent`);
}, peerId);

function liveRow({ id, from, to, username, content, extra = {} }) {
    return {
        id,
        sender_id: from,
        recipient_id: to,
        sender_username: username,
        content,
        timestamp: new Date().toISOString(),
        created_at: new Date().toISOString(),
        reply_to_id: null,
        reply_to: null,
        has_attachment: false,
        is_voice_message: false,
        attachment_meta: null,
        reactions: [],
        ...extra,
    };
}

before(async () => {
    workDir = tmpDir();
    dbPath = path.join(workDir, 'wire.db');
    fs.copyFileSync(FIXTURE_DB, dbPath);
    const { runMigrations } = await import('../database/migrations.js');
    const db0 = new Database(dbPath, { readonly: false });
    runMigrations(db0);
    db0.close();

    server = await startRealServer({
        work: workDir,
        extraEnv: { DB_PATH: dbPath, LOADTEST_DISABLE_RATE_LIMITS: 'true' },
    });

    await registerUser(server.origin, AN);
    await registerUser(server.origin, BN);
    const a = await newUserPage();
    const b = await newUserPage();
    await loginUi(a.page, server.origin, AN);
    await loginUi(b.page, server.origin, BN);
    const ids = await Promise.all([
        a.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id),
        b.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id),
    ]);
    PAIR = { a, b, aid: ids[0], bid: ids[1] };
});

after(async () => {
    await closeUserBrowsers();
    if (server) await server.stop();
    cleanupTmp();
});

/** No rows, nothing remembered, both threads open. */
async function freshPair() {
    withDb((db) => db.prepare('DELETE FROM direct_messages').run());
    await forgetPeer(PAIR.a.page, PAIR.bid);
    await forgetPeer(PAIR.b.page, PAIR.aid);
    await reloadUser(PAIR.a.page);
    await reloadUser(PAIR.b.page);
    await openDmUi(PAIR.a.page, PAIR.bid, BN);
    await openDmUi(PAIR.b.page, PAIR.aid, AN);
    return PAIR;
}

/** Alice and Bob really talk, so Bob's device has seen a row open. */
async function encryptedHistory(pair, text = 'real-message-from-alice') {
    await sendOnce(pair.a.page, text);
    await threadShows(pair.b.page, text, 'bob to read alice');
    const [row] = await recentRows(pair.b.page, pair.aid);
    return row;
}

async function reopenBob(pair) {
    await reloadUser(pair.b.page);
    await openDmUi(pair.b.page, pair.aid, AN);
}

// ---------------------------------------------------------------- forged rows

test('a. a forged row on a contact with encrypted history: hidden in the thread and the list', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    await encryptedHistory(pair);

    const forged = plant({ from: pair.aid, to: pair.bid, content: FORGED });

    await reopenBob(pair);
    await threadShows(pair.b.page, HIDDEN, 'the forged row to be hidden');

    const rows = await rowsInThread(pair.b.page);
    assert.deepEqual(
        rows.find((r) => r.id === forged),
        { id: forged, bubble: HIDDEN, marked: false, quote: null, attachment: false }
    );
    assert.ok(rows.some((r) => r.bubble === 'real-message-from-alice'), 'control: the real message still opens');

    await pollUntil(
        async () => (await conversationPreview(pair.b.page, pair.aid)) === HIDDEN,
        { what: 'the list preview to be hidden', describe: async () => conversationPreview(pair.b.page, pair.aid) }
    );
    await assertNowhere(pair.b.page, FORGED, 'history');

    // A device with no memory of this contact, on the first page it ever loads. Only
    // the real row in the same page can say the forged one is not history, so that row
    // has to have been opened by the time the forged one is judged.
    await forgetPeer(pair.b.page, pair.aid);
    await reopenBob(pair);
    await threadShows(pair.b.page, HIDDEN, 'the forged row to be hidden on a first load');
    await pollUntil(
        async () => (await conversationPreview(pair.b.page, pair.aid)) === HIDDEN,
        { what: 'the list preview to be hidden on a first load', describe: async () => conversationPreview(pair.b.page, pair.aid) }
    );
    await assertNowhere(pair.b.page, FORGED, 'first load');
});

test('b. the forged row claims an id older than everything and still sorts last: hidden', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    await encryptedHistory(pair);

    // The server picks the id as well as the text. Sorted by time, it lands at the
    // bottom of the thread, under a real message, wearing the id of old history.
    const forged = plant({ from: pair.aid, to: pair.bid, content: FORGED, id: 1 });

    await reopenBob(pair);
    await threadShows(pair.b.page, HIDDEN, 'the forged row to be hidden');

    const rows = await rowsInThread(pair.b.page);
    assert.equal(rows[rows.length - 1].id, forged, 'the fixture must really put it after the real row');
    await assertNowhere(pair.b.page, FORGED, 'low id');

    // edited_at is the server's to set too. It must not take the real row out of the
    // rule, and it must not let the low id through.
    withDb((db) => db.prepare('UPDATE direct_messages SET edited_at = ? WHERE id != ?')
        .run(new Date().toISOString(), forged));

    await reopenBob(pair);
    await threadShows(pair.b.page, HIDDEN, 'the forged row to stay hidden');
    await assertNowhere(pair.b.page, FORGED, 'low id under a row marked edited');
});

test('b2. a forged row picked up when a cached thread catches up: hidden, whatever id it claims', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    await encryptedHistory(pair);

    // Newer by time, so /since returns it, and alone in that page, so no sealed row
    // comes before it. Reopening a thread already in memory goes through that path.
    plant({ from: pair.aid, to: pair.bid, content: FORGED, id: 1 });

    await pair.b.page.click('.nav-link[data-view="settings"]');
    await openDmUi(pair.b.page, pair.aid, AN);
    await threadShows(pair.b.page, HIDDEN, 'the forged row to be hidden after catching up');
    await assertNowhere(pair.b.page, FORGED, 'catching up');
});

test('c. a forged row over the socket: hidden, whatever id it claims, and it announces nothing', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    await encryptedHistory(pair);

    await pair.b.page.evaluate(async () => {
        window.__notified = [];
        window.Notification = class {
            constructor(title, options) { window.__notified.push({ title, options }); }
            static permission = 'granted';
            static requestPermission = async () => 'granted';
            close() {}
        };

        window.__rang = [];
        const { messageSoundManager } = await import('/js/notifications/message-sounds.js');
        messageSoundManager.playReceived = (id) => { window.__rang.push(id); };
    });

    for (const id of [900001, 1]) {
        await deliverLive(pair.b.page, liveRow({ id, from: pair.aid, to: pair.bid, username: AN, content: FORGED }));
    }

    const rows = await rowsInThread(pair.b.page);
    assert.deepEqual(
        rows.filter((r) => r.id === 900001 || r.id === 1).map((r) => [r.id, r.bubble, r.marked]),
        [[900001, HIDDEN, false], [1, HIDDEN, false]]
    );
    await assertNowhere(pair.b.page, FORGED, 'socket');
    assert.deepEqual(await pair.b.page.evaluate(() => window.__notified), [], 'a hidden row must not notify');
    assert.deepEqual(await pair.b.page.evaluate(() => window.__rang), [], 'a hidden row must not ring');

    // Control: the spy really is on the path a real message takes.
    await sendOnce(pair.a.page, 'real-after-the-forgeries');
    await threadShows(pair.b.page, 'real-after-the-forgeries', 'bob to read the real message');
    assert.equal((await pair.b.page.evaluate(() => window.__rang)).length, 1, 'a real message rings once');
});

test('d. a forged row is hidden for the sender too: a row claiming to be your own proves nothing', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    await encryptedHistory(pair);

    plant({ from: pair.bid, to: pair.aid, content: FORGED });

    await reopenBob(pair);
    await threadShows(pair.b.page, HIDDEN, "the row claiming to be bob's own to be hidden");
    await assertNowhere(pair.b.page, FORGED, 'own row');
});

test('e. an edit that swaps a real message for plain text does not change what is on screen', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    const real = await encryptedHistory(pair);

    await pair.b.page.evaluate(async (row) => {
        const { updateDmMessage } = await import('/js/chat/dm.js');
        await updateDmMessage(row);
    }, { ...real, content: FORGED, edited_at: new Date().toISOString() });

    const rows = await rowsInThread(pair.b.page);
    assert.equal(rows.find((r) => r.id === real.id).bubble, 'real-message-from-alice');
    await assertNowhere(pair.b.page, FORGED, 'socket edit');

    // The same edit written into the row, so the next load serves it as history.
    withDb((db) => db.prepare('UPDATE direct_messages SET content = ?, edited_at = ? WHERE id = ?')
        .run(FORGED, new Date().toISOString(), real.id));

    // One more real row so this device still has a line to judge it by, then a reload.
    await sendOnce(pair.a.page, 'second-real-message');
    await threadShows(pair.b.page, 'second-real-message', 'bob to read the second message');
    await reopenBob(pair);
    await threadShows(pair.b.page, 'second-real-message', 'bob to read it again after reload');
    await threadShows(pair.b.page, HIDDEN, 'the rewritten row to be hidden');
    await assertNowhere(pair.b.page, FORGED, 'stored edit');
});

test('f. a real reply whose quote the server rewrote: the reply stays, the forged quote does not', { timeout: 240000 }, async () => {
    const pair = await freshPair();

    await sendOnce(pair.b.page, 'bob-asks-a-question');
    await threadShows(pair.a.page, 'bob-asks-a-question', 'alice to read bob');
    const [parent] = await recentRows(pair.a.page, pair.bid);

    await pair.a.page.waitForFunction((pid) => {
        window.replyToDmMessage(pid);
        return !!document.querySelector('#dm-reply-preview.active .reply-preview-body');
    }, { timeout: 30000, polling: 200 }, parent.id);
    await sendOnce(pair.a.page, 'yes-i-agree');
    await threadShows(pair.b.page, 'yes-i-agree', 'bob to read the reply');

    // The reply is sealed and real. What it quotes is whatever the target row now says.
    withDb((db) => db.prepare('UPDATE direct_messages SET content = ? WHERE id = ?').run(FORGED, parent.id));

    await reopenBob(pair);
    await threadShows(pair.b.page, 'yes-i-agree', 'the real reply to still open');

    const rows = await rowsInThread(pair.b.page);
    assert.equal(rows.find((r) => r.bubble === 'yes-i-agree').quote, HIDDEN);
    assert.equal(rows.find((r) => r.id === parent.id).bubble, HIDDEN, 'and the rewritten row itself');
    await assertNowhere(pair.b.page, FORGED, 'quote');
});

test('g. a forged file with no sealed metadata: hidden, and it is never fetched', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    await encryptedHistory(pair);

    const forged = plant({ from: pair.aid, to: pair.bid, content: '', attachment: true });

    const fetched = [];
    const onRequest = (request) => {
        if (request.url().includes(`/api/dm/attachments/${forged}`)) fetched.push(request.url());
    };
    pair.b.page.on('request', onRequest);

    try {
        await reopenBob(pair);
        await threadShows(pair.b.page, HIDDEN, 'the forged file to be hidden');

        const row = (await rowsInThread(pair.b.page)).find((r) => r.id === forged);
        assert.deepEqual(row, { id: forged, bubble: HIDDEN, marked: false, quote: null, attachment: false });
        await assertNowhere(pair.b.page, 'FORGED-invoice', 'forged file');
        assert.deepEqual(fetched, [], 'the file must not be requested');
    } finally {
        pair.b.page.off('request', onRequest);
    }
});

test('h. a real sealed caption with a file of the server\'s own bolted on: hidden', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    const real = await encryptedHistory(pair);
    await sendOnce(pair.a.page, 'second-real-message');
    await threadShows(pair.b.page, 'second-real-message', 'bob to read the second message');

    withDb((db) => db.prepare(
        "UPDATE direct_messages SET attachment_path = 'forged-file.pdf', attachment_name = 'FORGED-invoice.pdf', attachment_size = 10, attachment_mime = 'application/pdf', is_voice_message = 0 WHERE id = (SELECT MAX(id) FROM direct_messages)"
    ).run());

    await reopenBob(pair);
    await threadShows(pair.b.page, HIDDEN, 'the row with a forged file to be hidden');

    assert.equal((await rowsInThread(pair.b.page)).find((r) => r.id === real.id).bubble, 'real-message-from-alice',
        'control: the untouched row still opens');
    await assertNowhere(pair.b.page, 'FORGED-invoice', 'bolted-on file');
});

// ---------------------------------------------------------------- real history

test('i. history from before encryption stays readable, marked, even on a joined row', { timeout: 240000 }, async () => {
    const pair = await freshPair();

    // Two old rows from one sender a moment apart, so the second joins the first and
    // its name and time are hidden. The mark must not be hidden with them.
    const old = new Date(Date.now() - 86400000);
    const first = plant({ from: pair.aid, to: pair.bid, content: 'old-plain-one', createdAt: old.toISOString() });
    const second = plant({ from: pair.aid, to: pair.bid, content: 'old-plain-two', createdAt: new Date(old.getTime() + 1000).toISOString() });
    const own = plant({ from: pair.bid, to: pair.aid, content: 'old-plain-mine', createdAt: new Date(old.getTime() + 2000).toISOString() });
    const file = plant({ from: pair.aid, to: pair.bid, content: '', createdAt: new Date(old.getTime() + 3000).toISOString(), attachment: true });

    await encryptedHistory(pair, 'first-encrypted-message');

    await reopenBob(pair);
    await threadShows(pair.b.page, 'first-encrypted-message', 'the real message to open');

    const rows = await rowsInThread(pair.b.page);
    assert.deepEqual(rows.find((r) => r.id === first), { id: first, bubble: 'old-plain-one', marked: true, quote: null, attachment: false });
    assert.deepEqual(rows.find((r) => r.id === second), { id: second, bubble: 'old-plain-two', marked: true, quote: null, attachment: false });
    assert.deepEqual(rows.find((r) => r.id === own), { id: own, bubble: 'old-plain-mine', marked: true, quote: null, attachment: false });
    assert.deepEqual(rows.find((r) => r.id === file), { id: file, bubble: '', marked: true, quote: null, attachment: true });
    assert.equal(rows.find((r) => r.bubble === 'first-encrypted-message').marked, false, 'a sealed row carries no mark');

    // What is on top at the mark's own position: a joined row hides its meta line, and
    // the first row of a short thread starts under the floating header.
    const onScreen = (id) => pair.b.page.evaluate((rowId) => {
        const row = document.querySelector(`.chat-msg[data-msg-id="${rowId}"]`);
        const mark = row.querySelector('.dm-not-encrypted');
        const box = mark.getBoundingClientRect();
        return {
            joined: row.classList.contains('chat-msg--joined-prev'),
            text: mark.textContent.trim(),
            onTop: mark.contains(document.elementFromPoint(box.left + 8, box.top + box.height / 2)),
        };
    }, id);

    assert.deepEqual(await onScreen(first), { joined: false, text: MARK, onTop: true });
    assert.deepEqual(await onScreen(second), { joined: true, text: MARK, onTop: true });

    // An old row's id passes as history, but an edit is always new: a plaintext one is
    // dropped however old the row it claims to change.
    const [served] = (await recentRows(pair.b.page, pair.aid)).filter((r) => r.id === first);
    await pair.b.page.evaluate(async (row) => {
        const { updateDmMessage } = await import('/js/chat/dm.js');
        await updateDmMessage(row);
    }, { ...served, content: FORGED, edited_at: new Date().toISOString() });

    assert.equal((await rowsInThread(pair.b.page)).find((r) => r.id === first).bubble, 'old-plain-one');
    await assertNowhere(pair.b.page, FORGED, 'an edit of an old row');
});

test('j. a contact this device has never seen a row open from: shown and marked, thread and list', { timeout: 240000 }, async () => {
    const pair = await freshPair();

    const planted = plant({ from: pair.aid, to: pair.bid, content: 'hello-no-encryption' });

    await reopenBob(pair);
    await threadShows(pair.b.page, 'hello-no-encryption', 'the row to be shown');

    assert.deepEqual(
        (await rowsInThread(pair.b.page)).find((r) => r.id === planted),
        { id: planted, bubble: 'hello-no-encryption', marked: true, quote: null, attachment: false }
    );
    await pollUntil(
        async () => (await conversationPreview(pair.b.page, pair.aid)) === 'Not encrypted: hello-no-encryption',
        { what: 'the list to mark it', describe: async () => conversationPreview(pair.b.page, pair.aid) }
    );

    // A row claiming its file already opened must not count as a row that opened.
    await deliverLive(pair.b.page, liveRow({ id: 900004, from: pair.aid, to: pair.bid, username: AN, content: '', extra: { attachment_e2ee: true } }));

    // A live one on the same contact is marked too. Nothing has opened yet.
    await deliverLive(pair.b.page, liveRow({ id: 900002, from: pair.aid, to: pair.bid, username: AN, content: 'live-no-encryption' }));
    assert.equal((await rowsInThread(pair.b.page)).find((r) => r.id === 900002).marked, true);

    // The first row that opens draws the line, and the next forged row is hidden.
    await encryptedHistory(pair, 'now-encrypted');
    await deliverLive(pair.b.page, liveRow({ id: 900003, from: pair.aid, to: pair.bid, username: AN, content: FORGED }));
    assert.equal((await rowsInThread(pair.b.page)).find((r) => r.id === 900003).bubble, HIDDEN);
    await assertNowhere(pair.b.page, FORGED, 'after the line was drawn');
});

test('k. the line survives a reload: the device remembers, it does not need the page to prove it again', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    await encryptedHistory(pair);

    // Only the forged row is served after the reload. The real one is withheld, so the
    // page has nothing to prove the conversation was ever encrypted.
    withDb((db) => db.prepare('DELETE FROM direct_messages').run());
    plant({ from: pair.aid, to: pair.bid, content: FORGED });

    await reopenBob(pair);
    await threadShows(pair.b.page, HIDDEN, 'the forged row to be hidden');
    await assertNowhere(pair.b.page, FORGED, 'withheld history');
});

test('k2. the conversation list alone draws the line, before the thread is ever opened', { timeout: 240000 }, async () => {
    const pair = await freshPair();
    const real = await encryptedHistory(pair);

    await forgetPeer(pair.b.page, pair.aid);
    await reloadUser(pair.b.page);
    await pair.b.page.click('.nav-link[data-view="messages"]');

    const floor = () => pair.b.page.evaluate(async (peerId) => {
        const { getPeerTrustContext } = await import('/js/crypto/keys/peer-key-gate.js');
        const { getPeerPin } = await import('/js/crypto/keys/peer-trust.js');
        return (await getPeerPin(peerId, await getPeerTrustContext()))?.encryptedFloor ?? null;
    }, pair.aid);

    await pollUntil(
        async () => (await floor()) === real.id,
        { what: 'the list preview to record the row it opened', describe: async () => `floor=${await floor()}` }
    );
    assert.equal(await conversationPreview(pair.b.page, pair.aid), 'real-message-from-alice');
});

test('l. sealed rows are unaffected: send, read, reply, edit, list', { timeout: 240000 }, async () => {
    const pair = await freshPair();

    await sendOnce(pair.a.page, 'normal-one');
    await threadShows(pair.b.page, 'normal-one', 'bob to read normal-one');
    await sendOnce(pair.b.page, 'normal-two');
    await threadShows(pair.a.page, 'normal-two', 'alice to read normal-two');

    await reopenBob(pair);
    await threadShows(pair.b.page, 'normal-two', 'bob to read normal-two after reload');

    const rows = await rowsInThread(pair.b.page);
    assert.deepEqual(rows.map((r) => [r.bubble, r.marked]), [['normal-one', false], ['normal-two', false]]);
    assert.equal(await conversationPreview(pair.b.page, pair.aid), 'normal-two');

    const html = await pageHtml(pair.b.page);
    assert.ok(!html.includes(HIDDEN), 'nothing is hidden when nothing is forged');
    assert.ok(!html.includes('dm-not-encrypted'), 'nothing is marked when everything is sealed');
});
