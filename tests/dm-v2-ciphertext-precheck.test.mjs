// The DM v2 build and validate paths reject ciphertext over DM_V2_MAX_CIPHERTEXT_LENGTH
// (64 KiB decoded). A base64 pre-check now runs before the decode so an oversized
// string is rejected without being decoded. These tests pin the boundary: exactly
// the maximum is accepted, one byte more is rejected, both through the same
// DmV2ValidationError as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DM_V2_MAX_CIPHERTEXT_LENGTH,
    DM_V2_FINGERPRINT_LENGTH,
    DmV2ValidationError,
    buildDmV2Envelope,
    validateDmV2Envelope,
} from '../public/js/crypto/messages/dm-v2.js';

const ALICE = 12;
const BOB = 34;
const MSG_ID = '0123456789abcdef';
const IV = Uint8Array.from({ length: 12 }, () => 0xa5);
const FP = Uint8Array.from({ length: DM_V2_FINGERPRINT_LENGTH }, () => 0x42);
const b64 = (n) => Buffer.alloc(n, 0x37).toString('base64');

function build(ciphertext) {
    return buildDmV2Envelope({
        ciphertext, iv: IV, senderFp: FP, msgId: MSG_ID, senderId: ALICE, recipientId: BOB,
    });
}

test('the maximum decoded size (64 KiB) is accepted by the build path', () => {
    assert.equal(DM_V2_MAX_CIPHERTEXT_LENGTH, 64 * 1024);
    assert.doesNotThrow(() => build(b64(DM_V2_MAX_CIPHERTEXT_LENGTH)));
});

test('one byte over the maximum is rejected with the same error', () => {
    assert.throws(
        () => build(b64(DM_V2_MAX_CIPHERTEXT_LENGTH + 1)),
        (err) => err instanceof DmV2ValidationError && err.message === 'Ciphertext is too large'
    );
});

test('a far oversized string is rejected before decoding, same error', () => {
    const huge = 'A'.repeat(200000); // 200k chars, valid base64 alphabet
    assert.throws(
        () => build(huge),
        (err) => err instanceof DmV2ValidationError && err.message === 'Ciphertext is too large'
    );
});

test('the validate path applies the same boundary', () => {
    const good = build(b64(16));

    assert.doesNotThrow(() => validateDmV2Envelope({
        ...good, encryption: { ...good.encryption, ciphertext: b64(DM_V2_MAX_CIPHERTEXT_LENGTH) },
    }));

    assert.throws(
        () => validateDmV2Envelope({
            ...good, encryption: { ...good.encryption, ciphertext: b64(DM_V2_MAX_CIPHERTEXT_LENGTH + 1) },
        }),
        (err) => err instanceof DmV2ValidationError && err.message === 'Ciphertext is too large'
    );
});

test('a non-string ciphertext still fails with the existing validation error', () => {
    const good = build(b64(16));
    assert.throws(
        () => validateDmV2Envelope({ ...good, encryption: { ...good.encryption, ciphertext: 12345 } }),
        DmV2ValidationError
    );
});
