// tests/dm-csp-handlers-enforced-browser.test.mjs
//
// The DM "Send" button and the message "Delete" button used to be inline
// onclick="" handlers, which a strict CSP blocks. They are now delegated
// listeners (data-action="dm-send" / "dm-delete"). This drives the REAL
// app (the real server.js as a child process, real middleware/csp.js,
// real public/ assets) in REAL headless Chromium, with real mouse clicks,
// and asserts on SERVER STATE (the SQLite file), not on the DOM:
//
//   * Send creates a direct_messages row; Delete removes it
//   * under CSP_ENFORCE=true AND CSP_ENFORCE=false (identical behaviour)
//   * Send is attached once per conversation: after opening several
//     conversations one after the other, ONE click sends exactly ONE message
//   * Delete still resets the double-tap state (lastTap): a touch tap on the
//     bubble, a touch tap on Delete, then a second touch tap on the bubble
//     must NOT count as a double-tap (no reaction picker)
//   * negative control: a control that is still an inline handler (Attach)
//     raises a script-src-attr violation under enforcement, so a pass here
//     cannot be vacuous
//
// Needs Chromium (@sparticuz/chromium + puppeteer-core in CHROMIUM_DIR,
// default /tmp/browser-check). Without it the tests are SKIPPED and
// reported as BLOCKED, never as passed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { listenAvoidingBlockedPorts } from './_port.mjs';
import { makeServerDirs, serverEnv } from './_acceptance-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CHROMIUM_DIR = process.env.CHROMIUM_DIR || '/tmp/browser-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchBrowser() {
  try {
    const req = createRequire(path.join(CHROMIUM_DIR, 'noop.js'));
    const chromium = (await import(pathToFileURL(req.resolve('@sparticuz/chromium')).href)).default;
    const puppeteer = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
    return {
      launch: async () => puppeteer.launch({
        // headless Chromium reports (hover: none): without hover capability
        // the message actions only open via touch taps. Report a desktop
        // mouse (hover + fine pointer) so a real mouse hover reveals Delete.
        args: [...chromium.args, '--no-sandbox',
          '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'],
        executablePath: await chromium.executablePath(),
        headless: 'shell',
      }),
      reason: null,
    };
  } catch (e) {
    return { launch: null, reason: e.message };
  }
}

// Not a bare listen(0) on the real server: this file spawns a child that reads
// PORT from the environment, so the port is probed here first. The shared
// helper guarantees the probe can never return a port fetch() refuses.
async function freePort() {
  return listenAvoidingBlockedPorts(
    () => new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    })
  );
}

async function startRealServer(cspEnforce) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-dm-csp-'));
  const port = await freePort();
  // This file deliberately boots the server with a MINIMAL env (PATH only), so
  // `base` stays that way; only the eight dir vars come from the shared helper.
  // It previously set six of the eight, so GROUP_UPLOAD_DIR and BANNER_DIR fell
  // back to the repo root and were created there on every full run.
  const dirs = makeServerDirs(dir);
  const env = serverEnv({
    dirs,
    port,
    base: { PATH: process.env.PATH },
    csp: cspEnforce ? 'true' : 'false',
    extraEnv: { GROUPS_ENABLED: 'false' },
  });
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const origin = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      const res = await fetch(origin + '/');
      if (res.status === 200) break;
    } catch { /* not up yet */ }
    await sleep(500);
  }

  const Database = require('better-sqlite3');
  const query = (sql, ...params) => {
    const db = new Database(env.DB_PATH, { readonly: true, fileMustExist: true });
    try { return db.prepare(sql).all(...params); } finally { db.close(); }
  };

  return {
    origin,
    query,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for: ${label}`);
    await sleep(150);
  }
}

async function signUp(browser, origin, username, { recordCsp = false } = {}) {
  // browser.newPage() is correct here: the caller already gives every account
  // its OWN browser process via open(), and a page in a dedicated process is
  // the isolation this file needs. Creating a second context in that process
  // would not survive @sparticuz/chromium's --single-process --no-zygote.
  const page = await browser.newPage();
  // the driven user gets touch support so a real touch tap can open the
  // message action bar (the same path a phone user takes)
  await page.setViewport({ width: 1280, height: 800, hasTouch: recordCsp });
  if (recordCsp) {
    await page.evaluateOnNewDocument(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__csp.push({ directive: e.violatedDirective, disposition: e.disposition });
      });
    });
  }
  const response = await page.goto(origin + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#auth-username', { timeout: 20000 });
  if (!(await page.$('#auth-password-confirm'))) { await page.click('#switch-auth'); await sleep(400); }
  const pw = 'dm-csp-test-passphrase-long-enough-1';
  await page.type('#auth-username', username);
  if (await page.$('#auth-email')) await page.type('#auth-email', `${username}@example.test`);
  await page.type('#auth-password', pw);
  await page.type('#auth-password-confirm', pw);
  await page.click('#auth-form button');
  await page.waitForSelector('#nav-links > *', { timeout: 40000 });
  await sleep(2000);
  return { page, headers: response.headers() };
}

const clickNav = (page, source) => page.evaluate((src) => {
  const el = [...document.querySelectorAll('#nav-links > *')].find((e) => new RegExp(src, 'i').test(e.textContent));
  if (el) el.click();
  return !!el;
}, source);

async function openConversation(page, username) {
  await clickNav(page, 'messages');
  await page.waitForSelector('#new-chat-fab', { timeout: 15000 });
  await page.click('#new-chat-fab');
  await page.waitForSelector('#new-chat-menu [data-fab-action="message"]');
  await page.click('#new-chat-menu [data-fab-action="message"]');
  await page.waitForSelector(`.dm-picker-row[data-username="${username}"]`, { timeout: 15000 });
  await page.click(`.dm-picker-row[data-username="${username}"]`);
  await page.waitForSelector('#dm-input', { timeout: 15000 });
  await sleep(800);
}

const confirmVisible = (page, id) => page.waitForFunction(
  (i) => { const el = document.getElementById(i); return !!el && el.offsetParent !== null; },
  { timeout: 10000 }, id);

async function scenario(t, cspEnforce) {
  const b = await launchBrowser();
  if (!b.launch) {
    t.skip(`BLOCKED: no Chromium available (${b.reason})`);
    return;
  }

  const server = await startRealServer(cspEnforce);
  const browsers = [];
  try {
    const tag = String(Date.now() % 1000000);
    const names = { a: `dmcspa${tag}`, b: `dmcspb${tag}`, c: `dmcspc${tag}` };
    const open = async () => { const br = await b.launch(); browsers.push(br); return br; };

    // B and C only have to exist (their public keys are needed to encrypt).
    for (const n of [names.b, names.c]) {
      const br = await open();
      await signUp(br, server.origin, n);
      await br.close();
    }
    const br = await open();
    const { page, headers } = await signUp(br, server.origin, names.a, { recordCsp: true });

    // ---- the policy really is enforced / report-only as configured ----
    if (cspEnforce) {
      assert.ok(headers['content-security-policy'], 'enforced CSP header present');
      assert.equal(headers['content-security-policy-report-only'], undefined);
    } else {
      assert.ok(headers['content-security-policy-report-only'], 'report-only CSP header present');
      assert.equal(headers['content-security-policy'], undefined);
    }

    const id = (n) => server.query('SELECT id FROM users WHERE username = ?', n)[0].id;
    const aId = id(names.a); const bId = id(names.b); const cId = id(names.c);
    const dmRows = (to) => server.query(
      'SELECT id FROM direct_messages WHERE sender_id = ? AND recipient_id = ? ORDER BY id', aId, to);
    const violations = () => page.evaluate(() => window.__csp.slice());
    const attrViolations = async () => (await violations()).filter((v) => v.directive.startsWith('script-src-attr'));

    const sendOneByClick = async (text) => {
      await page.click('#dm-input');
      await page.type('#dm-input', text);
      const before = await attrViolations();
      await page.click('#dm-input-area .btn-send'); // real mouse click, no Enter key
      return before.length;
    };

    // ---- 1. Send via the button: one click, one row (conversation B) ----
    await openConversation(page, names.b);
    const attrBefore = await sendOneByClick('first message to B');
    await waitFor(() => dmRows(bId).length >= 1, 'a DM row for B after clicking Send');
    await sleep(800);
    assert.equal(dmRows(bId).length, 1, 'exactly one message after one Send click');
    assert.equal((await attrViolations()).length, attrBefore, 'Send raises no script-src-attr violation');

    // ---- 2. several conversations in a row: one click still sends ONE ----
    await openConversation(page, names.c);
    await sendOneByClick('hello C');
    await waitFor(() => dmRows(cId).length >= 1, 'a DM row for C');
    await sleep(800);
    assert.equal(dmRows(cId).length, 1, 'one click in the second conversation sends exactly one message');
    assert.equal(dmRows(bId).length, 1, 'nothing was sent to B by the click in the C conversation');

    await openConversation(page, names.b);
    await sendOneByClick('second message to B');
    await waitFor(() => dmRows(bId).length >= 2, 'the second DM row for B');
    await sleep(800);
    assert.equal(dmRows(bId).length, 2, 'back in B: one click, exactly one more message');
    assert.equal(dmRows(cId).length, 1, 'C unchanged');

    // ---- 3. Delete keeps resetting the double-tap state ----
    const [victim] = dmRows(bId);
    const sel = `#dm-messages .chat-msg[data-msg-id="${victim.id}"]`;
    await page.waitForSelector(sel, { timeout: 15000 });
    const pickerCalls = await page.evaluate((rowSel) => {
      const row = document.querySelector(rowSel);
      const bubble = row.querySelector('.chat-bubble');
      const del = row.querySelector('.chat-msg-delete');
      window.__pickerCalls = [];
      window.openReactionPicker = (...args) => window.__pickerCalls.push(args);
      const r = bubble.getBoundingClientRect();
      const at = { clientX: r.left + 6, clientY: r.top + 6 };
      const tap = (el) => el.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, pointerType: 'touch', ...at }));
      tap(bubble); // first tap on the bubble: arms a possible double-tap
      tap(del);    // touch tap on Delete: must reset that state
      tap(bubble); // second tap on the bubble, well inside the 300 ms window
      return window.__pickerCalls.length;
    }, sel);
    assert.equal(pickerCalls, 0, 'a tap on Delete in between means the next bubble tap is NOT a double-tap');
    await confirmVisible(page, 'confirm-modal-cancel');
    // The dialog's own OK/Cancel buttons are inline onclick="" in index.html
    // (not part of this change; blocked under enforcement), so it is
    // settled through the hook those buttons call.
    await page.evaluate(() => window.__confirmModalCancel());
    await sleep(500);
    assert.equal(await page.evaluate(() => document.getElementById('confirm-modal-ok').offsetParent !== null), false, 'dialog closed');
    assert.equal(dmRows(bId).length, 2, 'cancelling the confirm dialog deletes nothing');

    // ---- 4. Delete via a real click + confirm removes the row ----
    // A real touch tap on the bubble opens the action bar (armed after the
    // double-tap window); then Delete takes a real mouse click.
    const attrBeforeDelete = (await attrViolations()).length;
    const box = await (await page.$(`${sel} .chat-bubble`)).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector(`${sel}.is-actions-armed`, { timeout: 10000 });
    await page.click(`${sel} .chat-msg-delete`);
    await confirmVisible(page, 'confirm-modal-ok'); // the delegated Delete handler ran and opened the dialog
    assert.equal((await attrViolations()).length, attrBeforeDelete, 'the Delete click itself raised no script-src-attr violation');
    if (cspEnforce) {
        // The confirm modal is NOT an inline-handler control any more: it was
        // converted to data-action + one delegated listener in
        // public/js/ui/confirm.js, so its OK button carries no on*= attribute.
        // Under enforcement a real click must therefore WORK, not be blocked.
        //
        // This block is the regression guard in both directions: the DOM
        // assertion fails if an inline on* attribute is put back on the modal;
        // and if one were re-added, enforcement would block the click, raising
        // a script-src-attr violation (failing the next assert) and leaving the
        // row undeleted (failing the one after that).
        assert.equal(
            await page.evaluate(() => [...document.getElementById('confirm-modal-ok').attributes].some((a) => /^on/i.test(a.name))),
            false,
            'confirm OK must not carry an inline on*= handler attribute'
        );
        const n = (await violations()).filter((v) => v.directive.startsWith('script-src-attr') && v.disposition === 'enforce').length;
        await page.click('#confirm-modal-ok');
        await sleep(400);
        assert.equal((await violations()).filter((v) => v.directive.startsWith('script-src-attr') && v.disposition === 'enforce').length, n, 'confirm OK (a delegated data-action button) raises no script-src-attr violation');
        assert.equal(dmRows(bId).length, 1, 'confirm OK deletes the row even under enforcement');
    } else {
        await page.click('#confirm-modal-ok'); // Report-Only: a real click works
    }
    await waitFor(() => dmRows(bId).length === 1, 'the row to be deleted on the server');
    assert.ok(!dmRows(bId).some((r) => r.id === victim.id), 'the right message was deleted');

    // ---- 5. negative control: a still-inline control is blocked under enforcement ----
    const beforeAttach = (await violations()).filter((v) => v.directive.startsWith('script-src-attr') && v.disposition === 'enforce').length;
    await page.click('#dm-input-area button[title="Attach"]');
    await sleep(500);
    const enforcedAttr = (await violations()).filter((v) => v.directive.startsWith('script-src-attr') && v.disposition === 'enforce').length;
    if (cspEnforce) {
      assert.ok(enforcedAttr > beforeAttach, 'Attach (still an inline onclick) is blocked: expected script-src-attr violation');
    } else {
      assert.equal(enforcedAttr, 0, 'Report-Only never blocks');
    }
  } finally {
    for (const br of browsers) await br.close().catch(() => {});
    await server.stop();
  }
}

test('CSP_ENFORCE=true: DM Send and Delete work with real clicks; Attach is still blocked (negative control)', { timeout: 280000 }, async (t) => {
  await scenario(t, true);
});

test('CSP_ENFORCE=false (Report-Only): identical behaviour, nothing blocked', { timeout: 280000 }, async (t) => {
  await scenario(t, false);
});
