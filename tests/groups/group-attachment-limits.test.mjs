// tests/groups/group-attachment-limits.test.mjs
//
// STEP 3E item 1: the client learns the server's upload cap.
//
// The DM path uses `GET /api/dm/limits`; the group path now uses
// `GET /api/groups/limits` (routes/groups.routes.js). The client:
//
//   - fetches it once per session (memoised, like DM);
//   - uses it for the upload pre-check, so a smaller server cap makes the
//     client refuse BEFORE it encrypts (and before a counter is burned);
//   - uses it for the download bound (the item 0 maximum);
//   - falls back to the named default when the request fails - the server
//     stays the authority;
//   - NEVER trusts a value above its own compiled-in hard ceiling: a hostile
//     server must not be able to raise the client's memory bound.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installWebLocksPolyfill, newDeviceStorage, useDeviceStorage, makeTestIdentity, makeSessionKeyProvider } from './helpers.mjs';

installWebLocksPolyfill();

const js = (rel) => pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', rel)
).href;

const identitiesByUserId = new Map();
let currentActorId = null;

mock.module(js('crypto/identity-service.js'), {
    namedExports: {
        getCurrentIdentity: () => {
            const id = identitiesByUserId.get(currentActorId);
            return id ? { privateKey: id.privateKey, publicKey: id.publicKey } : null;
        },
    },
});
mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => (currentActorId ? { id: currentActorId } : null),
        getToken: () => 'fake-token',
        logout: () => {},
    },
});

// The limits endpoint is stubbed: the test drives the three cases (a smaller
// cap, a failing endpoint, a hostile huge value).
let limitsValue = 1;
let limitsFails = false;
let limitsCalls = 0;
mock.module(js('core/api.js'), {
    namedExports: {
        api: async (url) => {
            if (String(url).includes('/limits')) {
                limitsCalls++;
                if (limitsFails) throw new Error('the limits endpoint is unreachable');
                return { upload_max_mb: limitsValue };
            }
            throw new Error(`unexpected api call: ${url}`);
        },
    },
});

const identities = new Map();
const sessionProvider = makeSessionKeyProvider(identities);
mock.module(js('crypto/keys/session.js'), {
    namedExports: {
        getOrCreateSessionKey: (id) => sessionProvider.getOrCreateSessionKey(id),
        getOrCreateGroupKdmKey: (id) => sessionProvider.getOrCreateGroupKdmKey(id),
    },
});

const ga = await import(js('chat/group-attachments.js'));
const senderKey = await import(js('crypto/groups/sender-key.js'));
const keyStore = await import(js('crypto/groups/sender-key-store.js'));
const { rotateSenderKey } = await import(js('crypto/groups/rotation.js'));

const GROUP = 93;

async function user(id) {
    if (!identities.has(id)) identities.set(id, await makeTestIdentity(id));
    identitiesByUserId.set(id, identities.get(id));
    return identities.get(id);
}

async function device(identity) {
    const storage = newDeviceStorage();
    return {
        identity,
        async run(fn) {
            useDeviceStorage(storage);
            sessionProvider.setCurrentActor(identity.userId);
            currentActorId = identity.userId;
            return fn();
        },
    };
}

function resetLimits(value, fails = false) {
    limitsValue = value;
    limitsFails = fails;
    limitsCalls = 0;
    ga.resetGroupUploadLimitCache();
}

test('the cap is fetched once per session and memoised', async () => {
    resetLimits(7);
    assert.equal(await ga.getGroupUploadLimitMb(), 7);
    assert.equal(await ga.getGroupUploadLimitMb(), 7);
    assert.equal(limitsCalls, 1, 'the endpoint must be asked once');
});

test('a smaller server cap makes the client refuse BEFORE it encrypts (the counter does not move)', async () => {
    const alice = await user(21);
    const A = await device(alice);
    await A.run(() => rotateSenderKey(alice, GROUP, 0, [alice.userId]));
    const mine = await A.run(() => senderKey.getMySenderKey(alice, GROUP));
    assert.ok(mine?.senderKeyId, 'Alice must have a Sender Key');

    resetLimits(1);
    const file = new File([new Uint8Array(2 * 1024 * 1024)], 'big.bin', { type: 'application/octet-stream' });
    const before = await A.run(() => keyStore.readCounter(mine.senderKeyId));

    await assert.rejects(
        () => A.run(() => ga.prepareGroupAttachmentUpload({ file, groupId: GROUP })),
        (e) => e instanceof ga.GroupAttachmentTooLargeError && e.maxMb === 1,
        'the file must be refused with the server cap'
    );

    const after = await A.run(() => keyStore.readCounter(mine.senderKeyId));
    assert.equal(after, before, 'a refused file must not move the nonce counter');
});

test('a failing endpoint falls back to the named default (and the server stays the authority)', async () => {
    const alice = await user(22);
    const A = await device(alice);
    await A.run(() => rotateSenderKey(alice, GROUP, 0, [alice.userId]));

    resetLimits(50, true);
    assert.equal(await ga.getGroupUploadLimitMb(), ga.DEFAULT_GROUP_ATTACHMENT_UPLOAD_MAX_MB, 'the fallback is the named default');

    // A file that fits the default is accepted.
    const ok = new File([new Uint8Array(1024)], 'ok.bin', { type: 'application/octet-stream' });
    const prepared = await A.run(() => ga.prepareGroupAttachmentUpload({ file: ok, groupId: GROUP }));
    assert.ok(prepared.fields.content, 'the upload must be prepared');

    // A file over the default is refused.
    const tooBig = new File([new Uint8Array(60 * 1024 * 1024)], 'huge.bin', { type: 'application/octet-stream' });
    await assert.rejects(
        () => A.run(() => ga.prepareGroupAttachmentUpload({ file: tooBig, groupId: GROUP })),
        (e) => e instanceof ga.GroupAttachmentTooLargeError
    );
});

test('a value above the hard ceiling is clamped: a hostile server cannot raise the client bound', async () => {
    resetLimits(5000);
    assert.equal(await ga.getGroupUploadLimitMb(), ga.MAX_GROUP_ATTACHMENT_HARD_MAX_MB, 'the value must be clamped');

    // The download bound is the hard ceiling, not the server's value.
    const max = await ga.groupAttachmentDownloadMaxBytes();
    assert.equal(max, ga.MAX_GROUP_ATTACHMENT_PLAINTEXT_BYTES);
    assert.equal(max, ga.MAX_GROUP_ATTACHMENT_HARD_MAX_MB * 1024 * 1024);
});

test('a hostile value above the ceiling does not raise the download bound either', async () => {
    resetLimits(999999);
    const max = await ga.groupAttachmentDownloadMaxBytes();
    assert.equal(max, ga.MAX_GROUP_ATTACHMENT_PLAINTEXT_BYTES, 'the client bound stays at its own ceiling');
});
