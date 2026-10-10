// Phase C1: the per-message signing primitive (public/js/crypto/groups/signing.js).
// Pure unit tests: no KDM, no storage wiring (that is C2/C3/C4). The one storage
// touchpoint is the malleability test, which uses the REAL replay seen-set.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installWebLocksPolyfill, newDeviceStorage, useDeviceStorage } from './helpers.mjs';

installWebLocksPolyfill();

const S = await import('../../public/js/crypto/groups/signing.js');
const store = await import('../../public/js/crypto/groups/sender-key-store.js');

const hex = (u8) => Buffer.from(u8).toString('hex');
const ID = 'a'.repeat(64);

function baseFields(over = {}) {
    return {
        groupId: 7,
        senderKeyId: ID,
        counter: 41,
        iv: Uint8Array.from({ length: 12 }, (_, i) => i + 1),
        ciphertext: Uint8Array.from({ length: 40 }, (_, i) => (i * 7) & 0xff),
        replyToId: 123,
        attachment: new Uint8Array(0),
        ...over,
    };
}

async function newPair() {
    const { privateKey, publicKeyRaw } = await S.generateSigningKeyPair();
    const verifyKey = await S.importVerifyKey(publicKeyRaw);
    return { privateKey, publicKeyRaw, verifyKey };
}

// small deterministic PRNG so the property test is reproducible
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

/* ---------------------------------------------------------------- basics */

test('round trip: sign then verify; signature is raw P1363 of exactly 64 bytes; public key is 65 bytes 0x04||X||Y', async () => {
    const { privateKey, publicKeyRaw, verifyKey } = await newPair();
    assert.equal(publicKeyRaw.length, 65);
    assert.equal(publicKeyRaw[0], 0x04);

    const f = baseFields();
    const sig = await S.signMessage(privateKey, f);

    assert.ok(sig instanceof Uint8Array);
    assert.equal(sig.length, 64);
    assert.equal(await S.verifyMessage(verifyKey, sig, f), true);
    // not a DER signature (DER starts with 0x30 and is 70-72 bytes)
    assert.notEqual(sig.length, 70);
});

test('a reply_to_id of null (no reply) round-trips too', async () => {
    const { privateKey, verifyKey } = await newPair();
    const f = baseFields({ replyToId: null });
    assert.equal(await S.verifyMessage(verifyKey, await S.signMessage(privateKey, f), f), true);
    const g = baseFields({ replyToId: undefined });
    assert.equal(await S.verifyMessage(verifyKey, await S.signMessage(privateKey, g), f), true, 'undefined == null');
});

test('the imported verify key is non-extractable and verify-only', async () => {
    const { verifyKey } = await newPair();
    assert.equal(verifyKey.extractable, false);
    assert.deepEqual([...verifyKey.usages], ['verify']);
});

/* ------------------------------------------------------------- tampering */

test('tampering with ANY single signed field makes verification fail', async () => {
    const { privateKey, verifyKey } = await newPair();
    const f = baseFields();
    const sig = await S.signMessage(privateKey, f);
    assert.equal(await S.verifyMessage(verifyKey, sig, f), true);

    const flip = (u8, i = 0) => { const c = u8.slice(); c[i] ^= 0x01; return c; };

    const tampered = {
        groupId: { groupId: f.groupId + 1 },
        senderKeyId: { senderKeyId: 'b'.repeat(64) },
        'senderKeyId (one char)': { senderKeyId: ID.slice(0, 63) + 'b' },
        counter: { counter: f.counter + 1 },
        'iv (first byte = prefix)': { iv: flip(f.iv, 0) },
        'iv (last byte = counter)': { iv: flip(f.iv, 11) },
        'ciphertext (first byte)': { ciphertext: flip(f.ciphertext, 0) },
        'ciphertext (last byte = GCM tag)': { ciphertext: flip(f.ciphertext, f.ciphertext.length - 1) },
        'ciphertext (truncated)': { ciphertext: f.ciphertext.slice(0, -1) },
        'ciphertext (extended)': { ciphertext: Uint8Array.from([...f.ciphertext, 0]) },
        'reply_to_id (changed)': { replyToId: 124 },
        'reply_to_id (removed)': { replyToId: null },
        'attachment slot (filled)': { attachment: Uint8Array.of(1) },
    };

    for (const [name, over] of Object.entries(tampered)) {
        assert.equal(await S.verifyMessage(verifyKey, sig, { ...f, ...over }), false, `${name} must fail`);
    }

    // and the reverse: signed WITHOUT a reply, a reply cannot be added
    const noReply = baseFields({ replyToId: null });
    const sig2 = await S.signMessage(privateKey, noReply);
    assert.equal(await S.verifyMessage(verifyKey, sig2, { ...noReply, replyToId: 123 }), false, 'reply added');
});

test('a signature made with a different key does not verify', async () => {
    const a = await newPair();
    const b = await newPair();
    const f = baseFields();
    const sig = await S.signMessage(a.privateKey, f);
    assert.equal(await S.verifyMessage(a.verifyKey, sig, f), true);
    assert.equal(await S.verifyMessage(b.verifyKey, sig, f), false);
});

test('signature bytes: any bit flip, any wrong length, non-bytes -> false and never throws', async () => {
    const { privateKey, verifyKey } = await newPair();
    const f = baseFields();
    const sig = await S.signMessage(privateKey, f);

    for (const i of [0, 1, 31, 32, 33, 63]) {
        const bad = sig.slice();
        bad[i] ^= 0x80;
        assert.equal(await S.verifyMessage(verifyKey, bad, f), false, `bit flip at ${i}`);
    }

    for (const bad of [
        sig.slice(0, 63),
        Uint8Array.from([...sig, 0]),
        new Uint8Array(0),
        new Uint8Array(64), // all zeros: r = s = 0
        new Uint8Array(65),
        null,
        undefined,
        'abc',
        {},
        [...sig],
        sig.buffer,
    ]) {
        assert.equal(await S.verifyMessage(verifyKey, bad, f), false);
    }
});

test('verifyMessage fails closed on a bad key or bad fields, never throwing', async () => {
    const { privateKey, verifyKey } = await newPair();
    const f = baseFields();
    const sig = await S.signMessage(privateKey, f);

    for (const badKey of [null, undefined, {}, 'x', privateKey]) {
        assert.equal(await S.verifyMessage(badKey, sig, f), false);
    }

    for (const badFields of [
        null,
        undefined,
        {},
        baseFields({ iv: new Uint8Array(11) }),
        baseFields({ groupId: 0 }),
        baseFields({ counter: -1 }),
        baseFields({ counter: 1.5 }),
        baseFields({ replyToId: 0 }),
        baseFields({ replyToId: '123' }),
        baseFields({ ciphertext: new Uint8Array(0) }),
        baseFields({ senderKeyId: '' }),
        baseFields({ senderKeyId: 5 }),
    ]) {
        assert.equal(await S.verifyMessage(verifyKey, sig, badFields), false);
    }
});

/* -------------------------------------------------------------- encoder */

test('encodeSignedBytes rejects malformed fields with SigningFormatError (and signMessage too)', async () => {
    const { privateKey } = await newPair();

    for (const bad of [
        baseFields({ groupId: 0 }),
        baseFields({ groupId: 1.5 }),
        baseFields({ groupId: '7' }),
        baseFields({ senderKeyId: '' }),
        baseFields({ counter: -1 }),
        baseFields({ counter: Number.MAX_SAFE_INTEGER + 1 }),
        baseFields({ iv: new Uint8Array(13) }),
        baseFields({ iv: 'x'.repeat(12) }),
        baseFields({ ciphertext: new Uint8Array(0) }),
        baseFields({ ciphertext: [1, 2, 3] }),
        baseFields({ replyToId: 0 }),
        baseFields({ replyToId: -3 }),
        baseFields({ replyToId: 2.5 }),
        baseFields({ replyToId: '5' }),
        baseFields({ attachment: 'x' }),
    ]) {
        assert.throws(() => S.encodeSignedBytes(bad), S.SigningFormatError);
        await assert.rejects(() => S.signMessage(privateKey, bad), S.SigningFormatError);
    }
});

test('the signed bytes start with the domain-separation label and a different label gives a different signature domain', async () => {
    const f = baseFields();
    const bytes = S.encodeSignedBytes(f);
    const label = new TextEncoder().encode('wire-group-msg-sig/v1');

    // field 0 = type byte (0 = text), u32 length, label
    assert.equal(bytes[0], 0);
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(1), label.length);
    assert.deepEqual([...bytes.slice(5, 5 + label.length)], [...label]);

    // a signature over the same fields under another label (or over the message AAD)
    // must not verify as a group message signature
    const { privateKey, verifyKey } = await newPair();
    const { encodeFields } = await import('../../public/js/crypto/groups/codec.js');
    const otherLabel = encodeFields('wire-group-msg-sig/v0', f.groupId, f.senderKeyId, f.counter, f.iv, f.ciphertext, String(f.replyToId), new Uint8Array(0));
    const foreign = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, otherLabel));
    assert.equal(foreign.length, 64);
    assert.equal(await S.verifyMessage(verifyKey, foreign, f), false, 'other label');

    const mc = await import('../../public/js/crypto/groups/message-crypto.js');
    const aad = mc.messageAad(f.groupId, f.senderKeyId, f.counter, f.iv);
    const overAad = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, aad));
    assert.equal(await S.verifyMessage(verifyKey, overAad, f), false, 'signature over the AES-GCM AAD');
});

test('encoding is unambiguous: two different field tuples never encode to the same bytes (property test)', async () => {
    const rnd = prng(0xC1C1);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const bytesOf = (n) => Uint8Array.from({ length: n }, () => pick([0, 1, 2, 3, 0x30, 0x7f, 0xff]));

    // tiny alphabets and boundary-shifting shapes force near-collisions
    const ids = ['a', 'b', 'ab', 'a'.repeat(64), `a${'\u0000'}b`, '1', '12', '1\u00002', 'wire-group-msg-sig/v1', '\u0000\u0000\u0000\u0001a'];
    const groups = [1, 2, 12, 123, 7];
    const counters = [0, 1, 2, 12, 123, 256, Number.MAX_SAFE_INTEGER];
    const replies = [null, 1, 2, 12, 123];
    const ivs = [new Uint8Array(12), Uint8Array.from({ length: 12 }, (_, i) => i), Uint8Array.from({ length: 12 }, () => 0xff)];

    function randomTuple() {
        return {
            groupId: pick(groups),
            senderKeyId: pick(ids),
            counter: pick(counters),
            iv: pick(ivs),
            ciphertext: bytesOf(1 + Math.floor(rnd() * 6)),
            replyToId: pick(replies),
            attachment: bytesOf(Math.floor(rnd() * 4)),
        };
    }

    const canon = (t) => JSON.stringify([t.groupId, t.senderKeyId, t.counter, [...t.iv], [...t.ciphertext], t.replyToId, [...t.attachment]]);
    const seen = new Map();
    let distinct = 0;

    for (let i = 0; i < 40000; i++) {
        const t = randomTuple();
        const enc = hex(S.encodeSignedBytes(t));
        const c = canon(t);
        const prior = seen.get(enc);
        if (prior === undefined) {
            seen.set(enc, c);
            distinct++;
        } else {
            assert.equal(prior, c, 'two different tuples encoded to identical bytes');
        }
    }
    assert.ok(distinct > 500, `property test must exercise many distinct tuples (got ${distinct})`);

    // hand-picked boundary shifts the random generator might miss
    const t0 = randomTuple();
    const pairs = [
        [{ ...t0, ciphertext: Uint8Array.of(1, 2), attachment: Uint8Array.of(3) }, { ...t0, ciphertext: Uint8Array.of(1), attachment: Uint8Array.of(2, 3) }],
        [{ ...t0, replyToId: null, attachment: new Uint8Array(0) }, { ...t0, replyToId: 1, attachment: new Uint8Array(0) }],
        [{ ...t0, senderKeyId: '1', counter: 23 }, { ...t0, senderKeyId: '12', counter: 3 }],
        [{ ...t0, groupId: 1, counter: 23 }, { ...t0, groupId: 12, counter: 3 }],
    ];
    for (const [a, b] of pairs) {
        assert.notEqual(hex(S.encodeSignedBytes(a)), hex(S.encodeSignedBytes(b)));
    }
});

/* -------------------------------------------------------------- public key */

test('importVerifyKey fails closed on every malformed public key', async () => {
    const { publicKeyRaw } = await newPair();

    // sanity: the good key imports
    await S.importVerifyKey(publicKeyRaw);

    const withByte0 = (b) => { const c = publicKeyRaw.slice(); c[0] = b; return c; };
    const offCurve = publicKeyRaw.slice();
    offCurve[64] ^= 0x01; // same X, wrong Y: not on the curve

    const bad = {
        'empty': new Uint8Array(0),
        '64 bytes': publicKeyRaw.slice(0, 64),
        '66 bytes': Uint8Array.from([...publicKeyRaw, 0]),
        'compressed length (33)': publicKeyRaw.slice(0, 33),
        'first byte 0x00': withByte0(0x00),
        'first byte 0x02': withByte0(0x02),
        'first byte 0x03': withByte0(0x03),
        'first byte 0x05': withByte0(0x05),
        'point off the curve': offCurve,
        'all zeros after 0x04': Uint8Array.from([4, ...new Uint8Array(64)]),
        'X = Y = 0xff': Uint8Array.from([4, ...new Uint8Array(64).fill(0xff)]),
        'not bytes (array)': [...publicKeyRaw],
        'not bytes (base64 string)': Buffer.from(publicKeyRaw).toString('base64'),
        'null': null,
    };

    for (const [name, key] of Object.entries(bad)) {
        await assert.rejects(() => S.importVerifyKey(key), S.SigningFormatError, name);
    }
});

/* -------------------------------------------------------------- malleability */

const N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;

function flipS(sig) {
    const s = BigInt('0x' + hex(sig.slice(32)));
    const out = sig.slice();
    out.set(Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex'), 32);
    return out;
}

test('(r, n-s) is a second valid signature, but it cannot create a second accepted message: acceptance is keyed by (senderKeyId, nonce) in the seen-set', async () => {
    useDeviceStorage(newDeviceStorage());

    const { privateKey, verifyKey } = await newPair();
    const f = baseFields();
    const sig = await S.signMessage(privateKey, f);
    const sig2 = flipS(sig);

    assert.notDeepEqual([...sig2], [...sig]);
    assert.equal(sig2.length, 64);
    // documented: WebCrypto does not enforce low-S, so the variant verifies
    assert.equal(await S.verifyMessage(verifyKey, sig, f), true);
    assert.equal(await S.verifyMessage(verifyKey, sig2, f), true);

    // Acceptance claims the full 12-byte nonce, never the signature bytes.
    const nonceHex = hex(f.iv);
    const claim = (ref) => store.claimNonce({ senderKeyId: f.senderKeyId, nonceHex, counter: f.counter, ref });

    assert.equal(await claim('msg:1'), 'new', 'first copy is accepted');
    // the re-signed copy re-delivered under the SAME message id is the same message
    assert.equal(await claim('msg:1'), 'same');
    // posted again under a NEW message id it is a replay, however its signature bytes differ
    assert.equal(await claim('msg:2'), 'conflict');
    assert.equal(await store.countSeen(f.senderKeyId), 1, 'exactly one accepted message');
});
