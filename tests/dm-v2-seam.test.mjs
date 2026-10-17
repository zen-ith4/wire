// tests/dm-v2-seam.test.mjs
//
// STEP 1E regression tests for the two real bugs the protocol/browser tests
// found. NO mocks, NO identity, NO server - these are pure shape contracts
// between dm-v2.js and dm-v2-wire.js.
//
// BUG 1 (found in 1D): buildDmV2Content() returned {envelope, msgId, contentChars}
// but NOT `content`, while encryptDmTextV2() destructures `content`. Every real
// v2 send therefore posted an empty body.
//
// BUG 2 (found in 1E): openDmV2Envelope() passed validateDmV2Envelope()'s
// NORMALISED result into decryptDmV2(), which validates again. The normalised
// shape is FLAT and carries no `encryption` key, so the second validation threw
// "Missing encryption payload" and EVERY real v2 decrypt failed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
    encryptDmV2,
    decryptDmV2,
    validateDmV2Envelope,
    deriveDmV2Key,
    senderKeyFingerprint,
    buildDmV2Envelope,
} from '../public/js/crypto/messages/dm-v2.js';

const ALICE = 12;
const BOB = 34;

const FIXED = {
    ALICE: {
        pkcs8: '302e020100300506032b656e042204202096a2102d26e03e7d30af61f63afef9ac5911e480462340306b3e9019870165',
        spki: '302a300506032b656e0321008e8362dacb4b24be5d3c28e24fbece609ce12eb0c15e38a40524f8193ce0df1d'
    },
    BOB: {
        pkcs8: '302e020100300506032b656e0422042038ae07cbee9435860f9d893643f0474c381bb1e72cf8925589ff3ef63346e861',
        spki: '302a300506032b656e03210040ef23c0b0d8ca365bba1e3ec67487a155fcd050a7a594c13b8f26afe599452d'
    }
};

function wc(k) {
    const priv = crypto.createPrivateKey({ key: Buffer.from(k.pkcs8, 'hex'), format: 'der', type: 'pkcs8' });
    return {
        privateKey: crypto.webcrypto.subtle.importKey('pkcs8', priv.export({ format: 'der', type: 'pkcs8' }), { name: 'X25519' }, false, ['deriveBits']),
        publicKey: crypto.webcrypto.subtle.importKey('spki', crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }), { name: 'X25519' }, false, [])
    };
}

const A = wc(FIXED.ALICE);
const B = wc(FIXED.BOB);
const Akeys = { privateKey: await A.privateKey, publicKey: await A.publicKey };
const Bkeys = { privateKey: await B.privateKey, publicKey: await B.publicKey };

async function makeEnvelope() {
    const fp = await senderKeyFingerprint(new Uint8Array(
        crypto.createPublicKey({ key: Buffer.from(FIXED.ALICE.spki, 'hex'), format: 'der', type: 'spki' }).export({ format: 'der', type: 'spki' }).subarray(-32)
    ));
    const key = await deriveDmV2Key(ALICE, BOB, Akeys.privateKey, Bkeys.publicKey);
    const { envelope, msgId } = await encryptDmV2({ plaintext: 'seam', fromUserId: ALICE, toUserId: BOB, senderKeyFp: fp, key });
    return { envelope, fp, key };
}

test('BUG 2 seam: decryptDmV2 ACCEPTS the wire envelope', async () => {
    const { envelope, fp, key } = await makeEnvelope();
    const out = await decryptDmV2({ envelope, senderKeyFp: fp, key, replyToId: 0 });
    assert.equal(out, 'seam');
});

test('BUG 2 seam: decryptDmV2 REJECTS the normalised (flat) shape - this is why openDmV2Envelope must pass the original', async () => {
    const { envelope, fp, key } = await makeEnvelope();
    const normalised = validateDmV2Envelope(envelope);
    // The normalised shape is FLAT: it has no `encryption` key.
    assert.equal(normalised.encryption, undefined, 'normalised shape is flat by design');
    assert.equal(normalised.version, 2);
    // Re-validating it is exactly the bug: it throws "Missing encryption payload".
    await assert.rejects(
        () => decryptDmV2({ envelope: normalised, senderKeyFp: fp, key, replyToId: 0 }),
        /Missing encryption payload/
    );
});

test('BUG 2 seam: dm-v2-wire.js passes the ORIGINAL envelope to decryptDmV2 (regression guard)', () => {
    const src = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/js/crypto/messages/dm-v2-wire.js'),
        'utf8'
    );
    // The decryptDmV2 call must use `envelope: payload`, never `envelope: validated`.
    const call = src.slice(src.indexOf('const plaintext = await decryptDmV2'));
    assert.match(call, /envelope: payload\b/, 'must pass the original envelope');
    assert.doesNotMatch(call, /envelope: validated\b/, 'must NOT pass the flat normalised shape');
});

test('BUG 1 seam: buildDmV2Content returns a non-empty content string (regression guard, static)', () => {
    const src = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/js/crypto/messages/dm-v2-wire.js'),
        'utf8'
    );
    // The return must include `content`, because encryptDmTextV2 destructures it.
    assert.match(src, /return \{ envelope, msgId, content, contentChars: content\.length \};/);
    // buildDmV2Envelope must still produce a wire envelope the server accepts.
    const env = buildDmV2Envelope({ ciphertext: Buffer.from('aabb', 'hex').toString('base64'), iv: Buffer.alloc(12), senderFp: Buffer.alloc(32), msgId: '0123456789abcdef', senderId: ALICE, recipientId: BOB });
    assert.equal(env.encryption.version, 2);
    assert.equal(typeof env.encryption.ciphertext, 'string');
    assert.ok(env.encryption.ciphertext.length > 0);
});