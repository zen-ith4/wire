// tests/dm-verify-double-trigger-browser.test.mjs
//
// K6: the "Mark as verified" action must be one operation, not "read the pin,
// then write a whole new pin".
//
// public/js/crypto/keys/peer-trust.js markPeerVerified() did `await getPeerPin()`
// and then a separate writeRecord(). Two consequences, both security relevant:
//
//   (a) A double click on Verify runs it twice. Both handlers read the old pin
//       and both write a fresh verifiedAt, so the IDB gets two verified writes.
//   (b) A concurrent noteEncryptedRow() (atomic updateRecord) can lower
//       `encryptedFloor` between that read and that write, and the stale mark
//       overwrites it. encryptedFloor is what chat/dm-unencrypted.js trusts, so
//       resetting it is not cosmetic.
//
// This test drives the REAL UI and asserts, IN THIS ORDER:
//   (b) after 30 open/close cycles of the Verify panel exactly ONE click
//       listener is attached to [data-action="mark-verified"] (CDP);
//   (a) a real double click on that button produces exactly ONE verified write
//       to IndexedDB `wire-peer-trust` / store `peer-pins`;
//   (c) concurrent noteEncryptedRow() + markPeerVerified() keeps the lowest
//       encryptedFloor instead of letting the mark reset it.
//
// On the pre-fix code (b) passes and (a) is expected RED:
//   "a double click on Verify must mark exactly once; got 2 verified writes".

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
} from './_acceptance-harness.mjs';
import {
  pollUntil,
  cspProbe,
  watchPage,
  cspViolations,
  openThreadByRow,
  sendTextViaComposer,
} from './_dm-ui-helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;

after(async () => {
  await closeUserBrowsers();
  if (server) await server.stop().catch(() => {});
});

// ------------------------------------------------------------------ reading

async function verifyButton(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('dm-key-verify-open');
    if (!btn) return null;
    return { text: btn.textContent.trim(), verifiedClass: btn.classList.contains('is-verified'), dataVerified: btn.dataset.verified };
  });
}

async function readPin(page, peerId) {
  return page.evaluate(async (id) => {
    const { getPeerPin } = await import('/js/crypto/keys/peer-trust.js');
    const { getCurrentUser } = await import('/js/core/auth.js');
    const pin = await getPeerPin(Number(id), { origin: location.origin, ownUserId: Number(getCurrentUser().id) });
    return pin ? { verifiedAt: pin.verifiedAt ?? null, encryptedFloor: pin.encryptedFloor ?? null, current: pin.current?.fingerprint ?? null } : null;
  }, peerId);
}

async function trustStateOf(page, peerId) {
  return page.evaluate(async (id) => (await import('/js/chat/dm-key-trust.js')).trustState(id), peerId);
}

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
  }, { what, describe: async () => `button is ${JSON.stringify(await verifyButton(page))}` });
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

/** The Mark button's viewport centre, for real mouse input. */
async function markButtonCentre(page) {
  return page.$eval('#dm-key-verify [data-action="mark-verified"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/**
 * Wait until the observed verified-write count has been stable for two
 * consecutive 100 ms probes (so a second, still in-flight handler has landed).
 */
async function waitWritesSettled(page, { min = 1, timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = -1;
  let same = 0;
  let value = 0;
  while (Date.now() < deadline) {
    value = await page.evaluate(() => window.__verifiedWrites || 0);
    if (value >= min && value === last) {
      if (++same >= 2) return value;
    } else {
      same = 0;
    }
    last = value;
    await sleep(100);
  }
  return value;
}

/** Counts put() calls to peer-pins that store a verification timestamp. */
async function installVerifiedWriteCounter(page) {
  await page.evaluate(() => {
    window.__verifiedWrites = 0;
    if (!window.__origPut) window.__origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'peer-pins' && value && typeof value.verifiedAt === 'number') {
        window.__verifiedWrites++;
      }
      return window.__origPut.call(this, value, key);
    };
  });
}

async function removeVerifiedWriteCounter(page) {
  await page.evaluate(() => {
    if (window.__origPut) {
      IDBObjectStore.prototype.put = window.__origPut;
      delete window.__origPut;
    }
  });
}

// -------------------------------------------------------------------- tests

test('K6: Verify marks once per double click, keeps one listener, and never resets encryptedFloor', async () => {
  server = await startRealServer({ csp: 'true' });
  await registerUser(server.origin, 'k6-alice');
  await registerUser(server.origin, 'k6-bob');

  const A = await newUserPage({ onNewDocument: cspProbe });
  const B = await newUserPage({ onNewDocument: cspProbe });
  const errors = watchPage(A.page);
  await loginUi(A.page, server.origin, 'k6-alice');
  await loginUi(B.page, server.origin, 'k6-bob');
  const alice = await sessionFromPage(A.page, server.origin, 'k6-alice');
  const bob = await sessionFromPage(B.page, server.origin, 'k6-bob');
  assert.ok(await socketConnected(B.page), 'bob must be connected live');

  // Bob opens the DM and sends one message so Alice's row (and key) exist.
  await openDmUi(B.page, alice.id, 'k6-alice');
  await sendTextViaComposer(B.page, bob.api, alice.id, 'verify me once');

  await openThreadByRow(A.page, bob.id);
  assert.equal(await waitTrustResolved(A.page, bob.id), 'ok');

  // Unverified to begin with.
  let btn = await waitButton(A.page, 'Verify', 'the unverified button');
  assert.equal(btn.verifiedClass, false);
  assert.equal((await readPin(A.page, bob.id)).verifiedAt, null, 'nothing verified yet');

  // ---------------------------------------------------------------- (b)
  // Open/close the panel 30 times, then open it once more and count the click
  // listeners CDP sees on the Mark button. The render path must replace, not
  // stack, its listener.
  for (let i = 0; i < 30; i++) {
    await openPanel(A.page);
    await A.page.click('#dm-key-verify-open');
    await pollUntil(() => panelHidden(A.page), { what: `the Verify panel to close (cycle ${i + 1})` });
  }
  await openPanel(A.page);

  const cdp = await A.page.target().createCDPSession();
  await cdp.send('Runtime.enable');
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'document.querySelector(\'#dm-key-verify [data-action="mark-verified"]\')',
  });
  assert.ok(result.objectId, 'the Mark button must exist in the DOM');
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: -1, pierce: true });
  const clickListeners = listeners.filter((l) => l.type === 'click');
  assert.equal(
    clickListeners.length,
    1,
    `exactly one click listener must remain on the Mark button after 30 open/close cycles; got ${clickListeners.length}`
  );
  await cdp.detach().catch(() => {});

  // ---------------------------------------------------------------- (a)
  // A real double click: two separate mouse clicks at the button's centre, so
  // the page receives two genuine `click` events (not one detail=2 click).
  await installVerifiedWriteCounter(A.page);
  const centre = await markButtonCentre(A.page);
  await A.page.mouse.click(centre.x, centre.y);
  await A.page.mouse.click(centre.x, centre.y);

  btn = await waitButton(A.page, 'Verified', 'the button to turn Verified after the double click');
  const writes = await waitWritesSettled(A.page, { min: 1 });
  await removeVerifiedWriteCounter(A.page);

  assert.equal(
    writes,
    1,
    `a double click on Verify must mark exactly once; got ${writes} verified writes`
  );

  // ---------------------------------------------------------------- (c)
  // The mark must not reset the lowest encrypted row id. noteEncryptedRow is
  // atomic; a stale read-then-write in markPeerVerified would overwrite it.
  const floor = await A.page.evaluate(async (peerId) => {
    const pt = await import('/js/crypto/keys/peer-trust.js');
    const auth = await import('/js/core/auth.js');
    const context = { origin: location.origin, ownUserId: Number(auth.getCurrentUser().id) };
    // A high floor was already recorded, then the mark races a lower one.
    await pt.noteEncryptedRow(peerId, 100, context);
    await Promise.all([
      pt.markPeerVerified(peerId, context),
      pt.noteEncryptedRow(peerId, 1, context),
    ]);
    const pin = await pt.getPeerPin(peerId, context);
    return { encryptedFloor: pin?.encryptedFloor ?? null, verifiedAt: pin?.verifiedAt ?? null };
  }, bob.id);

  assert.equal(
    floor.encryptedFloor,
    1,
    `the mark must not reset the lowest encrypted row id; got ${floor.encryptedFloor}`
  );
  assert.ok(floor.verifiedAt, 'the verification itself must still be stored');

  assert.deepEqual(await cspViolations(A.page), [], 'no CSP violation');
  assert.deepEqual(errors.filter((e) => /pageerror/.test(e)), [], errors.join(' | '));
});
