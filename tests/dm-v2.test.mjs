// tests/dm-v2.test.mjs
//
// STEP 1A: DM envelope v2. Node-runnable, no browser: the module uses only Web
// Crypto and atob/btoa/TextEncoder, all of which exist in Node.
//
// THE RULE FOR THIS FILE: no expected value may come from calling the module
// under test. Every known answer below is computed by an INDEPENDENT
// implementation using node:crypto (hkdfSync, createCipheriv) and AAD bytes built
// by hand in the test, and then compared against the module. A test that asks the
// module what it thinks it produced proves nothing.
//
// Fixed inputs, so every answer is deterministic:
//   alice seed 0x000102...  bob seed 0x101112...   (32 bytes each, JWK-imported)
//   ids          alice=12, bob=34, replyToId=0 and 56
//   iv           12 bytes of 0xa5
//   msgId        16 hex chars, supplied so the envelope is reproducible
//   plaintext    'the quick brown fox'
//
// This file also pins the KNOWN-ANSWER values as literals (AAD hex, key hex,
// ciphertext hex) in one test, so a change in WebCrypto's or Node's HKDF/AES
// cannot silently move the answers. The independent-implementation tests sit
// beside it and agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
    DM_V2_VERSION,
    DM_V2_ALGORITHM,
    DM_V2_INFO_A2B,
    DM_V2_INFO_B2A,
    DM_V1_INFO,
    GROUP_KDM_INFO,
    DM_V2_AAD_LABEL,
    DM_ATTACHMENT_AAD_LABEL,
    DM_V2_IV_LENGTH,
    DM_V2_FINGERPRINT_LENGTH,
    directionLabel,
    dmV2Info,
    deriveDmV2Key,
    senderKeyFingerprint,
    dmMessageAad,
    dmAttachmentAad,
    dmV2AadLength,
    newDmV2MsgId,
    buildDmV2Envelope,
    validateDmV2Envelope,
    encryptDmV2,
    decryptDmV2,
    encryptDmAttachmentV2,
    decryptDmAttachmentV2,
    IvReplayGuard,
    DmV2IvReplayError,
    DmV2ValidationError
} from '../public/js/crypto/messages/dm-v2.js';

const ALICE = 12;
const BOB = 34;
const MSG_ID = '0123456789abcdef';
const PLAINTEXT = 'the quick brown fox';
const IV = Uint8Array.from({ length: 12 }, () => 0xa5);

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/* =========================================================
 * FIXED KEYS
 *
 * Node's WebCrypto will NOT import a raw 32-byte X25519 PRIVATE key ("Unsupported
 * key usage"), so the fixed keys are built as pkcs8/spki DER from a fixed 32-byte
 * seed through node:crypto's JWK import - which is exactly the shape production
 * uses, since identity.js exports pkcs8 and raw.
 * ========================================================= */

// Fixed keypairs, embedded as DER. Node's WebCrypto will NOT import a raw
// 32-byte X25519 PRIVATE key ("Unsupported key usage for a X25519 key"), and
// createPrivateKey() from a JWK demands both `d` and `x`, so fixed DER is the
// only shape that works in Node - and it is the shape production uses anyway,
// since identity.js exports pkcs8 and raw.
const FIXED = {
    ALICE: {
        pkcs8: '302e020100300506032b656e042204202096a2102d26e03e7d30af61f63afef9ac5911e480462340306b3e9019870165',
        spki: '302a300506032b656e0321008e8362dacb4b24be5d3c28e24fbece609ce12eb0c15e38a40524f8193ce0df1d',
        fingerprint: '8973e16ef446f9425e181a76e5dc2711e5791b58b13d25c6b7a47f2291e0e20c'
    },
    BOB: {
        pkcs8: '302e020100300506032b656e0422042038ae07cbee9435860f9d893643f0474c381bb1e72cf8925589ff3ef63346e861',
        spki: '302a300506032b656e03210040ef23c0b0d8ca365bba1e3ec67487a155fcd050a7a594c13b8f26afe599452d',
        fingerprint: '6b2f3d5696419ef592eea0067718f3fef27ad508ba710877c3d52b691d26650a'
    }
};

function keysFromDer(entry) {
    const privateKey = crypto.createPrivateKey({
        key: Buffer.from(entry.pkcs8, 'hex'), format: 'der', type: 'pkcs8'
    });
    const publicKey = crypto.createPublicKey(privateKey);
    // The embedded spki must agree with the one derived from the pkcs8, or the
    // "fixed key" pair is not what it claims to be.
    assert.equal(
        publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
        entry.spki,
        'the embedded spki must match the pkcs8 it came from'
    );
    return { privateKey, publicKey };
}

const A = keysFromDer(FIXED.ALICE);
const B = keysFromDer(FIXED.BOB);

async function wcKeys(k) {
    const privateKey = await crypto.webcrypto.subtle.importKey(
        'pkcs8',
        k.privateKey.export({ format: 'der', type: 'pkcs8' }),
        { name: 'X25519' }, false, ['deriveBits']
    );
    const publicKey = await crypto.webcrypto.subtle.importKey(
        'spki',
        k.publicKey.export({ format: 'der', type: 'spki' }),
        { name: 'X25519' }, false, []
    );
    return { privateKey, publicKey };
}

const rawPublic = (k) => k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

/* =========================================================
 * THE INDEPENDENT IMPLEMENTATION
 *
 * Deliberately written from the design doc, not from the module: HKDF by hand,
 * AAD assembled field by field, AES-GCM by node:crypto.
 * ========================================================= */

/** Hand-built AAD: 1 type byte | 4-byte BE length | data, per field, in order. */
function independentAad({
    label = 'dm-msg-v2',
    version = 2,
    from = ALICE,
    to = BOB,
    senderKeyFp,
    direction = 'a2b',
    iv = IV,
    replyToId = 0
} = {}) {
    const fields = [
        [0, Buffer.from(label, 'utf8')],
        [0, Buffer.from(String(version), 'utf8')],
        [0, Buffer.from(String(from), 'utf8')],
        [0, Buffer.from(String(to), 'utf8')],
        [1, Buffer.from(senderKeyFp)],
        [0, Buffer.from(direction, 'utf8')],
        [1, Buffer.from(iv)],
        [0, Buffer.from(String(replyToId), 'utf8')]
    ];
    const parts = [];
    for (const [type, data] of fields) {
        const head = Buffer.alloc(5);
        head[0] = type;
        head.writeUInt32BE(data.length, 1);
        parts.push(head, data);
    }
    return Buffer.concat(parts);
}

/** Independent directional key: X25519 then HKDF-SHA-256, salt 32 zero bytes. */
function independentKey(from, to, selfPriv, peerPub) {
    const ss = crypto.diffieHellman({
        privateKey: selfPriv,
        publicKey: from < to ? peerPub : peerPub
    });
    const info = from < to ? DM_V2_INFO_A2B : DM_V2_INFO_B2A;
    return Buffer.from(crypto.hkdfSync('sha256', ss, Buffer.alloc(32), Buffer.from(info, 'utf8'), 32));
}

/** Independent encrypt: AES-256-GCM, and WebCrypto appends the tag, so match it. */
function independentEncrypt(keyBytes, iv, aad, plaintext) {
    const c = crypto.createCipheriv('aes-256-gcm', keyBytes, iv, { ivLength: 12 });
    c.setAAD(aad, { plaintextLength: Buffer.byteLength(plaintext, 'utf8') });
    const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return Buffer.concat([body, c.getAuthTag()]);
}

/* =========================================================
 * 1. KNOWN-ANSWER vectors, computed independently
 * ========================================================= */

test('KAT: a2b AAD, key and ciphertext match an independent node:crypto implementation', async () => {
    const a = await wcKeys(A);
    const fp = await senderKeyFingerprint(rawPublic(A));

    // --- expected AAD, built by hand in this test
    const expAad = independentAad({ senderKeyFp: fp, direction: 'a2b', replyToId: 0 });

    // --- module's AAD
    const gotAad = dmMessageAad({
        version: 2, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, direction: 'a2b', iv: IV, replyToId: 0
    });

    assert.equal(
        hex(gotAad), hex(expAad),
        `AAD mismatch\n  independent: ${hex(expAad)}\n  module:      ${hex(gotAad)}`
    );

    // --- expected key, derived independently
    const expKey = independentKey(ALICE, BOB, A.privateKey, B.publicKey);

    // --- expected ciphertext, independent node:crypto
    const expCt = independentEncrypt(expKey, IV, expAad, PLAINTEXT);

    // --- module's key. WebCrypto will not export it (non-extractable by design),
    // so it is observed by what it opens: the independent ciphertext must decrypt
    // under it. Equal plaintext => same key, given the same iv and AAD.
    const b = await wcKeys(B);
    const modKey = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);

    const viaModuleKey = await crypto.webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: IV, additionalData: gotAad, tagLength: 128 },
        modKey, expCt
    );
    assert.equal(new TextDecoder().decode(viaModuleKey), PLAINTEXT,
        'the module key must open a ciphertext made with the independently derived key');

    // --- module's envelope
    const { envelope } = await encryptDmV2({
        plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, key: modKey, replyToId: 0, iv: IV, msgId: MSG_ID
    });

    assert.equal(
        Buffer.from(envelope.encryption.ciphertext, 'base64').toString('hex'),
        expCt.toString('hex'),
        'ciphertext mismatch'
    );
});

test('KAT: the AAD hex and length are the exact values this format defines', async () => {
    const fp = await senderKeyFingerprint(rawPublic(A));

    // Recomputed here from the layout, not copied from the module's output.
    const expected = independentAad({ senderKeyFp: fp, direction: 'a2b', replyToId: 0 });
    const got = dmMessageAad({
        version: 2, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, direction: 'a2b', iv: IV, replyToId: 0
    });

    // 40 bytes of framing (8 fields x 5) + 9 + 1 + 2 + 2 + 32 + 3 + 12 + 1
    assert.equal(expected.length, 102);
    assert.equal(got.length, expected.length);
    assert.equal(dmV2AadLength({
        fromUserId: ALICE, toUserId: BOB, senderKeyFp: fp, direction: 'a2b', iv: IV
    }), expected.length);

    // Walk the bytes field by field, so a reordering cannot hide inside a hex compare.
    const dv = new DataView(got.buffer, got.byteOffset, got.byteLength);
    const fields = [];
    let off = 0;
    while (off < got.length) {
        const type = got[off];
        const len = dv.getUint32(off + 1);
        const data = got.subarray(off + 5, off + 5 + len);
        fields.push({ type, len, text: type === 0 ? new TextDecoder().decode(data) : hex(data) });
        off += 5 + len;
    }
    assert.deepEqual(fields, [
        { type: 0, len: 9, text: 'dm-msg-v2' },
        { type: 0, len: 1, text: '2' },
        { type: 0, len: 2, text: String(ALICE) },
        { type: 0, len: 2, text: String(BOB) },
        { type: 1, len: 32, text: hex(fp) },
        { type: 0, len: 3, text: 'a2b' },
        { type: 1, len: 12, text: hex(IV) },
        { type: 0, len: 1, text: '0' }
    ]);
});

/* =========================================================
 * 2. Direction, and every header field is bound
 * ========================================================= */

test('direction: a2b and b2a keys differ, and a ciphertext does not open in reverse', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);

    // BOTH directions use the same ECDH operands (alice's private, bob's public).
    // The direction reaches the key only through the HKDF info, which is exactly
    // what this test pins.
    const kAB = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
    const kBA = await deriveDmV2Key(BOB, ALICE, a.privateKey, b.publicKey);

    assert.equal(directionLabel(ALICE, BOB), 'a2b');
    assert.equal(directionLabel(BOB, ALICE), 'b2a');
    assert.equal(dmV2Info(ALICE, BOB), DM_V2_INFO_A2B);
    assert.equal(dmV2Info(BOB, ALICE), DM_V2_INFO_B2A);

    // Same ECDH operands both times (alice's private, bob's public), so if the
    // direction did NOT feed the HKDF these two keys would be identical. They are
    // not, which is the whole point.
    const expA2B = independentKey(ALICE, BOB, A.privateKey, B.publicKey);
    const expB2A = independentKey(BOB, ALICE, A.privateKey, B.publicKey);
    assert.notEqual(hex(expA2B), hex(expB2A), 'the independent check also differs');

    const fpA = await senderKeyFingerprint(rawPublic(A));
    const { envelope } = await encryptDmV2({
        plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fpA, key: kAB, iv: IV, msgId: MSG_ID
    });

    // Opens forwards.
    assert.equal(
        await decryptDmV2({ envelope, senderKeyFp: fpA, key: kAB }),
        PLAINTEXT
    );

    // Does NOT open with the reverse-direction key.
    await assert.rejects(
        () => decryptDmV2({ envelope, senderKeyFp: fpA, key: kBA }),
        'a ciphertext must not decrypt under the reverse direction'
    );

    // And a relabelled envelope (bob -> alice) must not open with the b2a key
    // either, because the AAD now commits to different ids.
    const relabelled = {
        ...envelope,
        senderId: BOB,
        recipientId: ALICE
    };
    await assert.rejects(
        () => decryptDmV2({ envelope: relabelled, senderKeyFp: fpA, key: kBA }),
        'a relabelled envelope must not decrypt under the reverse key'
    );
});

/**
 * Decryption must fail, AND it must fail in the AEAD - not in one of this
 * module's own validation guards.
 *
 * Without this, a field that is merely hand-checked and has been REMOVED from the
 * AAD still "fails" (via the guard) and the test passes, while the design doc's
 * actual claim - "it cannot be stripped, because removing it changes the AAD" -
 * has quietly stopped being true.
 */
async function assertAeadRejects(thunk, what) {
    let err = null;
    try {
        // CALL it. Awaiting a function object resolves immediately to the
        // function itself and never throws, which made every one of these
        // assertions report "decryption unexpectedly SUCCEEDED".
        await thunk();
    } catch (e) {
        err = e;
    }
    assert.ok(err, `${what}: decryption unexpectedly SUCCEEDED`);
    assert.ok(
        !(err instanceof DmV2ValidationError),
        `${what}: rejected by a validation guard, not by the AEAD tag check, so ` +
        `this field may no longer be in the AAD. error was: ${err && err.message}`
    );
}

/** Every header field, one test each: changing it must break the tag. */
for (const [label, mutate] of [
    ['senderId', (env) => ({ ...env, senderId: BOB })],
    ['recipientId', (env) => ({ ...env, recipientId: ALICE + 1 })],
    // NOTE: `version` is deliberately NOT in this list. It is the discriminator
    // and is refused by validateDmV2Envelope() BEFORE any key is touched, so it
    // fails with a DmV2ValidationError rather than in the AEAD, and
    // assertAeadRejects() would (correctly) reject that. It has its own test
    // below, which pins the read-it-first behaviour.
    ['senderFp', (env) => ({
        ...env,
        encryption: { ...env.encryption, senderFp: b64(Buffer.alloc(32, 0x11)) }
    })],
    // 'version' is deliberately NOT here: it is the discriminator and is rejected
    // by validateDmV2Envelope BEFORE any key is touched. Its own test below pins
    // that, because reading it first is the property that lets an old client fail
    // cleanly on a v2 message instead of misreading it.
    ['iv', (env) => ({
        ...env,
        encryption: { ...env.encryption, iv: b64(Buffer.alloc(12, 0x22)) }
    })],
    ['replyToId', null]   // replyToId is not in the envelope; tested separately below
]) {
    if (!mutate) continue;

    test(`bound field: changing ${label} makes decryption fail`, async () => {
        const a = await wcKeys(A);
        const b = await wcKeys(B);
        const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
        const fp = await senderKeyFingerprint(rawPublic(A));

        const { envelope } = await encryptDmV2({
            plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
            senderKeyFp: fp, key, iv: IV, msgId: MSG_ID
        });

        assert.equal(await decryptDmV2({ envelope, senderKeyFp: fp, key }), PLAINTEXT,
            'the untampered envelope must open first');

        const tampered = mutate(envelope);

        if (label === 'senderFp') {
            // Two steps, because this module has a hand-rolled guard that fires
            // first and would otherwise mask the thing under test.
            //
            // Step 1: the server substitutes a different senderFp and the
            // receiver, key in hand, notices the mismatch.
            await assert.rejects(
                () => decryptDmV2({ envelope: tampered, senderKeyFp: fp, key }),
                DmV2ValidationError,
                'a substituted senderFp must be refused'
            );

            // Step 2: the real property. Hand the receiver a fingerprint that
            // MATCHES the substituted envelope - i.e. best case for the server -
            // and the AEAD must still reject, because the AAD committed to the
            // fingerprint that was used at encrypt time. This is the assertion
            // that fails if senderKeyFp is ever dropped from the AAD.
            const substitutedFp = Buffer.from(
                tampered.encryption.senderFp, 'base64');
            await assertAeadRejects(
                () => decryptDmV2({ envelope: tampered, senderKeyFp: substitutedFp, key }),
                'senderFp must be bound in the AAD'
            );
            return;
        }

        await assertAeadRejects(
            () => decryptDmV2({ envelope: tampered, senderKeyFp: fp, key }),
            `${label} must be bound in the AAD`
        );
    });
}

test('bound field: version is the discriminator and is refused before any key is touched', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);
    const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
    const fp = await senderKeyFingerprint(rawPublic(A));

    const { envelope } = await encryptDmV2({
        plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, key, iv: IV, msgId: MSG_ID
    });

    // Stripped to v1, which is what a downgrade attempt looks like. It must be
    // refused as an unknown envelope, NOT misread as a v1 message.
    for (const badVersion of [1, 3, 0, '2', null, 2.5]) {
        await assert.rejects(
            () => decryptDmV2({
                envelope: { ...envelope, encryption: { ...envelope.encryption, version: badVersion } },
                senderKeyFp: fp, key
            }),
            DmV2ValidationError,
            `version ${JSON.stringify(badVersion)} must be refused`
        );
    }
});

test('bound field: replyToId is bound, so a server cannot re-point a reply', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);
    const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
    const fp = await senderKeyFingerprint(rawPublic(A));

    const { envelope } = await encryptDmV2({
        plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, key, replyToId: 56, iv: IV, msgId: MSG_ID
    });

    assert.equal(await decryptDmV2({ envelope, senderKeyFp: fp, key, replyToId: 56 }), PLAINTEXT);
    await assertAeadRejects(
        () => decryptDmV2({ envelope, senderKeyFp: fp, key, replyToId: 57 }),
        'replyToId must be bound in the AAD'
    );
});

/* =========================================================
 * 3. v1 / v2 key separation
 * ========================================================= */

test('separation: the v2 key is not the v1 key, and neither opens the other', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);

    const v2 = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);

    // Independent v1 derivation: same shared secret, the v1 info.
    const ss = crypto.diffieHellman({ privateKey: A.privateKey, publicKey: B.publicKey });
    const v1Key = Buffer.from(crypto.hkdfSync('sha256', ss, Buffer.alloc(32), Buffer.from(DM_V1_INFO), 32));
    const v2KeyA2B = independentKey(ALICE, BOB, A.privateKey, B.publicKey);

    assert.notEqual(hex(v1Key), hex(v2KeyA2B),
        'v1 and v2 must not derive the same key for the same pair');

    const fpA = await senderKeyFingerprint(rawPublic(A));
    const { envelope } = await encryptDmV2({
        plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fpA, key: v2, iv: IV, msgId: MSG_ID
    });

    // ONE AAD for both directions of the check, so the KEY is the only variable.
    // Comparing with different AADs too would let this pass for the wrong reason.
    const aad = dmMessageAad({
        version: 2, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fpA, direction: 'a2b', iv: IV, replyToId: 0
    });

    // A v2 ciphertext must not open under the v1 key.
    const wcV1 = await crypto.webcrypto.subtle.importKey('raw', v1Key, 'AES-GCM', false, ['decrypt']);
    await assert.rejects(() => crypto.webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: IV, additionalData: aad, tagLength: 128 },
        wcV1, Buffer.from(envelope.encryption.ciphertext, 'base64')
    ), 'a v2 ciphertext must not open under the v1 key');

    // And a ciphertext made with the v1 key must not open under the v2 key.
    const v1Ct = independentEncrypt(v1Key, IV, Buffer.from(aad), PLAINTEXT);
    await assert.rejects(() => crypto.webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: IV, additionalData: aad, tagLength: 128 },
        v2, v1Ct
    ), 'a v1 ciphertext must not open under the v2 key');

    // Control: the v1 key DOES open its own ciphertext, so the two rejections
    // above are about the key and not about a broken setup.
    const v1CtOk = independentEncrypt(v1Key, IV, Buffer.from(aad), PLAINTEXT);
    const opened = await crypto.webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: IV, additionalData: aad, tagLength: 128 },
        wcV1, v1CtOk
    );
    assert.equal(new TextDecoder().decode(opened), PLAINTEXT,
        'the v1 key must open its own ciphertext');
});

/* =========================================================
 * 4. Malformed input
 * ========================================================= */

test('rejected: a replayed IV is refused for the same scope', () => {
    const guard = new IvReplayGuard(8);
    const iv = Uint8Array.from({ length: 12 }, (_, i) => i);

    guard.remember(iv, '12|34');
    assert.throws(() => guard.remember(iv, '12|34'), DmV2IvReplayError,
        'the same nonce twice in one scope must throw');

    // A different scope is a different key, so the same nonce is fine there.
    guard.remember(iv, '12|56');
    // A different nonce in the same scope is fine.
    guard.remember(Uint8Array.from(iv, (v) => (v + 1) & 0xff), '12|34');
});

test('rejected: the IV guard is bounded', () => {
    const guard = new IvReplayGuard(4);
    for (let i = 0; i < 4; i++) {
        guard.remember(new Uint8Array(12).fill(i + 1), 'scope');
    }
    assert.equal(guard.seen.get('scope').size, 4, 'the window must not exceed the capacity');
    guard.remember(new Uint8Array(12).fill(99), 'scope');
    assert.equal(guard.seen.get('scope').size, 4, 'and must stay at the capacity');
});

test('rejected: wrong-length IV', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);
    const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
    const fp = await senderKeyFingerprint(rawPublic(A));

    for (const bad of [new Uint8Array(11), new Uint8Array(13), new Uint8Array(0)]) {
        await assert.rejects(
            () => encryptDmV2({
                plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
                senderKeyFp: fp, key, iv: bad, msgId: MSG_ID
            }),
            DmV2ValidationError,
            `a ${bad.length}-byte IV must be rejected`
        );
    }
});

test('rejected: wrong-length fingerprint', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);
    const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);

    for (const n of [16, 31, 33, 64]) {
        await assert.rejects(
            () => encryptDmV2({
                plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
                senderKeyFp: new Uint8Array(n), key, iv: IV, msgId: MSG_ID
            }),
            DmV2ValidationError,
            `a ${n}-byte fingerprint must be rejected`
        );
    }
});

test('rejected: non-numeric or non-positive user ids', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);
    const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
    const fp = await senderKeyFingerprint(rawPublic(A));

    for (const bad of ['abc', NaN, -1, 0, 1.5, null, {}, '']) {
        await assert.rejects(
            () => encryptDmV2({
                plaintext: PLAINTEXT, fromUserId: bad, toUserId: BOB,
                senderKeyFp: fp, key, iv: IV, msgId: MSG_ID
            }),
            DmV2ValidationError,
            `fromUserId ${JSON.stringify(bad)} must be rejected`
        );
        await assert.rejects(
            () => encryptDmV2({
                plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: bad,
                senderKeyFp: fp, key, iv: IV, msgId: MSG_ID
            }),
            DmV2ValidationError,
            `toUserId ${JSON.stringify(bad)} must be rejected`
        );
    }
});

test('rejected: a direction that contradicts the ids', async () => {
    const fp = await senderKeyFingerprint(rawPublic(A));
    assert.throws(
        () => dmMessageAad({
            version: 2, fromUserId: ALICE, toUserId: BOB,
            senderKeyFp: fp, direction: 'b2a', iv: IV
        }),
        DmV2ValidationError,
        'a direction the ids contradict must be rejected rather than encoded'
    );
});

test('rejected: a malformed envelope', () => {
    const fp = new Uint8Array(32).fill(7);
    const good = buildDmV2Envelope({
        ciphertext: b64(Buffer.from('ct')), iv: IV, senderFp: fp,
        msgId: MSG_ID, senderId: ALICE, recipientId: BOB
    });

    // The discriminator is read FIRST.
    assert.throws(() => validateDmV2Envelope({
        ...good, encryption: { ...good.encryption, version: 1 }
    }), DmV2ValidationError);

    assert.throws(() => validateDmV2Envelope({
        ...good, encryption: { ...good.encryption, version: '2' }
    }), DmV2ValidationError, 'version 2 as a string is not the discriminator');

    assert.throws(() => validateDmV2Envelope({
        ...good, encryption: { ...good.encryption, algorithm: 'AES-CBC' }
    }), DmV2ValidationError);

    for (const badId of ['ABCDEF0123456789', '0123456789ABCDE', '0123456789abcde', '', 'zz23456789abcdef']) {
        assert.throws(() => validateDmV2Envelope({
            ...good, encryption: { ...good.encryption, msgId: badId }
        }), DmV2ValidationError, `msgId ${JSON.stringify(badId)} must be rejected`);
    }
});

test('msgId: 8 random bytes rendered as 16 lowercase hex characters', () => {
    for (let i = 0; i < 50; i++) {
        const id = newDmV2MsgId();
        assert.match(id, /^[0-9a-f]{16}$/, `bad msgId ${id}`);
    }
    const many = new Set(Array.from({ length: 200 }, () => newDmV2MsgId()));
    assert.equal(many.size, 200, 'msgIds must not repeat');
});

/* =========================================================
 * 5. The four HKDF infos
 * ========================================================= */

test('the four HKDF infos are distinct and none is a prefix of another', () => {
    const infos = {
        'DM v2 a2b': DM_V2_INFO_A2B,
        'DM v2 b2a': DM_V2_INFO_B2A,
        'DM v1': DM_V1_INFO,
        'Group KDM': GROUP_KDM_INFO
    };

    // The lengths the doc states, so a truncated string cannot pass the rest.
    assert.equal(DM_V2_INFO_A2B.length, 19);
    assert.equal(DM_V2_INFO_B2A.length, 19);
    assert.equal(DM_V1_INFO.length, 12);
    assert.equal(GROUP_KDM_INFO.length, 22);

    assert.equal(new Set(Object.values(infos)).size, 4, 'all four must be distinct');

    const entries = Object.entries(infos);
    for (const [an, av] of entries) {
        for (const [bn, bv] of entries) {
            if (an === bn) continue;
            assert.ok(!bv.startsWith(av), `${bn} ("${bv}") must not start with ${an} ("${av}")`);
        }
    }
});

test('the AAD label is the documented one', () => {
    assert.equal(DM_V2_AAD_LABEL, 'dm-msg-v2');
    assert.equal(DM_ATTACHMENT_AAD_LABEL, 'dm-att-v2');
    assert.equal(DM_V2_VERSION, 2);
    assert.equal(DM_V2_ALGORITHM, 'AES-GCM');
    assert.equal(DM_V2_IV_LENGTH, 12);
    assert.equal(DM_V2_FINGERPRINT_LENGTH, 32);
});

test('round trip: encrypt then decrypt returns the exact plaintext, envelopes and all', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);
    const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
    const fp = await senderKeyFingerprint(rawPublic(A));

    for (const text of ['hello', 'مرحبا', 'a'.repeat(5000), '{"json":true}']) {
        const { envelope } = await encryptDmV2({
            plaintext: text, fromUserId: ALICE, toUserId: BOB,
            senderKeyFp: fp, key, iv: IV
        });
        const got = await decryptDmV2({ envelope, senderKeyFp: fp, key });
        assert.equal(got, text);
    }

    // Fresh random iv and msgId when not injected.
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
        const { envelope } = await encryptDmV2({
            plaintext: 'x', fromUserId: ALICE, toUserId: BOB, senderKeyFp: fp, key
        });
        assert.match(envelope.encryption.msgId, /^[0-9a-f]{16}$/);
        assert.equal(envelope.encryption.version, 2);
        seen.add(envelope.encryption.iv);
    }
    assert.equal(seen.size, 20, 'every message must get a fresh random IV');
});

/* =========================================================
 * 4. Attachment meta (STEP 2A.2): a separate label, same field order
 * ========================================================= */

const clone = (o) => JSON.parse(JSON.stringify(o));

const isAuthFailure = (e) => {
    // An AEAD failure: WebCrypto rejects with OperationError and no useful
    // message. Anything else ("no key", "bad JSON", "unsupported version") would
    // mean the test proved the wrong thing.
    assert.ok(
        e && (e.name === 'OperationError' || /auth/i.test(String(e.message))),
        `expected an AEAD failure, got ${e && e.name}: ${e && e.message}`
    );
    return true;
};

test('2A.2 KAT: the attachment AAD is the text AAD with only the label changed', async () => {
    const fp = await senderKeyFingerprint(rawPublic(A));

    const expAad = independentAad({
        label: 'dm-att-v2', senderKeyFp: fp, direction: 'a2b', replyToId: 0
    });
    const gotAad = dmAttachmentAad({
        version: 2, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, direction: 'a2b', iv: IV, replyToId: 0
    });

    assert.equal(hex(gotAad), hex(expAad), 'attachment AAD mismatch');

    // Same field list and the same label LENGTH (both 9 bytes), so the two
    // AADs have the same length and differ ONLY in the label's bytes.
    const textAad = dmMessageAad({
        version: 2, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, direction: 'a2b', iv: IV, replyToId: 0
    });
    assert.equal(gotAad.length, 102);
    assert.equal(textAad.length, 102);
    assert.equal(new TextDecoder().decode(gotAad.subarray(5, 14)), 'dm-att-v2');
    assert.equal(new TextDecoder().decode(textAad.subarray(5, 14)), 'dm-msg-v2');
    assert.equal(
        hex(gotAad.subarray(14)), hex(textAad.subarray(14)),
        'everything after the label must be byte-identical to the text AAD'
    );

    // Walk the bytes field by field, like the text KAT, so a reordering or a
    // dropped field cannot hide inside a hex compare.
    const dv = new DataView(gotAad.buffer, gotAad.byteOffset, gotAad.byteLength);
    const fields = [];
    let off = 0;
    while (off < gotAad.length) {
        const type = gotAad[off];
        const len = dv.getUint32(off + 1);
        const data = gotAad.subarray(off + 5, off + 5 + len);
        fields.push({ type, len, text: type === 0 ? new TextDecoder().decode(data) : hex(data) });
        off += 5 + len;
    }
    assert.deepEqual(fields, [
        { type: 0, len: 9, text: 'dm-att-v2' },
        { type: 0, len: 1, text: '2' },
        { type: 0, len: 2, text: String(ALICE) },
        { type: 0, len: 2, text: String(BOB) },
        { type: 1, len: 32, text: hex(fp) },
        { type: 0, len: 3, text: 'a2b' },
        { type: 1, len: 12, text: hex(IV) },
        { type: 0, len: 1, text: '0' }
    ]);
});

test('2A.2: the two AAD labels are distinct and neither is a prefix of the other', () => {
    assert.notEqual(DM_ATTACHMENT_AAD_LABEL, DM_V2_AAD_LABEL);
    assert.ok(!DM_ATTACHMENT_AAD_LABEL.startsWith(DM_V2_AAD_LABEL));
    assert.ok(!DM_V2_AAD_LABEL.startsWith(DM_ATTACHMENT_AAD_LABEL));
});

test('2A.2: attachment meta round trip, and the ciphertext matches the independent implementation', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);
    const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
    const fp = await senderKeyFingerprint(rawPublic(A));
    const metaPlain = JSON.stringify({ rawKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', name: 'a.png' });

    const { envelope } = await encryptDmAttachmentV2({
        plaintext: metaPlain, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, key, iv: IV, msgId: MSG_ID
    });

    assert.equal(
        await decryptDmAttachmentV2({ envelope, senderKeyFp: fp, key }),
        metaPlain
    );

    // The envelope shape is the v2 text shape, unchanged: version/algorithm/iv/
    // ciphertext/senderFp/msgId. Only the AAD bytes differ.
    assert.equal(envelope.encryption.version, 2);
    assert.equal(envelope.encryption.algorithm, 'AES-GCM');
    assert.equal(envelope.encryption.msgId, MSG_ID);
    assert.equal(envelope.encryption.iv, b64(IV));

    // Independent ciphertext under the same attachment AAD: byte-identical.
    const expKey = independentKey(ALICE, BOB, A.privateKey, B.publicKey);
    const expCt = independentEncrypt(
        expKey, IV,
        independentAad({ label: 'dm-att-v2', senderKeyFp: fp, direction: 'a2b', replyToId: 0 }),
        metaPlain
    );
    assert.equal(
        Buffer.from(envelope.encryption.ciphertext, 'base64').toString('hex'),
        expCt.toString('hex'),
        'independent ciphertext mismatch'
    );
});

test('2A.2: a text envelope does not open as attachment meta, and the reverse fails too', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);
    const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
    const fp = await senderKeyFingerprint(rawPublic(A));

    const text = await encryptDmV2({
        plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, key, iv: IV, msgId: MSG_ID
    });
    const meta = await encryptDmAttachmentV2({
        plaintext: PLAINTEXT, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, key, iv: IV, msgId: MSG_ID
    });

    // Positive controls first: each opens with its own function.
    assert.equal(await decryptDmV2({ envelope: text.envelope, senderKeyFp: fp, key }), PLAINTEXT);
    assert.equal(await decryptDmAttachmentV2({ envelope: meta.envelope, senderKeyFp: fp, key }), PLAINTEXT);

    // Cross-purpose: the label is in the AAD, so each fails authentication.
    await assert.rejects(
        () => decryptDmAttachmentV2({ envelope: text.envelope, senderKeyFp: fp, key }),
        isAuthFailure
    );
    await assert.rejects(
        () => decryptDmV2({ envelope: meta.envelope, senderKeyFp: fp, key }),
        isAuthFailure
    );
});

test('2A.2: every AAD field of the attachment meta is bound', async () => {
    const a = await wcKeys(A);
    const b = await wcKeys(B);
    const key = await deriveDmV2Key(ALICE, BOB, a.privateKey, b.publicKey);
    const fp = await senderKeyFingerprint(rawPublic(A));
    const otherFp = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const metaPlain = '{"name":"a.png"}';

    const enc = async (o = {}) => (await encryptDmAttachmentV2({
        plaintext: metaPlain, fromUserId: ALICE, toUserId: BOB,
        senderKeyFp: fp, key, iv: IV, msgId: MSG_ID, ...o
    })).envelope;

    // Positive control.
    assert.equal(
        await decryptDmAttachmentV2({ envelope: await enc(), senderKeyFp: fp, key }),
        metaPlain
    );

    // replyToId: re-pointing a reply is refused...
    const replyZero = await enc({ replyToId: 0 });
    await assert.rejects(
        () => decryptDmAttachmentV2({ envelope: replyZero, senderKeyFp: fp, key, replyToId: 5 }),
        isAuthFailure
    );
    // ...and a reply the sender really used round-trips with the same value.
    assert.equal(
        await decryptDmAttachmentV2({ envelope: await enc({ replyToId: 11 }), senderKeyFp: fp, key, replyToId: 11 }),
        metaPlain
    );

    // iv: a server swap is an AEAD failure, not a replay verdict.
    const ivSwapped = clone(await enc());
    ivSwapped.encryption.iv = b64(Buffer.alloc(12, 0x5a));
    await assert.rejects(
        () => decryptDmAttachmentV2({ envelope: ivSwapped, senderKeyFp: fp, key }),
        isAuthFailure
    );

    // from/to relabel (reflection): the ids are in the AAD.
    const relabelled = clone(await enc());
    const t = relabelled.senderId;
    relabelled.senderId = relabelled.recipientId;
    relabelled.recipientId = t;
    await assert.rejects(
        () => decryptDmAttachmentV2({ envelope: relabelled, senderKeyFp: fp, key }),
        isAuthFailure
    );

    // senderKeyFp: the server swaps the key the envelope names AND the caller
    // matches it (the only way to reach the AAD with it) - still fails.
    const tampered = clone(await enc());
    tampered.encryption.senderFp = b64(otherFp);
    await assert.rejects(
        () => decryptDmAttachmentV2({ envelope: tampered, senderKeyFp: otherFp, key }),
        isAuthFailure
    );
    // A caller fp that contradicts the envelope fails explicitly, before the AEAD.
    const plain = await enc();
    await assert.rejects(
        () => decryptDmAttachmentV2({ envelope: plain, senderKeyFp: otherFp, key }),
        /does not match the envelope senderFp/
    );

    // version: stripping 2 -> 1 is refused by the discriminator before any key work.
    const stripped = clone(await enc());
    stripped.encryption.version = 1;
    await assert.rejects(
        () => decryptDmAttachmentV2({ envelope: stripped, senderKeyFp: fp, key }),
        /Unsupported encryption version/
    );

    // direction: a caller-chosen direction that contradicts the ids is refused
    // when the AAD is built, so an AAD nobody can reproduce cannot exist.
    assert.throws(
        () => dmAttachmentAad({
            version: 2, fromUserId: ALICE, toUserId: BOB,
            senderKeyFp: fp, direction: 'b2a', iv: IV
        }),
        /contradicts directionLabel/
    );
});
