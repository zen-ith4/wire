// tests/groups/lock-identity-clears-group-keys.test.mjs
//
// NEW test written for the X port (not from the source tree).
//
// identity-service.lockIdentity() must also drop the Group Sender Key caches
// (local at-rest wrap key + unwrapped Sender Key CryptoKeys), which are derived
// from the identity being locked. The port added that to X's lockIdentity(),
// but no other test depended on it (removing it left every existing test green),
// so it is pinned here. The group modules are mocked with spies: what is under
// test is that lockIdentity() calls them, not their internals.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const jsPath = (rel) => new URL(`../../public/js/${rel}`, import.meta.url).pathname;

const calls = { wrap: 0, sender: 0 };

mock.module(jsPath('crypto/identity.js'), {
    namedExports: {
        createEncryptedIdentity: async () => ({}),
        restoreIdentityFromServer: async () => ({}),
        decryptIdentityPrivateKey: async () => ({}),
        encryptIdentityPrivateKey: async () => ({}),
        deriveIdentityUnlockKey: async () => ({}),
        decryptIdentityPrivateKeyWithDerivedKey: async () => ({}),
    },
});
mock.module(jsPath('core/server.js'), {
    namedExports: { resolveServerUrl: (u) => u },
});
mock.module(jsPath('crypto/groups/local-wrap-key.js'), {
    namedExports: { clearLocalWrapKeyCache: () => { calls.wrap++; } },
});
mock.module(jsPath('crypto/groups/sender-key.js'), {
    namedExports: { clearSenderKeyCache: () => { calls.sender++; } },
});

const { lockIdentity, isIdentityUnlocked } = await import(jsPath('crypto/identity-service.js'));

// lockIdentity() clears via dynamic import().then(), so let those settle.
const settle = () => new Promise((r) => setTimeout(r, 25));

test('lockIdentity() clears BOTH group key caches (wrap key and Sender Keys)', async () => {
    calls.wrap = 0; calls.sender = 0;
    lockIdentity();
    await settle();
    assert.equal(calls.wrap, 1, 'local wrap key cache must be cleared');
    assert.equal(calls.sender, 1, 'Sender Key cache must be cleared');
    assert.equal(isIdentityUnlocked(), false);
});

test('lockIdentity() clears the group caches every time it is called, even when already locked', async () => {
    calls.wrap = 0; calls.sender = 0;
    lockIdentity();
    lockIdentity();
    await settle();
    assert.equal(calls.wrap, 2);
    assert.equal(calls.sender, 2);
});
