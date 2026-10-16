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

test('markPeerVerified records a real timestamp and returns the updated pin', async () => {
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);

    const before = await trust.getPeerPin(PEER, CTX);
    assert.equal(before.verifiedAt, null, 'nothing is verified before the user says so');

    const marked = await trust.markPeerVerified(PEER, CTX);

    assert.ok(marked, 'markPeerVerified must return the updated pin, not null');
    assert.equal(typeof marked.verifiedAt, 'number', 'verifiedAt must be a timestamp');
    assert.ok(marked.verifiedAt >= before.current.at,
        'verifiedAt must not predate the pin it belongs to');
    assert.equal(marked.current.fingerprint, before.current.fingerprint,
        'marking must not change WHICH key is current');

    // And it must be persisted, not just returned.
    const reread = await trust.getPeerPin(PEER, CTX);
    assert.equal(reread.verifiedAt, marked.verifiedAt);
});

test('marking a peer verified does NOT suppress the key-change alarm', async () => {
    // "Verified" is a label the user attaches, not a bypass. If it silenced the
    // alarm, one click would disarm the whole check for that conversation.
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);
    await trust.markPeerVerified(PEER, CTX);

    const changed = await trust.evaluatePeerKey(PEER, THEIRS_2, CTX);
    assert.equal(changed.state, 'changed',
        'an unrecognised key must still alarm on a verified conversation');
    assert.ok(changed.pending, 'and the pending key must still be reported for confirmation');
});

test('markPeerVerified on a peer with no pin returns null rather than inventing one', async () => {
    await resetPin();
    assert.equal(await trust.getPeerPin(PEER, CTX), null);
    assert.equal(await trust.markPeerVerified(PEER, CTX), null,
        'verifying a peer we have never met must not create a trust record');
});

test('a password change does not alarm, because it re-wraps the SAME key', async () => {
    // The real credential flow's invariant: prepareCredentialChange()
    // re-encrypts the existing PKCS#8 under a new salt and never generates a new
    // key pair, so the public key - and therefore the fingerprint - is unchanged.
    // Asserted here as the property the browser test proves end to end.
    await resetPin();
    await trust.pinOnFirstUse(PEER, THEIRS, CTX);

    // Same bytes => same state, and specifically NOT 'changed'.
    const after = await trust.evaluatePeerKey(PEER, THEIRS, CTX);
    assert.equal(after.state, 'ok');
    assert.equal(after.pending, null);

    // The fingerprint is a pure function of the key, so a re-wrap cannot move it.
    const again = await trust.computeSafetyNumber(MINE, THEIRS);
    const onceMore = await trust.computeSafetyNumber(MINE, THEIRS);
    assert.equal(again.fingerprint, onceMore.fingerprint);
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

/**
 * Strip JS comments properly - including TRAILING ones, which the previous
 * version missed entirely.
 *
 * That version filtered lines starting with `*`, `//` or `/*`, which handles
 * whole-line comments and nothing else. `text.textContent = x; // not innerHTML`
 * would have matched and failed the build, and a block comment's closing lines
 * would have been treated as code. Both directions of that are bad: a false
 * failure, and a real violation hidden inside a comment-looking line.
 *
 * Not a full parser - string literals are not tracked - but it handles the three
 * comment forms correctly, which is what this check needs.
 */
function stripComments(src) {
    let out = '';
    let i = 0;

    while (i < src.length) {
        const two = src.slice(i, i + 2);

        if (two === '//') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }

        if (two === '/*') {
            i += 2;
            while (i < src.length && src.slice(i, i + 2) !== '*/') i++;
            i += 2;
            continue;
        }

        out += src[i];
        i++;
    }

    return out;
}

/**
 * A `//` that sits INSIDE a string or a regex would be eaten as a comment by the
 * stripper above, which is fine for the answer but a trap for the check: a
 * violation later on that same line would vanish with it.
 *
 * Neither module does this today. Asserting it means that if a future edit adds
 * a URL or a regex, this test fails loudly and says why, instead of quietly
 * becoming weaker.
 */
function assertNoSlashSlashInStrings(rel, src) {
    const suspects = [];

    src.split('\n').forEach((line, n) => {
        const at = line.indexOf('//');
        if (at === -1) return;
        const before = line.slice(0, at);
        const odd = (q) => before.split(q).length % 2 === 0;   // unbalanced quote
        if (odd("'") || odd('"') || odd('`')) {
            suspects.push(`L${n + 1}: ${line.trim().slice(0, 90)}`);
        }
    });

    assert.deepEqual(suspects, [],
        `${rel} contains a "//" inside a string, which the comment stripper would ` +
        `swallow - make stripComments() string-aware before adding one:\n  ${suspects.join('\n  ')}`);
}

test('neither new module builds DOM from a string, by source or by API', async () => {
    const fs = await import('node:fs');

    for (const rel of [
        '../public/js/chat/dm-key-trust.js',
        '../public/js/crypto/keys/peer-trust.js',
    ]) {
        const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
        assertNoSlashSlashInStrings(rel, src);

        const code = stripComments(src);

        // Direct HTML sinks.
        for (const api of [
            'innerHTML',
            'outerHTML',
            'insertAdjacentHTML',
            'document.write',
            'createContextualFragment',
        ]) {
            assert.ok(
                !new RegExp(`\\b${api}\\b`).test(code),
                `${rel} must not use ${api} (comments are stripped, so this is a real use)`
            );
        }

        // An event handler built as an attribute rather than parsed from markup:
        // setAttribute('onerror', ...) / element.onclick = ... would execute just
        // as surely as innerHTML, and no amount of escaping inside markup stops
        // them.
        //
        // Only checked for modules that actually touch `document`, because a bare
        // `.onerror =` is indistinguishable from the IndexedDB request callback
        // of the same name - peer-trust has nine `tx.onerror` / `request.onerror`
        // lines and none of them is a DOM handler. Asserting the DOM rule there
        // would be a false alarm that teaches people to ignore the rule.
        //
        // There is deliberately NO `.onxxx =` regex here. It cannot tell
        // `el.onclick =` from `request.onerror =`, so it is either a false alarm
        // or, once loosened enough to be useful, a rule that matches almost
        // anything. The real check for handler properties is the DOM-level one in
        // tests/peer-trust-browser.test.mjs, which CAN tell them apart.
        const touchesDom = /\bdocument\b/.test(code);

        if (touchesDom) {
            assert.ok(!/\.setAttribute\s*\(\s*['"`]on/i.test(code),
                `${rel} must not setAttribute('on*', ...)`);
            // Parsing is only dangerous when the result reaches the document.
            assert.ok(!/\bDOMParser\b/.test(code) || !/\bappendChild\b|\breplaceChildren\b|\binnerHTML\b/.test(code),
                `${rel} must not build DOM nodes from a parsed string`);

            // And the positive side: a module that renders must be USING the safe
            // path, or this passes on a module that renders nothing at all.
            assert.ok(/\btextContent\b|\bcreateTextNode\b/.test(code),
                `${rel} renders, so it must render through textContent/createTextNode`);
        } else {
            assert.ok(!/\bdocument\b/.test(code),
                `${rel} touches no DOM and must not reach for one`);
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