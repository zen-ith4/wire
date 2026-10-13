// tests/acceptance-no-plaintext.test.mjs
//
// Automates acceptance items "the server never sees plaintext" and "nothing sensitive in the
// logs". REAL server process (node server.js) + REAL Chromium; no app changes.
//
// Scenario (all through the real UI so the CLIENT does the encryption):
//   alice sends a group text (marker G), a DM text (marker T), a DM attachment whose BYTES carry
//   marker A and whose caption carries marker C.
// Then, twice (server still running = live -wal/-shm, and after SIGTERM), every file the server
// could have persisted is scanned: .db, -wal, -shm, the uploads dirs, multer's temp dir
// (TMPDIR is isolated per run), plus the captured stdout/stderr.
//
//   * group text and DM text: MUST be absent                          -> hard tests
//   * DM attachment bytes + caption: MUST be absent. Agent B's patch (E2EE DM attachments) is not
//     in every tree; until it lands this one test is marked `todo` and says so. It turns into a
//     hard test automatically once dm.controller.js requires attachment_iv (B's server side), or
//     with DM_ATTACH_E2EE=1.
//   * group attachments are disabled: the server must reject uploads without a valid attachment_iv
//     and must leave nothing behind.
//   * log-leak: no key material / token / password patterns in the server logs, and none of the
//     exact secret values the server holds (tokens, password, key-ish DB columns) appear in them.
//
// Positive controls: the scanners are first proven to find a planted marker, and the scenario is
// proven to have really reached the server (rows exist) before any "absent" claim is made.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    ROOT,
    PASSWORD,
    rand,
    sleep,
    waitFor,
    startRealServer,
    jsonClient,
    filesContaining,
    textContains,
    walkFiles,
    launchBrowser,
    registerUser,
    restLogin,
    loginUi,
    socketConnected,
    openGroupUi,
    sendGroupTextUi,
    openDmUi,
    sendDmTextUi,
    sessionFromPage,
} from './_acceptance-harness.mjs';

const require = createRequire(import.meta.url);

// ------------------------------------------------------------------ leak patterns (exported shape kept simple)
const LEAK_PATTERNS = [
    ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
    ['Bearer token', /Bearer\s+[A-Za-z0-9._~+/-]{16,}/i],
    ['base64 32-byte key (44 chars, padded)', /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/],
    ['base64url 32-byte key (43 chars)', /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_=-])/],
    ['256-bit hex key (64 hex chars)', /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i],
    ['wrapped/private key field with a value', /(wrapped[_-]?(sender[_-]?)?key|sender[_-]?key|private[_-]?key|encrypted[_-]?(identity|private)[_-]?key|kdm[_-]?(payload|blob))["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{16,}/i],
    ['password / secret / token assignment', /(password|passphrase|secret|jwt|token)["']?\s*[:=]\s*["']?[^\s"',}]{6,}/i],
];
function scanLogText(text) {
    const found = [];
    for (const line of text.split('\n')) {
        for (const [name, re] of LEAK_PATTERNS) if (re.test(line)) found.push(`${name}: ${line.slice(0, 160)}`);
    }
    return found;
}

// ------------------------------------------------------------------ scenario
let server = null; let browser = null; let fixtureDir = null;
const DM_ATTACH_E2EE_LANDED = process.env.DM_ATTACH_E2EE === '1' ||
    fs.readFileSync(path.join(ROOT, 'controllers/dm.controller.js'), 'utf8').includes('attachment_iv');

after(async () => {
    await browser?.close().catch(() => {});
    await server?.stop().catch(() => {});
    for (const d of [server?.work, fixtureDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

let scenarioPromise = null;
function scenario() { return (scenarioPromise ??= runScenario()); }

async function runScenario() {
    const launched = await launchBrowser();
    if (!launched.browser) return { blocked: `no Chromium available (${launched.reason})` };
    browser = launched.browser;
    server = await startRealServer();
    const { origin } = server;
    const n = rand();
    const names = { alice: `al${n}`, bob: `bo${n}`, carol: `ca${n}` };
    const M = { group: `ZXQ-GRP-${rand()}`, dmText: `ZXQ-DMT-${rand()}`, dmFile: `ZXQ-DMA-${rand()}`, dmCaption: `ZXQ-DMC-${rand()}` };

    for (const u of Object.values(names)) await registerUser(origin, u);
    const bobPage = await browser.newPage(); bobPage.setDefaultTimeout(30000); await bobPage.setViewport({ width: 1280, height: 900 });
    await loginUi(bobPage, origin, names.bob); // creates bob's identity key
    const page = await browser.newPage(); page.setDefaultTimeout(30000); await page.setViewport({ width: 1280, height: 900 });
    await loginUi(page, origin, names.alice);
    assert.ok(await socketConnected(page), 'alice socket connected');
    await sleep(800);

    const sess = {};
    // alice and bob went through the UI login, so their accounts are on
    // login scheme 2 and no raw password is accepted for them any more:
    // reuse the session the browser already holds. carol never logged in
    // through the UI, so she is still scheme 1 and a plain REST login is
    // correct for her.
    sess.alice = await sessionFromPage(page, origin, names.alice);
    sess.bob = await sessionFromPage(bobPage, origin, names.bob);
    sess.carol = await restLogin(origin, names.carol);

    // group + member through the official routes
    const g = await sess.alice.api('/api/groups', { method: 'POST', body: JSON.stringify({ name: `plain ${n}` }) });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    const gid = g.body.id;
    const add = await sess.alice.api(`/api/groups/${gid}/members`, { method: 'POST', body: JSON.stringify({ user_id: sess.bob.id }) });
    assert.equal(add.status, 200, JSON.stringify(add.body));

    // 1. group text, through the UI
    await openGroupUi(page, gid);
    await sendGroupTextUi(page, sess.alice.api, gid, [sess.alice.id, sess.bob.id], M.group);

    // 2. DM text, through the UI
    await openDmUi(page, sess.bob.id, names.bob);
    await sendDmTextUi(page, M.dmText);

    // 3. DM attachment (bytes carry marker A, caption carries marker C), through the UI
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-fixture-')); // OUTSIDE the scanned work dir
    const fixture = path.join(fixtureDir, 'notes.txt');
    fs.writeFileSync(fixture, `attachment body ${M.dmFile}\n`.repeat(20));
    const before = await page.$$eval('#dm-thread .chat-msg', (e) => e.length);
    await (await page.$('#dm-file-input')).uploadFile(fixture);
    await page.waitForSelector('#dm-attach-staging .attach-chip', { timeout: 10000 });
    await page.type('#dm-input', M.dmCaption);
    await page.evaluate(() => window.sendDm());
    const attachSent = await waitFor(async () => (await page.$$eval('#dm-thread .chat-msg', (e) => e.length)) > before, 25000, 250);

    // what the server really holds (bob reads it as the recipient)
    const dmRecent = await sess.bob.api(`/api/dm/messages/${sess.alice.id}/recent?limit=50`);
    const dmMsgs = Array.isArray(dmRecent.body) ? dmRecent.body : dmRecent.body?.messages || [];
    const grpRecent = await sess.bob.api(`/api/groups/${gid}/messages/recent`);
    const grpMsgs = Array.isArray(grpRecent.body) ? grpRecent.body : grpRecent.body?.messages || [];
    await sleep(1200); // let the server flush

    // ---- group attachment rejection (REST, official route) ----
    const leftovers = () => ['ud', 'tmp', 'chat', 'dm', 'group', 'banners'].reduce((n, k) => n + walkFiles(server.dirs[k]).length, 0);
    const upload = async (token, fields) => {
        const fd = new FormData();
        fd.append('file', new Blob([`plain ${M.group}`]), 'x.txt');
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        return jsonClient(origin, token)(`/api/groups/${gid}/upload`, { method: 'POST', body: fd });
    };
    const reject = {};
    const baseFiles = leftovers();
    reject.noIv = await upload(sess.alice.token, {});
    reject.badIv = await upload(sess.alice.token, { attachment_iv: '!!not base64!!' });
    reject.longIv = await upload(sess.alice.token, { attachment_iv: 'A'.repeat(80) });
    reject.noAuth = await upload(null, { attachment_iv: 'AAAAAAAAAAAAAAAA' });
    reject.nonMember = await upload(sess.carol.token, { attachment_iv: 'AAAAAAAAAAAAAAAA' });
    await sleep(500);
    reject.leftoverFiles = leftovers() - baseFiles;

    // ---- scan 1: server still running (live -wal / -shm) ----
    const scan = (label) => {
        const out = { label, files: walkFiles(server.work).map((f) => path.relative(server.work, f)), hits: {} };
        for (const [k, m] of Object.entries(M)) out.hits[k] = { disk: filesContaining(server.work, m), logs: textContains(server.logs(), m) };
        return out;
    };
    const strayRoot = server.strayRootEntries();
    const live = scan('server running');
    const logsBeforeStop = server.logs();

    // exact secret values the server holds, for the log-leak test (read while the DB is still intact)
    const Database = require('better-sqlite3');
    const db = new Database(server.dbPath, { readonly: true, fileMustExist: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const rows = (t) => db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    const secretValues = [];
    const secretColumns = [];
    for (const t of tables) {
        for (const col of db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)) {
            if (/public/i.test(col) || !/(key|wrapped|secret|salt|token|password|hash)/i.test(col)) continue;
            secretColumns.push(`${t}.${col}`);
            for (const r of db.prepare(`SELECT "${col}" v FROM "${t}" WHERE "${col}" IS NOT NULL LIMIT 200`).all()) {
                const v = typeof r.v === 'string' ? r.v : Buffer.isBuffer(r.v) ? r.v.toString('base64') : String(r.v);
                if (v.length >= 20) secretValues.push({ where: `${t}.${col}`, value: v });
            }
        }
    }
    const journalMode = db.pragma('journal_mode', { simple: true });
    const counts = Object.fromEntries(tables.map((t) => [t, rows(t)]));
    const dmTable = tables.find((t) => /^direct_messages$/.test(t));
    const grpTable = tables.find((t) => /^group_messages$/.test(t));
    db.close();

    await bobPage.close().catch(() => {});
    await page.close().catch(() => {});
    await server.stop();
    const final = scan('after server stop');
    return {
        M, names, gid, sess, live, final, strayRoot, logs: server.logs(), logsBeforeStop, reject, attachSent, dmMsgs, grpMsgs,
        secretValues, secretColumns, journalMode, counts, dmTable, grpTable, tokens: [sess.alice.token, sess.bob.token, sess.carol.token],
    };
}

const skipIfBlocked = (t, s) => { if (s.blocked) { t.skip(`BLOCKED: ${s.blocked}`); return true; } return false; };

// ------------------------------------------------------------------ positive controls
test('control: the scanners really find a planted marker (disk, base64 spelling, logs, leak patterns)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-selfcheck-'));
    try {
        fs.writeFileSync(path.join(dir, 'a.db-wal'), Buffer.concat([Buffer.alloc(64), Buffer.from('xx ZXQ-SELF-1 yy')]));
        fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from(Buffer.from('ZXQ-SELF-2').toString('base64')));
        assert.deepEqual(filesContaining(dir, 'ZXQ-SELF-1'), ['a.db-wal']);
        assert.deepEqual(filesContaining(dir, 'ZXQ-SELF-2'), ['b.bin']);
        assert.deepEqual(filesContaining(dir, 'ZXQ-SELF-3'), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    assert.ok(textContains('log ZXQ-SELF-4 line', 'ZXQ-SELF-4'));
    const key = Buffer.alloc(32, 7).toString('base64');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZw';
    for (const line of [`key=${key}`, `Authorization: Bearer ${jwt}`, `token: ${jwt}`, `"wrapped_key":"${key}"`, `password=hunter2hunter2`, `k ${'ab'.repeat(32)}`]) {
        assert.ok(scanLogText(line).length > 0, `pattern set missed: ${line}`);
    }
    assert.deepEqual(scanLogText('[2026-10-05T10:00:00.000Z] ::1 USER:1 GET /api/groups 200 4ms'), [], 'normal request line is clean');
});

// ------------------------------------------------------------------ control: the scenario really reached the server
test('control: the scenario reached the server (rows exist, scan covered the real files)', async (t) => {
    const s = await scenario(); if (skipIfBlocked(t, s)) return;
    assert.ok(s.attachSent, 'DM attachment message rendered in the sender thread');
    assert.ok(s.grpMsgs.length >= 1, 'group message is on the server');
    assert.ok(s.dmMsgs.length >= 2, `DM text + DM attachment are on the server (got ${s.dmMsgs.length})`);
    assert.ok(s.counts[s.grpTable] >= 1 && s.counts[s.dmTable] >= 2, JSON.stringify(s.counts));
    for (const scan of [s.live, s.final]) {
        assert.ok(scan.files.some((f) => /wire\.db$/.test(f)), `${scan.label}: wire.db was scanned`);
    }
    if (/wal/i.test(String(s.journalMode))) {
        assert.ok(s.live.files.some((f) => f.endsWith('wire.db-wal')), 'live scan includes wire.db-wal (journal_mode=WAL)');
        assert.ok(s.live.files.some((f) => f.endsWith('wire.db-shm')), 'live scan includes wire.db-shm');
    }
    assert.deepEqual(s.strayRoot, [], 'the server wrote into the repo root: an upload dir was not redirected into the scanned work dir');
    assert.ok(s.live.files.some((f) => /^dm-uploads\//.test(f)), 'the DM attachment file exists in the scanned dm-uploads dir (the scan can see uploads)');
    assert.ok(s.logs.length > 200, 'server logs captured');
    console.log(`# scanned (${s.live.label}): ${s.live.files.length} files; journal_mode=${s.journalMode}; wal/shm present live: ${s.live.files.filter((f) => /-(wal|shm)$/.test(f)).join(', ') || 'none'}`);
    console.log(`# scanned (${s.final.label}): ${s.final.files.length} files`);
});

// ------------------------------------------------------------------ hard tests
for (const [name, key] of [['group message text', 'group'], ['DM text', 'dmText']]) {
    test(`no plaintext: ${name} marker is absent from .db/-wal/-shm, uploads dirs and server logs`, async (t) => {
        const s = await scenario(); if (skipIfBlocked(t, s)) return;
        for (const scan of [s.live, s.final]) {
            assert.deepEqual(scan.hits[key].disk, [], `${scan.label}: ${s.M[key]} found in ${JSON.stringify(scan.hits[key].disk)}`);
            assert.equal(scan.hits[key].logs, false, `${scan.label}: ${s.M[key]} found in the server logs`);
        }
    });
}

test(`no plaintext: DM attachment bytes + caption are absent from .db/-wal/-shm, uploads dirs and logs${DM_ATTACH_E2EE_LANDED ? '' : ' [depends on agent B DM attachment E2EE patch]'}`,
    DM_ATTACH_E2EE_LANDED ? {} : { todo: 'agent B patch (E2EE DM attachments) not in this tree: files and captions are stored in plaintext here' },
    async (t) => {
        const s = await scenario(); if (skipIfBlocked(t, s)) return;
        const problems = [];
        for (const scan of [s.live, s.final]) {
            for (const key of ['dmFile', 'dmCaption']) {
                if (scan.hits[key].disk.length) problems.push(`${scan.label}: ${s.M[key]} (${key}) in ${JSON.stringify(scan.hits[key].disk)}`);
                if (scan.hits[key].logs) problems.push(`${scan.label}: ${key} in logs`);
            }
        }
        assert.deepEqual(problems, []);
    });

test('log-leak: no key material, token or password patterns in the server logs', async (t) => {
    const s = await scenario(); if (skipIfBlocked(t, s)) return;
    assert.deepEqual(scanLogText(s.logs), [], 'pattern hits in server logs');
});

test('log-leak: none of the exact secret values the server holds appear in its logs', async (t) => {
    const s = await scenario(); if (skipIfBlocked(t, s)) return;
    const hay = s.logs;
    const leaked = [];
    if (hay.includes(PASSWORD)) leaked.push('plaintext password');
    s.tokens.forEach((tok, i) => { if (tok && hay.includes(tok)) leaked.push(`auth token #${i}`); });
    for (const { where, value } of s.secretValues) if (hay.includes(value)) leaked.push(`${where} value`);
    assert.ok(s.secretColumns.length > 0, 'found key-ish DB columns to check');
    assert.ok(s.secretValues.length > 0, 'found at least one stored secret value to check against');
    assert.deepEqual(leaked, []);
    console.log(`# checked ${s.secretValues.length} stored values from ${s.secretColumns.length} key-ish columns, ${s.tokens.length} tokens and the password`);
});

test('group attachments: uploads without a valid attachment_iv are rejected and leave nothing behind', async (t) => {
    const s = await scenario(); if (skipIfBlocked(t, s)) return;
    const r = s.reject;
    assert.equal(r.noIv.status, 400, JSON.stringify(r.noIv.body));
    assert.match(JSON.stringify(r.noIv.body), /attachment_iv/);
    assert.equal(r.badIv.status, 400, 'non-base64 iv');
    assert.equal(r.longIv.status, 400, 'oversized iv');
    assert.equal(r.noAuth.status, 401, 'no session');
    assert.ok([403, 404].includes(r.nonMember.status), `non-member upload rejected (got ${r.nonMember.status})`);
    assert.equal(r.leftoverFiles, 0, 'rejected uploads left files in the uploads / temp dirs');
});
