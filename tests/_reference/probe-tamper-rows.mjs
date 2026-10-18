import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRealServer, newUserPage, closeUserBrowsers, openDmUi, ROOT } from './_acceptance-harness.mjs';
import { Database, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(page, origin, u, p) {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth-username', { timeout: 30000 });
  await page.type('#auth-username', u); await page.type('#auth-password', p);
  await page.click('#auth-form button');
  await page.waitForSelector('.nav-link', { timeout: 60000 });
  await sleep(500);
}
async function sendOne(page, text) {
  const n0 = await page.$$eval('#dm-thread .chat-msg', (e) => e.length);
  await page.type('#dm-input', text); await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#dm-thread .chat-msg').length > n, { timeout: 30000 }, n0);
  await page.waitForFunction(() => document.getElementById('dm-input').value === '', { timeout: 15000 });
  await sleep(300);
}
const MUT = {
  flipCipher: (o) => { const c = o.encryption.ciphertext; o.encryption.ciphertext = (c[5] === 'A' ? 'B' : 'A').concat('') && c.slice(0,5) + (c[5] === 'A' ? 'B' : 'A') + c.slice(6); return null; },
  stripVersion: (o) => { o.encryption.version = 1; return null; },
  replyTo: (o) => 1,
};
async function runCase(name) {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db');
  fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass');
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    for (const t of ['first-msg', 'second-msg', 'third-msg']) await sendOne(a.page, t);
    await openDmUi(b.page, 2, 'alice');
    await b.page.waitForFunction(() => /third-msg/.test(document.body.innerText), { timeout: 30000 });
    // tamper middle row
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT id, content, reply_to_id FROM direct_messages ORDER BY id').all();
    const mid = rows[1];
    const o = JSON.parse(mid.content);
    const newReply = MUT[name](o);
    const res = db.prepare('UPDATE direct_messages SET content = ?, reply_to_id = COALESCE(?, reply_to_id) WHERE id = ?').run(JSON.stringify(o), newReply, mid.id);
    const back = db.prepare('SELECT content, reply_to_id FROM direct_messages WHERE id = ?').get(mid.id);
    db.close();
    // what bob's API returns
    const apiRows = await b.page.evaluate(async () => { const t = sessionStorage.getItem('token') || localStorage.getItem('token'); return null; });
    // bob re-login, fresh page
    const logs = [];
    b.page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text().slice(0, 160)); });
    await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(b.page, 2, 'alice');
    await sleep(3000);
    const view = await b.page.evaluate(() => ({ bubbles: document.querySelectorAll('#dm-thread .chat-msg').length, text: document.getElementById('dm-thread').innerText.replace(/\s+/g, ' ').slice(0, 300) }));
    console.log(`PROBE ${name}: changes=${res.changes} idMid=${mid.id} rowsTotal=${rows.length} contentChanged=${back.content !== mid.content} replyNow=${back.reply_to_id} -> bubbles=${view.bubbles} text="${view.text}" logs=${JSON.stringify(logs).slice(0, 400)}`);
  } finally { await closeUserBrowsers(); await server.stop(); cleanupTmp(); }
}
for (const n of ['flipCipher', 'stripVersion', 'replyTo']) test(`probe ${n}`, { timeout: 170000 }, () => runCase(n));
