// Reviewer's reference probe (NOT part of the suite: no .test. in the name, so
// scripts/run-tests.mjs does not pick it up). Real server + two real Chromium
// accounts: alice uploads a file with a caption through the composer to bob.
// CASES=none:1,stripMetaVersion:1,flipMetaCipher:1,none:0 (case:optInBobToV2)
// Run: CHROMIUM_DIR=... node --experimental-test-module-mocks --env-file=tests/test.env --test <copy of this file named *.test.mjs>
import { test } from 'node:test';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRealServer, newUserPage, closeUserBrowsers, openDmUi, ROOT } from '../_acceptance-harness.mjs';
import { Database, cleanupTmp, tmpDir, FIXTURE_DB } from '../credentials/_fixture.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(page, origin, u, p) {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth-username', { timeout: 30000 });
  await page.type('#auth-username', u); await page.type('#auth-password', p);
  await page.click('#auth-form button');
  await page.waitForSelector('.nav-link', { timeout: 60000 }); await sleep(500);
}
const MUT = {
  none: () => null,
  stripMetaVersion: (m) => { m.encryption.version = 1; },
  flipMetaCipher: (m) => { const c = m.encryption.ciphertext; m.encryption.ciphertext = c.slice(0, 5) + (c[5] === 'A' ? 'B' : 'A') + c.slice(6); },
};
async function run(name, optin) {
  const dir = tmpDir(); const dbPath = path.join(dir, 'wire.db'); fs.copyFileSync(FIXTURE_DB, dbPath);
  const { runMigrations } = await import('../../database/migrations.js');
  const d0 = new Database(dbPath); runMigrations(d0); d0.close();
  if (optin) spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs'), 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  const server = await startRealServer({ work: dir, extraEnv: { DB_PATH: dbPath } });
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'attfx-')); const file = path.join(fx, 'probe-notes.txt'); fs.writeFileSync(file, 'attachment body probe\n'.repeat(30));
  try {
    const a = await newUserPage(); const b = await newUserPage();
    await login(a.page, server.origin, 'alice', 'alice-legacy-pass'); await login(b.page, server.origin, 'bob', 'bob-legacy-pass');
    await openDmUi(a.page, 3, 'bob');
    const before = await a.page.$$eval('#dm-thread .chat-msg', (e) => e.length);
    await (await a.page.$('#dm-file-input')).uploadFile(file);
    await a.page.waitForSelector('#dm-attach-staging .attach-chip', { timeout: 10000 });
    await a.page.type('#dm-input', 'caption-probe-text');
    await a.page.evaluate(() => window.sendDm());
    await a.page.waitForFunction((n) => document.querySelectorAll('#dm-thread .chat-msg').length > n, { timeout: 30000 }, before);
    await sleep(800);
    const db = new Database(dbPath);
    // NOTE: SELECT id, then UPDATE ... WHERE id = ? and assert changes === 1.
    const row = db.prepare('SELECT id, content, attachment_meta, reply_to_id FROM direct_messages WHERE attachment_meta IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    const metaV = JSON.parse(row.attachment_meta).encryption.version; const capV = JSON.parse(row.content).encryption.version;
    let changes = '-';
    if (name !== 'none') {
      const m = JSON.parse(row.attachment_meta); MUT[name](m);
      changes = db.prepare('UPDATE direct_messages SET attachment_meta = ? WHERE id = ?').run(JSON.stringify(m), row.id).changes;
    }
    db.close();
    await openDmUi(b.page, 2, 'alice');
    await sleep(2500);
    const view = await b.page.evaluate(() => {
      const t = document.getElementById('dm-thread').innerText;
      return { bubbles: document.querySelectorAll('#dm-thread .chat-msg').length,
               names: [...document.querySelectorAll('.chat-attachment-name')].map((e) => e.textContent.trim()),
               caption: /caption-probe-text/.test(t), unavailable: /Attachment unavailable/.test(t) };
    });
    console.log(`ATTPROBE ${name} optin=${optin}: storedMeta=v${metaV} storedCaption=v${capV} changes=${changes} -> bubbles=${view.bubbles} captionShown=${view.caption} unavailable=${view.unavailable} names=${JSON.stringify(view.names)}`);
  } finally { await closeUserBrowsers(); await server.stop(); cleanupTmp(); fs.rmSync(fx, { recursive: true, force: true }); }
}
const CASES = (process.env.CASES || 'none:1,stripMetaVersion:1,flipMetaCipher:1,none:0').split(',');
for (const c of CASES) { const [n, o] = c.split(':'); test(`att ${c}`, { timeout: 100000 }, () => run(n, o === '1')); }
