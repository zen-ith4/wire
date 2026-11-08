// tests/groups/group-kdm-key-pinning.test.mjs
//
// R1: the group KDM path must consult the SAME peer-trust pin as DMs.
//
// These tests use the real keys/session.js + keys/peer-key-gate.js +
// keys/peer-trust.js, a real fake-indexeddb store and real WebCrypto. Only the
// app singletons (auth, server endpoint, identity, HTTP) are mocked, so the
// gate is exercised as production wires it:
//
//   - first contact pins, no alarm;
//   - a changed key is refused, the derived-key cache does not hide it;
//   - self-KDM uses the LOCAL identity key and never fetches the server;
//   - distribution skips only the changed member and re-wraps after accept;
//   - receive holds the KDM (throws before anything is stored);
//   - missing context fails closed.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';

const js = (rel) => new URL(`../../public/js/${rel}`, import.meta.url).href;

/* ------------------------------------------------------------- app mocks */

globalThis.indexedDB = new IDBFactory();

let currentUser = { id: 1 };
let serverEndpoint = 'https://wire.test';
let currentIdentity = null;
let fetchCount = 0;
const serverPeerKeys = new Map();
const retiredPeerKeys = new Map();

mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => currentUser,
    },
});

mock.module(js('core/server.js'), {
    namedExports: {
        getServerEndpoint: () => serverEndpoint,
    },
});

mock.module(js('crypto/identity-service.js'), {
    namedExports: {
        getCurrentIdentity: () => currentIdentity,
    },
});

mock.module(js('core/api.js'), {
    namedExports: {
        api: async (url) => {
            const path = String(url);

            const history = path.match(/^\/api\/me\/identity-key-history\/(\d+)$/);
            if (history) {
                const id = Number(history[1]);
                return {
                    current: serverPeerKeys.has(id)
                        ? { publicKey: serverPeerKeys.get(id) }
                        : null,
                    history: (retiredPeerKeys.get(id) || []).map((publicKey) => ({ publicKey })),
                };
            }

            const current = path.match(/^\/api\/me\/identity-key\/(\d+)$/);
            if (current) {
                const id = Number(current[1]);
                fetchCount++;
                if (!serverPeerKeys.has(id)) {
                    throw new Error(`no identity key for ${id}`);
                }
                return { publicKey: serverPeerKeys.get(id) };
            }

            throw new Error(`unexpected api call: ${path}`);
        },
    },
});

const {
    resolveGroupPeerKey,
    getChangedGroupPeers,
    clearChangedGroupPeer,
    resetGroupPeerKeyState,
} = await import(js('crypto/keys/peer-key-gate.js'));

const {
    acceptPeerKey,
} = await import(js('crypto/keys/peer-trust.js'));

const session = await import(js('crypto/keys/session.js'));
const { distributeSenderKey, receiveKdm } = await import(js('crypto/groups/kdm.js'));

/* ------------------------------------------------------------- helpers */

function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

async function makeIdentityPair() {
    const pair = await crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveBits']
    );
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);

    return {
        privateKey: pair.privateKey,
        publicKey: bytesToBase64(new Uint8Array(raw)),
    };
}

const own = await makeIdentityPair();
currentIdentity = { privateKey: own.privateKey, publicKey: own.publicKey };

let nextPeerId = 100;

function freshPeerId() {
    return nextPeerId++;
}

beforeEach(() => {
    currentUser = { id: 1 };
    serverEndpoint = 'https://wire.test';
    currentIdentity = { privateKey: own.privateKey, publicKey: own.publicKey };
    resetGroupPeerKeyState();
    session.clearSessionKeys();
});

/* ------------------------------------------------------------- tests */

test('first contact pins the peer key and a repeat use is not an alarm', async () => {
    const peerId = freshPeerId();
    const keyA = await makeIdentityPair();
    serverPeerKeys.set(peerId, keyA.publicKey);

    const first = await resolveGroupPeerKey(peerId, 1, own.publicKey);
    assert.equal(first.state, 'ok');
    assert.equal(first.publicKey, keyA.publicKey);
    assert.deepEqual(getChangedGroupPeers(), []);

    const second = await resolveGroupPeerKey(peerId, 1, own.publicKey);
    assert.equal(second.state, 'ok');
    assert.deepEqual(getChangedGroupPeers(), []);
});

test('a changed key is refused and recorded; the derived-key cache cannot hide it', async () => {
    const peerId = freshPeerId();
    const keyA = await makeIdentityPair();
    const keyB = await makeIdentityPair();
    serverPeerKeys.set(peerId, keyA.publicKey);

    const oldKey = await session.getOrCreateGroupKdmKey(peerId);
    assert.ok(oldKey);

    serverPeerKeys.set(peerId, keyB.publicKey);

    await assert.rejects(
        () => session.getOrCreateGroupKdmKey(peerId),
        (e) => e?.code === 'GROUP_PEER_KEY_CHANGED'
    );

    const changed = getChangedGroupPeers();
    assert.equal(changed.length, 1);
    assert.equal(changed[0].peerId, peerId);

    await acceptPeerKey(peerId, keyB.publicKey, {
        origin: serverEndpoint,
        ownUserId: 1,
    });
    clearChangedGroupPeer(peerId);

    const newKey = await session.getOrCreateGroupKdmKey(peerId);
    assert.notEqual(newKey, oldKey, 'a key derived from K2 must not reuse the K1 cache entry');
});

test('self-KDM uses the local identity key and never asks the server', async () => {
    fetchCount = 0;

    const resolved = await resolveGroupPeerKey(1, 1, own.publicKey);
    assert.equal(resolved.publicKey, own.publicKey);
    assert.equal(fetchCount, 0);

    const key = await session.getOrCreateGroupKdmKey(1);
    assert.ok(key);
    assert.equal(fetchCount, 0);
});

test('self-KDM ignores a hostile server key for the sender own id', async () => {
    // D3: a malicious server can answer /identity-key/<own id> with a key it
    // controls. The self branch must use the local identity public key and
    // never even fetch that response. Setting the server key here is what makes
    // this different from the "never asks the server" count check above: if the
    // branch regresses, the substituted key is a valid, fetchable answer rather
    // than a missing one.
    const hostile = await makeIdentityPair();
    serverPeerKeys.set(1, hostile.publicKey);
    fetchCount = 0;

    const resolved = await resolveGroupPeerKey(1, 1, own.publicKey);
    assert.equal(resolved.publicKey, own.publicKey);
    assert.notEqual(resolved.publicKey, hostile.publicKey);
    assert.equal(fetchCount, 0);

    const key = await session.getOrCreateGroupKdmKey(1);
    assert.ok(key);
    assert.equal(fetchCount, 0);
});

test('a missing signing context fails closed', async () => {
    const peerId = freshPeerId();
    serverPeerKeys.set(peerId, (await makeIdentityPair()).publicKey);

    currentUser = null;

    await assert.rejects(
        () => resolveGroupPeerKey(peerId, null, own.publicKey),
        (e) => e?.code === 'GROUP_PEER_KEY_UNAVAILABLE'
    );
});

test('distribution skips only the changed member and re-wraps after accept', async () => {
    const peerId = freshPeerId();
    const keyA = await makeIdentityPair();
    const keyB = await makeIdentityPair();
    serverPeerKeys.set(peerId, keyA.publicKey);

    await resolveGroupPeerKey(peerId, 1, own.publicKey);
    serverPeerKeys.set(peerId, keyB.publicKey);

    const raw = crypto.getRandomValues(new Uint8Array(32));
    const signPub = new Uint8Array(65);
    signPub[0] = 0x04;

    const first = await distributeSenderKey(raw, signPub, [1, peerId], {
        groupId: 1,
        fromUserId: 1,
        epoch: 0,
    });

    assert.deepEqual(first.recipients.map((r) => r.user_id), [1]);
    assert.deepEqual(first.skipped.map((r) => r.user_id), [peerId]);
    assert.ok(!first.recipients.some((r) => r.user_id === peerId), 'no KDM may be produced for the changed key');

    await acceptPeerKey(peerId, keyB.publicKey, {
        origin: serverEndpoint,
        ownUserId: 1,
    });
    clearChangedGroupPeer(peerId);

    const second = await distributeSenderKey(raw, signPub, [1, peerId], {
        groupId: 1,
        fromUserId: 1,
        epoch: 0,
    });

    assert.deepEqual(second.recipients.map((r) => r.user_id).sort(), [1, peerId].sort());
    assert.deepEqual(second.skipped, []);
});

test('receive holds a KDM from a changed peer before unwrapping or storing anything', async () => {
    const peerId = freshPeerId();
    const keyA = await makeIdentityPair();
    const keyB = await makeIdentityPair();
    serverPeerKeys.set(peerId, keyA.publicKey);

    await resolveGroupPeerKey(peerId, 1, own.publicKey);
    serverPeerKeys.set(peerId, keyB.publicKey);

    await assert.rejects(
        () => receiveKdm(
            { privateKey: own.privateKey, publicKey: own.publicKey, userId: 1 },
            {
                id: 1,
                group_id: 1,
                from_user_id: peerId,
                to_user_id: 1,
                epoch: 0,
                // Never reached: the gate refuses before this is parsed.
                wrapped_key: '{"v":2,"alg":"AES-GCM","iv":"","ciphertext":""}',
            }
        ),
        (e) => e?.code === 'GROUP_PEER_KEY_CHANGED'
    );

    assert.equal(getChangedGroupPeers().some((p) => p.peerId === peerId), true);
});
