// tests/dm-key-trust-account-switch-browser.test.mjs
//
// K4: account A's held DM rows and pending key questions must never be visible
// to account B on the SAME page.
//
// dm-key-trust.js keeps `held` (raw server rows + the pending key it is asking
// about) in a module-level Map. It is cleared only by the `wire:logout` event,
// which core/auth.js dispatches synchronously in logout() -- including on the
// 401 path, which does NOT reload the page.
//
// Two variants, each with a real held state (peer key changed after a first
// contact, so rows are held instead of decrypted):
//   (i)  the UI sign-out, then log in as another account on the same page;
//   (ii) a 401 that logs out WITHOUT a page reload: alice's server-side session
//        is revoked (users.token_version bump), then the page makes an
//        authenticated call so the app's own 401 handler runs.
//
// In both, the next account must see none of the previous account's held rows
// or its pending key question.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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
  openThreadByRow,
  sendTextViaComposer,
  clickReal,
} from './_dm-ui-helpers.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let server = null;

before(async () => {
  server = await startRealServer({ csp: 'true' });
});

after(async () => {
  await closeUserBrowsers();
  if (server) await server.stop().catch(() => {});
});

// ------------------------------------------------------------------ reading

async function heldCountOf(page, peerId) {
  return page.evaluate(async (id) => (await import('/js/chat/dm-key-trust.js')).heldCount(id), peerId);
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

/** Rotates this page's own identity key through the real endpoint. */
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

/**
 * Real held state for alice <-> carol:
 *   - carol writes first, alice opens the thread and pins carol's key (ok);
 *   - carol rotates her identity key and writes again;
 *   - alice reloads and opens the thread: the new key is unrecognised
 *     (changed), so the rows are held and the pending key question exists.
 */
async function setupHeldState({ aliceName, carolName }) {
  await registerUser(server.origin, aliceName);
  await registerUser(server.origin, carolName);

  const A = await newUserPage({});
  const C = await newUserPage({});
  await loginUi(A.page, server.origin, aliceName);
  await loginUi(C.page, server.origin, carolName);
  const alice = await sessionFromPage(A.page, server.origin, aliceName);
  const carol = await sessionFromPage(C.page, server.origin, carolName);
  assert.ok(await socketConnected(C.page), 'carol must be connected live');

  await openDmUi(C.page, alice.id, aliceName);
  await sendTextViaComposer(C.page, carol.api, alice.id, 'first contact');

  await openThreadByRow(A.page, carol.id);
  assert.equal(await waitTrustResolved(A.page, carol.id), 'ok', 'the first contact pins carol');

  const rotateError = await rotateIdentityKey(C.page);
  assert.equal(rotateError, null, `carol's key rotation failed: ${rotateError}`);
  await sendTextViaComposer(C.page, carol.api, alice.id, 'after the key change');

  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await loginUi(A.page, server.origin, aliceName);
  await openThreadByRow(A.page, carol.id);
  assert.equal(await waitTrustResolved(A.page, carol.id), 'changed', 'alice must see the changed key');

  const held = await pollUntil(async () => {
    const n = await heldCountOf(A.page, carol.id);
    return n > 0 ? n : null;
  }, { timeout: 20000, what: 'alice to hold carol\'s rows while the key is changed' });

  return { A, C, alice, carol, held };
}

// -------------------------------------------------------------------- tests

test('K4(i): UI sign-out then login as dave leaves none of alice\'s held rows', async () => {
  const { A, alice, carol } = await setupHeldState({ aliceName: 'k4i-alice', carolName: 'k4i-carol' });
  await registerUser(server.origin, 'k4i-dave');

  // Real sign-out: Settings -> Account -> Sign out (the button calls logout()
  // and then reloads the page).
  await clickReal(A.page, '.nav-link[data-view="settings"]');
  await clickReal(A.page, '.settings-category-row[data-category="account"]');
  await A.page.waitForSelector('#sign-out-button', { timeout: 20000 });
  await Promise.all([
    A.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    A.page.click('#sign-out-button'),
  ]);

  await loginUi(A.page, server.origin, 'k4i-dave');
  const dave = await sessionFromPage(A.page, server.origin, 'k4i-dave');
  assert.notEqual(dave.id, alice.id, 'the page must now be dave, not alice');

  assert.equal(await heldCountOf(A.page, carol.id), 0, 'account B must inherit none of account A\'s held rows');
  assert.notEqual(await trustStateOf(A.page, carol.id), 'changed', 'account B must not inherit the pending key question');
});

test('K4(ii): a revoked-token 401 logs out without a reload and clears alice\'s held state', async () => {
  const { A, alice, carol } = await setupHeldState({ aliceName: 'k4ii-alice', carolName: 'k4ii-carol' });

  // A marker that only survives if the page is NOT reloaded.
  const marker = await A.page.evaluate(() => {
    window.__k4NoReloadMarker = `alive-${Date.now()}`;
    return window.__k4NoReloadMarker;
  });

  // Revoke every session for alice on the server.
  const db = new Database(server.dbPath);
  const before = db.prepare('SELECT token_version FROM users WHERE id = ?').get(alice.id);
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(alice.id);
  const after = db.prepare('SELECT token_version FROM users WHERE id = ?').get(alice.id);
  db.close();
  assert.equal(after.token_version, before.token_version + 1, 'token_version bump must persist');

  // Make the page do an authenticated call; the app's own 401 handler decides.
  const outcome = await A.page.evaluate(async () => {
    try {
      const { api } = await import('/js/core/api.js');
      await api('/api/me/');
      return { threw: false, message: null };
    } catch (e) {
      return { threw: true, message: String(e && e.message ? e.message : e) };
    }
  });

  const token = await A.page.evaluate(async () => (await import('/js/core/auth.js')).getToken());
  assert.equal(
    token,
    null,
    `the 401 handler must end the revoked session (api outcome: ${JSON.stringify(outcome)})`
  );
  assert.equal(await A.page.evaluate(() => window.__k4NoReloadMarker), marker, 'the logout must not reload the page');
  assert.equal(await heldCountOf(A.page, carol.id), 0, 'held rows must be cleared on a 401 logout');

  // A second account on the same page still sees nothing of alice's state.
  await registerUser(server.origin, 'k4ii-dave');
  await loginUi(A.page, server.origin, 'k4ii-dave');
  const dave = await sessionFromPage(A.page, server.origin, 'k4ii-dave');
  assert.notEqual(dave.id, alice.id, 'the page must now be dave, not alice');
  assert.equal(await heldCountOf(A.page, carol.id), 0, 'account B must inherit none of account A\'s held rows');
  assert.notEqual(await trustStateOf(A.page, carol.id), 'changed', 'account B must not inherit the pending key question');
});
