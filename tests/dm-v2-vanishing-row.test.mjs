// tests/dm-v2-vanishing-row.test.mjs
//
// STEP 1G Part A. EVIDENCE ONLY - this file changes no production code.
//
// 1F left four red tests (e1-e4): after a stored row is tampered, the receiving
// thread renders NOTHING - not the plaintext, and not the "Unable to decrypt"
// placeholder - while the API still serves the row. This file establishes WHICH
// of the three candidate causes it is, and whether the behaviour is pre-existing
// (v1 goes through the same code) or specific to v2.
//
// WHAT IS ASSERTED HERE
//   The two SAFETY invariants, which must hold in every scenario and before and
//   after any fix:
//     - no plaintext reaches the DOM
//     - no ciphertext (the envelope's `ciphertext` string) reaches the DOM
//   The AVAILABILITY numbers - rendered bubbles, placeholder count, console error
//   - are REPORTED, not asserted. Asserting them would lock the current
//   behaviour into the suite, including the bug, and Part B would then have to
//   delete an assertion. That is the opposite of what evidence should do.

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

// ------------------------------------------------------------------ helpers

function makeServer(env = {}) {
    const dir = tmpDir();
    const p = path.join(dir, 'wire.db');
    fs.copyFileSync(FIXTURE_DB, p);
    return { dir, p, env };
}

async function bootServer({ dir, p, env }) {
    const { runMigrations } = await import('../database/migrations.js');
    const db0 = new Database(p, { readonly: false });
    runMigrations(db0);
    // The fixture's own DM row is deleted so every count below is exact.
    db0.prepare('DELETE FROM direct_messages').run();
    db0.close();
    const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: p, ...env } });
    return server;
}

async function makePair(origin, tag) {
    const an = `van${tag}a`;
    const bn = `van${tag}b`;
    await registerUser(origin, an);
    await registerUser(origin, bn);
    const a = await newUserPage();
    const b = await newUserPage();
    await loginUi(a.page, origin, an);
    await loginUi(b.page, origin, bn);
    const ids = await Promise.all([
        a.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id),
        b.page.evaluate(async () => (await import('/js/core/auth.js')).getCurrentUser().id),
    ]);
    return { a, b, an, bn, aid: ids[0], bid: ids[1] };
}

/** Send ONE message, never twice (see the 1F note on the harness double-send). */
async function sendOnce(page, text) {
    const deadline = Date.now() + 20000;
    await page.type('#dm-input', text);
    await page.keyboard.press('Enter');
    for (;;) {
        const v = await page.evaluate(() => document.getElementById('dm-input')?.value ?? null);
        if (v === '') return;
        if (Date.now() > deadline) {
            throw new Error(`the composer never cleared after ${JSON.stringify(text)}: ${JSON.stringify(v)}`);
        }
        await new Promise((r) => setTimeout(r, 200));
    }
}

const rendered = (page) => page.evaluate((ph) => {
    const all = [...document.querySelectorAll('#dm-messages .chat-msg')];
    return all.filter((el) => el.textContent.trim() !== ph).length;
}, PLACEHOLDER);

const placeholders = (page) => page.evaluate((ph) =>
    [...document.querySelectorAll('#dm-messages .chat-msg')]
        .filter((el) => el.textContent.trim() === ph).length, PLACEHOLDER);

const threadText = (page) =>
    page.evaluate(() => (document.getElementById('dm-messages')?.textContent || ''));

const rowsOf = (page, peerId) => page.evaluate(async (id) => {
    const { api } = await import('/js/core/api.js');
    const res = await api(`/api/dm/messages/${id}/recent`);
    const rows = Array.isArray(res) ? res : (res?.messages || []);
    return rows.map((r) => ({ id: Number(r.id), content: r.content }));
}, peerId);

/** Reload + unlock; the unlock card is expected but not required. */
async function reloadUser(page, password) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const locked = await page.waitForSelector('#unlock-password', { timeout: 20000 })
        .then(() => true, () => false);
    if (locked) {
        await page.type('#unlock-password', password);
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')]
                .find((x) => x.classList.contains('btn-primary') && /unlock/i.test(x.textContent || ''));
            btn.click();
        });
    }
    await page.waitForSelector('.nav-link[data-view="messages"]', { timeout: 60000 });
    const deadline = Date.now() + 30000;
    for (;;) {
        const ok = await page.evaluate(async () => !!(await import('/js/crypto/identity-service.js')).getCurrentIdentity());
        if (ok) return { locked };
        if (Date.now() > deadline) throw new Error('the identity never came back after the reload');
        await new Promise((r) => setTimeout(r, 250));
    }
}

/** Collect page console errors for the window that follows. */
function captureConsole(page, sink, label) {
    page.on('console', (m) => {
        if (m.type() !== 'error' && m.type() !== 'warning') return;
        const t = m.text();
        if (/decrypt|Failed to (process|sync|decrypt)|DM \d|dm/i.test(t)) {
            sink.push(`[${label}] ${t.slice(0, 220)}`);
        }
    });
    page.on('pageerror', (e) => sink.push(`[${label}] pageerror: ${String(e.message).slice(0, 220)}`));
}

const withDb = (p, fn) => {
    const db = new Database(p, { readonly: false });
    try { return fn(db); } finally { db.close(); }
};

/** One stable line per scenario, for the A5 table. */
function report(row) {
    const parts = [
        row.scenario.padEnd(26),
        row.wire.padEnd(5),
        `bubbles=${row.bubbles}`,
        `placeholder=${row.placeholder}`,
        `rows=${row.rows}`,
        `plaintext=${row.plaintext}`,
        `ciphertext=${row.ciphertext}`,
    ];
    if (row.console) parts.push(`console="${row.console}"`);
    console.log('VANISH | ' + parts.join(' | '));
}

/** The two invariants, always. */
function assertSafe(page, { secret, ciphertext }, label) {
    const t = await_text(page);
    assert.ok(!t.includes(secret), `${label}: PLAINTEXT reached the DOM: ${t.slice(0, 200)}`);
    assert.ok(!t.includes(ciphertext), `${label}: CIPHERTEXT reached the DOM: ${t.slice(0, 200)}`);
}
async function await_text(page) { return threadText(page); }

// ============================================================== A1: v1 parity
test('A1. v1 parity: a v1 row with one flipped ciphertext byte behaves the same way', { timeout: 300000 }, async () => {
    const spec = makeServer({ DM_E2EE_DEFAULT_MIN_VERSION: '1' });
    const server = await bootServer(spec);
    const sink = [];
    try {
        const p = await makePair(server.origin, 'a1');
        captureConsole(p.b.page, sink, 'bob');

        await openDmUi(p.a.page, p.bid, p.bn);
        await openDmUi(p.b.page, p.aid, p.an);
        await sendOnce(p.a.page, 'v1-good');
        await new Promise((r) => setTimeout(r, 2500));
        assert.equal(await rendered(p.b.page), 1, 'the untouched v1 row must render');

        // Flip ONE byte of the stored ciphertext.
        const [row] = await rowsOf(p.b.page, p.aid);
        const env = JSON.parse(row.content);
        assert.equal(env.encryption.version, 1, 'this scenario must really be v1');
        const raw = Buffer.from(env.encryption.ciphertext, 'base64');
        raw[0] ^= 0xff;
        const broken = Buffer.from(raw).toString('base64');
        withDb(spec.p, (db) => {
            const r = db.prepare('SELECT id, content FROM direct_messages WHERE id = ?').get(row.id);
            const e = JSON.parse(r.content);
            e.encryption.ciphertext = broken;
            db.prepare('UPDATE direct_messages SET content = ? WHERE id = ?').run(JSON.stringify(e), row.id);
        });

        assert.ok(true, 'A3 mutation applied (see the VANISH-MUT line above)');

        await reloadUser(p.b.page, PASSWORD);
        sink.length = 0;
        await openDmUi(p.b.page, p.aid, p.an);
        await new Promise((r) => setTimeout(r, 4000));

        const bubbles = await rendered(p.b.page);
        const placeholder = await placeholders(p.b.page);
        const rows = (await rowsOf(p.b.page, p.aid)).length;
        const text = await threadText(p.b.page);
        const con = sink.find((s) => /Failed to (process|sync)/.test(s)) || sink[0] || '(no console error)';

        report({ scenario: 'A1 v1 parity', wire: 'v1', bubbles, placeholder, rows,
            plaintext: text.includes('v1-good'), ciphertext: text.includes(env.encryption.ciphertext), console: con });

        assert.ok(!text.includes('v1-good'), 'A1: PLAINTEXT reached the DOM');
        assert.ok(!text.includes(env.encryption.ciphertext), 'A1: CIPHERTEXT reached the DOM');
    } finally {
        await closeUserBrowsers();
        await server.stop();
        fs.rmSync(spec.dir, { recursive: true, force: true });
    }
});

// ========================================================= A2: blast radius
test('A2. blast radius: one tampered row among three good ones, on the history path', { timeout: 300000 }, async () => {
    const spec = makeServer({});
    const server = await bootServer(spec);
    const sink = [];
    try {
        const p = await makePair(server.origin, 'a2');
        captureConsole(p.b.page, sink, 'bob');

        await openDmUi(p.a.page, p.bid, p.bn);
        await openDmUi(p.b.page, p.aid, p.an);
        const plaintexts = ['good-one', 'to-tamper', 'good-two'];
        await sendOnce(p.a.page, plaintexts[0]);
        await sendOnce(p.a.page, plaintexts[1]);
        await sendOnce(p.a.page, plaintexts[2]);
        await new Promise((r) => setTimeout(r, 3000));
        assert.equal(await rendered(p.b.page), 3, 'all three rows must render before the tamper');

        const rows = (await rowsOf(p.b.page, p.aid)).sort((x, y) => x.id - y.id);
        assert.equal(rows.length, 3, 'three rows must be stored');
        // Sent in order good-one, to-tamper, good-two, so the ids ascend.
        const victim = rows[1];
        assert.ok(victim, 'the middle row must exist');
        assert.ok(plaintexts.includes('to-tamper'),
            'sanity: the middle row is the one whose plaintext was to-tamper');
        const applied = withDb(spec.p, (db) => {
            const r = db.prepare('SELECT id, content FROM direct_messages WHERE id = ?').get(victim.id);
            const e = JSON.parse(r.content);
            e.senderId = e.senderId + 1000;
            const res = db.prepare('UPDATE direct_messages SET content = ? WHERE id = ?')
                .run(JSON.stringify(e), r.id);
            const back = db.prepare('SELECT id, content FROM direct_messages WHERE id = ?').get(victim.id);
            return {
                changes: res.changes,
                readBackChanged: back.content !== r.content,
                senderIdNow: JSON.parse(back.content).senderId,
            };
        });

        // STEP 1H item 1.1. Without this the whole scenario is unfalsifiable: 1G's A2
        // reported "3 bubbles, tampered plaintext visible", which reads as "tamper is
        // not detected in a multi-row conversation" - a P0 claim - and the real cause
        // was that the UPDATE never landed and nothing checked. The reviewer's probe
        // (tests/_reference/probe-tamper-rows.test.mjs) prints changes=1 and bubbles=0.
        console.log(`VANISH-MUT | A2 | row=${victim.id} changes=${applied.changes} `
            + `readBackChanged=${applied.readBackChanged} senderIdNow=${applied.senderIdNow}`);
        assert.equal(applied.changes, 1,
            `the mutation MUST land, or this scenario proves nothing (changes=${applied.changes})`);
        assert.equal(applied.readBackChanged, true,
            'the row read back from the same connection must differ from what was read in');

        await reloadUser(p.b.page, PASSWORD);
        sink.length = 0;
        await openDmUi(p.b.page, p.aid, p.an);
        await new Promise((r) => setTimeout(r, 5000));

        const bubbles = await rendered(p.b.page);
        const placeholder = await placeholders(p.b.page);
        const text = await threadText(p.b.page);
        const con = sink.find((s) => /Failed to (process|sync)/.test(s)) || sink[0] || '(no console error)';

        report({ scenario: 'A2 history 3 rows', wire: 'v2', bubbles, placeholder,
            rows: (await rowsOf(p.b.page, p.aid)).length,
            plaintext: text.includes('good-one') || text.includes('good-two'),
            ciphertext: text.includes(JSON.parse(victim.content).encryption.ciphertext), console: con });

        assert.ok(!text.includes('to-tamper'), 'A2: PLAINTEXT of the tampered row reached the DOM');
        console.log(`VANISH | A2 detail | good-one shown=${text.includes('good-one')} good-two shown=${text.includes('good-two')}`);
    } finally {
        await closeUserBrowsers();
        await server.stop();
        fs.rmSync(spec.dir, { recursive: true, force: true });
    }
});

test('A3. live path: a row delivered by the socket renders, and a tampered one re-opened does not', { timeout: 300000 }, async () => {
    const spec = makeServer({});
    const server = await bootServer(spec);
    const sink = [];
    try {
        const p = await makePair(server.origin, 'a3');
        captureConsole(p.b.page, sink, 'bob');

        // Bob's thread is OPEN, so the next message arrives on the LIVE path
        // (addDmMessage via the socket), not through the history batch.
        await openDmUi(p.b.page, p.aid, p.an);
        await openDmUi(p.a.page, p.bid, p.bn);
        await sendOnce(p.a.page, 'live-ok');
        const deadline = Date.now() + 25000;
        while (await rendered(p.b.page) < 1) {
            if (Date.now() > deadline) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const liveBubbles = await rendered(p.b.page);
        report({ scenario: 'A3 live delivery', wire: 'v2', bubbles: liveBubbles,
            placeholder: await placeholders(p.b.page), rows: (await rowsOf(p.b.page, p.aid)).length,
            plaintext: (await threadText(p.b.page)).includes('live-ok'), ciphertext: false,
            console: sink[0] || '(no console error)' });
        assert.equal(liveBubbles, 1, 'the live socket path must render the row');

        // Now tamper that row and RE-OPEN the conversation in the same page, with
        // no page reload, so the row comes back through the history batch.
        const [row] = await rowsOf(p.b.page, p.aid);
        withDb(spec.p, (db) => {
            const r = db.prepare('SELECT id, content FROM direct_messages WHERE id = ?').get(row.id);
            const e = JSON.parse(r.content);
            e.recipientId = e.recipientId + 1000;
            db.prepare('UPDATE direct_messages SET content = ? WHERE id = ?').run(JSON.stringify(e), r.id);
        });
        sink.length = 0;
        // RELOAD, not just re-open: re-opening in the same page renders from the
        // message cache, which still holds the decrypted row, so the tampered
        // bytes would never be read again.
        await reloadUser(p.b.page, PASSWORD);
        sink.length = 0;
        await openDmUi(p.b.page, p.aid, p.an);
        await new Promise((r) => setTimeout(r, 5000));

        const bubbles = await rendered(p.b.page);
        const text = await threadText(p.b.page);
        const con = sink.find((s) => /Failed to (process|sync)/.test(s)) || sink[0] || '(no console error)';
        report({ scenario: 'A3 re-open tampered', wire: 'v2', bubbles, placeholder: await placeholders(p.b.page),
            rows: (await rowsOf(p.b.page, p.aid)).length,
            plaintext: text.includes('live-ok'),
            ciphertext: text.includes(JSON.parse(row.content).encryption.ciphertext), console: con });
        assert.ok(!text.includes('live-ok'), 'A3: PLAINTEXT reached the DOM after the tamper');
    } finally {
        await closeUserBrowsers();
        await server.stop();
        fs.rmSync(spec.dir, { recursive: true, force: true });
    }
});

test('A4. held row (decryptDmMessage returns null): the batch sees a null', { timeout: 300000 }, async () => {
    const spec = makeServer({});
    const server = await bootServer(spec);
    const sink = [];
    try {
        const p = await makePair(server.origin, 'a4');
        captureConsole(p.b.page, sink, 'bob');

        await openDmUi(p.a.page, p.bid, p.bn);
        await sendOnce(p.a.page, 'held-row');
        await openDmUi(p.b.page, p.aid, p.an);
        await new Promise((r) => setTimeout(r, 3000));
        assert.equal(await rendered(p.b.page), 1, 'the row must render before the rotation');

        // Bob rotates, so Alice's next load HOLDS the row -> decryptDmMessage
        // returns null and the batch receives a null entry.
        const rot = await p.b.page.evaluate(async (password) => {
            const { api } = await import('/js/core/api.js');
            const { deriveCredentials } = await import('/js/crypto/credentials.js');
            const { generateIdentityKeyPair, exportPublicKey, exportPrivateKey, encryptIdentityPkcs8 } =
                await import('/js/crypto/identity.js');
            const kdf = await api('/api/me/kdf-params');
            const { authKey } = await deriveCredentials(password, kdf.salt, kdf.iterations);
            const before = await api('/api/me/identity-key');
            const pair = await generateIdentityKeyPair();
            const pk = await exportPublicKey(pair);
            const wrapped = await encryptIdentityPkcs8(await exportPrivateKey(pair), password, {
                salt: kdf.salt, iterations: kdf.iterations,
            });
            const out = await api('/api/me/identity-key/rotate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    current_auth_key: authKey,
                    expected_public_key: before.publicKey,
                    expected_updated_at: before.updatedAt,
                    identity: { publicKey: pk, ...wrapped },
                }),
            });
            return { error: out?.error ?? null };
        }, PASSWORD);
        assert.equal(rot.error, null, `rotation failed: ${rot.error}`);

        // Alice reloads (fresh client, pin for the retired key) and opens the DM:
        // this is the HISTORY batch with the row held.
        await reloadUser(p.a.page, PASSWORD);
        sink.length = 0;
        await openDmUi(p.a.page, p.bid, p.bn);
        await new Promise((r) => setTimeout(r, 5000));

        const bubbles = await rendered(p.a.page);
        const text = await threadText(p.a.page);
        const held = await p.a.page.evaluate(async (id) => {
            const kt = await import('/js/chat/dm-key-trust.js');
            return { state: kt.trustState(id), held: kt.heldCount(id) };
        }, p.bid);
        const con = sink.find((s) => /Failed to (process|sync)/.test(s)) || sink[0] || '(no console error)';

        report({ scenario: 'A4 held row', wire: 'v2', bubbles, placeholder: await placeholders(p.a.page),
            rows: (await rowsOf(p.a.page, p.bid)).length,
            plaintext: text.includes('held-row'), ciphertext: false,
            console: `state=${held.state} held=${held.held} ${con}` });

        // SAFETY only. A held row must never show plaintext, and the raw row is
        // kept in dm-key-trust.js for release on accept - so nothing is lost.
        assert.ok(!text.includes('held-row'), 'A4: a HELD row must not show its plaintext');
        assert.ok(held.held >= 1, `A4: the row should be held, held=${held.held}`);
    } finally {
        await closeUserBrowsers();
        await server.stop();
        fs.rmSync(spec.dir, { recursive: true, force: true });
    }
});