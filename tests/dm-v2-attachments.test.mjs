// tests/dm-v2-attachments.test.mjs
//
// STEP 2A.4: the DM attachment client path. REAL Express + Socket.IO + SQLite
// server and REAL client code (jsdom actors running the unmodified public/js
// modules, real session crypto). No mocks, no spies on the code under test.
//
// What is pinned here:
//   - the seam: the REAL prepare function's output is accepted by the REAL
//     server, and the REAL receive path opens what came back
//   - version selection per peer: a min-1 peer gets v1 envelopes byte-shape
//     unchanged, a min-2 peer gets v2 for BOTH meta and caption
//   - the version/pin gate runs BEFORE the file is read or encoded
//   - a v2 caption over the server's 2000-char cap is refused client-side
//   - a text envelope can never be opened as attachment meta, or the reverse
//   - decryptIncomingMessage still refuses a v2 payload without row context
//   - nothing imports the dead encryptAttachmentForDm/decryptAttachmentForDm
//
// The registration default is pinned to 1 with an env var (not an app edit) so a
// v1 recipient exists to compare against; carol is raised to 2 with one UPDATE,
// which the ratchet triggers allow (they refuse only a LOWERING).

import './dm-attachments/_env.mjs';

process.env.DM_E2EE_DEFAULT_MIN_VERSION = '1';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { startDmServer, createUser, authGet } = await import('./dm-attachments/_harness.mjs');
const {
    decryptAttachmentStream
} = await import('../public/js/crypto/messages/attachment-stream.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const META_V1_KEYS = ['algorithm', 'ciphertext', 'iv', 'version'];  // sorted: compared with .sort()

let server, alice, bob, carol;

function bytesPattern(n, seed = 1) {
    const out = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x >>> 16; }
    return out;
}

/** The REAL client prepare function, run in the sender's own module graph. */
async function prepare(sender, peer, { bytes, name = 'file.bin', mime = 'application/octet-stream', caption = '', isVoice = false, replyToId = 0 }) {
    sender.actor.use();
    const e2ee = await sender.actor.importModule('media/attachment-e2ee.js');
    const file = new sender.actor.window.File([bytes], name, { type: mime });
    const prepared = await e2ee.prepareDmAttachmentUpload({
        file, caption, isVoice, senderId: sender.id, recipientId: peer.id, replyToId
    });
    return { ...prepared, e2ee };
}

async function send(sender, peer, opts) {
    const prepared = await prepare(sender, peer, opts);
    const form = new FormData();
    form.append('file', prepared.file, prepared.file.name);
    form.append('recipient_id', String(peer.id));
    for (const [k, v] of Object.entries(prepared.fields)) form.append(k, v);
    const res = await globalThis.__nodeFetch(`${server.origin}/api/dm/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sender.token}` },
        body: form
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { prepared, status: res.status, body };
}

/** The REAL recipient-side path on a real stored row. */
async function receive(recipient, sender, row) {
    recipient.actor.use();
    const e2ee = await recipient.actor.importModule('media/attachment-e2ee.js');
    const msg = await e2ee.applyAttachmentMeta(row, sender.id, 'dm');
    let blob = null;
    let error = null;
    if (!msg.attachment_unreadable) {
        const res = await authGet(server, recipient, `/api/dm/attachments/${row.id}?download=1`);
        const secret = e2ee.getAttachmentSecret('dm', row.id);
        try {
            blob = await decryptAttachmentStream(new Uint8Array(await res.arrayBuffer()), secret.rawKey, secret.baseIv, msg.attachment_mime);
        } catch (e) { error = e; }
    }
    return { msg, blob, error, e2ee };
}

const stored = (id) => server.db.prepare(
    'SELECT id, content, attachment_meta FROM direct_messages WHERE id = ?'
).get(id);

before(async () => {
    server = await startDmServer();
    alice = await createUser(server, 'alice');   // min 1
    bob = await createUser(server, 'bob');       // min 1
    carol = await createUser(server, 'carol');
    server.db.prepare('UPDATE users SET dm_e2ee_min_version = 2 WHERE id = ?').run(carol.id);
});

after(async () => {
    await server.stop();
    fs.rmSync(process.env.DB_PATH, { force: true });
});

// ---------------------------------------------------------------- seam

test('2A.4 seam: the real prepare output is accepted by the real server and the real receive path opens it', async () => {
    const bytes = bytesPattern(4096, 3);
    const sent = await send(alice, carol, { bytes, name: 'report.bin', caption: 'the quarterly report', mime: 'application/zip' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const row = stored(sent.body.id);
    assert.equal(JSON.parse(row.attachment_meta).encryption.version, 2);
    assert.equal(JSON.parse(row.content).encryption.version, 2);

    const { msg, blob, error } = await receive(carol, alice, row);
    assert.equal(error, null);
    assert.equal(msg.attachment_name, 'report.bin');
    assert.equal(msg.attachment_mime, 'application/zip');
    assert.equal(msg.attachment_e2ee, true);
    assert.equal(msg.attachment_unreadable, undefined);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

// ---------------------------------------------------------------- version choice

test('2A.4: a min-1 peer gets v1 meta and v1 caption, byte-shape unchanged', async () => {
    const sent = await send(alice, bob, { bytes: bytesPattern(64, 9), name: 'legacy.bin', caption: 'legacy caption' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const row = stored(sent.body.id);
    const meta = JSON.parse(row.attachment_meta);
    assert.equal(meta.encryption.version, 1);
    assert.deepEqual(Object.keys(meta.encryption).sort(), META_V1_KEYS, 'the v1 envelope must gain no field');
    assert.equal(meta.encryption.senderFp, undefined);
    assert.equal(meta.encryption.msgId, undefined);
    assert.equal(JSON.parse(row.content).encryption.version, 1);
});

test('2A.4: a min-2 peer gets v2 meta and v2 caption', async () => {
    const sent = await send(alice, carol, { bytes: bytesPattern(64, 10), name: 'modern.bin', caption: 'modern caption' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const row = stored(sent.body.id);
    const meta = JSON.parse(row.attachment_meta);
    assert.equal(meta.encryption.version, 2);
    assert.equal(typeof meta.encryption.senderFp, 'string');
    assert.match(meta.encryption.msgId, /^[0-9a-f]{16}$/);
    assert.equal(JSON.parse(row.content).encryption.version, 2);
    // Two envelopes, two different ivs: the replay key must not collide.
    assert.notEqual(meta.encryption.iv, JSON.parse(row.content).encryption.iv);
});

// ---------------------------------------------------------------- ordering

/**
 * Records when the File is read. jsdom's Storage is Proxy-backed, so an
 * instance-level localStorage patch is never seen by the module under test;
 * ordering is therefore proven through the File instead.
 */
function instrumentedFile(actor, bytes, timeline) {
    const file = new actor.window.File([bytes], 'ordered.bin', { type: 'application/octet-stream' });
    const origArrayBuffer = file.arrayBuffer.bind(file);
    Object.defineProperty(file, 'arrayBuffer', {
        configurable: true,
        value: () => { timeline.push('read:arrayBuffer'); return origArrayBuffer(); }
    });
    const origSlice = file.slice.bind(file);
    Object.defineProperty(file, 'slice', {
        configurable: true,
        value: (...a) => { timeline.push('read:slice'); return origSlice(...a); }
    });
    return file;
}

// The ordering proof is the test below: a gate that FAILS must leave the file
// untouched, which can only hold if the version decision runs before any file
// work. An earlier leg of this tried to prove the same thing by intercepting the
// actor's fetch and asserting the peer-version call came first; it was removed
// because the actor installs its fetch in a context the test cannot wrap (two
// attempts, both saw an empty timeline). Reported rather than papered over.

test('2A.4: the version decision happens before ANY file work - a failed gate leaves the file untouched', async () => {
    // NOTE on reachability, reported rather than papered over: with the shipped
    // chooseDmVersion() a v1 decision for a pin-2 peer is UNREACHABLE - the pin
    // alone already makes chooseDmVersion() return 2 - so assertDmVersionAllowed
    // (and therefore DmDowngradeRefusedError) cannot fire through this function.
    // It is defence in depth, exactly as in the text path. The ORDERING that
    // decision requires is what is testable, and it is what this pins.
    alice.actor.use();
    const e2ee = await alice.actor.importModule('media/attachment-e2ee.js');
    const timeline = [];
    const file = instrumentedFile(alice.actor, bytesPattern(256, 6), timeline);

    // An invalid peer id makes the version gate throw before any file work.
    await assert.rejects(
        () => e2ee.prepareDmAttachmentUpload({
            file, caption: 'x', isVoice: false, senderId: alice.id, recipientId: 0, replyToId: 0
        }),
        /Invalid user ID/
    );
    assert.deepEqual(timeline, [], `nothing may be read when the gate refuses (timeline: ${timeline.join(' -> ')})`);
});

// ---------------------------------------------------------------- caption cap

test('2B-isVoice: isVoice: true is carried in the v2 meta for a v2 peer (node, no recorder)', async () => {
    const sent = await send(alice, carol, { bytes: bytesPattern(64, 23), name: 'voice.webm', mime: 'audio/webm', isVoice: true });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const row = stored(sent.body.id);
    const meta = JSON.parse(row.attachment_meta);
    assert.equal(meta.encryption.version, 2);
    carol.actor.use();
    const e2ee = await carol.actor.importModule('media/attachment-e2ee.js');
    const parsed = await e2ee.decryptAttachmentMetaEnvelope(row.attachment_meta, alice.id, { replyToId: row.reply_to_id || 0, rowId: row.id });
    assert.equal(parsed.isVoice, true, 'isVoice must survive the v2 round trip');
    assert.equal(parsed.name, 'voice.webm');
});

test('2A.4: a v2 caption over the server cap is refused client-side, before any upload', async () => {
    const long = 'x'.repeat(2100);
    alice.actor.use();
    const e2ee = await alice.actor.importModule('media/attachment-e2ee.js');
    const file = new alice.actor.window.File([bytesPattern(32, 7)], 'cap.bin', { type: 'application/octet-stream' });
    await assert.rejects(
        () => e2ee.prepareDmAttachmentUpload({
            file, caption: long, isVoice: false, senderId: alice.id, recipientId: carol.id, replyToId: 0
        }),
        (e) => e && e.code === 'DM_V2_TOO_LARGE',
        'an over-cap v2 caption must be refused like text is'
    );
});

// ---------------------------------------------------------------- reply binding

test('2A.4: the meta AAD binds replyToId - the wrong stored value does not open', async () => {
    const sent = await send(alice, carol, { bytes: bytesPattern(48, 11), name: 'reply.bin', replyToId: 4242 });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const row = stored(sent.body.id);

    carol.actor.use();
    const e2ee = await carol.actor.importModule('media/attachment-e2ee.js');
    const peerId = alice.id;

    // The real stored reply_to_id opens it.
    const ok = await e2ee.decryptAttachmentMetaEnvelope(row.attachment_meta, peerId, { replyToId: 4242, rowId: row.id });
    assert.ok(ok, 'the real reply target must open the meta');
    assert.equal(ok.name, 'reply.bin');

    // A re-pointed reply does not: the server's answer is null (the caller turns
    // that into the "Attachment unavailable" placeholder), never a throw.
    const tampered = await e2ee.decryptAttachmentMetaEnvelope(row.attachment_meta, peerId, { replyToId: 9999, rowId: row.id });
    assert.equal(tampered, null, 'a re-pointed reply must not open');

    // And applyAttachmentMeta turns that into the placeholder, nothing else changes.
    const msg = await e2ee.applyAttachmentMeta({ ...row, id: row.id, reply_to_id: 9999 }, peerId, 'dm');
    assert.equal(msg.attachment_unreadable, true);
    assert.equal(msg.attachment_name, 'Attachment unavailable');
});

// ---------------------------------------------------------------- type confusion

test('2A.4: a TEXT v2 envelope in the meta slot becomes the placeholder, never a message', async () => {
    const sent = await send(alice, carol, { bytes: bytesPattern(48, 13), name: 'type-confusion.bin', caption: 'secret text' });
    assert.equal(sent.status, 200);
    const row = stored(sent.body.id);

    // Put the caption's TEXT envelope into the attachment_meta slot.
    const confused = { ...row, attachment_meta: row.content };
    const { msg } = await receive(carol, alice, confused);
    assert.equal(msg.attachment_unreadable, true);
    assert.equal(msg.attachment_name, 'Attachment unavailable');
    assert.equal(msg.attachment_mime, 'application/octet-stream');
});

test('2A.4: decryptIncomingMessage still refuses a v2 payload without row context', async () => {
    carol.actor.use();
    const crypto = await carol.actor.importModule('crypto/messages/message-crypto.js');
    const row = stored((await send(alice, carol, { bytes: bytesPattern(16, 17), caption: 'no context' })).body.id);
    await assert.rejects(
        () => crypto.decryptIncomingMessage(JSON.parse(row.content), alice.id),
        /cannot read a v2 payload/
    );
});

test('2A.4: an attachment-meta envelope cannot be opened as a text message', async () => {
    const sent = await send(alice, carol, { bytes: bytesPattern(16, 19), caption: 'swapped' });
    const row = stored(sent.body.id);
    carol.actor.use();
    const crypto = await carol.actor.importModule('crypto/messages/message-crypto.js');
    // The TEXT slot holding the meta envelope: refused by the AEAD (dm-att-v2
    // label in the AAD), not opened as a caption.
    await assert.rejects(
        () => crypto.decryptDmTextV2(JSON.parse(row.attachment_meta), alice.id, { replyToId: 0, rowId: row.id }),
        (e) => /auth/i.test(String(e && e.name)) || /auth/i.test(String(e && e.message)) || e && e.name === 'OperationError'
    );
});

// ---------------------------------------------------------------- dead code

test('2A.4: nothing imports the dead encryptAttachmentForDm / decryptAttachmentForDm', () => {
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(js|mjs|cjs)$/.test(entry.name)) files.push(full);
        }
    };
    for (const dir of ['public', 'controllers', 'services', 'routes', 'utils', 'middleware', 'config', 'database']) {
        const full = path.join(ROOT, dir);
        if (fs.existsSync(full)) walk(full);
    }

    const re = /import\s*\{[^}]*\b(?:encryptAttachmentForDm|decryptAttachmentForDm)\b[^}]*\}\s*from|require\(\s*['"][^'"]*attachment-crypto[^'"]*['"]\s*\)\s*\.\s*(?:encryptAttachmentForDm|decryptAttachmentForDm)/;
    const offenders = files.filter((f) => re.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, [], 'attachment-crypto.js DM helpers must stay unused');
});