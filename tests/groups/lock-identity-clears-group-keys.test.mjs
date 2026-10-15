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

const jsPath = (rel) => new URL(`../../public/js/${rel}`, import.meta.url).href;

const calls = { wrap: 0, sender: 0 };

mock.module(jsPath('crypto/identity.js'), {
    namedExports: {
        createEncryptedIdentity: async () => ({}),
        restoreIdentityFromServer: async () => ({}),
        decryptIdentityPrivateKey: async () => ({}),
        encryptIdentityPrivateKey: async () => ({}),
        deriveIdentityUnlockKey: async () => ({}),
        decryptIdentityPrivateKeyWithDerivedKey: async () => ({}),
        decryptIdentityPkcs8: async () => ({}),
        encryptIdentityPkcs8: async () => ({}),
        assertKnownIdentityFormat: () => {},
    },
});
// identity-service.js now also imports the account-KDF helpers and the migration builder
// (F12); they pull in api.js/auth.js, which this test does not need.
mock.module(jsPath('crypto/account-kdf.js'), {
    namedExports: { fetchOwnKdfParams: async () => ({ scheme: 1 }), pinScheme2: () => {} },
});
mock.module(jsPath('crypto/credential-migration.js'), {
    namedExports: { buildMigrationPayload: async () => ({ body: {} }) },
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

// lockIdentity() clears the caches through dynamic import().then(), so the
// calls land on a later microtask - at least one, and on a loaded machine
// several task-queue turns later.
//
// This used to be a fixed `setTimeout(25)`. That is a guess about how long the
// machine takes, not about what the code does, and it is the one thing in this
// file that could be wrong: observed on Windows were calls.wrap of 0 or 1
// against an expected 2. A longer sleep would only move the guess.
//
// So: poll for the postcondition, bounded. The bound is what keeps this an
// assertion rather than a wait - if lockIdentity() never cleared the caches the
// poll exhausts and the test fails, exactly as it did before.
async function waitForClears(expected, what) {
    const deadline = Date.now() + 5000;

    for (;;) {
        if (calls.wrap >= expected && calls.sender >= expected) break;

        assert.ok(
            Date.now() < deadline,
            `${what}: after 5000 ms the caches were cleared ${calls.wrap}/${calls.sender} times, ` +
            `expected ${expected}/${expected} - lockIdentity() did not reach the dynamic import()`
        );

        await new Promise((r) => setTimeout(r, 5));
    }
}

test('lockIdentity() clears BOTH group key caches (wrap key and Sender Keys)', async () => {
    calls.wrap = 0; calls.sender = 0;
    lockIdentity();
    await waitForClears(1, 'one lockIdentity() call');
    assert.equal(calls.wrap, 1, 'local wrap key cache must be cleared');
    assert.equal(calls.sender, 1, 'Sender Key cache must be cleared');
    assert.equal(isIdentityUnlocked(), false);
});

test('lockIdentity() clears the group caches every time it is called, even when already locked', async () => {
    calls.wrap = 0; calls.sender = 0;
    lockIdentity();
    lockIdentity();
    await waitForClears(2, 'two lockIdentity() calls');
    assert.equal(calls.wrap, 2);
    assert.equal(calls.sender, 2);
});
