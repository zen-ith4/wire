// tests/dm-key-gate.test.mjs
//
// The DM send and receive paths against a HOSTILE server.
//
// The threat model says the server is an active adversary, and a server chooses
// the answer to every request separately. So it can show the trust check the pinned
// key and the encryption its own, or answer one key endpoint honestly and lie on the
// other. Everything before this file checked the gate and the crypto apart, which
// is why these paths stayed open while their tests were green.
//
// Real: keys/peer-keys.js, keys/peer-key-gate.js, keys/peer-trust.js, keys/session.js,
// messages/dm-v2.js, dm-v2-wire.js, message-crypto.js, encrypt.js, decrypt.js,
// media/attachment-e2ee.js, chat/dm-key-trust.js, and real WebCrypto. Only the app
// singletons and HTTP are replaced, and HTTP is the hostile server double below.
//
// Every "refused" assertion has a positive control beside it, so a refusal cannot
// pass because the fixture was simply broken.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

/* ---------------------------------------------------------------- IndexedDB stand-in */
function installFakeIndexedDb() {
    const stores = new Map();
    const store = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const request = (result) => {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result };
        queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
        return req;
    };
    const fakeDb = () => ({
        objectStoreNames: { contains: (n) => n === 'peer-pins' },
        transaction(storeName, mode) {
            const data = store(storeName);
            const tx = {
                oncomplete: null,
                onerror: null,
                objectStore() {
                    return {
                        put(value, key) { if (mode === 'readwrite') data.set(key, value); return request(undefined); },
                        get(key) { return request(data.get(key)); },
                        delete(key) { if (mode === 'readwrite') data.delete(key); return request(undefined); },
                    };
                },
            };
            queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); })));
            return tx;
        },
    });
    globalThis.indexedDB = {
        open() {
            const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null };
            queueMicrotask(() => {
                req.result = fakeDb();
                if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
                if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
        },
    };
}
installFakeIndexedDb();

/* ---------------------------------------------------------------- localStorage stand-in */
const ls = new Map();
globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(k, String(v)); },
    removeItem: (k) => { ls.delete(k); },
    clear: () => { ls.clear(); },
};

/* ---------------------------------------------------------------- real identities */
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function person() {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { priv: pair.privateKey, pub: pair.publicKey, raw, b64: b64(raw) };
}

const ALICE = 1;
const ORIGIN = 'https://wire.test';
const CTX = { origin: ORIGIN, ownUserId: ALICE };

const alice = await person();
const mallory = await person(); // the server's own key, the one it wants to substitute

/* ---------------------------------------------------------------- the hostile server */
const server = {
    // GET /api/me/identity-key/:id. `scripted` answers first, one per request.
    keys: new Map(),
    scripted: new Map(),
    // GET /api/me/identity-key-history/:id
    historyCurrent: new Map(),
    retired: new Map(),
    onHistory: null,
    calls: [],
};

function answerIdentityKey(id) {
    const queue = server.scripted.get(id);
    const answer = queue?.length ? queue.shift() : server.keys.get(id);
    if (!answer) throw new Error('Identity key not found');
    return { publicKey: answer, dmE2eeMinVersion: 2 };
}

let currentUser = { id: ALICE };
let currentIdentity = { privateKey: alice.priv, publicKey: alice.b64 };

mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => currentUser,
        getToken: () => 'test-token',
        logout: () => {},
    },
});

mock.module(js('core/server.js'), {
    namedExports: {
        getServerEndpoint: () => ORIGIN,
        resolveServerUrl: (url) => url,
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
                server.calls.push(`history:${id}`);
                if (server.onHistory) await server.onHistory(id);
                return {
                    current: { publicKey: server.historyCurrent.get(id) ?? server.keys.get(id) },
                    history: (server.retired.get(id) || []).map((publicKey) => ({ publicKey })),
                };
            }

            const key = path.match(/^\/api\/me\/identity-key\/(\d+)$/);
            if (key) {
                const id = Number(key[1]);
                server.calls.push(`key:${id}`);
                return answerIdentityKey(id);
            }

            if (path === '/api/dm/limits') return { upload_max_mb: 50 };

            throw new Error(`unexpected api call: ${path}`);
        },
    },
});

const trust = await import(js('crypto/keys/peer-trust.js'));
const gate = await import(js('crypto/keys/peer-key-gate.js'));
const session = await import(js('crypto/keys/session.js'));
const { deriveSessionKeyFromPeer } = await import(js('crypto/keys/key-derivation.js'));
const v2 = await import(js('crypto/messages/dm-v2.js'));
const wire = await import(js('crypto/messages/dm-v2-wire.js'));
const messageCrypto = await import(js('crypto/messages/message-crypto.js'));
const e2ee = await import(js('media/attachment-e2ee.js'));
const keyTrust = await import(js('chat/dm-key-trust.js'));

/* ---------------------------------------------------------------- helpers */
let nextPeerId = 100;
let nextRowId = 1000;

/** A peer whose real key the server currently reports honestly. */
async function meetPeer() {
    const id = nextPeerId++;
    const keys = await person();
    server.keys.set(id, keys.b64);
    return { id, keys };
}

/** Alice has already met this peer: the honest key is pinned. */
async function pinnedPeer() {
    const peer = await meetPeer();
    await gate.resolveDmPeerKey(peer.id);
    return peer;
}

const fp = (keys) => v2.senderKeyFingerprint(keys.raw);

/** A v2 row that `sender` really sealed to Alice under `fromId`. */
async function rowFrom(fromId, sender, plaintext) {
    const key = await v2.deriveDmV2Key(fromId, ALICE, sender.priv, alice.pub);
    const { envelope } = await v2.encryptDmV2({
        plaintext,
        fromUserId: fromId,
        toUserId: ALICE,
        senderKeyFp: await fp(sender),
        key,
    });
    return envelope;
}

const open = (envelope, peerId) => wire.openDmV2Envelope({
    payload: envelope,
    peerId,
    ownUserId: ALICE,
    rowId: nextRowId++,
});

/** Can `recipient` open a v2 envelope Alice sent to `recipientId`? */
async function peerOpens(envelope, recipientId, recipient) {
    const key = await v2.deriveDmV2Key(ALICE, recipientId, recipient.priv, alice.pub);
    return v2.decryptDmV2({ envelope, senderKeyFp: await fp(alice), key });
}

/** The v1 session key a person shares with Alice. */
const v1KeyWithAlice = (keys) => deriveSessionKeyFromPeer(keys.priv, alice.pub);

function ivBytes(payload) {
    return Buffer.from(payload.iv ?? payload.encryption.iv, 'base64');
}

async function v1Open(payload, keys) {
    const ciphertext = Buffer.from(payload.encryption.ciphertext, 'base64');
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes(payload) },
        await v1KeyWithAlice(keys),
        ciphertext
    );
    return new TextDecoder().decode(plain);
}

/** A v1 row `sender` really sealed to Alice under `fromId`. */
async function v1RowFrom(fromId, sender, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        await v1KeyWithAlice(sender),
        new TextEncoder().encode(plaintext)
    );
    return {
        encryption: {
            version: 1,
            algorithm: 'AES-GCM',
            iv: b64(iv),
            ciphertext: b64(new Uint8Array(ciphertext)),
        },
        senderId: fromId,
        recipientId: ALICE,
    };
}

beforeEach(() => {
    currentUser = { id: ALICE };
    currentIdentity = { privateKey: alice.priv, publicKey: alice.b64 };
    server.calls.length = 0;
    server.onHistory = null;
    session.clearSessionKeys();
});

/* ---------------------------------------------------------------- send */

test('send: the key encrypted to is the key that was checked, whatever the next answer is', async () => {
    const peer = await pinnedPeer();

    // The attack: the honest key for whichever request is the check, the server's
    // own for the one after it. There must not BE a request after it.
    server.scripted.set(peer.id, [peer.keys.b64, mallory.b64, mallory.b64]);
    server.calls.length = 0;

    const { envelope } = await wire.buildDmV2Content({
        plaintext: 'my secret',
        senderId: ALICE,
        recipientId: peer.id,
    });

    assert.deepEqual(server.calls, [`key:${peer.id}`], 'one send must fetch the peer key exactly once');
    server.scripted.delete(peer.id);

    assert.equal(await peerOpens(envelope, peer.id, peer.keys), 'my secret');
    await assert.rejects(() => peerOpens(envelope, peer.id, mallory),
        'the server must not be able to open what was sent');
});

test('send: a changed key is refused before anything is encrypted, text and attachment meta alike', async () => {
    const peer = await pinnedPeer();

    // Positive control: the same calls work while the server tells the truth.
    await wire.buildDmV2Content({ plaintext: 'x', senderId: ALICE, recipientId: peer.id });
    await wire.buildDmV2AttachmentMetaContent({ plaintext: '{}', senderId: ALICE, recipientId: peer.id });

    server.keys.set(peer.id, mallory.b64);

    const changed = (e) => e?.code === 'PEER_KEY_CHANGED';
    await assert.rejects(
        () => wire.buildDmV2Content({ plaintext: 'x', senderId: ALICE, recipientId: peer.id }), changed);
    await assert.rejects(
        () => wire.buildDmV2AttachmentMetaContent({ plaintext: '{}', senderId: ALICE, recipientId: peer.id }), changed);
    await assert.rejects(() => messageCrypto.encryptDmTextV2('x', ALICE, peer.id), changed);
});

test('send: failing the key request does not open the gate', async () => {
    const peer = await pinnedPeer();
    server.keys.delete(peer.id);

    await assert.rejects(
        () => wire.buildDmV2Content({ plaintext: 'x', senderId: ALICE, recipientId: peer.id }),
        (e) => e?.code === 'PEER_KEY_UNAVAILABLE' && /Identity key not found/.test(e.message)
    );
});

test('send: the thread gate refuses a changed key too', async () => {
    const peer = await pinnedPeer();
    await keyTrust.assertCanSendTo(peer.id);

    server.keys.set(peer.id, mallory.b64);

    await assert.rejects(() => keyTrust.assertCanSendTo(peer.id), (e) => e?.code === 'PEER_KEY_CHANGED');
});

/* ---------------------------------------------------------------- receive */

test('receive: a row forged under a substituted key does not open, whichever endpoint lies', async () => {
    const peer = await pinnedPeer();

    // Positive control: a genuine row opens.
    const genuine = await open(await rowFrom(peer.id, peer.keys, 'hello from the peer'), peer.id);
    assert.equal(genuine.plaintext, 'hello from the peer');

    const forged = () => rowFrom(peer.id, mallory, 'wire me the money');
    const noSenderKey = (e) => e?.code === 'DM_V2_NO_SENDER_KEY';

    // The check is told the truth; only the history endpoint lies.
    server.historyCurrent.set(peer.id, mallory.b64);
    await assert.rejects(async () => open(await forged(), peer.id), noSenderKey);

    // Both endpoints lie.
    server.keys.set(peer.id, mallory.b64);
    await assert.rejects(async () => open(await forged(), peer.id), noSenderKey);

    // Listed as a retired key as well, which is the other way in.
    server.retired.set(peer.id, [mallory.b64]);
    await assert.rejects(async () => open(await forged(), peer.id), noSenderKey);
});

test('receive: once pinned, the server is not asked which keys are the peer\'s', async () => {
    const peer = await pinnedPeer();
    server.calls.length = 0;

    const { plaintext } = await open(await rowFrom(peer.id, peer.keys, 'no fetch needed'), peer.id);

    assert.equal(plaintext, 'no fetch needed');
    assert.deepEqual(server.calls, []);

    // Which also means a failing server cannot stop history under a pinned key.
    server.keys.delete(peer.id);
    const offline = await open(await rowFrom(peer.id, peer.keys, 'still readable'), peer.id);
    assert.equal(offline.plaintext, 'still readable');
});

test('receive: a row forged as our OWN does not open under a key the server supplies', async () => {
    const peer = await pinnedPeer();

    // Positive control: a row Alice really sent opens.
    const { envelope: mine } = await wire.buildDmV2Content({
        plaintext: 'I really sent this',
        senderId: ALICE,
        recipientId: peer.id,
    });
    const ownRow = (envelope) => open(envelope, peer.id);
    assert.equal((await ownRow(mine)).plaintext, 'I really sent this');

    // The server seals a row "from Alice" with its own key, then names that key
    // as the peer's. The envelope's senderFp is Alice's real one.
    const forgedKey = await v2.deriveDmV2Key(ALICE, peer.id, mallory.priv, alice.pub);
    const { envelope: forged } = await v2.encryptDmV2({
        plaintext: 'I never sent this',
        fromUserId: ALICE,
        toUserId: peer.id,
        senderKeyFp: await fp(alice),
        key: forgedKey,
    });

    server.keys.set(peer.id, mallory.b64);
    server.historyCurrent.set(peer.id, mallory.b64);

    await assert.rejects(() => ownRow(forged));
});

test('receive: our own row sealed to a key the peer has since retired still opens', async () => {
    const peer = await pinnedPeer();
    const { envelope } = await wire.buildDmV2Content({
        plaintext: 'sent before the rotation',
        senderId: ALICE,
        recipientId: peer.id,
    });

    const rotated = await person();
    server.keys.set(peer.id, rotated.b64);
    await trust.acceptPeerKey(peer.id, rotated.b64, CTX);

    const { plaintext } = await open(envelope, peer.id);
    assert.equal(plaintext, 'sent before the rotation');
});

test('receive: first contact pins from the read path, so the next substitution has something to fail against', async () => {
    const peer = await meetPeer();

    // The conversation list is often the first thing to read a row from a peer.
    const first = await open(await rowFrom(peer.id, peer.keys, 'first sight'), peer.id);
    assert.equal(first.plaintext, 'first sight');
    assert.equal((await trust.getPeerPin(peer.id, CTX)).current.publicKey, peer.keys.b64);

    server.keys.set(peer.id, mallory.b64);
    await assert.rejects(
        async () => open(await rowFrom(peer.id, mallory, 'forged'), peer.id),
        (e) => e?.code === 'DM_V2_NO_SENDER_KEY'
    );
});

/* ---------------------------------------------------------------- attachments */

function watchedFile() {
    const reads = [];
    const file = new File([new Uint8Array(4096).fill(7)], 'holiday.bin', { type: 'application/octet-stream' });
    for (const method of ['arrayBuffer', 'stream', 'slice', 'text', 'bytes']) {
        const original = file[method];
        if (typeof original !== 'function') continue;
        file[method] = function watched(...args) {
            reads.push(method);
            return original.apply(this, args);
        };
    }
    return { file, reads };
}

test('attachments: a changed key refuses the file, the voice note and the caption before any byte is read', async () => {
    const peer = await pinnedPeer();

    // Positive control: under the pinned key the real prepare function works, and the
    // recipient really can open what it produced.
    const honest = watchedFile();
    const prepared = await e2ee.prepareDmAttachmentUpload({
        file: honest.file,
        caption: 'look at this',
        isVoice: false,
        senderId: ALICE,
        recipientId: peer.id,
    });
    assert.ok(honest.reads.length > 0, 'control: an accepted upload must actually read the file');
    assert.equal(
        await peerOpens(JSON.parse(prepared.fields.content), peer.id, peer.keys),
        'look at this'
    );

    server.keys.set(peer.id, mallory.b64);

    for (const isVoice of [false, true]) {
        const { file, reads } = watchedFile();
        await assert.rejects(
            () => e2ee.prepareDmAttachmentUpload({
                file,
                caption: 'look at this',
                isVoice,
                senderId: ALICE,
                recipientId: peer.id,
            }),
            (e) => e?.code === 'PEER_KEY_CHANGED'
        );
        assert.deepEqual(reads, [], 'a refusal must cost nothing: no byte of the file is read');
    }
});

test('attachments: a key that changes after the early check is refused at the point of use', async () => {
    const peer = await pinnedPeer();

    // The early check sees the pinned key. Everything after it is the attack, and
    // the file key inside the meta must not be encrypted to it.
    server.scripted.set(peer.id, [peer.keys.b64, mallory.b64, mallory.b64, mallory.b64]);

    const { file } = watchedFile();
    await assert.rejects(
        () => e2ee.prepareDmAttachmentUpload({
            file,
            caption: 'look at this',
            isVoice: false,
            senderId: ALICE,
            recipientId: peer.id,
        }),
        (e) => e?.code === 'PEER_KEY_CHANGED'
    );
    server.scripted.delete(peer.id);
});

/* ---------------------------------------------------------------- v1 */

test('v1: the session key comes from the pin, so a substituted key reaches neither side', async () => {
    const peer = await pinnedPeer();

    server.keys.set(peer.id, mallory.b64);
    session.clearSessionKeys();

    const sent = await messageCrypto.encryptOutgoingMessage('v1 secret', ALICE, peer.id);
    assert.equal(await v1Open(sent, peer.keys), 'v1 secret');
    await assert.rejects(() => v1Open(sent, mallory), 'the server must not be able to open it');

    // Positive control, then the forgery. The row is sealed with Alice's real key on
    // the far side, so only the choice of key could let it through.
    const genuine = await v1RowFrom(peer.id, peer.keys, 'genuine v1');
    assert.equal(await messageCrypto.decryptIncomingMessage(genuine, peer.id), 'genuine v1');

    server.historyCurrent.set(peer.id, mallory.b64);
    server.retired.set(peer.id, [mallory.b64]);
    await assert.rejects(
        async () => messageCrypto.decryptIncomingMessage(await v1RowFrom(peer.id, mallory, 'forged'), peer.id),
        /Message authentication failed/
    );
});

test('v1: reading an old row neither redirects later sends nor breaks new rows', async () => {
    const peer = await pinnedPeer();
    const oldRow = await v1RowFrom(peer.id, peer.keys, 'from the old key');

    const rotated = await person();
    server.keys.set(peer.id, rotated.b64);
    server.retired.set(peer.id, [peer.keys.b64]);
    await trust.acceptPeerKey(peer.id, rotated.b64, CTX);
    session.removeSessionKey(peer.id);

    // Through the retired-key fallback, which used to replace the session key.
    assert.equal(await messageCrypto.decryptIncomingMessage(oldRow, peer.id), 'from the old key');

    const sent = await messageCrypto.encryptOutgoingMessage('after reading history', ALICE, peer.id);
    assert.equal(await v1Open(sent, rotated), 'after reading history', 'sends must go to the current key');
    await assert.rejects(() => v1Open(sent, peer.keys), 'sends must not go to the retired key');

    const newRow = await v1RowFrom(peer.id, rotated, 'from the new key');
    assert.equal(await messageCrypto.decryptIncomingMessage(newRow, peer.id), 'from the new key');
    assert.equal(await messageCrypto.decryptIncomingMessage(oldRow, peer.id), 'from the old key');
});

/* ---------------------------------------------------------------- first contact */

test('first contact: a key the server planted in the retired list cannot become current', async () => {
    const peer = await meetPeer();
    server.retired.set(peer.id, [mallory.b64]);

    const first = await gate.resolveDmPeerKey(peer.id);
    assert.equal(first.publicKey, peer.keys.b64);

    // Unverified, and the alarm still fires. It used to be "reknown": no alarm.
    server.keys.set(peer.id, mallory.b64);
    await assert.rejects(() => gate.resolveDmPeerKey(peer.id), (e) => e?.code === 'PEER_KEY_CHANGED');
});

test('first contact: verifying removes the planted key as a way to forge messages', async () => {
    const peer = await meetPeer();
    server.retired.set(peer.id, [mallory.b64]);
    await gate.resolveDmPeerKey(peer.id);

    // KNOWN LIMIT, pinned on purpose: before anyone has compared numbers this is
    // ordinary TOFU. The server could as easily have substituted the current key.
    const beforeVerifying = await open(await rowFrom(peer.id, mallory, 'unverified contact'), peer.id);
    assert.equal(beforeVerifying.plaintext, 'unverified contact');

    await trust.markPeerVerified(peer.id, CTX);
    session.removeSessionKey(peer.id);

    await assert.rejects(
        async () => open(await rowFrom(peer.id, mallory, 'verified contact'), peer.id),
        (e) => e?.code === 'DM_V2_NO_SENDER_KEY'
    );
    await assert.rejects(
        async () => messageCrypto.decryptIncomingMessage(await v1RowFrom(peer.id, mallory, 'forged'), peer.id),
        /Message authentication failed/
    );

    // Positive control: the key the user actually verified still works.
    const genuine = await open(await rowFrom(peer.id, peer.keys, 'verified key'), peer.id);
    assert.equal(genuine.plaintext, 'verified key');
});

test('first contact: the loser of a race is told, not handed a key the pin does not hold', async () => {
    const peer = await meetPeer();

    // resolveDmPeerKey has fetched the server's key and seen no pin. While it asks
    // for the retired list, another caller pins the honest key first.
    server.keys.set(peer.id, mallory.b64);
    server.onHistory = () => trust.pinOnFirstUse(peer.id, peer.keys.b64, CTX);

    await assert.rejects(() => gate.resolveDmPeerKey(peer.id), (e) => e?.code === 'PEER_KEY_CHANGED');

    assert.equal((await trust.getPeerPin(peer.id, CTX)).current.publicKey, peer.keys.b64,
        'the first pin must survive');
});

test('no signed-in account: both directions fail closed', async () => {
    const peer = await meetPeer();
    currentUser = null;

    const unavailable = (e) => e?.code === 'PEER_KEY_UNAVAILABLE';
    await assert.rejects(() => gate.resolveDmPeerKey(peer.id), unavailable);
    await assert.rejects(() => gate.getTrustedPeerKeys(peer.id), unavailable);
});

/* ---------------------------------------------------------------- accepting */

test('accept pins the key the user was shown, not the server\'s latest answer', async () => {
    const peer = await pinnedPeer();
    const shown = await person();
    const later = await person();

    server.keys.set(peer.id, shown.b64);
    const first = await keyTrust.resolveTrust(peer.id);
    assert.equal(first.state, 'changed');
    assert.equal(first.pending.publicKey, shown.b64);

    // The server changes its answer while the user is comparing digits.
    server.keys.set(peer.id, later.b64);
    const second = await keyTrust.resolveTrust(peer.id);
    assert.equal(second.pending.publicKey, shown.b64, 'what the user is being asked about must not move');

    await keyTrust.acceptNewKey(peer.id);
    assert.equal((await trust.getPeerPin(peer.id, CTX)).current.publicKey, shown.b64);

    // The newer answer is not lost: it is a fresh alarm about a fresh key.
    const third = await keyTrust.resolveTrust(peer.id);
    assert.equal(third.state, 'changed');
    assert.equal(third.pending.publicKey, later.b64);
});

test('accepting a key does not verify it, and drops any earlier verification', async () => {
    const peer = await pinnedPeer();
    await trust.markPeerVerified(peer.id, CTX);
    assert.ok((await trust.getPeerPin(peer.id, CTX)).verifiedAt);

    const rotated = await person();
    server.keys.set(peer.id, rotated.b64);
    await keyTrust.resolveTrust(peer.id);
    await keyTrust.acceptNewKey(peer.id);

    const pin = await trust.getPeerPin(peer.id, CTX);
    assert.equal(pin.current.publicKey, rotated.b64);
    assert.equal(pin.verifiedAt, null);
});

test('accepting with nothing pending changes nothing', async () => {
    const peer = await pinnedPeer();
    const before = await trust.getPeerPin(peer.id, CTX);

    await keyTrust.acceptNewKey(peer.id);

    assert.deepEqual(await trust.getPeerPin(peer.id, CTX), before);
});

test('accepting clears keys derived before the pin moved', async () => {
    const peer = await pinnedPeer();
    await messageCrypto.encryptOutgoingMessage('primes the session cache', ALICE, peer.id);

    const rotated = await person();
    server.keys.set(peer.id, rotated.b64);
    await keyTrust.resolveTrust(peer.id);
    await keyTrust.acceptNewKey(peer.id);

    const sent = await messageCrypto.encryptOutgoingMessage('to the new key', ALICE, peer.id);
    assert.equal(await v1Open(sent, rotated), 'to the new key');
});

/* ---------------------------------------------------------------- pins an older version saved */

// Pins live on the user's device and outlive any deploy, so an upgraded device holds
// what an older version wrote. These tests put exactly that on disk: `verifiedAt` with
// no `verifiedKey`, and keys from first contact still in `accepted`.
const HOUR = 3600000;

const pinFingerprint = async (keys) => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', keys.raw)));

async function writeRawPin(peerId, pin) {
    const opening = indexedDB.open('wire-peer-trust', 1);
    const db = await new Promise((resolve, reject) => {
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
    });
    await new Promise((resolve, reject) => {
        const tx = db.transaction('peer-pins', 'readwrite');
        tx.objectStore('peer-pins').put(pin, `${ORIGIN}::${ALICE}::${peerId}`);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** `markedAfter`: how long after the key was pinned the old code stamped verifiedAt. */
async function peerWithOldPin(markedAfter) {
    const peer = await meetPeer();
    const planted = await person();
    const at = Date.now() - 24 * HOUR;

    await writeRawPin(peer.id, {
        peerId: peer.id,
        current: { fingerprint: await pinFingerprint(peer.keys), publicKey: peer.keys.b64, at },
        accepted: [{ fingerprint: await pinFingerprint(planted), publicKey: planted.b64, at, viaFirstContact: true }],
        verifiedAt: markedAfter === null ? null : at + markedAfter,
    });

    return { peer, planted };
}

const noSenderKey = (e) => e?.code === 'DM_V2_NO_SENDER_KEY';

test('old pin, really verified: a key the server listed at first contact opens nothing', async () => {
    const { peer, planted } = await peerWithOldPin(HOUR);

    const genuine = await open(await rowFrom(peer.id, peer.keys, 'real'), peer.id);
    assert.equal(genuine.plaintext, 'real', 'control: the real key still opens');

    await assert.rejects(async () => open(await rowFrom(peer.id, planted, 'forged'), peer.id), noSenderKey);
    await assert.rejects(async () => messageCrypto.decryptIncomingMessage(await v1RowFrom(peer.id, planted, 'forged'), peer.id));

    const retired = await trust.mayTryRetiredKey(peer.id, planted.b64, CTX);
    assert.equal(retired.allowed, false);
});

test('control for that: on a contact nobody verified, the same fixture really does open', async () => {
    const { peer, planted } = await peerWithOldPin(null);

    const forged = await open(await rowFrom(peer.id, planted, 'still allowed until verified'), peer.id);
    assert.equal(forged.plaintext, 'still allowed until verified');
    assert.equal((await trust.mayTryRetiredKey(peer.id, planted.b64, CTX)).allowed, true);
});

test('old pin, really verified: accepting a new key does not bring those keys back', async () => {
    const { peer, planted } = await peerWithOldPin(HOUR);
    const next = await person();

    const accepted = await trust.acceptPeerKey(peer.id, next.b64, CTX);
    assert.equal(accepted.verifiedAt, null, 'accepting is not verifying, so this contact is now unverified');

    await assert.rejects(async () => open(await rowFrom(peer.id, planted, 'forged'), peer.id), noSenderKey);
});

test('old pin: a mark stamped within a second of the key being pinned is not a verification', async () => {
    for (const [markedAfter, verified] of [[0, false], [1, false], [999, false], [1000, true], [HOUR, true]]) {
        const { peer, planted } = await peerWithOldPin(markedAfter);
        const pin = await trust.getPeerPin(peer.id, CTX);

        assert.equal(Boolean(pin.verifiedAt), verified, `${markedAfter}ms after the key was pinned`);
        assert.equal(
            trust.pinnedPeerKeys(pin).some((k) => k.publicKey === planted.b64),
            !verified,
            'an unverified contact keeps those keys for its history, a verified one does not'
        );
    }
});

test('old pin: a mark with no time to compare it against proves nothing', async () => {
    const peer = await meetPeer();

    await writeRawPin(peer.id, {
        peerId: peer.id,
        current: { fingerprint: await pinFingerprint(peer.keys), publicKey: peer.keys.b64 },
        accepted: [],
        verifiedAt: Date.now(),
    });

    assert.equal((await trust.getPeerPin(peer.id, CTX)).verifiedAt, null);
});

test('old pin: a key change on a contact the old button stamped is not called a verified key change', async () => {
    const { peer } = await peerWithOldPin(0);
    const evaluated = await trust.evaluatePeerKey(peer.id, mallory.b64, CTX);

    assert.equal(evaluated.state, 'changed');
    assert.equal(evaluated.pin.verifiedAt, null);
});

test('old pin: marking it now verifies it, and it stays verified', async () => {
    const { peer, planted } = await peerWithOldPin(0);
    const fingerprint = await pinFingerprint(peer.keys);

    const marked = await trust.markPeerVerified(peer.id, CTX, fingerprint);
    assert.ok(marked.verifiedAt);

    const pin = await trust.getPeerPin(peer.id, CTX);
    assert.ok(pin.verifiedAt, 'marking within a second of pinning is fine now the mark says who made it');
    assert.equal(trust.pinnedPeerKeys(pin).some((k) => k.publicKey === planted.b64), false);
});

test('a mark made today counts however soon it comes after the key was pinned', async () => {
    const peer = await pinnedPeer();
    await trust.markPeerVerified(peer.id, CTX);
    assert.ok((await trust.getPeerPin(peer.id, CTX)).verifiedAt, 'right after first contact');

    const next = await person();
    await trust.acceptPeerKey(peer.id, next.b64, CTX);
    assert.equal((await trust.getPeerPin(peer.id, CTX)).verifiedAt, null, 'accepting clears it');

    await trust.markPeerVerified(peer.id, CTX);
    assert.ok((await trust.getPeerPin(peer.id, CTX)).verifiedAt, 'right after accepting');
});

test('old pin: recording an opened row leaves the old fields alone and reads the same', async () => {
    const { peer, planted } = await peerWithOldPin(HOUR);

    await trust.noteEncryptedRow(peer.id, 500, CTX);

    const pin = await trust.getPeerPin(peer.id, CTX);
    assert.equal(pin.encryptedFloor, 500);
    assert.ok(pin.verifiedAt);
    assert.equal(trust.pinnedPeerKeys(pin).some((k) => k.publicKey === planted.b64), false);
});

/* ---------------------------------------------------------------- static guards */

test('no DM path can fetch a key and use it without going through the gate', () => {
    const read = (rel) => fs.readFileSync(new URL(`../public/js/${rel}`, import.meta.url), 'utf8');

    assert.doesNotMatch(read('crypto/keys/peer-keys.js'), /export async function getPeerPublicKey\b/,
        'a helper that fetches AND imports a peer key is how the check got bypassed');

    for (const rel of [
        'crypto/messages/dm-v2-wire.js',
        'crypto/keys/session.js',
        'chat/dm-key-trust.js',
    ]) {
        assert.doesNotMatch(read(rel), /\bgetPeerPublicKey\b/, `${rel} must not fetch a peer key to use`);
    }

    assert.doesNotMatch(read('crypto/messages/dm-v2-wire.js'), /\bgetPeerKeyCandidates\b/,
        'the DM v2 receive path must choose keys from the pin, not from the history endpoint');
});
