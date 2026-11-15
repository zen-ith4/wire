// tests/dm-verify-ui-browser.test.mjs
//
// Regression (Bug 4): the DM verification UI.
//
// A. Position. The Verify panel (and the key-change banner) opened UNDERNEATH
//    the floating glass header that shows the other participant's avatar, name
//    and status: the header is position:absolute over the top of the thread so
//    the list can scroll under it, and the Phase 2 panels were inserted in the
//    list's normal flow right below it - i.e. at the very top of the thread,
//    under the header. (tests/peer-trust-browser.test.mjs had to dispatch
//    clicks in-page because "the thread's own markup covers the banner".)
//    Asserted here with REAL input clicks and hit-testing at several viewport
//    sizes: every point of the panel's own content must be the panel itself.
//
// B. State. After a successful verification the header button still said
//    "Verify" and looked unverified. It must say "Verified" in the app's
//    success green, survive leaving the conversation and a reload, and never
//    show success for an incomplete, failed or outdated verification - it is
//    driven by the STORED result, not by the click.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startRealServer,
  registerUser,
  newUserPage,
  closeUserBrowsers,
  loginUi,
  sessionFromPage,
  socketConnected,
  openDmUi,
  PASSWORD,
} from './_acceptance-harness.mjs';
import {
  pollUntil,
  cspProbe,
  watchPage,
  cspViolations,
  openThreadByRow,
  leaveAndReturn,
  sendTextViaComposer,
} from './_dm-ui-helpers.mjs';

let server = null;

after(async () => {
  await closeUserBrowsers();
  if (server) await server.stop().catch(() => {});
});

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
];

// ------------------------------------------------------------------ reading

async function verifyButton(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('dm-key-verify-open');
    if (!btn) return null;
    const css = getComputedStyle(btn);
    const green = getComputedStyle(document.documentElement).getPropertyValue('--green').trim();
    return {
      text: btn.textContent.trim(),
      verifiedClass: btn.classList.contains('is-verified'),
      dataVerified: btn.dataset.verified,
      color: css.color,
      borderColor: css.borderTopColor,
      green: `rgb(${green.split(',').map((v) => v.trim()).join(', ')})`,
    };
  });
}

async function readPin(page, peerId) {
  return page.evaluate(async (id) => {
    const { getPeerPin } = await import('/js/crypto/keys/peer-trust.js');
    const { getCurrentUser } = await import('/js/core/auth.js');
    const pin = await getPeerPin(Number(id), { origin: location.origin, ownUserId: Number(getCurrentUser().id) });
    return pin ? { verifiedAt: pin.verifiedAt ?? null, current: pin.current?.fingerprint ?? null } : null;
  }, peerId);
}

async function trustStateOf(page, peerId) {
  return page.evaluate(async (id) => (await import('/js/chat/dm-key-trust.js')).trustState(id), peerId);
}

/** The thread has resolved trust (the button is painted from it after that). */
async function waitTrustResolved(page, peerId) {
  return pollUntil(async () => {
    const s = await trustStateOf(page, peerId);
    return s !== 'unknown' ? s : null;
  }, { timeout: 20000, what: 'the peer key trust state to resolve' });
}

async function waitButton(page, expected, what) {
  return pollUntil(async () => {
    const b = await verifyButton(page);
    return b && b.text === expected ? b : null;
  }, {
    what,
    describe: async () => `button is ${JSON.stringify(await verifyButton(page))}`,
  });
}

async function openPanel(page) {
  await page.click('#dm-key-verify-open'); // real input click
  return pollUntil(
    () => page.evaluate(() => {
      const panel = document.getElementById('dm-key-verify');
      const number = document.getElementById('dm-key-verify-number')?.textContent || '';
      return panel && !panel.hidden && number ? number : null;
    }),
    { what: 'the Verify panel to open with a safety number' }
  );
}

async function panelHidden(page) {
  return page.evaluate(() => document.getElementById('dm-key-verify').hidden);
}

/**
 * Geometry + hit-testing of the open panel. Every probe point lies on the
 * panel's OWN content; `elementFromPoint` there must be the panel (or a child),
 * never the header, the participant info or the message list.
 */
async function panelGeometry(page) {
  return page.evaluate(() => {
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
    };
    const panel = document.getElementById('dm-key-verify');
    const header = document.querySelector('#dm-thread .chat-top-bar');
    const thread = document.getElementById('dm-thread');
    const hits = [];
    for (const sel of ['.dm-key-verify-head', '.dm-key-verify-help', '#dm-key-verify-number', '#dm-key-verify-marked', '[data-action="mark-verified"]']) {
      const el = panel.querySelector(sel);
      const b = el.getBoundingClientRect();
      for (const fx of [0.1, 0.5, 0.9]) {
        const x = b.left + b.width * fx;
        const y = b.top + b.height / 2;
        const top = document.elementFromPoint(x, y);
        hits.push({
          sel,
          at: [Math.round(x), Math.round(y)],
          inPanel: !!top && panel.contains(top),
          covering: top ? (top.id ? `#${top.id}` : String(top.className || top.tagName)) : null,
        });
      }
    }
    return {
      panel: box(panel),
      header: box(header),
      thread: box(thread),
      viewport: { width: innerWidth, height: innerHeight },
      hits,
    };
  });
}

function assertPanelVisible(geo, where) {
  assert.ok(geo.panel.height > 0 && geo.panel.width > 0, `${where}: the panel must have a size`);
  assert.ok(
    geo.panel.top >= geo.header.bottom - 0.5,
    `${where}: the panel must start below the participant header (panel top ${geo.panel.top}, header bottom ${geo.header.bottom})`
  );
  assert.ok(geo.panel.left >= geo.thread.left - 0.5 && geo.panel.right <= geo.thread.right + 0.5,
    `${where}: the panel must stay inside the conversation pane ${JSON.stringify(geo)}`);
  assert.ok(geo.panel.left >= 0 && geo.panel.right <= geo.viewport.width + 0.5,
    `${where}: the panel must not overflow the viewport horizontally`);
  assert.ok(geo.panel.bottom <= geo.viewport.height + 0.5,
    `${where}: the panel must be fully on screen (bottom ${geo.panel.bottom} > ${geo.viewport.height})`);
  const covered = geo.hits.filter((h) => !h.inPanel);
  assert.deepEqual(covered, [], `${where}: parts of the panel are covered by other UI`);
}

/** The first message must not be under the header stack either. */
async function firstRowGeometry(page) {
  return page.evaluate(() => {
    const list = document.getElementById('dm-messages');
    list.scrollTop = 0;
    const row = list.querySelector('.chat-msg .chat-bubble');
    const stack = document.querySelector('.dm-thread-top') || document.querySelector('#dm-thread .chat-top-bar');
    if (!row || !stack) return null;
    const r = row.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      rowTop: r.top,
      stackBottom: stack.getBoundingClientRect().bottom,
      hitIsRow: !!top && row.contains(top),
    };
  });
}

// ------------------------------------------------------------- key rotation

/** Rotates this page's own identity key through the real endpoint (as in peer-trust-browser). */
async function rotateIdentityKey(page) {
  return page.evaluate(async (password) => {
    const { api } = await import('/js/core/api.js');
    const { deriveCredentials } = await import('/js/crypto/credentials.js');
    const { generateIdentityKeyPair, exportPublicKey, exportPrivateKey, encryptIdentityPkcs8 } = await import('/js/crypto/identity.js');
    const kdf = await api('/api/me/kdf-params');
    const { authKey } = await deriveCredentials(password, kdf.salt, kdf.iterations);
    const before = await api('/api/me/identity-key');
    const pair = await generateIdentityKeyPair();
    const publicKeyB64 = await exportPublicKey(pair);
    const pkcs8 = await exportPrivateKey(pair);
    const wrapped = await encryptIdentityPkcs8(pkcs8, password, { salt: kdf.salt, iterations: kdf.iterations });
    try {
      await api('/api/me/identity-key/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_auth_key: authKey,
          expected_public_key: before.publicKey,
          expected_updated_at: before.updatedAt,
          identity: { publicKey: publicKeyB64, ...wrapped },
        }),
      });
      return null;
    } catch (e) {
      return String(e && e.message ? e.message : e);
    }
  }, PASSWORD);
}

// -------------------------------------------------------------------- tests

test('A: the Verify panel opens below the participant info, unobscured, at every viewport size', async () => {
  server = await startRealServer({ csp: 'true' });
  await registerUser(server.origin, 'vu-alice');
  await registerUser(server.origin, 'vu-bob');

  const A = await newUserPage({ onNewDocument: cspProbe });
  const B = await newUserPage({ onNewDocument: cspProbe });
  const errors = watchPage(A.page);
  await loginUi(A.page, server.origin, 'vu-alice');
  await loginUi(B.page, server.origin, 'vu-bob');
  const alice = await sessionFromPage(A.page, server.origin, 'vu-alice');
  const bob = await sessionFromPage(B.page, server.origin, 'vu-bob');
  assert.ok(await socketConnected(B.page));

  await openDmUi(B.page, alice.id, 'vu-alice');
  await sendTextViaComposer(B.page, bob.api, alice.id, 'hello, let us verify');

  await openThreadByRow(A.page, bob.id);
  await waitTrustResolved(A.page, bob.id);

  await openPanel(A.page);

  for (const vp of VIEWPORTS) {
    await A.page.setViewport({ width: vp.width, height: vp.height });
    // The layout settles after the resize (the stack is re-measured).
    const geo = await pollUntil(async () => {
      const g = await panelGeometry(A.page);
      return g.viewport.width === vp.width && g.hits.every((h) => h.inPanel) && g.panel.top >= g.header.bottom - 0.5 ? g : null;
    }, {
      timeout: 8000,
      what: `${vp.name}: the panel to be fully visible below the header`,
      describe: async () => JSON.stringify(await panelGeometry(A.page)),
    }).catch(async () => panelGeometry(A.page));
    assertPanelVisible(geo, vp.name);

    // The message list starts below the stack too: the first message is not
    // hidden under the header or the panel.
    const first = await firstRowGeometry(A.page);
    assert.ok(first, `${vp.name}: a message must be rendered`);
    assert.ok(first.rowTop >= first.stackBottom - 0.5,
      `${vp.name}: the first message must start below the header stack (row ${first.rowTop}, stack ${first.stackBottom})`);
    assert.ok(first.hitIsRow, `${vp.name}: the first message must not be covered`);
  }

  // Back to desktop; the panel's own button takes a REAL input click (it is
  // not covered), and the Verify button closes the panel again.
  await A.page.setViewport({ width: 1280, height: 900 });
  await pollUntil(async () => (await panelGeometry(A.page)).hits.every((h) => h.inPanel), { what: 'the panel to settle at desktop size' });
  await A.page.click('#dm-key-verify [data-action="mark-verified"]');
  await waitButton(A.page, 'Verified', 'the mark (a real click on the panel button) to land');
  await A.page.click('#dm-key-verify-open');
  await pollUntil(() => panelHidden(A.page), { what: 'the Verify button to close the panel' });
  assert.equal(await A.page.$eval('#dm-key-verify-open', (b) => b.getAttribute('aria-expanded')), 'false');

  assert.deepEqual(await cspViolations(A.page), [], 'no CSP violation');
  assert.deepEqual(errors.filter((e) => /pageerror/.test(e)), [], errors.join(' | '));
});

test('B: the Verify button turns "Verified" (success green) only on a stored verification, and keeps it', async () => {
  if (!server) server = await startRealServer({ csp: 'true' });
  await registerUser(server.origin, 'vs-alice');
  await registerUser(server.origin, 'vs-bob');

  const A = await newUserPage({ onNewDocument: cspProbe });
  const B = await newUserPage({ onNewDocument: cspProbe });
  await loginUi(A.page, server.origin, 'vs-alice');
  await loginUi(B.page, server.origin, 'vs-bob');
  const alice = await sessionFromPage(A.page, server.origin, 'vs-alice');
  const bob = await sessionFromPage(B.page, server.origin, 'vs-bob');
  assert.ok(await socketConnected(B.page));

  await openDmUi(B.page, alice.id, 'vs-alice');
  await sendTextViaComposer(B.page, bob.api, alice.id, 'compare numbers?');

  await openThreadByRow(A.page, bob.id);
  assert.equal(await waitTrustResolved(A.page, bob.id), 'ok');

  // Unverified to begin with.
  let btn = await waitButton(A.page, 'Verify', 'the unverified button');
  assert.equal(btn.verifiedClass, false);
  assert.notEqual(btn.color, btn.green, 'an unverified button must not use the success colour');

  // 1. Incomplete: opening and closing the panel verifies nothing.
  await openPanel(A.page);
  await A.page.click('#dm-key-verify-open');
  await pollUntil(() => panelHidden(A.page), { what: 'the panel to close' });
  btn = await verifyButton(A.page);
  assert.equal(btn.text, 'Verify', 'opening the panel is not verifying');
  assert.equal((await readPin(A.page, bob.id)).verifiedAt, null);

  // 2. Failed: the mark cannot be stored (a storage error on the pin store).
  //    The click happened, but nothing was verified - so nothing may say so.
  await openPanel(A.page);
  await A.page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    window.__restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'peer-pins') throw new DOMException('simulated storage failure', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await A.page.click('#dm-key-verify [data-action="mark-verified"]');
  await pollUntil(
    () => A.page.evaluate(() => /Not yet marked/.test(document.getElementById('dm-key-verify-marked')?.textContent || '')),
    { what: 'the panel to show the mark was not stored' }
  );
  await A.page.evaluate(() => window.__restorePut());
  btn = await verifyButton(A.page);
  assert.equal(btn.text, 'Verify', 'a verification that failed to save must not show as verified');
  assert.equal(btn.verifiedClass, false);
  assert.notEqual(btn.dataVerified, 'true');
  assert.equal((await readPin(A.page, bob.id)).verifiedAt, null, 'nothing was stored');

  // 3. Success, immediately reflected.
  await A.page.click('#dm-key-verify [data-action="mark-verified"]');
  btn = await waitButton(A.page, 'Verified', 'the button to turn "Verified" right after a successful mark');
  assert.equal(btn.verifiedClass, true);
  assert.equal(btn.dataVerified, 'true');
  assert.equal(btn.color, btn.green, `"Verified" must use the success green (--green); got ${btn.color}, want ${btn.green}`);
  assert.ok((await readPin(A.page, bob.id)).verifiedAt, 'the verification is stored');
  assert.match(await A.page.$eval('#dm-key-verify-marked', (e) => e.textContent), /Marked as verified/);

  // 4. Persists: away to another tab and back...
  await leaveAndReturn(A.page, bob.id);
  btn = await waitButton(A.page, 'Verified', 'the verified state after returning to the conversation');
  assert.equal(btn.color, btn.green);

  // ...and across a full reload + login.
  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await loginUi(A.page, server.origin, 'vs-alice');
  await openThreadByRow(A.page, bob.id);
  btn = await waitButton(A.page, 'Verified', 'the verified state after a reload');
  assert.equal(btn.verifiedClass, true);

  // 5. Outdated: Bob's key changes. What Alice verified is no longer the key in
  //    use, so the button must go back to "Verify" (and the banner must say so).
  const rotateError = await rotateIdentityKey(B.page);
  assert.equal(rotateError, null, `rotation failed: ${rotateError}`);
  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await loginUi(A.page, server.origin, 'vs-alice');
  await openThreadByRow(A.page, bob.id);
  assert.equal(await waitTrustResolved(A.page, bob.id), 'changed');
  btn = await waitButton(A.page, 'Verify', 'the button after the verified key changed');
  assert.equal(btn.verifiedClass, false, 'a changed key must never keep the verified look');
  assert.notEqual(btn.color, btn.green);

  // The key-change banner is in the same floating stack: visible, and its
  // accept button takes a real input click.
  const bannerHit = await pollUntil(() => A.page.evaluate(() => {
    const accept = document.querySelector('#dm-key-trust-banner .dm-key-trust-accept');
    if (!accept) return null;
    const r = accept.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { covered: !(top && accept.contains(top)), by: top ? String(top.className || top.tagName) : null };
  }), { what: 'the key-change banner to render' });
  assert.equal(bannerHit.covered, false, `the banner's accept button is covered by ${bannerHit.by}`);
  await A.page.click('#dm-key-trust-banner .dm-key-trust-accept');
  await pollUntil(async () => (await trustStateOf(A.page, bob.id)) === 'ok', { what: 'the accept to land' });

  // Accepting is not verifying.
  btn = await waitButton(A.page, 'Verify', 'the button after accepting (not verifying) the new key');
  assert.equal(btn.verifiedClass, false);

  // Verifying the new key turns it green again.
  await openPanel(A.page);
  await A.page.click('#dm-key-verify [data-action="mark-verified"]');
  btn = await waitButton(A.page, 'Verified', 'the button after verifying the new key');
  assert.equal(btn.color, btn.green);

  assert.deepEqual(await cspViolations(A.page), [], 'no CSP violation');
});
