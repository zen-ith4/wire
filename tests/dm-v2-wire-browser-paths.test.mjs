// tests/dm-v2-wire-browser-paths.test.mjs
//
// STEP 1F. The one browser test in 1B proved exactly one thing: alice sends one
// v2 text, bob opens the DM and reads it. Everything ELSE in the v2 surface -
// reply, edit, history after reload, list previews, tamper as the user sees it,
// a v1 peer, the downgrade notice, key rotation - had no coverage at all, and
// those are precisely the seams that broke twice already:
//
//   BUG 1 (1D) buildDmV2Content() did not return `content` -> every v2 send posted
//   BUG 2 (1E) openDmV2Envelope() handed decryptDmV2() the FLAT normalised
//          envelope -> every v2 decrypt threw "Missing encryption payload"
//
// Both shipped because the tests called helpers directly or asserted on the
// wrong thing. These tests drive the REAL composer, the REAL thread renderer and
// the REAL conversation list, then read the result back of the DOM and the
// stored row. One browser PROCESS per account.
//
// ACCOUNTS. One pair, created once in `before`, kept for the whole file.
//   - The registration limiter (middleware/rateLimiter.js) allows 5 attempts per
//     IP per 15 minutes, and it is an in-process Map, so one server allows 5
//     registrations TOTAL. Registering a fresh pair per test exhausts it by
//     test 3.
//   - A fixture user cannot be re-logged-in: its first browser login migrates it
//     to scheme 2, and after that POST /api/auth/login answers 401 for a
//     password.
// So the pair is logged in ONCE and every test starts from it with a RELOAD +
// UNLOCK, which is the state the app is really in between sessions anyway, and
// with the conversation emptied, so message counts are exact.
// Test (f) needs accounts that were never v2 at all, and gets its OWN server -
// whose limiter map is a different process, so it has its own budget of 5.

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
} from './_acceptance-harness.mjs';
import { PASSWORD } from './_acceptance-harness.mjs';
import { Database, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';

const PLACEHOLDER = 'Unable to decrypt';

const AN = 'mvpatha';
const BN = 'mvpathb';

let workDir = null;
let dbPath = null;
let server = null;
let PAIR = null;   // { a, b, an, bn, aid, bid } - long lived, reloaded per test

// ---------------------------------------------------------------- utilities

async function pollUntil(probe, {
    timeout = 15000,
    step = 50,
    what = 'a condition',
    describe = null,
} = {}) {
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

/**
 * Reload and unlock through the app's OWN screen.
 *
 * After a reload the session token survives in localStorage but the identity is
 * locked, and the app renders the unlock card ("Enter your password to unlock
 * your encrypted messages on this device"), not the shell. A raw password login
 * is NOT available: the account is scheme 2 and POST /api/auth/login answers 401.
 *
 * The unlock card is EXPECTED, not required: the app can also come back already
 * unlocked. Waiting for `#unlock-password` unconditionally turns that normal
 * state into a 60s selector timeout, which reads as a broken unlock flow.
 */
async function reloadUser(page, password) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const locked = await page.waitForSelector('#unlock-password', { timeout: 20000 })
        .then(() => true, () => false);
    if (locked) {
        await page.type('#unlock-password', password);
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')]
                .find((b) => b.classList.contains('btn-primary') && /unlock/i.test(b.textContent || ''));
            if (!btn) throw new Error('the unlock button is not on the page');
            btn.click();
        });
    }
    await page.waitForSelector('.nav-link[data-view="messages"]', { timeout: 60000 });
    // The shell mounts before the identity lands; nothing below may be asserted
    // until the CryptoKey is really back.
    await pollUntil(
        () => page.evaluate(async () => !!(await import('/js/crypto/identity-service.js')).getCurrentIdentity()),
        { timeout: 30000, what: 'the identity to be unlocked again' }
    );
    return { locked };
}

const reloadAndUnlock = reloadUser;

/** Record every downgrade toast as it appears, before anything can render one. */
async function watchDowngradeToasts(page) {
    await page.evaluate(() => {
        window.__toasts = [];
        window.__toastObserver?.disconnect();
        window.__toastObserver = new MutationObserver((muts) => {
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    const t = (n.textContent || '').trim();
                    if (/downgraded to legacy encryption/i.test(t)) window.__toasts.push(t.slice(0, 160));
                }
            }
        });
        window.__toastObserver.observe(document.body, { childList: true, subtree: true });
    });
}

const toastCount = (page) => page.evaluate(() => (window.__toasts || []).length);

/**
 * How many messages the thread rendered as REAL text (the placeholder excluded).
 *
 * PLACEHOLDER is passed IN, not closed over: page.evaluate() serialises the
 * function and runs it in the browser, where this module's constants do not
 * exist. Closing over it fails with "PLACEHOLDER is not defined".
 */
// Measure the BUBBLE, not the whole .chat-msg: the whole element carries the
// sender, the time, the actions and the text, so a strict compare on it was
// never true and made every tamper test report placeholders=0.
const decryptedCount = (page) => page.evaluate((ph) => {
    return [...document.querySelectorAll('#dm-messages .chat-msg')]
        .filter((el) => {
            const b = el.querySelector('.chat-bubble');
            return (b ? b.textContent.trim() : el.textContent.trim()) !== ph;
        }).length;
}, PLACEHOLDER);

const placeholderCount = (page) => page.evaluate((ph) =>
    [...document.querySelectorAll('#dm-messages .chat-msg')]
        .filter((el) => {
            const b = el.querySelector('.chat-bubble');
            return (b ? b.textContent.trim() : el.textContent.trim()) === ph;
        }).length, PLACEHOLDER);

const threadText = (page) =>
    page.evaluate(() => (document.getElementById('dm-messages')?.textContent || ''));

/** Wait for the thread to render exactly `n` real messages (placeholder excluded). */
const waitDecrypted = (page, n, what) => pollUntil(
    async () => (await decryptedCount(page)) === n ? { n } : null,
    { timeout: 30000, what, describe: async () => `decrypted=${await decryptedCount(page)} placeholders=${await placeholderCount(page)}` }
);

/** The rows the SERVER holds for this conversation. */
const recentRows = (page, peerId) => page.evaluate(async (id) => {
    const { api } = await import('/js/core/api.js');
    const res = await api(`/api/dm/messages/${id}/recent`);
    const rows = Array.isArray(res) ? res : (res?.messages || []);
    return rows.map((r) => ({
        id: Number(r.id),
        sender_id: Number(r.sender_id),
        recipient_id: Number(r.recipient_id),
        reply_to_id: r.reply_to_id == null ? null : Number(r.reply_to_id),
        content: r.content,
    }));
}, peerId);

const envelopeOf = (row) => JSON.parse(row.content);

/**
 * Send ONE message through the real composer, and never send twice.
 *
 * The harness helper sendOnce() types, presses Enter, and then - if the input
 * is still non-empty after 1500ms - calls window.sendDm() AGAIN as a fallback.
 * On this machine the composer clears slower than 1500ms, so that fallback fires
 * and the message is POSTed twice: the thread then renders two bubbles with two
 * different row ids carrying the same text.
 *
 * Observed, not theorised:
 *   BEFORE SEND: alice []
 *   AFTER SEND (alice): [ {dsid:"2", text:"...probe-one..."},
 *                        {dsid:"3", text:"......probe-one..."} ]
 *
 * Every count in this file is exact, so a silent double-send makes them all wrong.
 * So: press Enter once, then poll the composer's own postcondition - it clears
 * the input only after the POST returns. If a send were REFUSED (the trust gate,
 * a block) the input never clears and this times out saying so, which is the
 * blocked case handled explicitly in test (h).
 */
async function sendOnce(page, text) {
    await page.type('#dm-input', text);
    await page.keyboard.press('Enter');
    await pollUntil(async () => {
        const v = await page.evaluate(() => document.getElementById('dm-input')?.value ?? null);
        return v === '' ? { cleared: true } : null;
    }, {
        timeout: 20000,
        what: `the composer to clear after sending ${JSON.stringify(text)}`,
        describe: async () => JSON.stringify(await page.evaluate(() => document.getElementById('dm-input')?.value ?? null)),
    });
}

/** Open both threads and assert both start EMPTY, so every count below is exact. */
async function openBothFresh(pair) {
    await openDmUi(pair.a.page, pair.bid, pair.bn);
    await openDmUi(pair.b.page, pair.aid, pair.an);
    const [ac, bc] = [await decryptedCount(pair.a.page), await decryptedCount(pair.b.page)];
    assert.equal(ac, 0, `alice's thread must start empty, found ${ac} rendered message(s)`);
    assert.equal(bc, 0, `bob's thread must start empty, found ${bc} rendered message(s)`);
    return pair;
}

// ------------------------------------------------------------------ fixtures

before(async () => {
    workDir = tmpDir();
    dbPath = path.join(workDir, 'wire.db');
    fs.copyFileSync(FIXTURE_DB, dbPath);
    const { runMigrations } = await import('../database/migrations.js');
    const db0 = new Database(dbPath, { readonly: false });
    runMigrations(db0);
    db0.close();

    server = await startRealServer({ work: workDir, extraEnv: { DB_PATH: dbPath } });

    // The fixture's own DM row (user 2 -> user 3) is not ours, but it is
    // DELETED here rather than ignored: every count in this file is exact, and a
    // leftover row that renders as plaintext would make "1 message" read as 2.
    await withDb((db) => db.prepare('DELETE FROM direct_messages').run());

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
    PAIR = { a, b, an: AN, bn: BN, aid: ids[0], bid: ids[1] };
});

after(async () => {
    await closeUserBrowsers();
    if (server) await server.stop();
    cleanupTmp();
});

/**
 * Run `fn` with the DB the test owns, WITHOUT stopping the server.
 *
 * The first version of this file stopped and restarted the server around every
 * mutation. That cannot work: startRealServer() picks a FRESH free port on every
 * call (harness L185), so a restart moves the origin and the browser pages - still
 * sitting on the old origin - load nothing at all. Every test then failed on
 * "Waiting for selector `#unlock-password` failed", which looks like an unlock
 * problem and is not one.
 *
 * So the server stays up and the test writes to the same SQLite file directly.
 * SQLite serialises the write lock per transaction and the server commits per
 * request, so the write lands between requests; the read paths
 * (getRecentMessages, getConversationsHandler) query per request and see it.
 */
const withDb = (fn) => {
    const db = new Database(dbPath, { readonly: false });
    try {
        return fn(db);
    } finally {
        db.close();
    }
};

/** Every test starts here: no stored rows, both identities unlocked, both threads open. */
async function freshPair() {
    await withDb((db) => db.prepare('DELETE FROM direct_messages').run());
    await reloadAndUnlock(PAIR.a.page, PASSWORD);
    await reloadAndUnlock(PAIR.b.page, PASSWORD);
    await watchDowngradeToasts(PAIR.a.page);
    await watchDowngradeToasts(PAIR.b.page);
    return openBothFresh(PAIR);
}

// ============================================================== (a) history
test('a. after BOTH users reload and re-login, each side still reads the v2 history, including their own message', { timeout: 240000 }, async () => {
    const { a, b, aid, bid, an, bn } = await freshPair();

    await sendOnce(a.page, 'hist-alice-1');
    await waitDecrypted(b.page, 1, "bob to render alice's first v2 message");
    await waitDecrypted(a.page, 1, 'alice to render her OWN v2 message');

    // Reload + re-login on BOTH sides: the identity is gone from memory and has
    // to be restored, which is the state every later turn of this app runs in.
    await reloadAndUnlock(a.page, PASSWORD);
    await reloadAndUnlock(b.page, PASSWORD);

    await openDmUi(a.page, bid, bn);
    await openDmUi(b.page, aid, an);
    await waitDecrypted(a.page, 1, 'alice to read her own v2 message after reload');
    await waitDecrypted(b.page, 1, 'bob to read alice v2 message after reload');

    const [at, bt] = [await threadText(a.page), await threadText(b.page)];
    assert.ok(at.includes('hist-alice-1'), `alice lost her own message after reload: ${at.slice(0, 200)}`);
    assert.ok(bt.includes('hist-alice-1'), `bob lost the message after reload: ${bt.slice(0, 200)}`);
    assert.equal(await placeholderCount(a.page), 0, 'alice must have no placeholder after reload');
    assert.equal(await placeholderCount(b.page), 0, 'bob must have no placeholder after reload');
    void an; void bn;
});

// ================================================================ (b) reply
test('b. bob replies through the real composer; both render it and the quote shows the ORIGINAL text', { timeout: 240000 }, async () => {
    const { a, b, aid, bid, an, bn } = await freshPair();

    await sendOnce(a.page, 'reply-parent');
    const [first] = await recentRows(b.page, aid);
    assert.ok(first, 'alice v2 row must exist before the reply');
    assert.equal(envelopeOf(first).encryption.version, 2, 'the parent must be a v2 envelope');

    // Bob's thread must be OPEN before replyToDmMessage: the handler reads
    // dmEntry.byId and returns early when the conversation was never loaded.
    await openDmUi(b.page, aid, an);
    await waitDecrypted(b.page, 1, 'bob to render the parent before replying');
    await b.page.evaluate((id) => window.replyToDmMessage(id), first.id);
    await sendOnce(b.page, 'reply-child');

    const rows = await recentRows(b.page, aid);
    const child = rows.find((r) => r.sender_id === bid);
    assert.ok(child, `bob's reply must be stored: ${JSON.stringify(rows.map((r) => r.id))}`);
    assert.equal(child.reply_to_id, first.id,
        `the reply must point at the original row: reply_to_id=${child.reply_to_id} parent=${first.id}`);
    assert.equal(envelopeOf(child).encryption.version, 2, 'the reply must be a v2 envelope');

    await waitDecrypted(b.page, 2, 'bob to render both messages');
    await waitDecrypted(a.page, 2, 'alice to render both messages');

    const [at, bt] = [await threadText(a.page), await threadText(b.page)];
    for (const [label, t] of [['alice', at], ['bob', bt]]) {
        assert.ok(t.includes('reply-parent'), `${label} lost the parent text: ${t.slice(0, 200)}`);
        assert.ok(t.includes('reply-child'), `${label} lost the reply text: ${t.slice(0, 200)}`);
        assert.ok(!t.includes(PLACEHOLDER), `${label} rendered a reply quote as "${PLACEHOLDER}": ${t.slice(0, 200)}`);
    }
    // The quote is a SEPARATE element from the body. "Both texts appear" would
    // also pass if the quote were empty and only the body carried the text, so
    // count the bubbles that contain the parent text: the reply's quote is one
    // more than the parent's own bubble.
    const quoted = await a.page.evaluate((parent) =>
        [...document.querySelectorAll('#dm-messages .chat-msg')]
            .filter((el) => el.textContent.includes(parent)).length,
        'reply-parent');
    assert.ok(quoted >= 2,
        `the parent text must appear in the thread AND in bob's reply quote: only ${quoted} bubble(s) carried it`);

    void an; void bn;
});

// ========================================================= (c) list previews
test('c. the conversation list shows the decrypted v2 preview on both sides after reload', { timeout: 240000 }, async () => {
    const { a, b, aid, bid, an, bn } = await freshPair();

    await sendOnce(a.page, 'preview-alice-1');
    await waitDecrypted(b.page, 1, "bob to render alice's v2 message");

    await reloadAndUnlock(a.page, PASSWORD);
    await reloadAndUnlock(b.page, PASSWORD);

    // The LIST, not the thread: this is decryptConversationPreview (the dm.js
    // ~611 guard), reading getConversationsHandler's last_message plus
    // last_message_id and last_message_reply_to_id.
    for (const [label, page] of [['alice', a.page], ['bob', b.page]]) {
        await page.click('.nav-link[data-view="messages"]');
        await page.waitForSelector('.dm-layout #dm-conv-list', { timeout: 20000 });
        const preview = await pollUntil(async () => {
            const t = await page.evaluate((needle) => {
                const rows = [...document.querySelectorAll('#dm-conv-list .dm-conv-item, #dm-conv-list > *')];
                const row = rows.find((r) => (r.textContent || '').includes(needle));
                return row ? (row.querySelector('.dm-conv-preview')?.textContent?.trim() || null) : null;
            }, 'preview-alice-1');
            return t || null;
        }, {
            timeout: 20000,
            what: `${label}'s conversation preview to decrypt`,
            describe: async () => JSON.stringify(await page.evaluate(() => (document.querySelector('.dm-conv-preview')?.textContent || '').slice(0, 80))),
        });

        assert.ok(preview.includes('preview-alice-1'),
            `${label}'s preview must show the decrypted v2 text, got ${JSON.stringify(preview)}`);
        assert.ok(!preview.includes(PLACEHOLDER),
            `${label}'s preview fell back to "${PLACEHOLDER}": ${JSON.stringify(preview)}`);
    }

    void aid; void bid; void an; void bn;
});

// ================================================================== (d) edit
test('d. editing a v2 REPLY through the real UI rewrites the envelope with a new msgId and keeps reply_to_id', { timeout: 240000 }, async () => {
    const { a, b, aid, bid } = await freshPair();

    await sendOnce(a.page, 'edit-parent');
    const [parent] = await recentRows(b.page, aid);
    assert.equal(envelopeOf(parent).encryption.version, 2, 'the parent must be a v2 envelope');

    // Bob's thread MUST be open before replyToDmMessage: the handler reads
    // dmEntry.byId and returns early when the conversation was never loaded, so
    // calling it on a fresh page would silently do nothing and the stored row
    // would carry reply_to_id=null. That was the cause of the 10-run failure
    // (9/10 failed with "the reply must carry reply_to_id 2, got null").
    await openDmUi(b.page, aid, PAIR.an);
    await waitDecrypted(b.page, 1, 'bob to render the parent before replying');
    await b.page.evaluate((id) => window.replyToDmMessage(id), parent.id);
    await sendOnce(b.page, 'edit-reply');

    const before = await recentRows(a.page, bid);
    const reply = before.find((r) => r.sender_id === bid);
    assert.ok(reply, 'the reply row must exist');
    assert.equal(reply.reply_to_id, parent.id,
        `the reply must carry reply_to_id ${parent.id}, got ${reply.reply_to_id}`);
    const replyMsgId = envelopeOf(reply).encryption.msgId;
    const replyCiphertext = envelopeOf(reply).encryption.ciphertext;

    // The real edit entry point, on bob's own message.
    //
    // STEP 1I.1. editDmMessage() sets `is-editing` on the composer
    // (composer.js:1089) and RETURNS EARLY - silently - if the message is not in
    // dmEntry.byId. Nothing in the old version checked that it had actually
    // engaged, so when it did not, window.sendDm() sent a BRAND NEW message
    // instead. That was the flakiness: the stored row never changed and a fourth
    // row appeared - the failure text `[2,3,4]` versus the expected `[2,3]`.
    //
    // The race is in the ENTRY CACHE, not the network: dmEntry.byId is populated
    // as messages arrive, and a send can clear the composer before the message is
    // in the cache. So the exact postcondition before editing is not "the send
    // finished" (sendOnce already waited for that) but "the reply is actually
    // rendered and in dmEntry.byId". We wait for the bubble count of 2 first.
    await waitDecrypted(b.page, 2, 'bob to render the parent and the reply before editing');

    const entered = await b.page.evaluate((id) => {
        if (typeof window.editDmMessage !== 'function') return { ok: false };
        window.editDmMessage(id);
        return {
            ok: true,
            isEditing: !!document.querySelector('.is-editing'),
            prefilled: document.getElementById('dm-input')?.value ?? null,
        };
    }, reply.id);
    assert.equal(entered.ok, true, 'dm.js must expose editDmMessage');
    assert.equal(entered.isEditing, true,
        `editDmMessage() must put the composer in edit mode (composer.js sets is-editing); `
        + `prefilled=${JSON.stringify(entered.prefilled)} - without this window.sendDm() `
        + 'would post a NEW message instead of editing');

    const rowCountBefore = (await recentRows(a.page, bid)).length;
    await b.page.evaluate(() => {
        const i = document.getElementById('dm-input');
        i.value = 'edit-reply-CHANGED';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        window.sendDm();
    });

    // The server edits IN PLACE (updateDmMessageContent), so the row id is
    // stable and the ENVELOPE is what changes. The FULL postcondition, all four
    // parts at once - a new msgId alone was not enough, because a plain re-send
    // of the same row would also change it:
    //   1. the SAME row id carries a new msgId
    //   2. the ciphertext is different (the text actually changed)
    //   3. reply_to_id is unchanged
    //   4. NO new row appeared (an edit is not a new message)
    const edited = await apiPoll(async () => {
        const rs = await recentRows(a.page, bid);
        const row = rs.find((r) => r.id === reply.id);
        if (!row) return null;
        const env = envelopeOf(row);
        if (env.encryption.msgId === replyMsgId) return null;
        if (env.encryption.ciphertext === replyCiphertext) return null;
        if (row.reply_to_id !== reply.reply_to_id) return null;
        if (rs.length !== rowCountBefore) return null;
        return { row, env, ids: rs.map((r) => r.id) };
    }, {
        timeout: 30000,
        what: 'the SAME row to be re-encrypted in place, with no new row',
        describe: async () => {
            const rs = await recentRows(a.page, bid);
            const row = rs.find((r) => r.id === reply.id);
            return `ids=${JSON.stringify(rs.map((r) => r.id))} `
                + `expected=${rowCountBefore} msgIdChanged=${row ? envelopeOf(row).encryption.msgId !== replyMsgId : 'row gone'} `
                + `replyTo=${row ? row.reply_to_id : '-'}`;
        },
    });

    assert.equal(edited.env.encryption.version, 2, 'the edit must still be a v2 envelope');
    assert.notEqual(edited.env.encryption.msgId, replyMsgId,
        `an edit must produce a NEW msgId (was ${replyMsgId})`);
    assert.equal(edited.row.reply_to_id, reply.reply_to_id,
        `the edit must keep reply_to_id ${reply.reply_to_id}, got ${edited.row.reply_to_id}`);

    await openDmUi(a.page, bid, PAIR.bn);
    await waitDecrypted(a.page, 2, 'alice to render the parent and the edited reply');
    await openDmUi(b.page, aid, PAIR.an);
    await waitDecrypted(b.page, 2, 'bob to render the parent and his edited reply');

    const at = await threadText(a.page);
    const bt = await threadText(b.page);
    assert.ok(at.includes('edit-reply-CHANGED'), `alice must see the edited text: ${at.slice(0, 240)}`);
    assert.ok(bt.includes('edit-reply-CHANGED'), `bob must see the edited text: ${bt.slice(0, 240)}`);
    assert.equal(await placeholderCount(a.page), 0, 'the edit must not render a placeholder for alice');
    assert.equal(await placeholderCount(b.page), 0, 'the edit must not render a placeholder for bob');
});

// ====================================================== (e) tamper, as seen
/** A real v2 exchange between the shared pair, and the row the receiver sees. */
async function tamperedExchange(secret) {
    const pair = await freshPair();
    await sendOnce(pair.a.page, secret);
    await waitDecrypted(pair.b.page, 1, 'the receiver to render the untouched v2 message');
    const [row] = await recentRows(pair.b.page, pair.aid);
    const ciphertext = JSON.parse(row.content).encryption.ciphertext;
    return { pair, row, secret, ciphertext };
}

/** Reload the receiver after the DB was rewritten underneath it. */
const reloadUserAlias = reloadUser;

/**
 * A poll that hits the API.
 *
 * step is 500ms, not the 50ms default: every probe here is one HTTP request, and
 * a 50ms poll over a 30s budget is ~600 requests, which trips the app's own rate
 * limiter - the test then dies with "Too many requests, please slow down" from
 * apiRequest(), which looks like an app failure and is a test-harness failure.
 */
function apiPoll(probe, opts = {}) {
    return pollUntil(probe, { step: 500, timeout: 20000, ...opts });
}

async function assertTamperIsNotReadable(page, peerId, rowId, secret, label) {
    // FIRST: the row must still be served. If the API stopped returning it, an
    // empty thread would prove nothing about the tamper and the placeholder
    // assertion below would be asserting the wrong thing.
    const served = await apiPoll(async () => {
        const rows = await recentRows(page, peerId);
        return rows.some((r) => r.id === rowId) ? { rows } : null;
    }, { what: 'the tampered row to still be served by the API' });
    assert.ok(served.rows.length >= 1, 'sanity: at least the tampered row must come back');

    // THEN: the user must see a "cannot decrypt" placeholder for it - never the
    // plaintext, and never nothing at all.
    const got = await pollUntil(async () => {
        const ph = await placeholderCount(page);
        return ph > 0 ? { ph, real: await decryptedCount(page) } : null;
    }, {
        timeout: 25000,
        what: 'a "cannot decrypt" placeholder',
        describe: async () => `${label}: placeholders=${await placeholderCount(page)} decrypted=${await decryptedCount(page)} rows=${served.rows.length} - the API still serves the row, so an empty thread is the app DROPPING it rather than marking it unreadable`,
    });
    assert.equal(got.real, 0,
        `${label}: a broken row must not render as a real message (decrypted=${got.real})`);
    const t = await threadText(page);
    assert.ok(!t.includes(secret),
        `${label}: the plaintext leaked into the thread after tampering: ${t.slice(0, 200)}`);
}

test('e1. a stored row with version stripped 2->1 is not readable', { timeout: 240000 }, async () => {
    const { pair, row, secret, ciphertext } = await tamperedExchange('tamper-e1');
    // POSITIVE CONTROL, in the same test: the untouched row DOES decrypt.
    assert.ok((await threadText(pair.b.page)).includes(secret),
        'positive control: the clean row must read before it is broken');

    await withDb((db) => {
        const r = db.prepare('SELECT id, content FROM direct_messages WHERE id = ?').get(row.id);
        const env = JSON.parse(r.content);
        env.encryption.version = 1;
        db.prepare('UPDATE direct_messages SET content = ? WHERE id = ?').run(JSON.stringify(env), r.id);
    });
    await reloadUser(pair.b.page, PASSWORD);
    await openDmUi(pair.b.page, pair.aid, PAIR.an);
    await assertTamperIsNotReadable(pair.b.page, pair.aid, row.id, secret, ciphertext, 'e1 version strip');
});

test('e2. a stored row with senderId rewritten is not readable', { timeout: 240000 }, async () => {
    const { pair, row, secret, ciphertext } = await tamperedExchange('tamper-e2');
    assert.ok((await threadText(pair.b.page)).includes(secret),
        'positive control: the clean row must read before it is broken');

    await withDb((db) => {
        const r = db.prepare('SELECT id, content FROM direct_messages WHERE id = ?').get(row.id);
        const env = JSON.parse(r.content);
        env.senderId = env.senderId + 1000;
        db.prepare('UPDATE direct_messages SET content = ? WHERE id = ?').run(JSON.stringify(env), r.id);
    });
    await reloadUser(pair.b.page, PASSWORD);
    await openDmUi(pair.b.page, pair.aid, pair.an);
    await assertTamperIsNotReadable(pair.b.page, pair.aid, row.id, secret, ciphertext, 'e2 senderId rewrite');
});

test('e3. a stored row with recipientId rewritten is not readable', { timeout: 240000 }, async () => {
    const { pair, row, secret, ciphertext } = await tamperedExchange('tamper-e3');
    assert.ok((await threadText(pair.b.page)).includes(secret),
        'positive control: the clean row must read before it is broken');

    await withDb((db) => {
        const r = db.prepare('SELECT id, content FROM direct_messages WHERE id = ?').get(row.id);
        const env = JSON.parse(r.content);
        env.recipientId = env.recipientId + 1000;
        db.prepare('UPDATE direct_messages SET content = ? WHERE id = ?').run(JSON.stringify(env), r.id);
    });
    await reloadUser(pair.b.page, PASSWORD);
    await openDmUi(pair.b.page, pair.aid, pair.an);
    await assertTamperIsNotReadable(pair.b.page, pair.aid, row.id, secret, ciphertext, 'e3 recipientId rewrite');
});

test('e4. changing the row reply_to_id breaks the AAD binding, so the row is not readable', { timeout: 240000 }, async () => {
    const { pair, row, secret, ciphertext } = await tamperedExchange('tamper-e4');
    assert.ok((await threadText(pair.b.page)).includes(secret),
        'positive control: the clean row must read before it is broken');

    await withDb((db) => {
        db.prepare('UPDATE direct_messages SET reply_to_id = ? WHERE id = ?').run(999999, row.id);
    });
    await reloadUser(pair.b.page, PASSWORD);
    await openDmUi(pair.b.page, pair.aid, pair.an);
    await assertTamperIsNotReadable(pair.b.page, pair.aid, row.id, secret, ciphertext, 'e4 reply_to_id rewrite');
});

// ================================================================ (f) v1 peer
test('f. a recipient created with default 1 gets a real v1 message and no downgrade notice', { timeout: 300000 }, async () => {
    // Its OWN server, started with the default at 1, so this pair is min-1 from
    // birth and the version choice can only be v1. Its limiter Map is a
    // different process, so it also has its own registration budget.
    const dir = tmpDir();
    const p = path.join(dir, 'wire.db');
    fs.copyFileSync(FIXTURE_DB, p);
    const { runMigrations } = await import('../database/migrations.js');
    const db0 = new Database(p, { readonly: false });
    runMigrations(db0);
    db0.prepare('DELETE FROM direct_messages').run();
    db0.close();

    const v1server = await startRealServer({
        work: dir,
        extraEnv: { DB_PATH: p, DM_E2EE_DEFAULT_MIN_VERSION: '1' }
    });

    let a = null;
    let b = null;
    try {
        const an = 'v1peer';
        const bn = 'v1peer2';
        await registerUser(v1server.origin, an);
        await registerUser(v1server.origin, bn);
        a = await newUserPage();
        b = await newUserPage();
        await loginUi(a.page, v1server.origin, an);
        await loginUi(b.page, v1server.origin, bn);
        await watchDowngradeToasts(a.page);
        await watchDowngradeToasts(b.page);

        const ids = await Promise.all([
            a.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id),
            b.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id),
        ]);
        const aid = ids[0];
        const bid = ids[1];

        await openDmUi(a.page, bid, bn);
        await openDmUi(b.page, aid, an);
        assert.equal(await decryptedCount(a.page), 0, 'the v1 thread must start empty');
        assert.equal(await decryptedCount(b.page), 0, 'the v1 thread must start empty');

        await sendOnce(a.page, 'v1-peer-text');
        await waitDecrypted(b.page, 1, 'the recipient to decrypt the v1 message');

        const [row] = await recentRows(b.page, aid);
        assert.equal(envelopeOf(row).encryption.version, 1,
            `a min-1 recipient must be sent v1, got version ${envelopeOf(row).encryption.version}`);

        assert.equal(await toastCount(a.page), 0, 'no downgrade notice: nothing was ever v2 here');
        assert.equal(await toastCount(b.page), 0, 'no downgrade notice on the receiving side either');
    } finally {
        // NOT closeUserBrowsers(): it closes every browser newUserPage()
        // opened, including the long-lived PAIR pages that (g) and (h) still
        // use, and those tests then die with "Attempted to use detached
        // Frame". Close only this test's own two processes.
        await Promise.all(
            [a?.browser, b?.browser].filter(Boolean).map((x) => x.close().catch(() => {}))
        );
        await v1server.stop();
        // NOT cleanupTmp(): it removes every directory tmpDir() handed out,
        // including the main server's, which is still running. This one dir only.
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ======================================================= (g) downgrade notice
test('g. a v1 row from a peer pinned at 2 still decrypts, and the notice appears exactly once per page load', { timeout: 300000 }, async () => {
    const { a, b, aid, bid } = await freshPair();

    await sendOnce(a.page, 'downgrade-before');
    await waitDecrypted(b.page, 1, 'the v2 exchange to settle before the downgrade');

    // Alice produces a REAL v1 envelope for bob through the app's own v1
    // encryptor, so the injected row is decryptable and the ONLY thing unusual
    // about it is its version.
    const v1content = await a.page.evaluate(async (peerId) => {
        const { encryptOutgoingMessage } = await import('/js/crypto/messages/message-crypto.js');
        const auth = await import('/js/core/auth.js');
        return encryptOutgoingMessage('downgrade-injected', auth.getCurrentUser().id, Number(peerId));
    }, bid);
    // encryptOutgoingMessage() returns the ENVELOPE OBJECT, not a JSON string.
    const v1env = typeof v1content === 'string' ? JSON.parse(v1content) : v1content;
    assert.equal(v1env.encryption.version, 1,
        'the injected envelope must really be v1, or the test proves nothing');

    await withDb((db) => {
        db.prepare(
            // 'now' in SINGLE quotes: with double quotes SQLite reads "now" as a
            // column name and answers `no such column: "now"`.
            "INSERT INTO direct_messages (sender_id, recipient_id, content, created_at) VALUES (?, ?, ?, datetime('now'))"
        ).run(aid, bid, JSON.stringify(v1env));
    });

    // The observer must be installed AFTER the reload: window.__toasts lives in the
    // page's own context, and a reload destroys it. Installing it before the
    // reload leaves the recorder pointing at a dead context and every count
    // reads 0 - which looks exactly like "the notice never fired".
    await reloadUser(b.page, PASSWORD);
    await watchDowngradeToasts(b.page);
    await openDmUi(b.page, aid, PAIR.an);

    // History is NOT the attack: the v1 row must still be readable.
    await pollUntil(async () => {
        const t = await threadText(b.page);
        return t.includes('downgrade-injected') ? { t } : null;
    }, {
        timeout: 25000,
        what: 'bob to decrypt the injected v1 row',
        describe: async () => `placeholders=${await placeholderCount(b.page)}`,
    });
    assert.equal(await placeholderCount(b.page), 0,
        'a v1 row must not become a placeholder just because the peer is pinned at 2');

    // Exactly once per page load. The flag is consumed by the first render, so
    // re-opening the conversation must not produce a second notice.
    const first = await pollUntil(
        async () => (await toastCount(b.page)) > 0 ? { n: await toastCount(b.page) } : null,
        { timeout: 20000, what: 'the downgrade notice to be shown' }
    );
    assert.equal(first.n, 1, `the notice must appear exactly once, saw ${first.n}`);

    await openDmUi(b.page, bid, PAIR.bn);
    await openDmUi(b.page, aid, PAIR.an);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await toastCount(b.page), 1,
        `re-opening the conversation must NOT show a second notice, saw ${await toastCount(b.page)}`);

    // And "once per page load" means a fresh page load gets one more.
    await reloadUser(b.page, PASSWORD);
    await watchDowngradeToasts(b.page);
    await openDmUi(b.page, aid, PAIR.an);
    await pollUntil(
        async () => (await toastCount(b.page)) > 0 ? { n: await toastCount(b.page) } : null,
        { timeout: 20000, what: 'the notice to be shown again on the fresh page' }
    );
    assert.equal(await toastCount(b.page), 1,
        'a fresh page load must show the notice exactly once again');
    void a;
});

// ========================================================= (h) key rotation
test('h. after bob rotates his identity key the v2 thread holds, alarms, and releasing it keeps the pre-rotation row readable', { timeout: 300000 }, async () => {
    const { a, b, aid, bid } = await freshPair();

    await sendOnce(b.page, 'rotate-before');
    await waitDecrypted(a.page, 1, 'alice to read the pre-rotation v2 row');
    const stateBefore = await a.page.evaluate(async (id) => (await import('/js/chat/dm-key-trust.js')).trustState(id), bid);
    assert.equal(stateBefore, 'ok', `first contact pins and must not alarm, got ${stateBefore}`);

    // Rotate bob's key through the REAL endpoint, from bob's own page.
    const rotated = await b.page.evaluate(async (password) => {
        const { api } = await import('/js/core/api.js');
        const { deriveCredentials } = await import('/js/crypto/credentials.js');
        const { generateIdentityKeyPair, exportPublicKey, exportPrivateKey, encryptIdentityPkcs8 } =
            await import('/js/crypto/identity.js');
        const kdf = await api('/api/me/kdf-params');
        const { authKey } = await deriveCredentials(password, kdf.salt, kdf.iterations);
        const before = await api('/api/me/identity-key');
        const pair = await generateIdentityKeyPair();
        const publicKeyB64 = await exportPublicKey(pair);
        const wrapped = await encryptIdentityPkcs8(await exportPrivateKey(pair), password, {
            salt: kdf.salt, iterations: kdf.iterations,
        });
        const out = await api('/api/me/identity-key/rotate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                current_auth_key: authKey,
                expected_public_key: before.publicKey,
                expected_updated_at: before.updatedAt,
                identity: { publicKey: publicKeyB64, ...wrapped },
            }),
        });
        return { error: out?.error ?? null, installed: publicKeyB64, retired: before.publicKey };
    }, PASSWORD);
    assert.equal(rotated.error, null, `rotation failed: ${rotated.error}`);
    assert.notEqual(rotated.retired, rotated.installed, 'the rotation must actually change the key');

    // Alice reloads: a fresh client that has only ever seen the CURRENT key and
    // has a pin for the retired one. Everything must come from the thread-open
    // path, which is what this file is here to cover.
    await reloadAndUnlock(a.page, PASSWORD);
    await openDmUi(a.page, bid, PAIR.bn);

    const state = await pollUntil(async () => {
        const s = await a.page.evaluate(async (id) => {
            const kt = await import('/js/chat/dm-key-trust.js');
            return { state: kt.trustState(id), held: kt.heldCount(id) };
        }, bid);
        return s.state === 'unknown' ? null : s;
    }, { timeout: 20000, what: "alice's trust state to resolve after the rotation" });
    assert.equal(state.state, 'changed',
        `alice must be in the changed state after bob's rotation, got ${state.state}`);

    await pollUntil(async () => {
        const h = await a.page.evaluate(async (id) => (await import('/js/chat/dm-key-trust.js')).heldCount(id), bid);
        return h >= 1 ? { h } : null;
    }, {
        timeout: 20000,
        what: 'alice to hold the pre-rotation row',
        describe: async () => `held=${await a.page.evaluate(async (id) => (await import('/js/chat/dm-key-trust.js')).heldCount(id), bid)}`,
    });

    assert.equal(await decryptedCount(a.page), 0, 'a held v2 row must not be readable in the thread');
    assert.ok(!(await threadText(a.page)).includes('rotate-before'),
        'the held plaintext must not appear in the thread');

    // The REAL accept button, so its own listener runs.
    const banner = await pollUntil(
        () => a.page.evaluate(() => (document.querySelector('#dm-key-trust-banner .dm-key-trust-accept')
            ? { found: true }
            : null)),
        { timeout: 20000, what: 'the accept button to render' }
    );
    assert.equal(banner.found, true);
    const fired = await a.page.evaluate(() => {
        const btn = document.querySelector('#dm-key-trust-banner .dm-key-trust-accept');
        if (!btn) return { ok: false };
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return { ok: true, disabled: btn.disabled };
    });
    assert.equal(fired.ok, true);
    assert.equal(fired.disabled, true, "the accept button's own listener did not run");

    await waitDecrypted(a.page, 1, 'the released pre-rotation row to render');
    const t = await threadText(a.page);
    assert.ok(t.includes('rotate-before'),
        `the row encrypted to the RETIRED key must be readable after accepting: ${t.slice(0, 240)}`);
    assert.equal(await placeholderCount(a.page), 0, 'accepting must not leave a placeholder');

    // And the gate is open again, through the real composer.
    await openDmUi(a.page, bid, PAIR.bn);
    await sendOnce(a.page, 'rotate-after');
});


// ================================================== (i) three rows, tamper in place
test('i. three rows (good, tampered, good): 2 good bubbles + 1 placeholder in order', { timeout: 300000 }, async () => {
    const { a, b, aid, bid, an, bn } = await freshPair();

    await sendOnce(a.page, 'good-first');
    await sendOnce(a.page, 'to-tamper');
    await sendOnce(a.page, 'good-last');
    const rows = (await recentRows(b.page, aid)).sort((x, y) => x.id - y.id);
    assert.equal(rows.length, 3, 'three rows must be stored');
    // tamper the MIDDLE one (rows[1])
    const victim = rows[1];
    const originalCiphertext = JSON.parse(victim.content).encryption.ciphertext;
    await withDb((db) => {
        const r = db.prepare('SELECT id, content FROM direct_messages WHERE id = ?').get(victim.id);
        const e = JSON.parse(r.content);
        e.senderId = e.senderId + 1000;
        db.prepare('UPDATE direct_messages SET content = ? WHERE id = ?').run(JSON.stringify(e), r.id);
    });

    await reloadUser(b.page, PASSWORD);
    await openDmUi(b.page, aid, an);
    await new Promise((r) => setTimeout(r, 5000));

    // 2 good bubbles + 1 placeholder = 3 .chat-msg elements
    assert.equal(await decryptedCount(b.page), 2,
        `the two good rows must still render (got ${await decryptedCount(b.page)})`);
    assert.equal(await placeholderCount(b.page), 1,
        `exactly one placeholder for the tampered row (got ${await placeholderCount(b.page)})`);

    const text = await threadText(b.page);
    assert.ok(text.includes('good-first'), 'the first good row must render');
    assert.ok(text.includes('good-last'), 'the last good row must render');
    assert.ok(!text.includes('to-tamper'), 'the tampered plaintext must not leak');

    const html = await b.page.evaluate(() => document.body.innerHTML);
    assert.ok(!html.includes(originalCiphertext),
        'the ciphertext must not reach the DOM');

    // Order: good-first before Unable to decrypt before good-last.
    const idxFirst = text.indexOf('good-first');
    const idxPh = text.indexOf('Unable to decrypt');
    const idxLast = text.indexOf('good-last');
    assert.ok(idxFirst >= 0 && idxPh > idxFirst && idxLast > idxPh,
        `order wrong: first=${idxFirst} placeholder=${idxPh} last=${idxLast}`);

    await closeUserBrowsers();
    void an; void bn; void bid; void aid;
});

// ================================================== (j) v1 parity
test('j. v1 parity: a v1 conversation with one flipped ciphertext byte shows a placeholder and keeps the good row', { timeout: 300000 }, async () => {
    // Own server with default 1.
    const dir = tmpDir();
    const p = path.join(dir, 'wire.db');
    fs.copyFileSync(FIXTURE_DB, p);
    const { runMigrations } = await import('../database/migrations.js');
    const db0 = new Database(p, { readonly: false });
    runMigrations(db0);
    db0.prepare('DELETE FROM direct_messages').run();
    db0.close();
    const v1server = await startRealServer({ work: dir, extraEnv: { DB_PATH: p, DM_E2EE_DEFAULT_MIN_VERSION: '1' } });

    try {
        const an = 'v1par';
        const bn = 'v1par2';
        await registerUser(v1server.origin, an);
        await registerUser(v1server.origin, bn);
        const a = await newUserPage();
        const b = await newUserPage();
        await loginUi(a.page, v1server.origin, an);
        await loginUi(b.page, v1server.origin, bn);
        await openDmUi(a.page, (await b.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id)), bn);
        await openDmUi(b.page, (await a.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id)), an);

        const aid = await a.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id);
        const bid = await b.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id);

        // Two messages: one good, one to be tampered.
        await sendOnce(a.page, 'v1-good');
        await sendOnce(a.page, 'v1-tamper');
        await new Promise((r) => setTimeout(r, 2500));
        const rows = (await recentRows(b.page, aid)).sort((x, y) => x.id - y.id);
        assert.equal(rows.length, 2, 'two v1 rows must be stored');
        assert.equal(JSON.parse(rows[0].content).encryption.version, 1, 'must really be v1');

        const victim = rows[1];
        const originalCiphertext = JSON.parse(victim.content).encryption.ciphertext;
        // Test j has its OWN server (v1server), so the global withDb() helper -
        // which stops and restarts the MAIN server - is wrong here. Write to the
        // v1 DB directly; SQLite serialises the write lock per transaction and
        // the v1 server commits per request, so the write lands between requests.
        const jdb = new Database(p, { readonly: false });
        try {
            const r = jdb.prepare('SELECT id, content FROM direct_messages WHERE id = ?').get(victim.id);
            const e = JSON.parse(r.content);
            const c = Buffer.from(e.encryption.ciphertext, 'base64');
            c[0] ^= 0xff;
            e.encryption.ciphertext = c.toString('base64');
            jdb.prepare('UPDATE direct_messages SET content = ? WHERE id = ?').run(JSON.stringify(e), r.id);
        } finally {
            jdb.close();
        }

        await reloadUser(b.page, PASSWORD);
        await openDmUi(b.page, aid, an);
        await new Promise((r) => setTimeout(r, 5000));

        assert.equal(await decryptedCount(b.page), 1,
            `the good v1 row must still render (got ${await decryptedCount(b.page)})`);
        assert.equal(await placeholderCount(b.page), 1,
            `exactly one placeholder (got ${await placeholderCount(b.page)})`);
        const text = await threadText(b.page);
        assert.ok(text.includes('v1-good'), 'the good v1 text must render');
        assert.ok(!text.includes('v1-tamper'), 'the tampered plaintext must not leak');
        const html = await b.page.evaluate(() => document.body.innerHTML);
        assert.ok(!html.includes(originalCiphertext),
            'the v1 ciphertext must not reach the DOM');

        await closeUserBrowsers();
    } finally {
        await closeUserBrowsers();
        await v1server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
