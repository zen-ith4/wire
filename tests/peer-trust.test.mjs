// tests/peer-trust.test.mjs
//
// Unit tests for Phase 2 of docs/e2ee-dm-hardening.md: the safety number, the
// TOFU pin, the key-change alarm and the retired-key rule.
//
// Node-runnable (no server, no browser). The browser-level alarm/accept flow is
// tests/peer-trust-browser.test.mjs.
//
// peer-trust.js uses WebCrypto and IndexedDB, both available in Node 22 as
// globals — but the storage layer needs an IndexedDB, which Node does not have.
// A minimal in-memory stand-in is installed BEFORE the module is imported, and
// the tests that care about persistence use it deliberately.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ IndexedDB stand-in */

/**
 * Just enough IndexedDB for peer-trust.js: open/name/version, one object store
 * with no key path, get/put/delete. Records persist for the life of the process,
 * which is what lets a test assert "pinned, then later changed" across two
 * calls.
 */
function installFakeIndexedDb() {
    const stores = new Map(); // dbName -> Map(key -> value)

    function store(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    }

    const request = (result) => {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result };
        queueMicrotask(() => {
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    };

    const fakeDb = (name) => ({
        name,
        objectStoreNames: { contains: (n) => n === 'peer-pins' },
        transaction(storeName, mode) {
            const data = store(storeName);
            const tx = {
                oncomplete: null,
                onerror: null,
                objectStore() {
                    return {
                        put(value, key) {
                            if (mode === 'readwrite') data.set(key, value);
                            return request(undefined);
                        },
                        get(key) {
                            const req = request(data.get(key));
                            queueMicrotask(() => {
                                if (req.onsuccess) req.onsuccess({ target: req });
                            });
                            return req;
                        },
                        delete(key) {
                            if (mode === 'readwrite') data.delete(key);
                            return request(undefined);
                        },
                    };
                },
            };
            // A get() resolves the request; commit fires after everything settles.
            queueMicrotask(() => queueMicrotask(() => {
                if (mode === 'readwrite' && tx.oncomplete) tx.oncomplete();
            }));
            return tx;
        },
        close() {},
    });

    globalThis.indexedDB = {
        open(name) {
            const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: fakeDb(name) };
            queueMicrotask(() => {
                if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
            });
            queueMicrotask(() => {
                if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
        },
    };
}

installFakeIndexedDb();

const trust = await import('../public/js/crypto/keys/peer-trust.js');

/* ------------------------------------------------------------------ helpers */

/** A deterministic, obviously-fake 32-byte X25519-shaped public key. */
function fakeKey(seed) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = (seed * 37 + i * 101 + 13) % 256;
    }
    return trust.bytesToBase64(bytes);
}

const MINE = fakeKey(1);
const MINE_2 = fakeKey(2);
const THEIRS = fakeKey(9);
const THEIRS_2 = fakeKey(11);

const CTX = { origin: 'http://localhost:3000', ownUserId: 42 };
const PEER = 7;

let idbSave;
before(() => {
    idbSave = globalThis.indexedDB;
});
after(() => {
    globalThis.indexedDB = idbSave;
});

async function resetPin() {
    await trust.clearPeerPin(PEER, CTX);
}

/* ------------------------------------------------------------------ safety number */

test('the safety number does not depend on WHO computed it', async () => {
    const a = await trust.computeSafetyNumber(MINE, THEIRS);
    const b = await trust.computeSafetyNumber(THEIRS, MINE);

    assert.equal(a.fingerprint, b.fingerprint,
        'order-independence: both users must see the SAME number');
    assert.equal(a.number, b.number);
    assert.notEqual(a.fingerprint, MINE);
    assert.notEqual(a.fingerprint, THEIRS);
});

test('the safety number changes when EITHER key changes', async () => {
    const base = await trust.computeSafetyNumber(MINE, THEIRS);

    const mineChanged = await trust.computeSafetyNumber(MINE_2, THEIRS);
    assert.notEqual(base.fingerprint, mineChanged.fingerprint,
        'my own key changing must change the number');

    const theirsChanged = await trust.computeSafetyNumber(MINE, THEIRS_2);
    assert.notEqual(base.fingerprint, theirsChanged.fingerprint,
        "the peer's key changing must change the number");
});

test('the safety number is 60 digits in 12 groups of 5, with leading zeros kept', async () => {
    const { number } = await trust.computeSafetyNumber(MINE, THEIRS);

    const groups = number.split(' ');
    assert.equal(groups.length, 12, 'twelve groups');
    for (const g of groups) {
        assert.match(g, /^\d{5}$/, `group "${g}" must be exactly five digits`);
    }
    assert.equal(number.replace(/ /g, '').length, 60);
});

test('a digest that starts with zero bytes keeps its leading zero digits', () => {
    // A fixed all-zero digest is the deterministic leading-zero case. Without
    // padStart, this would print as "0 0 0 ..." and two numbers could differ only
    // in invisible padding - which is the one thing a comparison must not do.
    const zero = new Uint8Array(32);
    assert.equal(trust.formatSafetyNumber(zero), '00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000');

    // A digest whose top byte is 0 but which is not all zero: still 60 digits.
    const small = new Uint8Array(32);
    small[31] = 1;
    const formatted = trust.formatSafetyNumber(small);
    assert.equal(formatted.replace(/ /g, '').length, 60);
    assert.equal(formatted.split(' ')[0], '00000');
});

test('the hash input is length-prefixed and sorted, so it is unambiguous', () => {
    const a = trust.base64ToBytes(MINE);
    const b = trust.base64ToBytes(THEIRS);

    const ab = trust.safetyNumberPreimage(a, b);
    const ba = trust.safetyNumberPreimage(b, a);

    assert.deepEqual([...ab], [...ba], 'the preimage itself must be order-independent');

    const label = new TextEncoder().encode('wire-safety-number-v1');
    assert.deepEqual([...ab.slice(0, label.length)], [...label], 'domain separator comes first');

    // label | u32be(lenA) | A | u32be(lenB) | B
    const view = new DataView(ab.buffer, ab.byteOffset, ab.byteLength);
    const at = label.length;
    assert.equal(view.getUint32(at), 32, 'first key is length-prefixed');
    assert.equal(view.getUint32(at + 4 + 32), 32, 'second key is length-prefixed');

    // The smaller raw key must come first.
    const first = ab.slice(at + 4, at + 4 + 32);
    const second = ab.slice(at + 4 + 32 + 4);
    assert.ok(first[0] <= second[0], 'keys are ordered by their first byte');
});

test('a key that is not 32 bytes is rejected outright', async () => {
    await assert.rejects(
        () => trust.computeSafetyNumber(MINE, trust.bytesToBase64(new Uint8Array(16))),
        /32-byte X25519/
    );
});

/* ------------------------------------------------------------------ pin / alarm */

test('first contact pins the key and does NOT alarm', async () => {
    await resetPin();

    const first = await trust.evaluatePeerKey(PEER, THEIRS, CTX);
    assert.equal(first.state, 'first-contact', 'nothing pinned yet');

    await trust.pinOnFirstUse(PEER, THEIRS, CTX);

    const second = await trust.evaluatePeerKey(PEER, THEIRS, CTX);
    assert.equal(second.state, 'ok', 'the same key after pinning must not alarm');
});

test('pinOnFirstUse never overwrites an existing pin', async () => {
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);

    // A hostile "first use" later must not replace what we already trust.
    await trust.pinOnFirstUse(PEER, THEIRS_2, CTX);

    const evaluated = await trust.evaluatePeerKey(PEER, THEIRS, CTX);
    assert.equal(evaluated.state, 'ok', 'the original pin must survive');
});

test('an unrecognised key raises the alarm', async () => {
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);

    const changed = await trust.evaluatePeerKey(PEER, THEIRS_2, CTX);
    assert.equal(changed.state, 'changed');
    assert.equal(changed.pending.fingerprint, changed.fingerprint,
        'the pending key is the one to be confirmed with the user');
    assert.equal(changed.pending.publicKey, THEIRS_2);
});

test('accepting the new key clears the alarm AND remembers the old one', async () => {
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);
    assert.equal((await trust.evaluatePeerKey(PEER, THEIRS_2, CTX)).state, 'changed');

    const pin = await trust.acceptPeerKey(PEER, THEIRS_2, CTX);

    assert.equal((await trust.evaluatePeerKey(PEER, THEIRS_2, CTX)).state, 'ok',
        'after accepting, the new key is the trusted one');

    // Rotating back to the ORIGINAL key must not alarm: the user demonstrably
    // had that key, so it is "reknown", not a fresh MITM.
    assert.equal((await trust.evaluatePeerKey(PEER, THEIRS, CTX)).state, 'reknown');

    const fps = pin.accepted.map((k) => k.fingerprint);
    assert.ok(fps.length >= 2, 'both keys are remembered');
    assert.equal(new Set(fps).size, fps.length, 'no duplicate entries');
});

test('a normal PASSWORD change does not alarm: the identity key is unchanged', async () => {
    // This is the real credential flow's invariant. A password change re-wraps
    // the SAME PKCS#8 with a new salt/iterations; it does not generate a new key.
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);

    // Exactly what a password change produces: the same public key bytes.
    const sameKeyAfterPasswordChange = THEIRS;
    assert.equal((await trust.evaluatePeerKey(PEER, sameKeyAfterPasswordChange, CTX)).state, 'ok');

    // And with the pin written later in the "new password" session.
    await trust.markPeerVerified(PEER, CTX);
    assert.equal((await trust.evaluatePeerKey(PEER, THEIRS, CTX)).state, 'ok');
});

test('pins are namespaced by origin and by own account id', async () => {
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);

    const otherAccount = await trust.evaluatePeerKey(PEER, THEIRS, { ...CTX, ownUserId: 43 });
    assert.equal(otherAccount.state, 'first-contact', 'another account has its own pin store');

    const otherOrigin = await trust.evaluatePeerKey(PEER, THEIRS, { ...CTX, origin: 'http://elsewhere' });
    assert.equal(otherOrigin.state, 'first-contact', 'another origin has its own pin store');

    // The other half of the property, and the part that actually bites: a WRITE
    // by one account must not land on another account's record. Without
    // ownUserId in the record key, the second pin would overwrite the first and
    // account 42 would silently start trusting account 43's key.
    await trust.pinOnFirstUse(PEER, THEIRS_2, { ...CTX, ownUserId: 43 });

    assert.equal((await trust.evaluatePeerKey(PEER, THEIRS, CTX)).state, 'ok',
        "account 42's own pin must be untouched by account 43 writing a pin");
    assert.equal((await trust.evaluatePeerKey(PEER, THEIRS_2, CTX)).state, 'changed',
        "account 43 pinned a different key for the same peer, which account 42 must not inherit");

    // Same for origin: a write from another origin must not land on this record.
    await trust.pinOnFirstUse(PEER, THEIRS_2, { ...CTX, origin: 'http://elsewhere' });
    assert.equal((await trust.evaluatePeerKey(PEER, THEIRS, CTX)).state, 'ok',
        'this origin pin must be untouched by another origin writing one');
});

/* ------------------------------------------------------------------ wiring */

/**
 * The browser test drives dm-key-trust.js directly because the conversation
 * sidebar is not mounted in the state it needs. That leaves the question of
 * whether dm.js actually CALLS it - easy to break silently with a rename, a
 * deleted import or a moved guard. These static assertions exist precisely
 * because the behaviour itself is covered elsewhere.
 */
test('dm.js wires the trust gate into send, decrypt and the thread', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
        new URL('../public/js/chat/dm.js', import.meta.url),
        'utf8'
    );

    for (const [what, pattern] of [
        ['the send gate runs before encrypting', /await assertCanSendTo\(\s*dmActivePeer\.id\s*\)/],
        ['trust is resolved before a row is decrypted', /await resolveTrust\(peerId\)/],
        ['messages are held, not decrypted, while the key is unrecognised',
            /if \(shouldHoldMessage\(peerId\)\)\s*\{\s*holdMessage\(peerId, msg\)/],
        ['a held row does not fall through to the decrypt path',
            /if \(decrypted === null\)\s*\{\s*return;/],
        ['the thread renders the banner', /renderKeyTrustBanner\(peerId, username\)/],
        ['the thread renders the safety number', /renderVerifyView\(peerId, username\)/],
        ['accepting releases the held rows', /bindKeyTrustRelease\(peerId,/],
    ]) {
        assert.match(src, pattern, `dm.js must still wire: ${what}`);
    }
});

test('neither new module builds DOM from strings', async () => {
    const fs = await import('node:fs');

    for (const rel of [
        '../public/js/chat/dm-key-trust.js',
        '../public/js/crypto/keys/peer-trust.js',
    ]) {
        const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

        // Strip comments first: both files TALK ABOUT innerHTML, and a naive
        // grep matches its own documentation.
        const code = src
            .split('\n')
            .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
            .join('\n');

        for (const api of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
            assert.ok(
                !new RegExp(`\\b${api}\\b`).test(code),
                `${rel} must not use ${api}`
            );
        }
    }
});

test('retired key rule, first contact: allowed (no pin exists to check against)', async () => {
    await resetPin();

    const verdict = await trust.mayTryRetiredKey(PEER, THEIRS, CTX);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, 'first-contact',
        'with no pin there is nothing to check, which is the v15 behaviour unchanged');
});

test('retired key rule: a key this device already accepted IS allowed', async () => {
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);
    await trust.acceptPeerKey(PEER, THEIRS_2, CTX);

    const verdict = await trust.mayTryRetiredKey(PEER, THEIRS, CTX);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, 'previously-accepted',
        'history the user already had must stay readable');
});

test('retired key rule: the PINNED CURRENT key stays usable after the peer rotates', async () => {
    // The ordinary case, and the one the v15 history test caught: the user pins
    // Bob's key, Bob later rotates, and the retired key that decrypts their
    // history is exactly the pinned `current`. Checking only `accepted` refused it.
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);

    assert.equal((await trust.evaluatePeerKey(PEER, THEIRS_2, CTX)).state, 'changed',
        'the alarm still fires for the NEW key');

    const verdict = await trust.mayTryRetiredKey(PEER, THEIRS, CTX);
    assert.equal(verdict.allowed, true,
        'history sealed to the pinned key must stay readable after a rotation');
    assert.equal(verdict.reason, 'pinned-current');
});

test('retired key rule: an UNKNOWN retired key is REFUSED once a pin exists', async () => {
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);

    const stranger = await trust.mayTryRetiredKey(PEER, THEIRS_2, CTX);
    assert.equal(stranger.allowed, false,
        'after a key-change alarm, an unknown retired key must not be a second way in');
    assert.equal(stranger.reason, 'not-previously-accepted');
});

test('retired key rule: after accepting a new key, the OLD one is still allowed', async () => {
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);
    await trust.acceptPeerKey(PEER, THEIRS_2, CTX);

    // The old key is now in `accepted`, so decrypting old history still works.
    assert.equal((await trust.mayTryRetiredKey(PEER, THEIRS, CTX)).allowed, true);

    // But a key nobody ever saw is still refused.
    assert.equal((await trust.mayTryRetiredKey(PEER, MINE_2, CTX)).allowed, false);
});

test('first contact AFTER a rotation still lets you read the earlier history', async () => {
    // This is a real regression that the full suite caught, not a hypothetical.
    // The retired-key rule refuses a key that is not in `accepted`; but if the
    // user's FIRST contact happens after their peer has rotated, pinning only the
    // current key would lock them out of exactly the history the v15 archive
    // exists to preserve.
    //
    // So the first contact must record the peer's reported retired keys as
    // accepted too. That is TOFU, not a hole: at first contact there is nothing
    // to compare against, and every key arrived in the same server response.
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS_2, CTX, [THEIRS]);

    assert.equal((await trust.evaluatePeerKey(PEER, THEIRS_2, CTX)).state, 'ok');
    assert.equal((await trust.mayTryRetiredKey(PEER, THEIRS, CTX)).allowed, true,
        'history sealed to a key the server disclosed at first contact must stay readable');
});

test('first contact does NOT accept a key nobody disclosed', async () => {
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS_2, CTX, [THEIRS]);

    assert.equal((await trust.mayTryRetiredKey(PEER, MINE_2, CTX)).allowed, false,
        'only the keys the server actually listed may be seeded');
});