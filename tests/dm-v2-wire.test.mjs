// tests/dm-v2-wire.test.mjs
//
// STEP 1B: node-runnable units for the DM v2 wiring. No browser, no server.
// peer-trust.js uses WebCrypto + IndexedDB and core/auth.js reads localStorage at
// module load, so a tiny in-memory stand-in is installed BEFORE the imports below.
// The browser-level flow is tests/dm-v2-wire-browser.test.mjs.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/* ---------------------------------------------------------------- IndexedDB stand-in (peer-trust) */
function installFakeIndexedDb() {
    const stores = new Map();
    const store = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const request = (result) => {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result };
        queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
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
                        put(value, key) { if (mode === 'readwrite') data.set(key, value); return request(undefined); },
                        get(key) { const req = request(data.get(key)); queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); }); return req; },
                        delete(key) { if (mode === 'readwrite') data.delete(key); return request(undefined); },
                    };
                },
            };
            queueMicrotask(() => queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); }));
            return tx;
        },
    });
    const open = (name) => {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null };
        queueMicrotask(() => {
            req.result = fakeDb(name);
            if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    };
    globalThis.indexedDB = { open };
}
installFakeIndexedDb();

/* ---------------------------------------------------------------- localStorage stand-in */
const ls = new Map();
globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(k, String(v)); },
    removeItem: (k) => { ls.delete(k); },
    clear: () => { ls.clear(); },
};
globalThis.window = { location: { origin: 'http://127.0.0.1:5000' }, Capacitor: undefined };
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

before(async () => {
    // Nothing else to do; modules are imported below.
});

const {
    dmScopeKey,
    readDmV2Pin,
    noteDmV2Version,
    chooseDmVersion,
    assertDmVersionAllowed,
    DmDowngradeRefusedError,
    DM_V2_REPLAY_PER_CONV_MAX,
    DM_V2_REPLAY_MAX_CONVERSATIONS,
    DM_V2_MAX_CONTENT_CHARS,
    assertDmV2ContentFits,
    DmV2TooLargeError,
    classifyDmV2MsgId,
    DM_V2_MSGID_NEW,
    DM_V2_MSGID_SAME_ROW,
    DM_V2_MSGID_REPLAY,
    resetDmDowngradeNotices,
    takeDmDowngradeNotice,
    envelopeVersion,
    isDmV2Envelope
} = await import('../public/js/crypto/messages/dm-v2-wire.js');

const { setCurrentUser } = await import('../public/js/core/auth.js');
const { api } = await import('../public/js/core/api.js');

// dm-v2.js is pure WebCrypto; import for the payload-switch test.
const { validateEncryptedMessagePayload } = await import('../public/js/crypto/messages/payload.js');
const { encryptDmV2, decryptDmV2 } = await import('../public/js/crypto/messages/dm-v2.js');
const { decryptIncomingMessage } = await import('../public/js/crypto/messages/message-crypto.js');

// ---------------------------------------------------------------- dmScopeKey
test('dmScopeKey: format is endpoint|ownUserId|peerId', () => {
    assert.equal(dmScopeKey('http://x', 12, 34), 'http://x|12|34');
});

test('dmScopeKey: collides neither across endpoints nor across accounts nor peers', () => {
    const a = dmScopeKey('http://a', 1, 2);
    const seen = new Set([
        dmScopeKey('http://b', 1, 2),
        dmScopeKey('http://a', 2, 2),
        dmScopeKey('http://a', 1, 3),
    ]);
    for (const v of seen) assert.notEqual(v, a);
    assert.equal(new Set([a, ...seen]).size, 4);
});

// ---------------------------------------------------------------- version choice
test('chooseDmVersion: peer min 1 -> 1', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    assert.equal(chooseDmVersion(34, 1), 1);
});

test('chooseDmVersion: peer min 2 -> 2', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    assert.equal(chooseDmVersion(34, 2), 2);
});

test('chooseDmVersion: peer min 2 + garbage -> 2 (clamped)', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    assert.equal(chooseDmVersion(34, 'abc'), 1);
    assert.equal(chooseDmVersion(34, 99), 2);
});

test('chooseDmVersion: pinned at 2 forces 2 even if peer min is 1', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    noteDmV2Version(34, 2);
    assert.equal(chooseDmVersion(34, 1), 2);
});

test('assertDmVersionAllowed: v1 to a pinned-2 peer throws DmDowngradeRefusedError', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    noteDmV2Version(34, 2);
    assert.throws(() => assertDmVersionAllowed(34, 1), (e) => e instanceof DmDowngradeRefusedError && e.code === 'DM_DOWNGRADE_REFUSED');
});

test('assertDmVersionAllowed: v2 to a pinned-2 peer is fine', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    noteDmV2Version(34, 2);
    assert.doesNotThrow(() => assertDmVersionAllowed(34, 2));
});

test('assertDmVersionAllowed: v1 to an unpinned peer is fine', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    assert.doesNotThrow(() => assertDmVersionAllowed(34, 1));
});

// ---------------------------------------------------------------- pin storage
test('readDmV2Pin: defaults to 1 and never lowers', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    assert.equal(readDmV2Pin(34), 1);
    noteDmV2Version(34, 2);
    assert.equal(readDmV2Pin(34), 2);
    noteDmV2Version(34, 1);
    assert.equal(readDmV2Pin(34), 2);
});

test('readDmV2Pin: cross-account isolation', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    noteDmV2Version(34, 2);
    setCurrentUser({ id: 8, groups_enabled: true });
    assert.equal(readDmV2Pin(34), 1, 'account 8 must not see account 7 pin');
});

test('readDmV2Pin: cross-origin isolation', () => {
    ls.clear();
    setCurrentUser({ id: 7, groups_enabled: true });
    noteDmV2Version(34, 2);
    globalThis.window.location.origin = 'http://127.0.0.1:5001';
    assert.equal(readDmV2Pin(34), 1, 'different origin must not see the pin');
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
});

// ---------------------------------------------------------------- storage unavailable -> no-op
test('storage unavailable: readDmV2Pin -> 1, noteDmV2Version does not throw', () => {
    const real = globalThis.localStorage;
    globalThis.localStorage = {
        getItem: () => { throw new Error('no storage'); },
        setItem: () => { throw new Error('no storage'); },
        removeItem: () => {},
        clear: () => {}
    };
    try {
        setCurrentUser({ id: 7, groups_enabled: true });
        assert.equal(readDmV2Pin(34), 1);
        assert.doesNotThrow(() => noteDmV2Version(34, 2));
        assert.equal(readDmV2Pin(34), 1);
    } finally {
        globalThis.localStorage = real;
    }
});

// ---------------------------------------------------------------- payload switch
test('validateEncryptedMessagePayload: v1 path is unchanged', () => {
    const iv = Buffer.alloc(12, 0xa5).toString('base64');
    const ct = Buffer.from('deadbeef', 'hex').toString('base64');
    const p = { encryption: { version: 1, algorithm: 'AES-GCM', iv, ciphertext: ct }, senderId: 1, recipientId: 2 };
    const out = validateEncryptedMessagePayload(p);
    assert.equal(out.version, 1);
    assert.equal(out.algorithm, 'AES-GCM');
});

test('validateEncryptedMessagePayload: v2 delegates to validateDmV2Envelope', () => {
    const env = { encryption: { version: 2, algorithm: 'AES-GCM', iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.from('aa', 'hex').toString('base64'), senderFp: Buffer.alloc(32).toString('base64'), msgId: '0123456789abcdef' }, senderId: 12, recipientId: 34 };
    const out = validateEncryptedMessagePayload(env);
    assert.equal(out.version, 2);
    assert.equal(out.senderId, 12);
});

test('validateEncryptedMessagePayload: version 3 throws "Unsupported encryption version"', () => {
    const p = { encryption: { version: 3, algorithm: 'AES-GCM', iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.from('aa', 'hex').toString('base64') } };
    assert.throws(() => validateEncryptedMessagePayload(p), /Unsupported encryption version/);
});

test('validateEncryptedMessagePayload: missing version throws', () => {
    const p = { encryption: { algorithm: 'AES-GCM', iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.from('aa', 'hex').toString('base64') } };
    assert.throws(() => validateEncryptedMessagePayload(p));
});

// ---------------------------------------------------------------- decryptIncomingMessage on v2 throws
test('decryptIncomingMessage on a v2 payload throws (no context)', async () => {
    const iv = Buffer.alloc(12).toString('base64');
    const ct = Buffer.from('aa', 'hex').toString('base64');
    const fp = Buffer.alloc(32).toString('base64');
    const p = { encryption: { version: 2, algorithm: 'AES-GCM', iv, ciphertext: ct, senderFp: fp, msgId: '0123456789abcdef' }, senderId: 12, recipientId: 34 };
    await assert.rejects(() => decryptIncomingMessage(p, 34), /cannot read a v2 payload/);
});

// ---------------------------------------------------------------- replay store
test('classifyDmV2MsgId: new -> same-row -> replay', () => {
    ls.clear();
    setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
    const m = '0123456789abcdef';
    assert.equal(classifyDmV2MsgId(34, m, 100), DM_V2_MSGID_NEW);
    assert.equal(classifyDmV2MsgId(34, m, 100), DM_V2_MSGID_SAME_ROW);
    assert.equal(classifyDmV2MsgId(34, m, 101), DM_V2_MSGID_REPLAY);
});

test('classifyDmV2MsgId: different msgId is new', () => {
    ls.clear();
    setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
    assert.equal(classifyDmV2MsgId(34, '0123456789abcdef', 100), DM_V2_MSGID_NEW);
    assert.equal(classifyDmV2MsgId(34, 'fedcba9876543210', 101), DM_V2_MSGID_NEW);
});

test('classifyDmV2MsgId: no rowId -> not accounted', () => {
    ls.clear();
    setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
    const m = '0123456789abcdef';
    assert.equal(classifyDmV2MsgId(34, m, null), DM_V2_MSGID_NEW);
    // still not accounted, so a second call with a real row is "new"
    assert.equal(classifyDmV2MsgId(34, m, 100), DM_V2_MSGID_NEW);
});

test('classifyDmV2MsgId: FIFO eviction at the cap', () => {
    ls.clear();
    setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
    const cap = DM_V2_REPLAY_PER_CONV_MAX;
    // fill
    for (let i = 0; i < cap; i++) {
        const id = i.toString(16).padStart(16, '0');
        classifyDmV2MsgId(34, id, i + 1);
    }
    const first = (0).toString(16).padStart(16, '0');
    // one more, NEW msgId, triggers eviction of the oldest
    const trigger = (cap + 1).toString(16).padStart(16, '0');
    assert.equal(classifyDmV2MsgId(34, trigger, cap + 2), DM_V2_MSGID_NEW);
    // first should now be evicted
    assert.equal(classifyDmV2MsgId(34, first, 999999), DM_V2_MSGID_NEW);
});

test('classifyDmV2MsgId: cross-account isolation', () => {
    ls.clear();
    setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
    const m = '0123456789abcdef';
    classifyDmV2MsgId(34, m, 100);
    setCurrentUser({ id: 10, groups_enabled: true });
    // account 10 must not see account 9's record
    assert.equal(classifyDmV2MsgId(34, m, 200), DM_V2_MSGID_NEW);
});

test('classifyDmV2MsgId: cross-origin isolation', () => {
    ls.clear();
    setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
    const m = '0123456789abcdef';
    classifyDmV2MsgId(34, m, 100);
    globalThis.window.location.origin = 'http://127.0.0.1:5001';
    assert.equal(classifyDmV2MsgId(34, m, 200), DM_V2_MSGID_NEW);
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
});

// ---------------------------------------------------------------- 2A.0 replay bypass (KNOWN BUG; fixed in 2A.1)
//
// The reviewer reproduced this in node: msgId is NOT in the AAD, the store is
// keyed by msgId, so a server that copies a row to a new id AND changes the
// clear msgId is not detected as a replay. These three tests pin the CURRENT
// behaviour. 2A.1 flips the first one: the key becomes the AAD-bound iv.
test('2A.0 KNOWN BUG: the msgId-keyed store accepts a row COPIED to a new id when the server swaps the msgId', async () => {
    ls.clear();
    setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
    const m1 = '0123456789abcdef';
    const m2 = 'fedcba9876543210';

    // Row R1 arrives and is accounted as new.
    assert.equal(classifyDmV2MsgId(34, m1, 100), DM_V2_MSGID_NEW);
    // The server copies R1's ciphertext to R2 and changes the clear msgId.
    // Keyed by msgId, this looks like a brand-new message. That is the bypass.
    assert.equal(
        classifyDmV2MsgId(34, m2, 101),
        DM_V2_MSGID_NEW,
        'KNOWN BUG (2A.0): the replay key is msgId, which the server controls'
    );

    // And no key check can catch it, because msgId is deliberately NOT in the
    // AAD (design 4.3): the copied ciphertext still opens under the same key.
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const fp = crypto.getRandomValues(new Uint8Array(32));
    const { envelope } = await encryptDmV2({
        plaintext: 'hello',
        fromUserId: 12,
        toUserId: 34,
        senderKeyFp: fp,
        key,
        iv: crypto.getRandomValues(new Uint8Array(12)),
        msgId: m1
    });
    const copied = JSON.parse(JSON.stringify(envelope));
    copied.encryption.msgId = m2;
    assert.equal(
        await decryptDmV2({ envelope: copied, senderKeyFp: fp, key, replyToId: 0 }),
        'hello',
        'KNOWN BUG (2A.0): swapping msgId does not break decryption - it is not bound'
    );
});

test('2A.0: the same row opened twice is not a replay; a lazy copy (same msgId, new row) is', () => {
    ls.clear();
    setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
    const m = '0123456789abcdef';
    assert.equal(classifyDmV2MsgId(34, m, 100), DM_V2_MSGID_NEW);
    assert.equal(classifyDmV2MsgId(34, m, 100), DM_V2_MSGID_SAME_ROW);
    assert.equal(classifyDmV2MsgId(34, m, 101), DM_V2_MSGID_REPLAY);
});

test('2A.0: the iv IS bound - a server that swaps it fails the AEAD, so it is the right replay key', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const fp = crypto.getRandomValues(new Uint8Array(32));
    const { envelope } = await encryptDmV2({
        plaintext: 'hello',
        fromUserId: 12,
        toUserId: 34,
        senderKeyFp: fp,
        key,
        iv: crypto.getRandomValues(new Uint8Array(12)),
        msgId: '0123456789abcdef'
    });

    // Positive control: the untouched envelope opens.
    assert.equal(await decryptDmV2({ envelope, senderKeyFp: fp, key, replyToId: 0 }), 'hello');

    // Swap the iv for another 12-byte one: the AAD and the GCM nonce change,
    // so this is an authentication failure, not a replay verdict.
    const swapped = JSON.parse(JSON.stringify(envelope));
    swapped.encryption.iv = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64');
    await assert.rejects(
        () => decryptDmV2({ envelope: swapped, senderKeyFp: fp, key, replyToId: 0 }),
        (e) => !/replay/i.test(String(e && e.message)),
        'a swapped iv must fail as an AEAD error, not be excused as a replay'
    );
});

// ---------------------------------------------------------------- 2000-char boundary
test('assertDmV2ContentFits: 2000 passes, 2001 throws', () => {
    assert.equal(assertDmV2ContentFits(2000), 2000);
    assert.throws(() => assertDmV2ContentFits(2001), (e) => e instanceof DmV2TooLargeError);
});

test('assertDmV2ContentFits: negative / non-integer throws', () => {
    assert.throws(() => assertDmV2ContentFits(-1));
    assert.throws(() => assertDmV2ContentFits(1.5));
});

test('DM_V2_MAX_CONTENT_CHARS is 2000', () => {
    assert.equal(DM_V2_MAX_CONTENT_CHARS, 2000);
});

// ---------------------------------------------------------------- misc
test('envelopeVersion / isDmV2Envelope', () => {
    assert.equal(envelopeVersion({ encryption: { version: 2 } }), 2);
    assert.equal(envelopeVersion({ encryption: { version: 1 } }), 1);
    assert.equal(envelopeVersion({}), null);
    assert.equal(isDmV2Envelope({ encryption: { version: 2 } }), true);
    assert.equal(isDmV2Envelope({ encryption: { version: 1 } }), false);
});

test('resetDmDowngradeNotices + takeDmDowngradeNotice: once per conversation', () => {
    ls.clear();
    setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = 'http://127.0.0.1:5000';
    resetDmDowngradeNotices();
    assert.equal(takeDmDowngradeNotice(34), true);
    assert.equal(takeDmDowngradeNotice(34), false);
    assert.equal(takeDmDowngradeNotice(35), true);

    // The page-load leg (STEP 1I.2). Without it this test only pins "once per
    // conversation", not the rule that actually exists: "once per PAGE LOAD".
    // That distinction is exactly what STEP 1G's browser plant could not reach -
    // the browser test cannot call the notice a second time, so the one-shot flag
    // was untestable there. Here a fresh module state stands in for a reload.
    resetDmDowngradeNotices();
    assert.equal(takeDmDowngradeNotice(34), true);
    assert.equal(takeDmDowngradeNotice(34), false);
});