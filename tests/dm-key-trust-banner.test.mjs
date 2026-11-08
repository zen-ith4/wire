// tests/dm-key-trust-banner.test.mjs
//
// The key-change banner and the verify panel, in a DOM: accepting is not verifying,
// the digits on screen are the key that gets accepted or marked, and a key can
// change while a thread is already open.
//
// Real: chat/dm-key-trust.js, keys/peer-key-gate.js, keys/peer-trust.js, session.js,
// real fake-indexeddb and real WebCrypto. No layout or CSP here: the real-browser
// flow is tests/peer-trust-browser.test.mjs.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBDatabase, IDBFactory } from 'fake-indexeddb';

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
    return { priv: pair.privateKey, pub: pair.publicKey, raw, b64: b64(raw) };
}

const ALICE = 1;
const ORIGIN = 'https://wire.test';
const CTX = { origin: ORIGIN, ownUserId: ALICE };
const alice = await person();
const serverKeys = new Map();

mock.module(js('core/auth.js'), {
    namedExports: { getCurrentUser: () => ({ id: ALICE }) },
});

mock.module(js('core/server.js'), {
    namedExports: { getServerEndpoint: () => ORIGIN },
});

mock.module(js('crypto/identity-service.js'), {
    namedExports: { getCurrentIdentity: () => ({ privateKey: alice.priv, publicKey: alice.b64 }) },
});

mock.module(js('core/api.js'), {
    namedExports: {
        api: async (url) => {
            const path = String(url);

            const history = path.match(/^\/api\/me\/identity-key-history\/(\d+)$/);
            if (history) {
                return { current: null, history: [] };
            }

            const key = path.match(/^\/api\/me\/identity-key\/(\d+)$/);
            if (key && serverKeys.has(Number(key[1]))) {
                return { publicKey: serverKeys.get(Number(key[1])) };
            }

            throw new Error(`unexpected api call: ${path}`);
        },
    },
});

const trust = await import(js('crypto/keys/peer-trust.js'));
const keyTrust = await import(js('chat/dm-key-trust.js'));

/* ---------------------------------------------------------------- helpers */

let nextPeerId = 100;
let verifyOpenClicks = 0;

/** The thread's own markup, rebuilt per test like dm.js rebuilds it per conversation. */
beforeEach(() => {
    verifyOpenClicks = 0;
    document.body.innerHTML = `
        <button id="dm-key-verify-open"></button>
        <div id="dm-key-trust-banner"></div>
        <section id="dm-key-verify" hidden>
            <span id="dm-key-verify-who"></span>
            <div id="dm-key-verify-number"></div>
            <div id="dm-key-verify-marked"></div>
            <button type="button" data-action="mark-verified">Mark as verified</button>
        </section>`;
    document.getElementById('dm-key-verify-open').addEventListener('click', () => { verifyOpenClicks++; });
});

const banner = () => document.getElementById('dm-key-trust-banner');
const panel = () => document.getElementById('dm-key-verify');
const markButton = () => panel().querySelector('[data-action="mark-verified"]');
const acceptButton = () => banner().querySelector('.dm-key-trust-accept');
const reviewButton = () => banner().querySelector('.dm-key-trust-verify');
const shownNumber = () => document.getElementById('dm-key-verify-number').textContent;
const markedText = () => document.getElementById('dm-key-verify-marked').textContent;

async function until(probe, what) {
    for (let i = 0; i < 200; i++) {
        const value = await probe();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
}

const numberFor = async (key) => (await trust.computeSafetyNumber(alice.b64, key.b64)).number;

/** A peer Alice has pinned, whose key has since changed to the returned `rotated`. */
async function changedPeer({ verified = false } = {}) {
    const id = nextPeerId++;
    const original = await person();
    const rotated = await person();

    serverKeys.set(id, original.b64);
    await keyTrust.resolveTrust(id);
    if (verified) await trust.markPeerVerified(id, CTX);

    serverKeys.set(id, rotated.b64);
    await keyTrust.resolveTrust(id);

    return { id, original, rotated };
}

/* ---------------------------------------------------------------- the banner */

test('no key change, no banner; and the empty bar is still there for a later change', async () => {
    const id = nextPeerId++;
    const original = await person();
    serverKeys.set(id, original.b64);
    await keyTrust.resolveTrust(id);

    keyTrust.renderKeyTrustBanner(id, 'Bob');
    assert.equal(banner().childElementCount, 0);
    assert.ok(banner().isConnected, 'removing the bar would leave a mid-thread key change nowhere to appear');

    serverKeys.set(id, (await person()).b64);
    await keyTrust.resolveTrust(id);

    keyTrust.renderKeyTrustBanner(id, 'Bob');
    assert.ok(acceptButton(), 'a key that changes while the thread is open must still get its banner');
});

test('the wording says so when the key that changed was one the user verified', async () => {
    const plain = await changedPeer();
    keyTrust.renderKeyTrustBanner(plain.id, 'Bob');
    assert.match(banner().textContent, /Bob is using a new key/);
    assert.doesNotMatch(banner().textContent, /after you verified/);

    banner().replaceChildren();

    const verified = await changedPeer({ verified: true });
    keyTrust.renderKeyTrustBanner(verified.id, 'Bob');
    assert.match(banner().textContent, /key changed after you verified it/);
    assert.match(banner().textContent, /intercepting/);
});

test('the username is inert text', async () => {
    const { id } = await changedPeer();
    keyTrust.renderKeyTrustBanner(id, '<img src=x onerror="window.pwned=1">');

    assert.equal(banner().querySelector('img'), null);
    assert.match(banner().textContent, /<img src=x onerror=/);
});

test('rendering again while it is showing does not replace the button the user may be pressing', async () => {
    const { id } = await changedPeer();

    keyTrust.renderKeyTrustBanner(id, 'Bob');
    const first = acceptButton();
    keyTrust.renderKeyTrustBanner(id, 'Bob');

    assert.equal(acceptButton(), first);
});

test('accept moves the pin, does not verify, clears the banner and releases held rows', async () => {
    const { id, rotated } = await changedPeer({ verified: true });
    const delivered = [];
    let drained = 0;

    keyTrust.holdMessage(id, { id: 7 });
    keyTrust.bindKeyTrustRelease(id, async (msg) => { delivered.push(msg.id); }, () => { drained++; });
    keyTrust.renderKeyTrustBanner(id, 'Bob');

    const button = acceptButton();
    button.click();
    assert.equal(button.disabled, true, 'the listener must run synchronously');

    await until(() => drained === 1, 'the held rows to be released');

    assert.deepEqual(delivered, [7]);
    assert.equal(banner().childElementCount, 0);
    assert.equal(keyTrust.trustState(id), 'ok');

    const pin = await trust.getPeerPin(id, CTX);
    assert.equal(pin.current.publicKey, rotated.b64);
    assert.equal(pin.verifiedAt, null, 'getting past the alarm must not claim a comparison');

    keyTrust.unbindKeyTrustRelease();
});

test('a failed accept leaves the button usable and the held rows held', async () => {
    const { id } = await changedPeer();
    const savedError = console.error;
    console.error = () => {};

    keyTrust.holdMessage(id, { id: 8 });
    keyTrust.renderKeyTrustBanner(id, 'Bob');

    const realTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = () => { throw new Error('storage is gone'); };

    try {
        const button = acceptButton();
        button.click();
        await until(() => button.disabled === false, 'the button to come back');
        assert.equal(keyTrust.heldCount(id), 1);
        assert.equal(keyTrust.trustState(id), 'changed');
    } finally {
        IDBDatabase.prototype.transaction = realTransaction;
        console.error = savedError;
        keyTrust.clearHeldMessages(id);
    }
});

test('View safety number opens the panel through the header button, and never closes it', async () => {
    const { id } = await changedPeer();
    keyTrust.renderKeyTrustBanner(id, 'Bob');

    reviewButton().click();
    assert.equal(verifyOpenClicks, 1);

    panel().removeAttribute('hidden');
    reviewButton().click();
    assert.equal(verifyOpenClicks, 1, 'that button toggles, so pressing it on an open panel would close it');
});

/* ---------------------------------------------------------------- the verify panel */

test('the digits are for the key that would be accepted, even if the server changes its answer', async () => {
    const { id, rotated } = await changedPeer();
    await keyTrust.renderVerifyView(id, 'Bob');
    assert.equal(shownNumber(), await numberFor(rotated));

    // The server shows one key while the users compare, then answers another.
    const swapped = await person();
    serverKeys.set(id, swapped.b64);
    await keyTrust.renderVerifyView(id, 'Bob');
    assert.equal(shownNumber(), await numberFor(rotated), 'the digits must not move under the user');

    await keyTrust.acceptNewKey(id);
    assert.equal((await trust.getPeerPin(id, CTX)).current.publicKey, rotated.b64,
        'what was compared is what gets pinned');
});

test('Mark is off while a key is pending, and comes on when an open panel sees the accept', async () => {
    const { id, rotated } = await changedPeer({ verified: true });

    await keyTrust.renderVerifyView(id, 'Bob');
    panel().removeAttribute('hidden');
    assert.equal(markButton().disabled, true);
    assert.match(markedText(), /Not yet marked/, 'the old key\'s flag must not be shown against the new key');

    keyTrust.renderKeyTrustBanner(id, 'Bob');
    acceptButton().click();

    await until(() => markButton().disabled === false, 'the open panel to re-render');
    assert.match(markedText(), /Not yet marked/, 'accepting is not verifying');
    assert.equal(shownNumber(), await numberFor(rotated));

    markButton().click();
    await until(() => /Marked as verified/.test(markedText()), 'the mark to land');
    assert.ok((await trust.getPeerPin(id, CTX)).verifiedAt);
});

test('a listener from an earlier render cannot stamp a key that is no longer on screen', async () => {
    const id = nextPeerId++;
    serverKeys.set(id, (await person()).b64);
    await keyTrust.resolveTrust(id);

    await keyTrust.renderVerifyView(id, 'Bob');
    assert.equal(markButton().disabled, false, 'control: the ok state offers the button');

    serverKeys.set(id, (await person()).b64);
    await keyTrust.renderVerifyView(id, 'Bob');
    assert.equal(markButton().disabled, true);

    markButton().removeAttribute('disabled');
    markButton().click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal((await trust.getPeerPin(id, CTX)).verifiedAt, null);
});

test('Mark refuses when the pinned key moved after the digits were drawn', async () => {
    const id = nextPeerId++;
    const original = await person();
    const other = await person();
    serverKeys.set(id, original.b64);
    await keyTrust.resolveTrust(id);

    await keyTrust.renderVerifyView(id, 'Bob');
    const drawn = shownNumber();

    // Another tab accepted a different key while this panel sat open.
    await trust.acceptPeerKey(id, other.b64, CTX);
    serverKeys.set(id, other.b64);

    markButton().click();
    await until(() => shownNumber() !== drawn, 'the panel to show the current key');

    assert.equal((await trust.getPeerPin(id, CTX)).verifiedAt, null);
    assert.equal(shownNumber(), await numberFor(other));
    assert.match(markedText(), /Not yet marked/);
});

test('a key this device held before gets no Mark button, because Mark stamps the pinned key', async () => {
    const id = nextPeerId++;
    const original = await person();
    const rotated = await person();
    serverKeys.set(id, original.b64);
    await keyTrust.resolveTrust(id);
    await trust.acceptPeerKey(id, rotated.b64, CTX);

    // The server goes back to the older key. Unverified, so no alarm, but the digits
    // are not for the key pinned as current.
    await keyTrust.renderVerifyView(id, 'Bob');

    assert.equal(keyTrust.trustState(id), 'reknown');
    assert.equal(shownNumber(), await numberFor(original));
    assert.equal(markButton().disabled, true);
});

/* ---------------------------------------------------------------- logout, races */

test('a logout forgets held rows and pending keys, so the next account cannot accept them', async () => {
    const { id } = await changedPeer();
    keyTrust.holdMessage(id, { id: 9 });

    window.dispatchEvent(new window.Event('wire:logout'));

    assert.equal(keyTrust.heldCount(id), 0);
    assert.equal(keyTrust.trustState(id), 'unknown');
});

test('two first contacts racing leave one pin, and both are told which', async () => {
    const id = nextPeerId++;
    const a = await person();
    const b = await person();

    const [first, second] = await Promise.all([
        trust.pinOnFirstUse(id, a.b64, CTX),
        trust.pinOnFirstUse(id, b.b64, CTX),
    ]);

    assert.equal(first.current.fingerprint, second.current.fingerprint,
        'the later write must not replace a pin the earlier caller has acted on');

    const stored = await trust.getPeerPin(id, CTX);
    assert.equal(stored.current.fingerprint, first.current.fingerprint);
});
