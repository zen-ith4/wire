// tests/groups/group-attachment-binding.test.mjs
//
// STEP 3B: group attachment binding - the file's iv, ciphertext hash and
// plaintext length are bound into the per-message ECDSA signature, and the
// receive side refuses a file whose bytes do not match what the sender signed.
//
// Real WebCrypto, real fake-indexeddb; only the pairwise-session provider is
// in-memory. No server, no browser - pure crypto layer.
//
// Attacks covered (see docs/GROUP_ATTACHMENTS_E2EE.md sections 3.2/3.6):
//   1 member forges file "from" another member
//   2 splice/swap: file A's bytes served under message B
//   4 server swaps stored file bytes
//   5 truncate/append ciphertext (single AES-GCM, groups don't stream)
//   6 nonce/counter reuse between message text and attachments
//   plus all-or-none fields, legacy keys, cross-group replay, same-group replay,
//   bit flip, per-row isolation and text-only byte stability.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './_env.mjs';

import {
    installWebLocksPolyfill,
    newDeviceStorage,
    useDeviceStorage,
    makeTestIdentity,
    makeSessionKeyProvider,
} from './helpers.mjs';
import { createScenario } from './_scenario.mjs';

installWebLocksPolyfill();

const js = (rel) =>
    pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', rel)).href;

const identities = new Map();
let currentActorId = null;

mock.module(js('crypto/identity-service.js'), {
    namedExports: {
        getCurrentIdentity: () => {
            const id = identities.get(currentActorId);
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

const GROUP = 41;
const sessionProvider = makeSessionKeyProvider(identities);

mock.module('../../public/js/crypto/keys/session.js', {
    namedExports: {
        getOrCreateSessionKey: (id) => sessionProvider.getOrCreateSessionKey(id),
        getOrCreateGroupKdmKey: (id) => sessionProvider.getOrCreateGroupKdmKey(id),
    },
});

const sk = await import('../../public/js/crypto/groups/sender-key.js');
const mc = await import('../../public/js/crypto/groups/message-crypto.js');
const ac = await import('../../public/js/crypto/messages/attachment-crypto.js');
const signing = await import('../../public/js/crypto/groups/signing.js');
const kdm = await import('../../public/js/crypto/groups/kdm.js');
const codec = await import('../../public/js/crypto/groups/codec.js');
const store = await import('../../public/js/crypto/groups/sender-key-store.js');
const { rotateSenderKey } = await import('../../public/js/crypto/groups/rotation.js');

async function ensureUsers(...ids) {
    for (const id of ids) {
        if (!identities.has(id)) {
            identities.set(id, await makeTestIdentity(id));
        }
    }
}

async function user(id) {
    await ensureUsers(id);
    return identities.get(id);
}

async function makeDevice(identity) {
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

function kdmRow(from, to, epoch, wrapped, group = GROUP) {
    return { id: 1, group_id: group, from_user_id: from, to_user_id: to, epoch, wrapped_key: wrapped };
}

async function rotateAndDeliver(owner, epoch, recipients, group = GROUP) {
    const pending = await owner.run(() =>
        rotateSenderKey(owner.identity, group, epoch, recipients.map((d) => d.identity.userId), { deferPersist: true })
    );
    await owner.run(() => pending.commit());
    for (const d of recipients) {
        const row = pending.recipients.find((r) => r.user_id === d.identity.userId);
        await d.run(() => kdm.receiveKdm(d.identity, kdmRow(owner.identity.userId, d.identity.userId, epoch, row.wrapped_key, group)));
    }
    return pending;
}

/** alice (1), bob (2), mallory (3). After opt-in, all hold Alice's Sender Key. */
async function world() {
    const [alice, bob, mallory] = await Promise.all([user(1), user(2), user(3)]);
    const A = await makeDevice(alice);
    const B = await makeDevice(bob);
    const M = await makeDevice(mallory);
    const key = await rotateAndDeliver(A, 0, [A, B, M]);
    // Mallory also owns a sending key (distributed to everybody), so she can
    // sign - with her OWN key - and therefore attempt a forgery.
    const mKey = await rotateAndDeliver(M, 0, [A, B, M]);
    return { alice, bob, mallory, A, B, M, aliceKeyId: key.senderKeyId, malloryKeyId: mKey.senderKeyId };
}

const send = (dev, text, opts) => dev.run(() => mc.encryptGroupMessage(dev.identity, GROUP, text, opts));
const open = (dev, env, id, expect = {}, group = GROUP) => dev.run(() => mc.decryptGroupMessageDetailed(dev.identity, group, typeof env === 'string' ? env : JSON.stringify(env), id, expect));

function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
}

function b64(u8) {
    return codec.bytesToBase64(u8);
}

/** Flips the first byte of a base64 string and re-encodes it. */
function flipB64(s) {
    const bytes = new Uint8Array(codec.base64ToBytes(s));
    bytes[0] ^= 0x01;
    return b64(bytes);
}

async function sendAttachment(dev, fileBytes, opts = {}) {
    return dev.run(async () => {
        const { ivBase64, ciphertext } = await ac.encryptAttachmentForGroup(GROUP, fileBytes);
        const envelope = await mc.encryptGroupMessage(dev.identity, GROUP, 'attachment message', {
            replyToId: null,
            attachment: { ivBase64, ciphertext, plaintextLength: fileBytes.byteLength },
            ...opts,
        });
        return { envelope, ivBase64, ciphertext, fileBytes };
    });
}

async function decrypt(dev, ciphertext, rowIvBase64, binding, senderKeyId, ref) {
    return dev.run(() => ac.decryptAttachmentForGroup(GROUP, ciphertext, rowIvBase64, binding, senderKeyId, ref));
}

/** How many nonces this device has claimed for a Sender Key. */
async function seen(dev, senderKeyId) {
    return dev.run(() => store.countSeen(senderKeyId));
}

/* ---------------------------------------------------------------- 1. valid file accepted */

test('1 valid file accepted: honest send + receive recovers plaintext, nonce claimed once', async () => {
    const w = await world();
    const fileBytes = randomBytes(1000);
    const sent = await sendAttachment(w.A, fileBytes);
    const env = JSON.parse(sent.envelope);
    assert.equal(env.v, 2);
    assert.equal(env.att_iv, sent.ivBase64);
    const r = await open(w.B, sent.envelope, 1);
    assert.equal(r.plaintext, 'attachment message');
    assert.equal(r.ownerUserId, 1);
    assert.ok(r.attachmentBinding, 'attachment binding must be present');
    assert.equal(r.attachmentBinding.iv, sent.ivBase64);
    assert.equal(r.attachmentBinding.len, fileBytes.byteLength);
    assert.equal(r.attachmentBinding.ctHash, env.att_ct_hash);

    const decrypted = await decrypt(w.B, sent.ciphertext, sent.ivBase64, r.attachmentBinding, w.aliceKeyId, 'a1');
    assert.deepEqual(new Uint8Array(decrypted), new Uint8Array(fileBytes));
    // Two nonces for this Sender Key on this device: the MESSAGE nonce (claimed
    // by the message open) and the FILE nonce (claimed by the file decrypt).
    // Attachments and messages share one counter/nonce space per key.
    assert.equal(await seen(w.B, w.aliceKeyId), 2, 'message nonce + file nonce claimed once each');
    // Accepting the same file under the same ref again must not claim more.
    await decrypt(w.B, sent.ciphertext, sent.ivBase64, r.attachmentBinding, w.aliceKeyId, 'a1');
    assert.equal(await seen(w.B, w.aliceKeyId), 2, 'a repeated accept under the same ref claims nothing new');
});

/* ---------------------------------------------------------------- 2. forgery rejected */

test('2 forgery rejected: Mallory signs Alice\'s message with Mallory\'s key', async () => {
    const w = await world();
    const fileBytes = randomBytes(500);
    const sent = await sendAttachment(w.A, fileBytes);
    const env = JSON.parse(sent.envelope);

    // Mallory re-signs Alice's OWN envelope fields (same group, key id,
    // counter, iv, ciphertext and attachment slot) with HER signing key.
    const slot = new Uint8Array(40);
    slot.set(codec.base64ToBytes(env.att_ct_hash));
    new DataView(slot.buffer).setBigUint64(32, BigInt(env.att_len), false);
    const sig = await w.M.run(async () => {
        const mine = await sk.getMySenderKey(w.mallory, GROUP);
        assert.ok(mine?.signKey, 'Mallory must own a signing key');
        return signing.signMessage(mine.signKey, {
            groupId: GROUP, senderKeyId: w.aliceKeyId, counter: env.counter,
            iv: codec.base64ToBytes(env.iv), ciphertext: codec.base64ToBytes(env.ciphertext),
            replyToId: env.reply_to_id, attachment: slot,
        });
    });
    const forged = { ...env, sig: b64(sig) };

    await assert.rejects(
        () => open(w.B, forged, 2),
        (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'bad-signature',
        'forged signature must be rejected before decrypt'
    );
    assert.equal(await seen(w.B, w.aliceKeyId), 0, 'forgery must not claim a nonce');
});

/* ---------------------------------------------------------------- 3. splice/swap rejected */

test('3 splice/swap rejected: file A\'s bytes served under message B', async () => {
    const w = await world();
    const fileA = randomBytes(400);
    const fileB = randomBytes(400);
    const sentA = await sendAttachment(w.A, fileA);
    const sentB = await sendAttachment(w.A, fileB);
    const bindingB = (await open(w.B, sentB.envelope, 3)).attachmentBinding;
    assert.ok(bindingB, 'message B must produce a binding');
    // The message open already claimed the MESSAGE nonce; the splice attempt
    // must not claim anything (neither the message nor the file nonce).
    const noncesBefore = await seen(w.B, w.aliceKeyId);

    // Serve file A's bytes under message B's binding -> must fail.
    await assert.rejects(
        () => decrypt(w.B, sentA.ciphertext, sentA.ivBase64, bindingB, w.aliceKeyId, 'b1'),
        (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'attachment-mismatch',
        'spliced file must fail attachment-mismatch before decrypt'
    );
    assert.equal(await seen(w.B, w.aliceKeyId), noncesBefore, 'splice attempt must not claim a nonce');
});

/* ---------------------------------------------------------------- 4. attachment_iv column mismatch rejected */

test('4 attachment_iv column mismatch rejected', async () => {
    const w = await world();
    const sent = await sendAttachment(w.A, randomBytes(300));
    const binding = (await open(w.B, sent.envelope, 4)).attachmentBinding;
    assert.ok(binding);

    await assert.rejects(
        () => decrypt(w.B, sent.ciphertext, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', binding, w.aliceKeyId, 'b2'),
        (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'attachment-mismatch',
        'row attachment_iv != signed iv must fail'
    );
});

/* ---------------------------------------------------------------- 5. length mismatch rejected */

test('5 length mismatch rejected: truncated ciphertext fails before hashing', async () => {
    const w = await world();
    const fileBytes = randomBytes(200);
    const sent = await sendAttachment(w.A, fileBytes);
    const binding = (await open(w.B, sent.envelope, 5)).attachmentBinding;
    assert.ok(binding);

    const truncated = new Uint8Array(sent.ciphertext).slice(0, sent.ciphertext.byteLength - 20);
    await assert.rejects(
        () => decrypt(w.B, truncated, sent.ivBase64, binding, w.aliceKeyId, 'b3'),
        (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'attachment-mismatch',
        'truncated ciphertext must fail at length check'
    );
});

/* ---------------------------------------------------------------- 6. signed field tamper rejected */

test('6 signed field tamper rejected: tamper att_ct_hash / att_iv / att_len in the envelope', async () => {
    const w = await world();
    const sent = await sendAttachment(w.A, randomBytes(300));
    const env = JSON.parse(sent.envelope);
    const binding = (await open(w.B, sent.envelope, 6)).attachmentBinding;
    assert.ok(binding);

    // att_ct_hash and att_len are IN the signed slot (SHA-256(iv||ciphertext) ||
    // length), so changing either breaks the signature.
    const slotCases = {
        'att_ct_hash flipped': { ...env, att_ct_hash: flipB64(env.att_ct_hash) },
        'att_len wrong': { ...env, att_len: String(binding.len + 100) },
    };
    for (const [name, tampered] of Object.entries(slotCases)) {
        await assert.rejects(
            () => open(w.B, tampered, 7),
            (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'bad-signature',
            `${name} must fail signature verification`
        );
    }

    // att_iv is NOT in the slot directly - it is committed THROUGH the digest
    // (the slot is SHA-256(iv || ciphertext)). So flipping it leaves the
    // signature valid, and it is the FILE check that catches it: the receiver
    // recomputes SHA-256(tampered iv || ciphertext), which no longer matches
    // the signed att_ct_hash -> attachment-mismatch, before any decryption.
    // The SAME message id is used, so the message nonce is not re-claimed
    // (a different id for the same nonce would be a replay, not this test).
    const ivTampered = { ...env, att_iv: flipB64(env.att_iv) };
    const r = await open(w.B, ivTampered, 6);
    assert.ok(r.attachmentBinding, 'the tampered-iv message still verifies (slot unchanged)');
    await assert.rejects(
        () => decrypt(w.B, sent.ciphertext, r.attachmentBinding.iv, r.attachmentBinding, w.aliceKeyId, 'b6'),
        (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'attachment-mismatch',
        'a tampered att_iv must fail the file check'
    );
});

/* ---------------------------------------------------------------- 7. att fields stripped/added rejected */

test('7 att fields stripped/added rejected', async () => {
    const w = await world();
    const sent = await sendAttachment(w.A, randomBytes(300));
    const env = JSON.parse(sent.envelope);
    await open(w.B, sent.envelope, 8); // prime

    // Strip att_* from a signed attachment message -> signature was over non-empty slot.
    const stripped = { ...env };
    delete stripped.att_iv;
    delete stripped.att_ct_hash;
    delete stripped.att_len;
    await assert.rejects(
        () => open(w.B, stripped, 9),
        (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'bad-signature',
        'stripped att fields must fail signature verification'
    );

    // Add att_* to a text-only message (signed over empty slot) -> slot mismatch.
    const textEnv = JSON.parse(await send(w.A, 'plain text'));
    const textWithAtt = { ...textEnv, att_iv: sent.ivBase64, att_ct_hash: JSON.parse(sent.envelope).att_ct_hash, att_len: '5' };
    await assert.rejects(
        () => open(w.B, textWithAtt, 10),
        (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'bad-signature',
        'text-only msg with added att fields must fail signature verification'
    );
});

/* ---------------------------------------------------------------- 8. all-or-none rejected */

test('8 all-or-none: partial att fields, bad base64, wrong lengths, non-canonical att_len -> dropped as malformed', async () => {
    const w = await world();
    const sent = await sendAttachment(w.A, randomBytes(100));
    const env = JSON.parse(sent.envelope);

    const cases = {
        'only att_iv': { ...env, att_ct_hash: undefined, att_len: undefined },
        'only att_ct_hash': { ...env, att_iv: undefined, att_len: undefined },
        'att_iv + att_len, no hash': { ...env, att_ct_hash: undefined },
        'att_iv bad base64': { ...env, att_iv: '!!!not base64!!!' },
        'att_iv wrong length': { ...env, att_iv: 'AAAA' },
        'att_ct_hash wrong length': { ...env, att_ct_hash: 'AAAA' },
        'att_len non-canonical': { ...env, att_len: '-5' },
        'att_len non-numeric': { ...env, att_len: 'abc' },
    };
    for (const [name, tampered] of Object.entries(cases)) {
        await assert.rejects(
            () => open(w.B, tampered, 11),
            (e) => !(e instanceof mc.UnverifiedMessageError),
            `${name} must be a plain (structural) error, not unverified`
        );
    }
});

/* ---------------------------------------------------------------- 9. legacy keys still refused */

test('9 legacy keys refused: att/attachment/attachments -> attachment-not-bound', async () => {
    const w = await world();
    const sent = await sendAttachment(w.A, randomBytes(100));
    const env = JSON.parse(sent.envelope);
    await open(w.B, sent.envelope, 12); // prime

    for (const key of ['att', 'attachment', 'attachments']) {
        const tampered = { ...env, [key]: 'x' };
        await assert.rejects(
            () => open(w.B, tampered, 13),
            (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'attachment-not-bound',
            `${key} must be refused with attachment-not-bound`
        );
    }
});

/* ---------------------------------------------------------------- 10. cross-group replay rejected */

test('10 cross-group replay rejected: same envelope in another group', async () => {
    const w = await world();
    const sent = await sendAttachment(w.A, randomBytes(200));
    await open(w.B, sent.envelope, 14);
    await assert.rejects(
        () => open(w.B, sent.envelope, 15, {}, GROUP + 1),
        (e) => e instanceof mc.UnverifiedMessageError,
        'cross-group replay must fail signature verification'
    );
});

/* ---------------------------------------------------------------- 11. same-group file replay rejected */

test('11 same-group file replay rejected: same file bytes accepted again under a DIFFERENT ref', async () => {
    const w = await world();
    const sent = await sendAttachment(w.A, randomBytes(300));
    const binding = (await open(w.B, sent.envelope, 16)).attachmentBinding;
    assert.ok(binding);

    // First accept succeeds.
    await decrypt(w.B, sent.ciphertext, sent.ivBase64, binding, w.aliceKeyId, 'ref-1');
    // The SAME ref again is idempotent (the same message id arriving twice is
    // not a replay - the same contract as C3-6 for message text).
    await decrypt(w.B, sent.ciphertext, sent.ivBase64, binding, w.aliceKeyId, 'ref-1');
    // The same file bytes under a DIFFERENT ref -> replay.
    await assert.rejects(
        () => decrypt(w.B, sent.ciphertext, sent.ivBase64, binding, w.aliceKeyId, 'ref-2'),
        (e) => e.name === 'ReplayedMessageError',
        'same file under a different ref must be rejected as a replay'
    );
});

/* ---------------------------------------------------------------- 12. bit flip rejected */

test('12 bit flip rejected: flipped ciphertext bit with old hash -> attachment-mismatch', async () => {
    const w = await world();
    const fileBytes = randomBytes(256);
    const sent = await sendAttachment(w.A, fileBytes);
    const binding = (await open(w.B, sent.envelope, 17)).attachmentBinding;
    assert.ok(binding);

    const flipped = new Uint8Array(sent.ciphertext);
    flipped[10] ^= 0x01;
    await assert.rejects(
        () => decrypt(w.B, flipped, sent.ivBase64, binding, w.aliceKeyId, 'b4'),
        (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'attachment-mismatch',
        'flipped ciphertext with old hash must fail attachment-mismatch'
    );
});

/* ---------------------------------------------------------------- 13. nonce: no reuse */

test('13 nonce: no reuse - two files + one text under one Sender Key -> three distinct counters', async () => {
    const w = await world();
    const fileA = randomBytes(100);
    const fileB = randomBytes(100);
    const sentA = await sendAttachment(w.A, fileA);
    const sentB = await sendAttachment(w.A, fileB);
    const envA = JSON.parse(sentA.envelope);
    const envB = JSON.parse(sentB.envelope);
    assert.notEqual(envA.counter, envB.counter, 'two files must use distinct counters');
    const textEnv = JSON.parse(await send(w.A, 'plain text message'));
    assert.notEqual(textEnv.counter, envA.counter, 'text message counter must differ from attachment counter');
    assert.notEqual(textEnv.counter, envB.counter, 'text message counter must differ from second attachment counter');
});

/* ---------------------------------------------------------------- 15. per-row isolation */

test('15 per-row isolation: one bad-attachment row does not break good rows', async () => {
    const w = await world();
    const sentGood = await sendAttachment(w.A, randomBytes(200));
    const sentBad = await sendAttachment(w.A, randomBytes(200));
    const bindingGood = (await open(w.B, sentGood.envelope, 18)).attachmentBinding;
    assert.ok(bindingGood);

    // Good row decrypts fine.
    const good = await decrypt(w.B, sentGood.ciphertext, sentGood.ivBase64, bindingGood, w.aliceKeyId, 'good-1');
    assert.ok(good, 'good row must decrypt');

    // Tampered row fails.
    const flipped = new Uint8Array(sentBad.ciphertext);
    flipped[5] ^= 0xFF;
    const bindingBad = (await open(w.B, sentBad.envelope, 19)).attachmentBinding;
    await assert.rejects(
        () => decrypt(w.B, flipped, sentBad.ivBase64, bindingBad, w.aliceKeyId, 'bad-1'),
        (e) => e instanceof mc.UnverifiedMessageError && e.reason === 'attachment-mismatch',
        'tampered row must fail'
    );
});

/* ---------------------------------------------------------------- 14. text-only bytes unchanged */

test('14 text-only bytes unchanged: a text-only message keeps byte-identical signed bytes (known-answer vector)', async () => {
    const w = await world();
    const bytes = signing.encodeSignedBytes({
        groupId: 1,
        senderKeyId: 'ab'.repeat(32),
        counter: 5,
        iv: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
        ciphertext: Uint8Array.from([200, 201, 202, 203]),
        replyToId: null,
        attachment: new Uint8Array(0),
    });
    assert.equal(bytes.length, 143);
    assert.equal(
        Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(''),
        '0000000015776972652d67726f75702d6d73672d7369672f7631000000000131000000004061626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162000000000135010000000c0102030405060708090a0b0c0100000004c8c9cacb01000000000100000000',
        'text-only signed bytes must stay byte-identical'
    );

    // And a text-only ENVELOPE carries no att_* keys at all.
    const env = JSON.parse(await send(w.A, 'just text'));
    assert.equal(env.att_iv, undefined);
    assert.equal(env.att_ct_hash, undefined);
    assert.equal(env.att_len, undefined);
    const r = await open(w.B, env, 20);
    assert.equal(r.plaintext, 'just text');
    assert.equal(r.attachmentBinding, null, 'a text-only message has no binding');
});

/* ------------------------------------------- 15. real server: no plaintext on disk */

test('15 real server: a group file produced by the real encrypt path leaves only ciphertext on disk', async (t) => {
    const s = await createScenario(['alice', 'bob']);
    t.after(() => s.stop());

    const alice = s.users.alice;
    const bob = s.users.bob;
    const group = await s.createGroup(alice, 'attach');
    await s.addMember(alice, group.id, bob);
    await s.mount(alice);
    await s.open(alice, group.id);
    await s.mount(bob);
    await s.open(bob, group.id);

    // The REAL encrypt path, with Alice's REAL Sender Key.
    alice.actor.use();
    const groupCrypto = await alice.actor.importModule('crypto/messages/group-message-crypto.js');
    const senderKey = await alice.actor.importModule('crypto/groups/sender-key.js');
    const mine = await senderKey.getMySenderKey(groupCrypto.getGroupIdentity(), group.id);
    assert.ok(mine?.senderKeyId, 'Alice must have a Sender Key for the group');

    const attach = await alice.actor.importModule('crypto/messages/attachment-crypto.js');
    const marker = 'ZXQ-GRP-ATTACH-MARKER-1234';
    // A Uint8Array (not a Buffer): Buffer.buffer is the whole 8 KB pool, not
    // the view, and the file bytes must be exactly the marker's length.
    const plaintext = new Uint8Array(Buffer.from(marker.repeat(20), 'utf8'));
    const { ivBase64, ciphertext } = await attach.encryptAttachmentForGroup(group.id, plaintext.buffer);

    // Upload through the REAL route (multipart), exactly as the composer would.
    // NOTE: config/multer.js's mkdir list does NOT include GROUP_UPLOAD_DIR, so a
    // first-ever group upload into a fresh tree 500s (a pre-existing server gap;
    // config/ is not in this step's allowed paths). The test owns its temp dirs,
    // so it creates the directory itself.
    fs.mkdirSync(process.env.GROUP_UPLOAD_DIR, { recursive: true });
    const fd = new FormData();
    fd.append('file', new Blob([ciphertext], { type: 'application/octet-stream' }), 'attachment.bin');
    fd.append('attachment_iv', ivBase64);
    fd.append('content', 'a caption');
    const res = await globalThis.__nodeFetch(`${s.server.origin}/api/groups/${group.id}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.ident.token}`, 'X-Wire-Group-Proto': '2' },
        body: fd,
    });
    assert.equal(res.status, 200, `upload failed: ${res.status} ${await res.text()}`);

    // What the server actually stored.
    const row = s.server.db
        .prepare('SELECT attachment_path, attachment_size, attachment_name FROM group_messages WHERE group_id = ? ORDER BY id DESC LIMIT 1')
        .get(group.id);
    assert.ok(row?.attachment_path, 'the upload must have produced a row');
    const stored = fs.readFileSync(path.join(process.env.GROUP_UPLOAD_DIR, row.attachment_path));

    assert.equal(stored.length, plaintext.length + 16, 'ciphertext is the plaintext plus the GCM tag');
    assert.ok(!stored.includes(Buffer.from(marker, 'utf8')), 'no plaintext substring on disk');
    // The BYTES are opaque, but (unlike the DM path) the group server still
    // stores the client-supplied file NAME in the clear - pre-existing server
    // behaviour, unchanged here.
    assert.equal(row.attachment_name, 'attachment.bin');
});

