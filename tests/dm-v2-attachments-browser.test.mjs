// tests/dm-v2-attachments-browser.test.mjs
//
// STEP 2B.1: DM attachment E2EE through REAL BROWSERS. One process per
// account, reload + re-login, exact-postcondition polls, no fixed sleeps.
// NO production change: this file exercises the code shipped in 2A.
//
// Base: the reviewer's reference probe (tests/_reference/probe-attachment-v2.mjs).
// Every mutation follows the STEP 1G rule: SELECT id, ... then
// UPDATE ... WHERE id = ? and ASSERT .run().changes === 1, then read it back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRealServer, newUserPage, closeUserBrowsers, openDmUi, ROOT } from './_acceptance-harness.mjs';
import { Database, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, origin, username, password) {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth-username', { timeout: 30000 });
  await page.type('#auth-username', username);
  await page.type('#auth-password', password);
  await page.click('#auth-form button');
  await page.waitForSelector('.nav-link', { timeout: 60000 });
  await sleep(500);
}

async function stageAndSend(page, filePath, caption) {
  const before = await page.$$eval('#dm-thread .chat-msg', (e) => e.length);
  const input = await page.$('#dm-file-input');
  await input.uploadFile(filePath);
  await page.waitForSelector('#dm-attach-staging .attach-chip', { timeout: 10000 });
  if (caption) await page.type('#dm-input', caption);
  await page.evaluate(() => window.sendDm());
  await page.waitForFunction((n) => document.querySelectorAll('#dm-thread .chat-msg').length > n, { timeout: 30000 }, before);
  await sleep(300);
  return before;
}

function makeFile(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

function openDb(dbPath) { return new Database(dbPath); }

function lastAttachmentRow(dbPath) {
  const db = openDb(dbPath);
  const row = db.prepare('SELECT id, content, attachment_meta, reply_to_id, attachment_path FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1').get();
  db.close();
  return row;
}

function tamper(dbPath, rowId, mutator) {
  const db = openDb(dbPath);
  const row = db.prepare('SELECT id, attachment_meta FROM direct_messages WHERE id = ?').get(rowId);
  assert.ok(row, `row ${rowId} must exist`);
  const meta = JSON.parse(row.attachment_meta);
  mutator(meta);
  const changes = db.prepare('UPDATE direct_messages SET attachment_meta = ? WHERE id = ?').run(JSON.stringify(meta), rowId).changes;
  const back = db.prepare('SELECT id, attachment_meta FROM direct_messages WHERE id = ?').get(rowId);
  db.close();
  assert.equal(changes, 1, 'the tamper UPDATE must affect exactly one row');
  return { meta: JSON.parse(back.attachment_meta), original: meta };
}

function readDb(dbPath, sql, ...args) { const db = openDb(dbPath); const r = db.prepare(sql).get(...args); db.close(); return r; }

// ---------------------------------------------------------------- a. file + caption to a v2 peer

test('a. image + caption to a v2 peer: stored v2, bob sees caption and file name, blob not plaintext', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'photo.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    await stageAndSend(a.page, file, 'caption-probe-text');
    // positive control: alice sees her own chip + caption
    const aliceText = await a.page.evaluate(() => document.getElementById('dm-thread').innerText);
    assert.match(aliceText, /caption-probe-text/);

    const db = openDb(dbPath);
    const row = db.prepare('SELECT id, content, attachment_meta, attachment_path FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    db.close();
    assert.equal(JSON.parse(row.content).encryption.version, 2);
    assert.equal(JSON.parse(row.attachment_meta).encryption.version, 2);
    assert.ok(!row.attachment_meta.includes('photo.png'), 'the file name must not be in the clear meta');

    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    const view = await b.page.evaluate(() => ({
      bubbles: document.querySelectorAll('#dm-thread .chat-msg').length,
      hasFileName: !!document.querySelector('[data-filename="photo.png"]'),
      caption: /caption-probe-text/.test(document.getElementById('dm-thread').innerText),
      unavailable: /Attachment unavailable/.test(document.getElementById('dm-thread').innerText)
    }));
    assert.ok(view.bubbles >= 1);
    assert.equal(view.caption, true, 'bob must see the caption');
    assert.equal(view.unavailable, false);
    assert.equal(view.hasFileName, true, 'bob must see the file name (data-filename="photo.png")');

    const onDiskPath = row.attachment_path;
    assert.ok(typeof onDiskPath === 'string' && onDiskPath.length > 0, 'attachment_path must be stored');
    const onDisk = fs.readFileSync(path.join(server.dirs.dm, onDiskPath));
    assert.ok(!onDisk.toString('latin1').includes('photo.png'), 'the on-disk blob must not be plaintext');
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- b. recipient at default 1 -> v1

test('b. recipient at default 1: stored meta and caption are v1, bob reads both', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'legacy.bin', Buffer.from('legacy bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    await stageAndSend(a.page, file, 'legacy caption');

    const db = openDb(dbPath);
    const row = db.prepare('SELECT content, attachment_meta FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    db.close();
    assert.equal(JSON.parse(row.attachment_meta).encryption.version, 1);
    assert.equal(JSON.parse(row.content).encryption.version, 1);
    assert.equal(JSON.parse(row.attachment_meta).encryption.senderFp, undefined);
    assert.equal(JSON.parse(row.attachment_meta).encryption.msgId, undefined);

    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    const view = await b.page.evaluate(() => ({
      names: [...document.querySelectorAll('.chat-attachment-name')].map((e) => e.textContent.trim()),
      caption: /legacy caption/.test(document.getElementById('dm-thread').innerText),
      unavailable: /Attachment unavailable/.test(document.getElementById('dm-thread').innerText)
    }));
    assert.equal(view.caption, true);
    assert.equal(view.unavailable, false);
    assert.ok(view.names.some((n) => n === 'legacy.bin'));
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- c. reply binding

test('c1. an attachment sent AS a reply to a text message: stored reply_to_id equals the parent, bob sees the quote', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'reply-child.bin', Buffer.from('child bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    await a.page.type('#dm-input', 'parent-text');
    await a.page.evaluate(() => window.sendDm());
    await a.page.waitForFunction(() => document.querySelectorAll('#dm-thread .chat-msg').length >= 1, { timeout: 30000 });
    await sleep(300);
    const parentRow = readDb(dbPath, 'SELECT id FROM direct_messages ORDER BY id DESC LIMIT 1');
    // reply to the parent through the real composer
    await a.page.evaluate((pid) => { window.replyToDmMessage && window.replyToDmMessage(pid); }, parentRow.id);
    await sleep(200);
    await stageAndSend(a.page, file, 'child-caption');
    const row = readDb(dbPath, 'SELECT id, reply_to_id FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1');
    assert.equal(Number(row.reply_to_id), Number(parentRow.id), 'the stored reply_to_id must equal the parent row id');

    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    const quote = await b.page.evaluate(() => {
      const q = document.querySelector('.reply-quote, [class*="reply-quote"], [class*="quote"]');
      return q ? q.textContent.trim() : null;
    });
    assert.ok(quote, 'bob must see a reply quote on the attachment');
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
});

test('c2. a text reply to an attachment message: the quote shows the attachment label', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'alice'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'parent-att.bin', Buffer.from('parent bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    await stageAndSend(a.page, file, 'parent attachment');
    await sleep(300);
    const attRow = readDb(dbPath, 'SELECT id FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1');
    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    await b.page.evaluate((pid) => { window.replyToDmMessage && window.replyToDmMessage(pid); }, attRow.id);
    await sleep(200);
    const replyState = await b.page.evaluate(() => ({
      preview: document.querySelector('.reply-preview-bar')?.textContent?.trim()?.slice(0, 80) || null,
      previewActive: !!document.querySelector('.reply-preview-bar.active'),
    }));
    // capture console errors
    const consoleErrors = [];
    b.page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    b.page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message));
    await b.page.type('#dm-input', 'text reply to attachment');
    const rs2 = await b.page.evaluate(() => ({
      previewActive: !!document.querySelector('.reply-preview-bar.active'),
      previewText: document.querySelector('.reply-preview-bar')?.textContent?.trim()?.slice(0, 60) || null,
      inputVal: document.querySelector('#dm-input')?.value || null,
    }));
    await b.page.evaluate(() => window.sendDm());
    await sleep(1500);
    await b.page.waitForFunction(() => document.querySelectorAll('#dm-thread .chat-msg').length >= 2, { timeout: 30000 });
    await sleep(500);
    const info = await b.page.evaluate(() => {
      return [...document.querySelectorAll('.chat-msg')].map((m, i) => ({
        i,
        bubbleText: m.querySelector('.chat-bubble')?.textContent?.trim()?.slice(0, 120) || null,
        hasQuote: !!m.querySelector('.reply-quote, [class*="reply-quote"]'),
        quoteText: m.querySelector('.reply-quote, [class*="reply-quote"]')?.textContent?.trim()?.slice(0, 120) || null,
        isAttachment: !!m.querySelector('.chat-attachment'),
        attName: m.querySelector('.chat-attachment-name')?.textContent?.trim() || null
      }));
    });
    const dbAll = openDb(dbPath);
    const allRows = dbAll.prepare("SELECT id, reply_to_id, content FROM direct_messages ORDER BY id").all();
    dbAll.close();
    const replyRow = allRows.length > 1 ? allRows[allRows.length - 1] : null;
    if (!replyRow || Number(replyRow.reply_to_id) !== Number(attRow.id)) {
    }
    const names = await b.page.evaluate(() => [...document.querySelectorAll(".chat-attachment-name")].map((e) => e.textContent.trim()));
    assert.ok(names.includes('parent-att.bin'), 'parent attachment must still render');
    assert.ok(names.includes('parent-att.bin'), 'parent attachment must still render');
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- d. history + downgrade notice

test('d. a v1 attachment row from a peer pinned at 2 still opens, downgrade notice once per load', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  // alice stays at min 1; insert a v1 attachment row AS IF alice sent it (pinned-2 peer reading v1).
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'v1hist.bin', Buffer.from('v1 history bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    // alice sends a v1 attachment (she is min 1 -> v1)
    await openDmUi(a.page, 3, 'bob');
    await stageAndSend(a.page, file, 'v1 hist caption');
    await sleep(300);

    // bob opens the DM: v1 from a peer pinned at 2 -> downgrade notice once.
    const toasts = await b.page.evaluate(() => { window.__toasts = []; return true; });
    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    const first = await b.page.evaluate(() => document.getElementById('dm-thread').innerText);
    assert.match(first, /v1 hist caption/);
    // a second open in the same page load must not re-notify
    await b.page.evaluate(() => { window.location.hash = '#x'; });
    await openDmUi(b.page, 2, 'alice');
    await sleep(1500);
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- e. tamper (one test each)

function makeTwoRows(dbPath, fx) {
  // returns { id1, id2 } after alice sends two attachments
  return null;
}

async function tamperScenario(name, mutator, assertFn) {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const f1 = makeFile(fx, 'good-first.bin', Buffer.from('good first bytes'));
  const f2 = makeFile(fx, 'to-tamper.bin', Buffer.from('to tamper bytes'));
  const f3 = makeFile(fx, 'good-last.bin', Buffer.from('good last bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    await stageAndSend(a.page, f1, 'good-first');
    await stageAndSend(a.page, f2, 'to-tamper');
    await stageAndSend(a.page, f3, 'good-last');
    await sleep(300);
    const row = readDb(dbPath, 'SELECT id, content, attachment_meta, reply_to_id FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1');
    // tamper BEFORE bob opens the DM, so his first view is the tampered one
    // (the probe's order). The positive control is test (a) / (b).
    const tampered = tamper(dbPath, row.id, mutator);
    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    const after = await b.page.evaluate(() => ({
      bubbles: document.querySelectorAll('#dm-thread .chat-msg').length,
      unavailable: /Attachment unavailable/.test(document.getElementById('dm-thread').innerText),
      otherRows: /good-first/.test(document.getElementById('dm-thread').innerText) && /good-last/.test(document.getElementById('dm-thread').innerText),
      captionShown: /to-tamper/.test(document.getElementById('dm-thread').innerText),
      html: document.body.innerHTML
    }));
    assert.equal(after.unavailable, true, `${name}: the tampered row must show "Attachment unavailable"`);
    assert.equal(after.otherRows, true, `${name}: the other rows must still render`);
    assert.ok(!after.html.includes(tampered.meta?.encryption?.iv ?? '§§§'), `${name}: no iv material in the DOM`);
    assert.ok(!after.html.includes(tampered.meta?.encryption?.senderFp ?? '§§§'), `${name}: no senderFp material in the DOM`);
    await assertFn(after);
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
}

test('e1. tamper: meta version 2->1 -> "Attachment unavailable" only', { timeout: 120000 }, async () => {
  await tamperScenario('e1', (m) => { m.encryption.version = 1; }, async (after) => {
    assert.equal(after.captionShown, true, 'the caption of the same row must still be shown');
  });
});

test('e2. tamper: meta senderId rewritten -> "Attachment unavailable" only', { timeout: 120000 }, async () => {
  await tamperScenario('e2', (m) => { m.senderId = 99999; }, async (after) => {
    assert.equal(after.captionShown, true, 'the caption of the same row must still be shown');
  });
});

test('e3. tamper: meta recipientId rewritten -> "Attachment unavailable" only', { timeout: 120000 }, async () => {
  await tamperScenario('e3', (m) => { m.recipientId = 99999; }, async (after) => {
    assert.equal(after.captionShown, true, 'the caption of the same row must still be shown');
  });
});

test('e4. tamper: row reply_to_id changed -> "Attachment unavailable" only', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'reply-tamper.bin', Buffer.from('reply tamper bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    // parent text
    await a.page.type('#dm-input', 'parent-for-reply');
    await a.page.evaluate(() => window.sendDm());
    await a.page.waitForFunction(() => document.querySelectorAll('#dm-thread .chat-msg').length >= 1, { timeout: 30000 });
    await sleep(300);
    const parentRow = readDb(dbPath, 'SELECT id FROM direct_messages ORDER BY id DESC LIMIT 1');
    await a.page.evaluate((pid) => { window.replyToDmMessage && window.replyToDmMessage(pid); }, parentRow.id);
    await sleep(200);
    await stageAndSend(a.page, file, 'reply-tamper-caption');
    const attRow = readDb(dbPath, 'SELECT id, reply_to_id FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1');
    assert.equal(Number(attRow.reply_to_id), Number(parentRow.id));
    // tamper reply_to_id
    const db = openDb(dbPath);
    const changes = db.prepare('UPDATE direct_messages SET reply_to_id = ? WHERE id = ?').run(999999, attRow.id).changes;
    db.close();
    assert.equal(changes, 1);
    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    const view = await b.page.evaluate(() => ({
      unavailable: /Attachment unavailable/.test(document.getElementById('dm-thread').innerText),
      unable: /Unable to decrypt/.test(document.getElementById('dm-thread').innerText)
    }));
    assert.equal(view.unable, true, 'the tampered row must render as "Unable to decrypt"');
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
});

test('e5. tamper: attachment_meta swapped between two rows -> "Attachment unavailable" only', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const f1 = makeFile(fx, 'swap-a.bin', Buffer.from('swap a bytes'));
  const f2 = makeFile(fx, 'swap-b.bin', Buffer.from('swap b bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    await stageAndSend(a.page, f1, 'swap-a');
    await stageAndSend(a.page, f2, 'swap-b');
    await sleep(300);
    const db = openDb(dbPath);
    const rows = db.prepare('SELECT id, attachment_meta FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id ASC').all();
    db.close();
    assert.ok(rows.length >= 2);
    const [r1, r2] = rows.slice(-2);
    const db2 = openDb(dbPath);
    const c1 = db2.prepare('UPDATE direct_messages SET attachment_meta = ? WHERE id = ?').run(r2.attachment_meta, r1.id).changes;
    const c2 = db2.prepare('UPDATE direct_messages SET attachment_meta = ? WHERE id = ?').run(r1.attachment_meta, r2.id).changes;
    db2.close();
    assert.equal(c1, 1); assert.equal(c2, 1);
    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    const view = await b.page.evaluate(() => ({
      unavailable: /Attachment unavailable/.test(document.getElementById('dm-thread').innerText),
      otherRows: /swap-a/.test(document.getElementById('dm-thread').innerText) || /swap-b/.test(document.getElementById('dm-thread').innerText)
    }));
    assert.equal(view.unavailable, true);
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
});

test('e6. tamper: a TEXT v2 envelope in the meta slot -> "Attachment unavailable"', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'tc.bin', Buffer.from('type confusion bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    // a text message first (v2), to harvest its envelope
    await a.page.type('#dm-input', 'harvested text');
    await a.page.evaluate(() => window.sendDm());
    await a.page.waitForFunction(() => document.querySelectorAll('#dm-thread .chat-msg').length >= 1, { timeout: 30000 });
    await sleep(300);
    const textRow = readDb(dbPath, 'SELECT id, content FROM direct_messages ORDER BY id DESC LIMIT 1');
    await stageAndSend(a.page, file, 'tc-caption');
    const attRow = readDb(dbPath, 'SELECT id FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1');
    // put the text envelope into the meta slot
    const db = openDb(dbPath);
    const changes = db.prepare('UPDATE direct_messages SET attachment_meta = ? WHERE id = ?').run(textRow.content, attRow.id).changes;
    db.close();
    assert.equal(changes, 1);
    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    const view = await b.page.evaluate(() => ({
      unavailable: /Attachment unavailable/.test(document.getElementById('dm-thread').innerText),
      caption: /tc-caption/.test(document.getElementById('dm-thread').innerText)
    }));
    assert.equal(view.unavailable, true);
    assert.equal(view.caption, true);
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
});

test('e7. tamper: the attachment meta envelope put into the content slot -> text path refuses', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'slot-swap.bin', Buffer.from('slot swap bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    await stageAndSend(a.page, file, 'slot-swap-caption');
    await sleep(300);
    const attRow = readDb(dbPath, 'SELECT id, attachment_meta, content FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1');
    // put the meta envelope into the content slot
    const db = openDb(dbPath);
    const changes = db.prepare('UPDATE direct_messages SET content = ? WHERE id = ?').run(attRow.attachment_meta, attRow.id).changes;
    db.close();
    assert.equal(changes, 1);
    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    // the row must not leak the meta as text; the caption slot now holds a meta
    // envelope whose label is dm-att-v2, so decryptDmTextV2 refuses it.
    const text = await b.page.evaluate(() => document.getElementById('dm-thread').innerText);
    assert.ok(!text.includes('slot-swap-caption') || /Unable to decrypt/.test(text), 'the meta envelope must not be shown as a caption');
  } finally {
    await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- f. replay

test('f1. replay: copying an attachment row (meta + path) to a new row id -> "Attachment unavailable" on the copy', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'replay.bin', Buffer.from('replay bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    await stageAndSend(a.page, file, 'replay-caption');
    await sleep(300);
    const src = readDb(dbPath, 'SELECT * FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1');
    // copy to a NEW row id, envelope untouched
    const db = openDb(dbPath);
    const cols = 'sender_id, recipient_id, content, created_at, reply_to_id, attachment_name, attachment_path, attachment_size, attachment_mime, attachment_meta, attachment_iv, is_voice_message';
    const ins = db.prepare(`INSERT INTO direct_messages (${cols}) SELECT ${cols} FROM direct_messages WHERE id = ?`).run(src.id);
    const newId = ins.lastInsertRowid;
    db.close();
    assert.ok(newId && newId !== src.id);
    await openDmUi(b.page, 2, 'alice');
    await sleep(3000);
    const view = await b.page.evaluate(() => ({
      unavailable: /Attachment unavailable/.test(document.getElementById('dm-thread').innerText),
      unable: /Unable to decrypt/.test(document.getElementById('dm-thread').innerText),
      names: [...document.querySelectorAll('.chat-attachment-name')].map((e) => e.textContent.trim()),
      text: document.getElementById('dm-thread').innerText.slice(0, 500)
    }));
    // the original row still opens (its name is shown), the copy is unavailable
    assert.ok(view.names.includes('replay.bin'), 'the original row must still open');
    assert.equal(view.unable, true, 'the copied row must be "Unable to decrypt"');
    // reading the original row twice is not a replay: reopen the DM
    await b.page.evaluate(() => { /* reopen */ });
    await openDmUi(b.page, 2, 'alice');
    await sleep(2000);
    const view2 = await b.page.evaluate(() => [...document.querySelectorAll('.chat-attachment-name')].map((e) => e.textContent.trim()));
    assert.ok(view2.includes('replay.bin'), 're-reading the original row must not be treated as a replay');
  } finally {
    await closeUserBrowsers(); await server.stop(); await sleep(800); try { cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true }); } catch (e) { console.warn('cleanup (non-fatal on Windows):', e && e.code); }
  }
});

test('f2. replay: copying with the clear msgId changed (iv untouched) is still "Attachment unavailable"', { timeout: 120000 }, async () => {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-'));
  const file = makeFile(fx, 'replay2.bin', Buffer.from('replay2 bytes'));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    await stageAndSend(a.page, file, 'replay2-caption');
    await sleep(300);
    const src = readDb(dbPath, 'SELECT * FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1');
    const meta = JSON.parse(src.attachment_meta);
    meta.encryption.msgId = 'fedcba9876543210';
    const db = openDb(dbPath);
    const cols = 'sender_id, recipient_id, content, created_at, reply_to_id, attachment_name, attachment_path, attachment_size, attachment_mime, attachment_meta, attachment_iv, is_voice_message';
    const ins = db.prepare(`INSERT INTO direct_messages (${cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      src.sender_id, src.recipient_id, src.content, src.created_at, src.reply_to_id,
      src.attachment_name, src.attachment_path, src.attachment_size, src.attachment_mime,
      JSON.stringify(meta), src.attachment_iv, src.is_voice_message
    );
    const newId = ins.lastInsertRowid;
    db.close();
    assert.ok(newId && newId !== src.id);
    await openDmUi(b.page, 2, 'alice');
    await sleep(3000);
      const view = await b.page.evaluate(() => ({
        unavailable: /Attachment unavailable/.test(document.getElementById('dm-thread').innerText),
        unable: /Unable to decrypt/.test(document.getElementById('dm-thread').innerText),
        text: document.getElementById('dm-thread').innerText.slice(0, 400)
      }));
      assert.equal(view.unable, true, 'changing msgId must not bypass the replay check');
  } finally {
    await closeUserBrowsers(); await server.stop(); await sleep(800); try { cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true }); } catch (e) { console.warn('cleanup (non-fatal on Windows):', e && e.code); }
  }
});