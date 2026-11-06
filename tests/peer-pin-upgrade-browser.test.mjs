// tests/peer-pin-upgrade-browser.test.mjs
//
// A device that saved its pins under an older version, in the real client: real
// IndexedDB, real thread, real verify panel, real crypto.
//
// The pin is written to IndexedDB exactly as the older code left it. The forged row is
// really encrypted under a key the server listed at first contact, and written straight
// into SQLite, which is what a hostile server serves. Each attack has a control beside
// it showing the same fixture does open when the rule does not apply.
//
// ACCOUNTS. One pair for the whole file, same reasons as
// tests/dm-v2-wire-browser-paths.test.mjs. Every test starts with no rows and with what
// the devices remember about each other forgotten.

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

const UNREADABLE = 'Unable to decrypt';
const FORGED = 'FORGED-under-a-planted-key';
const REAL = 'real-message-from-alice';
const HOUR = 3600000;

const AN = 'mvpinolda';
const BN = 'mvpinoldb';

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

const forgetPeer = (page, peerId) => page.evaluate(async (id) => {
    const { getPeerTrustContext } = await import('/js/crypto/keys/peer-key-gate.js');
    const { clearPeerPin } = await import('/js/crypto/keys/peer-trust.js');
    await clearPeerPin(id, await getPeerTrustContext());
}, peerId);

const bubbles = (page) => page.evaluate(() =>
    [...document.querySelectorAll('#dm-messages .chat-msg')].map((el) => el.querySelector('.chat-bubble')?.textContent.trim() ?? ''));

const threadShows = (page, text, what) => pollUntil(
    async () => (await bubbles(page)).includes(text),
    { what, describe: async () => JSON.stringify(await bubbles(page)) }
);

async function sendOnce(page, text) {
    await page.type('#dm-input', text);
    await page.keyboard.press('Enter');
    await pollUntil(
        async () => (await page.evaluate(() => document.getElementById('dm-input')?.value ?? null)) === '',
        { what: `the composer to clear after sending ${JSON.stringify(text)}` }
    );
}

/**
 * Replace this device's pin for `peerId` with what an older version would have left.
 *
 * `markedAfter`: how long after the key was pinned verifiedAt was stamped, or null. The
 * page keeps the planted key's private half so it can really encrypt under that key.
 */
const writeOldPin = (page, peerId, markedAfter) => page.evaluate(async (id, after, ageMs) => {
    const { getPeerTrustContext } = await import('/js/crypto/keys/peer-key-gate.js');
    const { getPeerPin, bytesToBase64 } = await import('/js/crypto/keys/peer-trust.js');

    const context = await getPeerTrustContext();
    const { current } = await getPeerPin(id, context);

    const planted = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', planted.publicKey));
    const fingerprint = bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
    window.__planted = { privateKey: planted.privateKey, raw };

    const at = Date.now() - ageMs;
    const pin = {
        peerId: id,
        current: { fingerprint: current.fingerprint, publicKey: current.publicKey, at },
        accepted: [{ fingerprint, publicKey: bytesToBase64(raw), at, viaFirstContact: true }],
        verifiedAt: after === null ? null : at + after,
    };

    const db = await new Promise((resolve, reject) => {
        const opening = indexedDB.open('wire-peer-trust', 1);
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
    });
    await new Promise((resolve, reject) => {
        const tx = db.transaction('peer-pins', 'readwrite');
        tx.objectStore('peer-pins').put(pin, `${context.origin}::${context.ownUserId}::${id}`);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}, peerId, markedAfter, 24 * HOUR);

/** A row really encrypted under the planted key, as if the peer had written it. */
const encryptUnderPlantedKey = (page, fromId, toId, plaintext) => page.evaluate(async (from, to, text) => {
    const v2 = await import('/js/crypto/messages/dm-v2.js');
    const { base64ToBytes } = await import('/js/crypto/keys/peer-trust.js');
    const { getCurrentIdentity } = await import('/js/crypto/identity-service.js');

    const recipient = await crypto.subtle.importKey(
        'raw', base64ToBytes(getCurrentIdentity().publicKey), { name: 'X25519' }, true, []
    );
    const { envelope } = await v2.encryptDmV2({
        plaintext: text,
        fromUserId: from,
        toUserId: to,
        senderKeyFp: await v2.senderKeyFingerprint(window.__planted.raw),
        key: await v2.deriveDmV2Key(from, to, window.__planted.privateKey, recipient),
    });
    return JSON.stringify(envelope);
}, fromId, toId, plaintext);

const plantRow = (from, to, content) => withDb((db) => db.prepare(
    'INSERT INTO direct_messages (sender_id, recipient_id, content, created_at) VALUES (?, ?, ?, ?)'
).run(from, to, content, new Date().toISOString()));

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

/** Alice and Bob really talk, so Bob's device holds a pin and has a real row to control with. */
async function conversationOnBobsDevice() {
    withDb((db) => db.prepare('DELETE FROM direct_messages').run());
    await forgetPeer(PAIR.a.page, PAIR.bid);
    await forgetPeer(PAIR.b.page, PAIR.aid);
    await reloadUser(PAIR.a.page);
    await reloadUser(PAIR.b.page);
    await openDmUi(PAIR.a.page, PAIR.bid, BN);
    await openDmUi(PAIR.b.page, PAIR.aid, AN);
    await sendOnce(PAIR.a.page, REAL);
    await threadShows(PAIR.b.page, REAL, 'bob to read alice');
    return PAIR;
}

async function reopenBob(pair) {
    await reloadUser(pair.b.page);
    await openDmUi(pair.b.page, pair.aid, AN);
}

test('a. a contact really verified under the old code: a row under a key the server listed at first contact does not open', { timeout: 240000 }, async () => {
    const pair = await conversationOnBobsDevice();

    await writeOldPin(pair.b.page, pair.aid, HOUR);
    plantRow(pair.aid, pair.bid, await encryptUnderPlantedKey(pair.b.page, pair.aid, pair.bid, FORGED));

    await reopenBob(pair);
    await threadShows(pair.b.page, REAL, 'the real message to still open');
    await threadShows(pair.b.page, UNREADABLE, 'the forged row to be refused');

    const html = await pair.b.page.evaluate(() => document.documentElement.outerHTML);
    assert.ok(!html.includes(FORGED), 'the forged text reached the page');
});

test('b. control: on a contact nobody verified, that same forged row does open, which is the documented limit', { timeout: 240000 }, async () => {
    const pair = await conversationOnBobsDevice();

    await writeOldPin(pair.b.page, pair.aid, null);
    plantRow(pair.aid, pair.bid, await encryptUnderPlantedKey(pair.b.page, pair.aid, pair.bid, FORGED));

    await reopenBob(pair);
    await threadShows(pair.b.page, FORGED, 'the fixture to be a working forgery');
});

// The Verify button's listener is attached after an await, so one early click can land
// on nothing. The text is empty until a render has filled it, which makes this safe to
// keep pressing.
const panelSays = (page) => pollUntil(async () => {
    const text = await page.evaluate(() => document.getElementById('dm-key-verify-marked')?.textContent ?? '');
    if (text) return text;
    await page.evaluate(() => document.getElementById('dm-key-verify-open')?.click());
    return null;
}, { step: 300, what: 'the verify panel to say whether this contact is verified' });

test('c. a mark the old accept button stamped: the panel says not verified, and Mark works', { timeout: 240000 }, async () => {
    const pair = await conversationOnBobsDevice();

    await writeOldPin(pair.b.page, pair.aid, 0);

    await reopenBob(pair);
    assert.equal(await panelSays(pair.b.page), 'Not yet marked as verified on this device.');

    await pair.b.page.evaluate(() => document.querySelector('#dm-key-verify [data-action="mark-verified"]').click());
    await pollUntil(
        async () => (await pair.b.page.evaluate(() => document.getElementById('dm-key-verify-marked')?.textContent)) === 'Marked as verified on this device.',
        { what: 'the panel to confirm the mark' }
    );

    await reopenBob(pair);
    assert.equal(await panelSays(pair.b.page), 'Marked as verified on this device.', 'a real mark survives a reload');
});

test('d. a mark a person made under the old code: the panel still says verified', { timeout: 240000 }, async () => {
    const pair = await conversationOnBobsDevice();

    await writeOldPin(pair.b.page, pair.aid, HOUR);

    await reopenBob(pair);
    assert.equal(await panelSays(pair.b.page), 'Marked as verified on this device.');
});
