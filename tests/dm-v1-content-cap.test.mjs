// tests/dm-v1-content-cap.test.mjs
//
// R2: the old server truncated `content` at 2000 characters. A v1 envelope cut
// at that boundary is still valid JSON only if the cut happens to land outside
// the ciphertext string; in practice the row decrypts to a shorter message or
// fails. The client now measures the exact serialised envelope for BOTH wire
// versions and refuses before the request. This file pins the v1 half (the v2
// half is covered by dm-v2-wire.test.mjs and the server tests).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const js = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

const ls = new Map();
globalThis.localStorage = {
    getItem: (key) => (ls.has(key) ? ls.get(key) : null),
    setItem: (key, value) => { ls.set(key, String(value)); },
    removeItem: (key) => { ls.delete(key); },
    clear: () => { ls.clear(); },
};
globalThis.window = { location: { origin: 'http://127.0.0.1:5000' } };
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

let lastPlaintext = null;

mock.module(js('core/api.js'), {
    namedExports: {
        // getPeerDmMinVersion() asks this endpoint; answer "v1 only".
        api: async () => ({ dmE2eeMinVersion: 1 }),
    },
});

mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => ({ id: 7, groups_enabled: true }),
    },
});

mock.module(js('crypto/messages/encrypt.js'), {
    namedExports: {
        encryptMessage: async (plaintext) => {
            lastPlaintext = plaintext;
            const ciphertextBytes = plaintext.length > 1000 ? 1800 : 8;
            return {
                version: 1,
                algorithm: 'AES-GCM',
                iv: Buffer.alloc(12, 1).toString('base64'),
                ciphertext: Buffer.alloc(ciphertextBytes, 2).toString('base64'),
            };
        },
        decryptMessage: async () => {
            throw new Error('not used by this test');
        },
    },
});

const { encryptDmTextV2 } = await import(js('crypto/messages/message-crypto.js'));

test('v1: an envelope above the server cap is refused before the send', async () => {
    await assert.rejects(
        () => encryptDmTextV2('x'.repeat(2000), 7, 34),
        (error) => error && error.code === 'DM_V2_TOO_LARGE',
    );
    assert.equal(lastPlaintext.length, 2000, 'the cap is measured on the serialised envelope, not before encryption');
});

test('v1: an ordinary message is still returned unchanged', async () => {
    const result = await encryptDmTextV2('hello', 7, 34);
    assert.equal(result.version, 1);
    assert.equal(result.msgId, null);
    assert.ok(result.content.length <= 2000);
    assert.equal(JSON.parse(result.content).senderId, 7);
    assert.equal(JSON.parse(result.content).recipientId, 34);
});
