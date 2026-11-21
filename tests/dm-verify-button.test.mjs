// tests/dm-verify-button.test.mjs
//
// The DM header's Verify button (Bug 4B), in a DOM: it must say "Verified"
// exactly when the STORED trust state says this contact is verified on this
// device, and never on the strength of a click.
//
// Real: chat/dm-key-trust.js, keys/peer-key-gate.js, keys/peer-trust.js and
// session.js, with fake-indexeddb and real WebCrypto - the same set-up as
// tests/dm-key-trust-banner.test.mjs. The real-browser flow (position, colour,
// persistence across navigation and reload) is tests/dm-verify-ui-browser.test.mjs.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

const js = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://wire.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.indexedDB = new IDBFactory();

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function person() {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { priv: pair.privateKey, raw, b64: b64(raw) };
}

const ALICE = 1;
const ORIGIN = 'https://wire.test';
const CTX = { origin: ORIGIN, ownUserId: ALICE };
const alice = await person();
const serverKeys = new Map();

mock.module(js('core/auth.js'), { namedExports: { getCurrentUser: () => ({ id: ALICE }) } });
mock.module(js('core/server.js'), { namedExports: { getServerEndpoint: () => ORIGIN } });
mock.module(js('crypto/identity-service.js'), {
  namedExports: { getCurrentIdentity: () => ({ privateKey: alice.priv, publicKey: alice.b64 }) },
});
mock.module(js('core/api.js'), {
  namedExports: {
    api: async (url) => {
      const path = String(url);
      if (/^\/api\/me\/identity-key-history\/\d+$/.test(path)) return { current: null, history: [] };
      const key = path.match(/^\/api\/me\/identity-key\/(\d+)$/);
      if (key && serverKeys.has(Number(key[1]))) return { publicKey: serverKeys.get(Number(key[1])) };
      throw new Error(`unexpected api call: ${path}`);
    },
  },
});

const trust = await import(js('crypto/keys/peer-trust.js'));
const keyTrust = await import(js('chat/dm-key-trust.js'));

let nextPeerId = 500;
let peerId;

/** The thread's header + panel for ONE conversation, as dm.js builds it. */
beforeEach(() => {
  peerId = nextPeerId++;
  document.body.innerHTML = `
    <button type="button" class="dm-verify-btn" id="dm-key-verify-open" data-peer-id="${peerId}" data-verified="false">Verify</button>
    <div id="dm-key-trust-banner"></div>
    <section id="dm-key-verify" hidden>
      <span id="dm-key-verify-who"></span>
      <div id="dm-key-verify-number"></div>
      <div id="dm-key-verify-marked"></div>
      <button type="button" data-action="mark-verified">Mark as verified</button>
    </section>`;
});

const button = () => document.getElementById('dm-key-verify-open');
const markButton = () => document.querySelector('#dm-key-verify [data-action="mark-verified"]');
const markedText = () => document.getElementById('dm-key-verify-marked').textContent;

function look() {
  const b = button();
  return { text: b.textContent, verified: b.classList.contains('is-verified'), data: b.dataset.verified };
}

const UNVERIFIED = { text: 'Verify', verified: false, data: 'false' };
const VERIFIED = { text: 'Verified', verified: true, data: 'true' };

async function until(probe, what) {
  for (let i = 0; i < 400; i++) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function knownPeer() {
  const key = await person();
  serverKeys.set(peerId, key.b64);
  await keyTrust.resolveTrust(peerId);
  return key;
}

test('a fresh contact is "Verify"; a successful mark turns it "Verified" at once, from the stored pin', async () => {
  await knownPeer();
  assert.deepEqual(look(), UNVERIFIED);
  assert.equal(keyTrust.isPeerVerified(peerId), false);

  await keyTrust.renderVerifyView(peerId, 'Bob');
  markButton().click();
  await until(() => /Marked as verified/.test(markedText()), 'the mark to land');

  assert.deepEqual(look(), VERIFIED);
  assert.equal(keyTrust.isPeerVerified(peerId), true);
  assert.ok((await trust.getPeerPin(peerId, CTX)).verifiedAt, 'the state on screen is the stored one');
});

test('a contact verified earlier shows "Verified" as soon as its thread resolves trust again', async () => {
  await knownPeer();
  await trust.markPeerVerified(peerId, CTX);

  // A new visit: dm.js rebuilds the header ("Verify") and resolves trust.
  button().textContent = 'Verify';
  button().classList.remove('is-verified');
  await keyTrust.resolveTrust(peerId);
  assert.deepEqual(look(), VERIFIED);
});

test('a mark that cannot be stored never shows success', async () => {
  await knownPeer();
  await keyTrust.renderVerifyView(peerId, 'Bob');

  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () {
    throw new Error('simulated storage failure');
  };
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    markButton().click();
    await until(() => /Not yet marked/.test(markedText()) && errors.length > 0, 'the failed mark to be reported');
  } finally {
    IDBObjectStore.prototype.put = put;
    console.error = consoleError;
  }

  assert.deepEqual(look(), UNVERIFIED);
  assert.equal((await trust.getPeerPin(peerId, CTX)).verifiedAt, null);
});

test('a mark refused because the pinned key moved never shows success', async () => {
  await knownPeer();
  await keyTrust.renderVerifyView(peerId, 'Bob');

  // Another tab accepted a different key while this panel sat open.
  const other = await person();
  await trust.acceptPeerKey(peerId, other.b64, CTX);
  serverKeys.set(peerId, other.b64);

  markButton().click();
  await until(() => /Not yet marked/.test(markedText()), 'the panel to show the current key');
  assert.deepEqual(look(), UNVERIFIED);
  assert.equal((await trust.getPeerPin(peerId, CTX)).verifiedAt, null);
});

test('a key change after verifying turns the button back to "Verify"; accepting the new key keeps it there', async () => {
  await knownPeer();
  await trust.markPeerVerified(peerId, CTX);
  await keyTrust.resolveTrust(peerId);
  assert.deepEqual(look(), VERIFIED);

  serverKeys.set(peerId, (await person()).b64);
  await keyTrust.resolveTrust(peerId);
  assert.equal(keyTrust.trustState(peerId), 'changed');
  assert.deepEqual(look(), UNVERIFIED, 'what was verified is not the key in use any more');

  await keyTrust.acceptNewKey(peerId);
  assert.deepEqual(look(), UNVERIFIED, 'accepting is not verifying');
});

test('a key lookup that fails is not shown as verified', async () => {
  await knownPeer();
  await trust.markPeerVerified(peerId, CTX);
  await keyTrust.resolveTrust(peerId);
  assert.deepEqual(look(), VERIFIED);

  serverKeys.delete(peerId); // the key endpoint now fails
  const result = await keyTrust.resolveTrust(peerId);
  assert.equal(result.state, 'no-key');
  assert.deepEqual(look(), UNVERIFIED);
});

test("another peer's trust resolution never paints this conversation's button", async () => {
  await knownPeer();
  assert.deepEqual(look(), UNVERIFIED);

  // A different, verified peer resolves while this thread is open (sending,
  // decrypting a reply quote, the group gate...).
  const otherId = peerId + 10000;
  serverKeys.set(otherId, (await person()).b64);
  await keyTrust.resolveTrust(otherId);
  await trust.markPeerVerified(otherId, CTX);
  await keyTrust.resolveTrust(otherId);
  assert.equal(keyTrust.isPeerVerified(otherId), true);

  assert.deepEqual(look(), UNVERIFIED, "this thread's contact is still unverified");
});

test('the label is plain text', async () => {
  await knownPeer();
  await trust.markPeerVerified(peerId, CTX);
  await keyTrust.resolveTrust(peerId);
  assert.equal(button().children.length, 0, 'no markup inside the button');
  assert.equal(button().textContent, 'Verified');
});
