// EXPERIMENT (not a test - deliberately outside tests/ so run-tests.mjs never
// picks it up).
//
// Question: when does the one-time credential migration flip auth_scheme from 1
// to 2, relative to the moment the app UI appears?
//
// The client's order is:
//   renderAuthCard -> await initializeIdentity(password, onSuccess)
//     -> await migrateLegacyAccount(...)   (public/js/core/auth.js:418)
//     -> await onSuccess()                 (public/js/core/auth.js:505)
// and onSuccess is what renders the app. Reading the code says the migration
// always finishes BEFORE `.nav-link` can exist. This script measures it
// instead of assuming, by polling the database directly.
//
// READ-ONLY with respect to server code: it only registers a user, logs in
// through the real form, and SELECTs auth_scheme. Nothing in the product is
// changed or stubbed.
//
// Usage (Linux, with Chromium available in CHROMIUM_DIR, default /tmp/browser-check):
//   node scripts/experiments/migration-timing.mjs
//
// It prints exactly one line:
//   auth_scheme became 2 BEFORE|AFTER .nav-link by N ms

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

// reuse the acceptance harness so the server and browser are started exactly the
// way the real tests start them
const harness = await import(
  pathToFileURL(path.join(ROOT, 'tests', '_acceptance-harness.mjs')).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 20;

function readScheme(dbPath, username) {
  // a short-lived read-only connection; never held across polls
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT auth_scheme FROM users WHERE username = ?').get(username);
    return row ? Number(row.auth_scheme) : null;
  } finally {
    db.close();
  }
}

let server, browser;
try {
  server = await harness.startRealServer();
  const username = `mt${Date.now().toString(36)}`;

  await harness.registerUser(server.origin, username);

  const before = readScheme(server.dbPath, username);
  console.error(`registered ${username}; auth_scheme before login = ${before}`);

  // launchBrowser() returns { browser, reason }; reason is set when Chromium
  // is unavailable. Using the object directly gives `browser.newPage is not a
  // function` and then hangs until the tool timeout, so fail fast instead.
  const launched = await harness.launchBrowser();
  browser = launched.browser;
  if (!browser) throw new Error(`Chromium unavailable: ${launched.reason}`);

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  // start polling BEFORE submitting, so nothing is missed
  let migratedAt = null;
  let polling = true;
  const poll = (async () => {
    while (polling) {
      try {
        const s = readScheme(server.dbPath, username);
        if (s === 2 && migratedAt === null) migratedAt = performance.now();
      } catch { /* the server may be mid-write; retry on the next tick */ }
      await sleep(POLL_MS);
    }
  })();

  // the real login form, driven exactly as a user would
  await page.goto(`${server.origin}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${server.origin}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth-username');
  await page.type('#auth-username', username);
  await page.type('#auth-password', harness.PASSWORD);

  const submittedAt = performance.now();
  await page.click('#auth-form button');
  await page.waitForSelector('.nav-link', { timeout: 30000 });
  const navAt = performance.now();

  // give the poll a fair chance to see the flip after the UI appeared
  const deadline = Date.now() + 5000;
  while (migratedAt === null && Date.now() < deadline) await sleep(POLL_MS);
  polling = false;
  await poll;

  if (migratedAt === null) {
    console.error('auth_scheme never became 2 within 5s of the UI appearing');
    console.log('auth_scheme became 2 NEVER within 5000 ms of .nav-link');
    process.exitCode = 1;
  } else {
    const delta = migratedAt - navAt; // negative => BEFORE
    const when = delta < 0 ? 'BEFORE' : 'AFTER';
    console.log(
      `auth_scheme became 2 ${when} .nav-link by ${Math.abs(Math.round(delta))} ms ` +
      `(submit->nav ${Math.round(navAt - submittedAt)} ms, submit->flip ${Math.round(migratedAt - submittedAt)} ms)`
    );
  }

  const after = readScheme(server.dbPath, username);
  console.error(`auth_scheme after login = ${after}`);
} catch (e) {
  console.error('experiment failed:', e?.stack || e);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await server?.stop(); } catch { /* ignore */ }
  try { fs.rmSync(server?.work, { recursive: true, force: true }); } catch { /* ignore */ }
}