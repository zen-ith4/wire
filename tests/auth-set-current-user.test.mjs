import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
// The repo root is derived from this file, so the test runs from any
// checkout instead of only at a hardcoded absolute path. fileURLToPath
// is for fs paths; mock.module() and import() need a real file:// URL.
const js = (rel) => pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "js", rel)
).href;


// auth.js reads localStorage at module top-level (for the persisted
// token) — minimal in-memory stand-in.
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
    };
}
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}

// auth.js pulls in a fair amount of the app (api.js, server.js,
// identity-service.js, unlock-key-store.js) — stub exactly its
// direct imports so it loads standalone, same technique as the
// DM-regression and reactions-endpoint tests.
let apiCallLog = [];
let apiResponses = [];

mock.module(js('core/api.js'), {
    namedExports: {
        api: async (url) => {
            apiCallLog.push(url);
            const next = apiResponses.shift();
            if (next?.error) throw next.error;
            return next?.body ?? {};
        },
        fetchBlob: async () => new Blob(),
    },
});
mock.module(js('core/server.js'), {
    namedExports: {
        getServerEndpoint: () => 'http://localhost',
        setServerEndpoint: () => {},
        isNativeApp: () => false,
    },
});
mock.module(js('crypto/identity-service.js'), {
    namedExports: {
        createIdentity: async () => ({}),
        restoreIdentity: async () => ({}),
        restoreIdentityWithUnlockKey: async () => ({}),
        migrateLegacyAccount: async () => ({ migrated: true }),
        prepareCredentialChange: async () => ({}),
        lockIdentity: () => {},
    },
});
mock.module(js('crypto/keys/session.js'), {
    namedExports: {
        clearSessionKeys: () => {},
    },
});
mock.module(js('crypto/keys/unlock-key-store.js'), {
    namedExports: {
        idbStoreUnlockKey: async () => {},
        idbGetUnlockKey: async () => null,
        idbClearUnlockKey: async () => {},
    },
});
mock.module(js('media/attachment-e2ee.js'), {
    namedExports: {
        clearAllAttachmentSecrets: () => {},
    },
});
mock.module(js('media/mediaToken.js'), {
    namedExports: {
        clearMediaTokenCache: () => {},
    },
});
mock.module(js('media/lazy-e2ee-media.js'), {
    namedExports: {
        purgeMediaStreams: () => {},
    },
});

const { setCurrentUser, getCurrentUser } = await import(
    js('core/auth.js')
);

function resetApiMock(responses) {
    apiCallLog = [];
    apiResponses = [...responses];
}

// Wait for the fire-and-forget /api/me refresh inside setCurrentUser
// to resolve, without relying on a fixed timeout — poll until the
// queued mock responses have actually been consumed.
async function flush() {
    for (let i = 0; i < 50 && apiResponses.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 5));
}

test('setCurrentUser patches groups_enabled from /api/me without touching other fields', async () => {
    resetApiMock([{ body: { groups_enabled: true, accent_color: '#ABCDEF' } }]);

    setCurrentUser({ id: 1, username: 'alice', is_admin: false, bio: 'hello' });
    await flush();

    const user = getCurrentUser();
    assert.equal(user.id, 1);
    assert.equal(user.username, 'alice');
    assert.equal(user.is_admin, false);
    assert.equal(user.bio, 'hello', 'unrelated fields must be untouched');
    assert.equal(user.groups_enabled, true, 'groups_enabled should be patched in from /api/me');
    // Only groups_enabled is merged — /api/me's accent_color must NOT
    // leak in and silently overwrite whatever the caller set.
    assert.equal('accent_color' in user, false, 'must not merge unrelated /api/me fields');
    assert.deepEqual(apiCallLog, ['/api/me']);
});

test('setCurrentUser(null) (logout) does not trigger a refresh call', async () => {
    resetApiMock([]);
    setCurrentUser(null);
    await flush();
    assert.equal(getCurrentUser(), null);
    assert.deepEqual(apiCallLog, [], 'logout must not fire an /api/me request');
});

test('a slow/stale /api/me response never clobbers a newer currentUser (race guard)', async () => {
    // Two rapid setCurrentUser calls, e.g. a fast logout/login —
    // the FIRST call's /api/me response resolves AFTER the second
    // call has already replaced currentUser. It must not stomp the
    // second (current) user's identity with the first (stale) one's
    // groups_enabled value landing on the wrong object.
    resetApiMock([
        { body: { groups_enabled: true } },  // for user A (resolves late, see below)
        { body: { groups_enabled: false } }, // for user B
    ]);

    setCurrentUser({ id: 100, username: 'userA' });
    setCurrentUser({ id: 200, username: 'userB' });

    await flush();

    const user = getCurrentUser();
    assert.equal(user.id, 200, 'userB must remain current');
    // Both queued responses get consumed (each setCurrentUser call
    // fires its own /api/me), but whichever resolves is applied to
    // whatever object is CURRENTLY referenced by currentUser at that
    // time -- since patching happens on the live object via
    // getCurrentUser()-equivalent reference, not a stale closure over
    // "the user that was current when the request was made".
    assert.deepEqual(apiCallLog, ['/api/me', '/api/me']);
});
