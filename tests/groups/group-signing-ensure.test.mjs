// Phase C2: the orchestration around the signing key (messages/group-message-crypto.js):
//   ensureSenderKeyForGroup  - re-key when there is no usable sending key; the superseded
//                              private signing key is dropped only AFTER the 201 and after
//                              the new key is durably stored, under the sender-key lock;
//   drainGroupKdms           - legacy / invalid KDMs are never acked and log ONE line per drain.
// The client's api(), identity and auth singletons are replaced by in-memory fakes; the
// crypto, the Web-Locks-shaped locking and IndexedDB are the real modules.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
    installWebLocksPolyfill,
    newDeviceStorage,
    useDeviceStorage,
    makeTestIdentity,
    makeSessionKeyProvider,
} from './helpers.mjs';

installWebLocksPolyfill();
const polyfillLocks = globalThis.navigator.locks;

const jsPath = (rel) => new URL(`../../public/js/${rel}`, import.meta.url).pathname;
const GROUP = 88;

const identities = new Map();
const sessionProvider = makeSessionKeyProvider(identities);

let currentIdentity = null;
let apiImpl = async () => [];

mock.module(jsPath('crypto/keys/session.js'), {
    namedExports: {
        getOrCreateSessionKey: (id) => sessionProvider.getOrCreateSessionKey(id),
        getOrCreateGroupKdmKey: (id) => sessionProvider.getOrCreateGroupKdmKey(id),
    },
});
mock.module(jsPath('core/api.js'), { namedExports: { api: (...args) => apiImpl(...args) } });
mock.module(jsPath('crypto/identity-service.js'), { namedExports: { getCurrentIdentity: () => currentIdentity } });
mock.module(jsPath('core/auth.js'), { namedExports: { getCurrentUser: () => ({ id: currentIdentity?.userId }) } });

const gmc = await import(jsPath('crypto/messages/group-message-crypto.js'));
const sk = await import(jsPath('crypto/groups/sender-key.js'));
const kdm = await import(jsPath('crypto/groups/kdm.js'));
const store = await import(jsPath('crypto/groups/sender-key-store.js'));
const { encryptBytes } = await import(jsPath('crypto/groups/aead.js'));
const signing = await import(jsPath('crypto/groups/signing.js'));

async function user(id) {
    if (!identities.has(id)) identities.set(id, await makeTestIdentity(id));
    return identities.get(id);
}

async function makeDevice(identity) {
    const storage = newDeviceStorage();
    return {
        identity,
        async run(fn) {
            useDeviceStorage(storage);
            sessionProvider.setCurrentActor(identity.userId);
            currentIdentity = identity;
            globalThis.navigator.locks = polyfillLocks;
            return fn();
        },
    };
}

async function objectStoreProto() {
    const probe = newDeviceStorage();
    return new Promise((resolve) => {
        const req = probe.open('probe', 1);
        req.onupgradeneeded = () => resolve(Object.getPrototypeOf(req.result.createObjectStore('s')));
    });
}

/** Observes every put into the sender-key store (and can inject a fault) without changing behaviour. */
async function watchPuts(onPut, fn) {
    const proto = await objectStoreProto();
    const original = proto.put;
    proto.put = function (value, key) {
        onPut(value);
        return original.call(this, value, key);
    };
    try {
        return await fn();
    } finally {
        proto.put = original;
    }
}

function captureConsole(fn) {
    const lines = [];
    const saved = { warn: console.warn, error: console.error, log: console.log };
    for (const k of Object.keys(saved)) console[k] = (...a) => lines.push([k, a.map(String).join(' ')]);
    return Promise.resolve(fn()).then(
        (r) => { Object.assign(console, saved); return { result: r, lines }; },
        (e) => { Object.assign(console, saved); throw e; }
    );
}

test('E-1: ensureSenderKeyForGroup mints a signing key with the first key, is a no-op afterwards, and re-keys for a new epoch', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);
    const posts = [];
    apiImpl = async (path, opts) => { posts.push({ path, body: JSON.parse(opts.body) }); return {}; };

    await dev.run(async () => {
        assert.equal(await gmc.ensureSenderKeyForGroup(GROUP, [1], 0), true);
        assert.equal(posts.length, 1);
        assert.equal(posts[0].body.epoch, 0);

        const mine = await sk.getMySenderKey(alice, GROUP);
        assert.ok(mine.signKey && mine.signPub, 'the sending key carries a signing key');

        assert.equal(await gmc.ensureSenderKeyForGroup(GROUP, [1], 0), false, 'same epoch: nothing to do');
        assert.equal(posts.length, 1);

        assert.equal(await gmc.ensureSenderKeyForGroup(GROUP, [1], 1), true, 'new epoch: rotates');
        assert.notEqual((await sk.getMySenderKey(alice, GROUP)).senderKeyId, mine.senderKeyId);
    });
});

test('E-2: a sending row without a signing key is unusable for sending and the next ensure re-keys (even at the same epoch)', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);
    apiImpl = async () => ({});

    await dev.run(async () => {
        await gmc.ensureSenderKeyForGroup(GROUP, [1], 0);
        const mine = await sk.getMySenderKey(alice, GROUP);

        const rec = await store.getSenderKeyRecord(mine.senderKeyId);
        const { signKeyWrapped, ...legacyShape } = rec; // an own row that has no signing key
        await store.putSenderKeyRecord(legacyShape);
        sk.clearSenderKeyCache();

        await assert.rejects(() => gmc.encryptOutgoingGroupMessage(GROUP, 'x'), /No Sender Key/);

        assert.equal(await gmc.ensureSenderKeyForGroup(GROUP, [1], 0), true, 're-keyed at the same epoch');
        const after = await sk.getMySenderKey(alice, GROUP);
        assert.notEqual(after.senderKeyId, mine.senderKeyId);
        assert.equal(typeof (await gmc.encryptOutgoingGroupMessage(GROUP, 'sends again')), 'string');
    });
});

test('E-3 (B): the old private signing key is dropped only after the POST returned 201 and the new key was durably stored, under the sender-key lock', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);
    const events = [];
    const held = new Set();
    let oldId = null;

    await dev.run(async () => {
        apiImpl = async () => ({});
        await gmc.ensureSenderKeyForGroup(GROUP, [1], 0);
        oldId = (await sk.getMySenderKey(alice, GROUP)).senderKeyId;

        // track which Web Locks are held
        const baseLocks = globalThis.navigator.locks;
        globalThis.navigator.locks = {
            request: (name, cb) => baseLocks.request(name, async () => {
                held.add(name);
                try { return await cb(); } finally { held.delete(name); }
            }),
        };

        apiImpl = async () => {
            events.push('POST-201');
            assert.ok((await store.getSenderKeyRecord(oldId)).signKeyWrapped, 'at POST time the old signing key still exists');
            return {};
        };

        await watchPuts((v) => {
            if (v?.isMine === 1 && v.signKeyWrapped && v.epoch === 1) events.push('new-key-put');
            if (v?.isMine === 1 && !v.signKeyWrapped && v.senderKeyId === oldId) {
                events.push(held.has(`wire-group-key-ensure:1:${GROUP}`) ? 'old-signing-key-dropped(lock held)' : 'old-signing-key-dropped(NO LOCK)');
            }
        }, () => gmc.ensureSenderKeyForGroup(GROUP, [1], 1));

        assert.deepEqual(events, ['POST-201', 'new-key-put', 'old-signing-key-dropped(lock held)']);
        assert.equal((await store.getSenderKeyRecord(oldId)).signKeyWrapped, undefined);
    });
});

test('E-4 (B): a failed KDM POST leaves the old key fully usable and persists nothing; a process killed mid-POST likewise', async () => {
    const alice = await user(1);
    const dev = await makeDevice(alice);
    let oldId = null;

    await dev.run(async () => {
        apiImpl = async () => ({});
        await gmc.ensureSenderKeyForGroup(GROUP, [1], 0);
        oldId = (await sk.getMySenderKey(alice, GROUP)).senderKeyId;

        // (a) the POST fails
        apiImpl = async () => { throw new Error('network down'); };
        await assert.rejects(() => gmc.ensureSenderKeyForGroup(GROUP, [1], 1), /network down/);
        assert.equal((await store.getAllSenderKeysForGroup(GROUP)).length, 1, 'no orphan key persisted');
        assert.ok((await store.getSenderKeyRecord(oldId)).signKeyWrapped, 'old signing key intact');
        assert.equal((await sk.getMySenderKey(alice, GROUP)).senderKeyId, oldId);
        assert.equal(typeof (await gmc.encryptOutgoingGroupMessage(GROUP, 'old key still sends')), 'string');
    });

    // (b) the process is killed mid-POST: the request never answers, the pending key is abandoned
    await dev.run(async () => {
        apiImpl = () => new Promise(() => {});
        const hung = gmc.ensureSenderKeyForGroup(GROUP, [1], 1);
        hung.catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
    });

    // relaunch: fresh cache, locks released with the dead process
    await dev.run(async () => {
        globalThis.navigator.locks = { request: (_n, cb) => cb() };
        apiImpl = async () => ({});
        assert.equal((await store.getAllSenderKeysForGroup(GROUP)).length, 1);
        assert.ok((await store.getSenderKeyRecord(oldId)).signKeyWrapped);
        assert.equal((await sk.getMySenderKey(alice, GROUP)).senderKeyId, oldId, 'the old key is still the sending key');
        assert.equal(typeof (await gmc.encryptOutgoingGroupMessage(GROUP, 'after the crash')), 'string');
        assert.equal(await gmc.ensureSenderKeyForGroup(GROUP, [1], 1), true, 'and the next ensure rotates normally');
    });
});

test('E-5 (H): legacy and invalid KDMs are never acked and a drain logs at most ONE console line, every drain', async () => {
    const [alice, bob] = await Promise.all([user(1), user(2)]);
    const aliceDev = await makeDevice(alice);
    const bobDev = await makeDevice(bob);

    // one good KDM from Alice
    let good;
    await aliceDev.run(async () => {
        const { rotateSenderKey } = await import(jsPath('crypto/groups/rotation.js'));
        const pending = await rotateSenderKey(alice, GROUP, 0, [1, 2], { deferPersist: true });
        await pending.commit();
        good = pending.recipients.find((r) => r.user_id === 2).wrapped_key;
    });

    const craft = async (payload, epoch = 0) => {
        sessionProvider.setCurrentActor(1);
        const key = await sessionProvider.getOrCreateGroupKdmKey(2);
        const env = await encryptBytes(key, payload, undefined, kdm.kdmAad({ groupId: GROUP, fromUserId: 1, toUserId: 2, epoch }));
        return JSON.stringify({ v: 2, alg: 'AES-GCM', iv: env.iv, ciphertext: env.ciphertext });
    };
    const legacy = () => craft(crypto.getRandomValues(new Uint8Array(32)));
    const bad = (id, wrapped) => ({ id, group_id: GROUP, from_user_id: 1, to_user_id: 2, epoch: 0, wrapped_key: wrapped });

    const rows = [
        bad(10, await legacy()),
        bad(11, await legacy()),
        bad(12, 'this is not json'),
        bad(13, good),
        bad(14, await craft(Uint8Array.from([...crypto.getRandomValues(new Uint8Array(32)), 4, ...new Uint8Array(64)]))), // off-curve point
        bad(15, await legacy()),
    ];

    const acks = [];
    apiImpl = async (path, opts) => {
        if (path.startsWith('/api/groups/kdms/ack')) { acks.push(JSON.parse(opts.body).ids); return {}; }
        return rows;
    };

    await bobDev.run(async () => {
        for (let drain = 1; drain <= 3; drain++) {
            const { result, lines } = await captureConsole(() => gmc.drainGroupKdms());
            assert.equal(result, 1, `drain ${drain}: exactly the one valid KDM was consumed`);
            assert.deepEqual(acks.at(-1), [13], `drain ${drain}: only the consumed row is acked`);
            assert.ok(lines.length <= 1, `drain ${drain}: at most ONE console line, got ${lines.length}: ${JSON.stringify(lines)}`);
            assert.equal(lines.length, 1);
            assert.equal(lines[0][0], 'warn');
            assert.match(lines[0][1], /5 KDM\(s\) could not be consumed and were left unacked/);
            assert.match(lines[0][1], /LegacyKdmError: 3/);
        }

        assert.equal((await store.getAllSenderKeysForGroup(GROUP)).length, 1, 'only the valid key was stored');
        assert.ok(bob);
    });

    // a drain with nothing wrong logs nothing
    apiImpl = async (path, opts) => (path.startsWith('/api/groups/kdms/ack') ? {} : [rows[3]]);
    await bobDev.run(async () => {
        const { lines } = await captureConsole(() => gmc.drainGroupKdms());
        assert.deepEqual(lines, []);
    });
});

test('E-6: a received key can never become a sending key through ensure/send (isMine required)', async () => {
    const [alice, bob] = await Promise.all([user(1), user(2)]);
    const aliceDev = await makeDevice(alice);
    const bobDev = await makeDevice(bob);
    apiImpl = async () => ({});

    let wrapped;
    await aliceDev.run(async () => {
        const { rotateSenderKey } = await import(jsPath('crypto/groups/rotation.js'));
        const pending = await rotateSenderKey(alice, GROUP, 0, [1, 2], { deferPersist: true });
        await pending.commit();
        wrapped = pending.recipients.find((r) => r.user_id === 2).wrapped_key;
    });

    await bobDev.run(async () => {
        await kdm.receiveKdm(bob, { id: 1, group_id: GROUP, from_user_id: 1, to_user_id: 2, epoch: 0, wrapped_key: wrapped });
        await assert.rejects(() => gmc.encryptOutgoingGroupMessage(GROUP, 'x'), /No Sender Key/);

        // ensure for the SAME epoch still mints Bob's OWN key (he has no sending key)
        assert.equal(await gmc.ensureSenderKeyForGroup(GROUP, [1, 2], 0), true);
        const mine = await sk.getMySenderKey(bob, GROUP);
        assert.equal((await store.getSenderKeyRecord(mine.senderKeyId)).ownerUserId, 2);
        assert.ok(mine.signKey);
        assert.ok(signing);
    });
});
