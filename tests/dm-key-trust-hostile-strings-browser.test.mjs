// tests/dm-key-trust-hostile-strings-browser.test.mjs
//
// K5: hostile peer-controlled strings must reach the key-trust UI as TEXT.
//
// WHICH PEER-CONTROLLED STRINGS REACH dm-key-trust.js
// --------------------------------------------------
// The only peer-controlled string this module renders is the peer's USERNAME:
//
//   - renderVerifyView(peerId, username)  ->  #dm-key-verify-who   (textContent)
//   - renderKeyTrustBanner(peerId, username)
//         -> #dm-key-trust-banner .dm-key-trust-text            (textContent)
//
// Nothing else from the peer is interpolated there: the safety NUMBER comes from
// computeSafetyNumber() over the pinned public keys, and every button label is a
// constant. There is no innerHTML/insertAdjacentHTML in this module.
//
// THE SERVER'S USERNAME RULES (utils/username.js, used by registration and admin
// creation) make a hostile name unreachable through the real API: after trim +
// lowercase a new name must be 3-32 characters of [a-z0-9._-], start and end with
// a letter or digit, contain no "..", "__" or "--", and not be reserved.
// Existing accounts are never changed by those rules, so this test injects the
// hostile strings AT THE RENDER BOUNDARY: that is the boundary the UI owns, and
// it must stay a text sink even if a future schema, import or migration ever
// hands it a name the rules would not have allowed.
//
// THEN, with CSP ENFORCED and with CSP OFF, for each hostile string:
//   - the exact string is what the DOM node's textContent holds (rendered as
//     text, not parsed);
//   - the text node has no element children (no tags were created);
//   - the canary `window.__xssPwned` stays false (no script/handler ran);
//   - with CSP on, no securitypolicyviolation is recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  ROOT,
  PASSWORD,
  startRealServer,
  registerUser,
  newUserPage,
  closeUserBrowsers,
  loginUi,
  sessionFromPage,
  socketConnected,
  openDmUi,
  jsonClient,
} from './_acceptance-harness.mjs';
import {
  pollUntil,
  openThreadByRow,
  sendTextViaComposer,
  cspViolations,
  watchPage,
} from './_dm-ui-helpers.mjs';

const require = createRequire(import.meta.url);
const { validateNewUsername } = require(path.join(ROOT, 'utils', 'username.js'));

// One probe for both canaries: the XSS flag and (for CSP on) the violations.
function hostileProbe() {
  window.__xssPwned = false;
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI || ''} ${e.sourceFile || ''}:${e.lineNumber || ''}`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strings a peer would love to turn into markup, a URL scheme, an oversized
// field, or a direction/control trick. Kept as data, never as code.
const HOSTILE = Object.freeze([
  '<img src=x onerror="window.__xssPwned=true">',
  '"><script>window.__xssPwned=true</script>',
  '</script><svg onload="window.__xssPwned=true">',
  '\'><iframe src="javascript:window.__xssPwned=true"></iframe>',
  'javascript:window.__xssPwned=true',
  '&lt;already-escaped&gt; &amp; "quoted"',
  '{{constructor.constructor("window.__xssPwned=true")()}}',
  '\u202Eevil\u202C', // RTL override
  'zero\u200Bwidth\u200Djoiner', // zero-width space + ZWJ
  'ctrl\u0007\u001Bchars', // BEL + ESC
  `${'A'.repeat(4096)}<script>window.__xssPwned=true</script>`, // very long, markup late
]);

/** Rotates this page's own identity key through the real endpoint (a real key change). */
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

async function trustStateOf(page, peerId) {
  return page.evaluate(async (id) => (await import('/js/chat/dm-key-trust.js')).trustState(id), peerId);
}

async function animateSweep(server, { label }) {
  // ---------------------------------------------------------- server rules
  // The rules are the reason a hostile name cannot be registered; assert them
  // (and the real endpoint) rather than trusting the comment above.
  for (const name of [
    '<img src=x onerror=alert(1)>',
    'two words',
    'semi;colon',
    'quote"name',
    'A'.repeat(33),
  ]) {
    const verdict = validateNewUsername(name);
    assert.equal(verdict.ok, false, `utils/username.js must reject ${JSON.stringify(name)}`);
  }

  const rejected = await jsonClient(server.origin)('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username: '<img src=x onerror=alert(1)>',
      email: 'hostile-name@example.com',
      password: PASSWORD,
    }),
  });
  assert.equal(rejected.status, 400, 'the real registration endpoint must refuse a hostile username');

  // ---------------------------------------------------------- real DM thread
  const aliceName = `${label}-alice`;
  const bobName = `${label}-bob`;
  await registerUser(server.origin, aliceName);
  await registerUser(server.origin, bobName);

  const A = await newUserPage({ onNewDocument: hostileProbe });
  const B = await newUserPage({ onNewDocument: hostileProbe });
  const errors = watchPage(A.page);

  try {
    await loginUi(A.page, server.origin, aliceName);
    await loginUi(B.page, server.origin, bobName);
    const alice = await sessionFromPage(A.page, server.origin, aliceName);
    const bob = await sessionFromPage(B.page, server.origin, bobName);
    assert.ok(await socketConnected(B.page), 'the peer must be connected live');

    // Bob writes first; Alice opens the thread and pins his key (state 'ok').
    await openDmUi(B.page, alice.id, aliceName);
    await sendTextViaComposer(B.page, bob.api, alice.id, 'hostile strings are only text');
    await openThreadByRow(A.page, bob.id);
    await pollUntil(async () => (await trustStateOf(A.page, bob.id)) !== 'unknown', {
      timeout: 20000,
      what: 'the peer key trust state to resolve',
    });
    assert.equal(await trustStateOf(A.page, bob.id), 'ok', 'the first contact pins the peer');

    // Wait for the Verify panel's own markup (the render target).
    await A.page.waitForSelector('#dm-key-verify-who', { timeout: 20000 });

    // ------------------------------------------------- verify view: as text
    for (const hostile of HOSTILE) {
      const seen = await A.page.evaluate(async ({ peerId, s }) => {
        const m = await import('/js/chat/dm-key-trust.js');
        await m.renderVerifyView(peerId, s);
        const who = document.getElementById('dm-key-verify-who');
        return {
          text: who.textContent,
          children: who.children.length,
          descendants: who.querySelectorAll('*').length,
        };
      }, { peerId: bob.id, s: hostile });
      await sleep(100); // give a parsed tag's handler a chance to fire

      assert.equal(seen.text, hostile, 'the username must be stored literally, not parsed');
      assert.equal(seen.children, 0, 'no element may be created from a username (verify view)');
      assert.equal(seen.descendants, 0, 'no descendant element may be created (verify view)');
      assert.equal(
        await A.page.evaluate(() => window.__xssPwned),
        false,
        `no script/handler may run for ${JSON.stringify(hostile.slice(0, 40))}`
      );
    }

    // ------------------------------------------------------ a REAL key change
    // Rotate Bob's identity key, so Alice's next resolution is 'changed' and the
    // banner (the second username sink) actually renders.
    const rotateError = await rotateIdentityKey(B.page);
    assert.equal(rotateError, null, `the peer key rotation failed: ${rotateError}`);

    await A.page.evaluate(async (peerId) => {
      await (await import('/js/chat/dm-key-trust.js')).resolveTrust(peerId);
    }, bob.id);
    assert.equal(await trustStateOf(A.page, bob.id), 'changed', 'the rotated key must be unrecognised');

    // --------------------------------------------------- banner: as text
    for (const hostile of HOSTILE) {
      const seen = await A.page.evaluate(async ({ peerId, s }) => {
        const m = await import('/js/chat/dm-key-trust.js');
        // Re-render for each string: the banner deliberately skips a second
        // render while it already has children.
        const bar = document.getElementById('dm-key-trust-banner');
        bar.replaceChildren();
        m.renderKeyTrustBanner(peerId, s);
        const text = bar.querySelector('.dm-key-trust-text');
        return {
          text: text ? text.textContent : null,
          children: text ? text.children.length : -1,
          descendants: text ? text.querySelectorAll('*').length : -1,
          // innerHTML escapes markup: a parsed tag would appear raw here.
          rawMarkup: /<script|<img|<svg|<iframe/i.test(bar.innerHTML),
          expected:
            `${s} is using a new key. Messages are held until you accept it. ` +
            'Compare safety numbers first if you can.',
        };
      }, { peerId: bob.id, s: hostile });
      await sleep(100);

      assert.equal(seen.text, seen.expected, 'the banner must embed the username literally');
      assert.equal(seen.children, 0, 'no element may be created from a username (banner)');
      assert.equal(seen.descendants, 0, 'no descendant element may be created (banner)');
      assert.equal(seen.rawMarkup, false, 'the banner must not contain raw markup');
      assert.equal(
        await A.page.evaluate(() => window.__xssPwned),
        false,
        `no script/handler may run in the banner for ${JSON.stringify(hostile.slice(0, 40))}`
      );
    }

    assert.equal(await A.page.evaluate(() => window.__xssPwned), false, 'no hostile string may ever execute');
    assert.deepEqual(errors.filter((e) => /pageerror/.test(e)), [], errors.join(' | '));

    // No CSP violation is expected in either mode; with CSP ON this is the
    // assertion that a parsed inline handler did not even get attempted.
    assert.deepEqual(await cspViolations(A.page), [], 'no CSP violation');
  } finally {
    await B.browser.close().catch(() => {});
    await A.browser.close().catch(() => {});
  }
}

test('K5: hostile peer strings render as text with CSP ENFORCED', async () => {
  const server = await startRealServer({ csp: 'true' });
  try {
    await animateSweep(server, { label: 'k5-csp-on' });
  } finally {
    await closeUserBrowsers();
    await server.stop().catch(() => {});
  }
});

test('K5: hostile peer strings render as text with CSP OFF', async () => {
  const server = await startRealServer({ csp: 'false' });
  try {
    await animateSweep(server, { label: 'k5-csp-off' });
  } finally {
    await closeUserBrowsers();
    await server.stop().catch(() => {});
  }
});
