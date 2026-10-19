// tests/groups/group-attachment-upload-cap.test.mjs
//
// STEP 3D item 3: the client cap must come from one place.
//
// The DM path learns the server's cap from `GET /api/dm/limits`
// (public/js/media/attachment-e2ee.js:288-303, served by
// controllers/dm.controller.js:326 and routes/dm.routes.js:31). There is NO
// group equivalent: routes/groups.routes.js has no /limits route, so this
// step cannot add one (routes/ is out of scope and the task forbids
// inventing a new endpoint) - the sub-item is a documented STOP.
//
// What IS testable here is the client side of the mechanism: the cap is
// checked BEFORE the file is encrypted, so a file that is too big never
// burns a counter and never reaches the network.

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

const GROUP = 91;

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

test('a file over the client cap is refused BEFORE it is encrypted (no counter is burned)', async () => {
    const alice = await user(11);
    const A = await device(alice);
    await A.run(() => rotateSenderKey(alice, GROUP, 0, [alice.userId]));
    const mine = await A.run(() => senderKey.getMySenderKey(alice, GROUP));
    assert.ok(mine?.senderKeyId, 'Alice must have a Sender Key');

    // 2 MB with a 1 MB cap: the server would refuse it, so the client must
    // refuse it first - before the file is encrypted.
    const file = new File([new Uint8Array(2 * 1024 * 1024)], 'big.bin', { type: 'application/octet-stream' });
    const before = await A.run(() => keyStore.readCounter(mine.senderKeyId));

    await assert.rejects(
        () => A.run(() => ga.prepareGroupAttachmentUpload({ file, groupId: GROUP, maxMb: 1 })),
        (e) => e instanceof ga.GroupAttachmentTooLargeError && e.maxMb === 1,
        'the file must be refused with the typed error'
    );

    const after = await A.run(() => keyStore.readCounter(mine.senderKeyId));
    assert.equal(after, before, 'a refused file must not move the nonce counter');
});

test('the cap is a named constant, so the one place that has to learn it is obvious', async () => {
    assert.equal(typeof ga.DEFAULT_GROUP_ATTACHMENT_UPLOAD_MAX_MB, 'number');
    assert.ok(ga.DEFAULT_GROUP_ATTACHMENT_UPLOAD_MAX_MB > 0);
    // The client refuses over the cap, never exactly at it.
    const file = new File([new Uint8Array(16)], 'x.bin', { type: 'application/octet-stream' });
    await assert.rejects(
        () => ga.prepareGroupAttachmentUpload({ file, groupId: GROUP, maxMb: 0 }),
        (e) => e instanceof ga.GroupAttachmentTooLargeError
    );
});
