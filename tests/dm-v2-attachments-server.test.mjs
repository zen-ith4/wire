// tests/dm-v2-attachments-server.test.mjs
//
// STEP 2A.3: real server, no browser. What the upload route now accepts and
// refuses:
//   - the v2 envelope shape for BOTH attachment_meta and the caption
//   - the text rule (v2 to a recipient below dm_e2ee_min_version 2) applied to
//     BOTH fields, with the same message as text
//   - v1 still accepted for everyone
//   - the server never alters a stored byte
//
// The env default is pinned to 1 here (env var, not an edit to the app) so that
// a min-1 recipient exists to test the refusal against; carol is raised to 2
// with one UPDATE, which the ratchet triggers allow (they only refuse lowering).

import './dm-attachments/_env.mjs';

// config/constants.js reads the default ONCE, at its first require, so this must
// be set before anything that pulls the server in - hence the dynamic imports.
process.env.DM_E2EE_DEFAULT_MIN_VERSION = '1';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { startDmServer, createUser, postUpload, authGet } = await import('./dm-attachments/_harness.mjs');
const {
    encryptAttachmentStream,
    generateAttachmentKeyMaterial,
    streamBytesToBase64
} = await import('../public/js/crypto/messages/attachment-stream.js');

const DM_DIR = process.env.DM_UPLOAD_DIR;
let server, alice, bob, carol;

function v1Envelope(text) {
    return JSON.stringify({
        encryption: {
            version: 1,
            algorithm: 'AES-GCM',
            iv: Buffer.alloc(12, 3).toString('base64'),
            ciphertext: Buffer.from(text, 'utf8').toString('base64')
        },
        senderId: 2,
        recipientId: 34
    });
}

/** A well-formed v2 envelope. Overrides let a test break one field on purpose. */
function v2Envelope(from, to, overrides = {}, msgId = '0123456789abcdef') {
    const enc = {
        version: 2,
        algorithm: 'AES-GCM',
        iv: Buffer.alloc(12, 5).toString('base64'),
        ciphertext: Buffer.from('aabbccdd', 'hex').toString('base64'),
        senderFp: Buffer.alloc(32, 7).toString('base64'),
        msgId
    };
    Object.assign(enc, overrides);
    const payload = { encryption: enc, senderId: from, recipientId: to };
    if (overrides.__dropSenderFp) delete payload.encryption.senderFp;
    if (overrides.__dropMsgId) delete payload.encryption.msgId;
    return JSON.stringify(payload);
}

/** A real encrypted STREAM file, exactly as production builds it. */
async function streamUpload() {
    const material = generateAttachmentKeyMaterial();
    const { blob } = await encryptAttachmentStream(new Blob([new Uint8Array(128)]), material);
    return {
        file: new File([blob], 'attachment.bin', { type: 'application/octet-stream' }),
        iv: streamBytesToBase64(material.baseIv)
    };
}

async function upload(peer, fields, extra = {}) {
    const s = await streamUpload();
    return postUpload(server, alice, peer.id, {
        file: s.file,
        fields: { attachment_iv: s.iv, ...fields, ...extra }
    });
}

async function dmJson(user, method, path, body) {
    const res = await globalThis.__nodeFetch(`${server.origin}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${user.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
}

const rows = () => server.db.prepare('SELECT COUNT(*) AS c FROM direct_messages').get().c;
const rowOf = (id) => server.db.prepare(
    'SELECT id, content, attachment_meta, attachment_iv, attachment_path FROM direct_messages WHERE id = ?'
).get(id);
const fileCount = () => fs.readdirSync(DM_DIR).length;

before(async () => {
    server = await startDmServer();
    alice = await createUser(server, 'alice');
    bob = await createUser(server, 'bob');      // min 1 (the pinned default)
    carol = await createUser(server, 'carol');
    server.db.prepare('UPDATE users SET dm_e2ee_min_version = 2 WHERE id = ?').run(carol.id);
    const mins = server.db.prepare('SELECT username, dm_e2ee_min_version FROM users WHERE id IN (?, ?) ORDER BY id')
        .all(bob.id, carol.id);
    assert.deepEqual(mins.map((m) => m.dm_e2ee_min_version), [1, 2]);
});

after(async () => {
    await server.stop();
    fs.rmSync(process.env.DB_PATH, { force: true });
});

// ---------------------------------------------------------------- accepted

test('2A.3: a v2 meta AND a v2 caption are stored verbatim for a min-2 recipient', async () => {
    const meta = v2Envelope(alice.id, carol.id);
    const caption = v2Envelope(alice.id, carol.id, {}, 'fedcba9876543210');
    const before = rows();

    const res = await upload(carol, { attachment_meta: meta, content: caption });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(rows(), before + 1);
    const row = rowOf(res.body.id);
    assert.equal(row.attachment_meta, meta, 'the server must not alter a stored meta byte');
    assert.equal(row.content, caption, 'the server must not alter a stored caption byte');
    assert.equal(JSON.parse(row.attachment_meta).encryption.version, 2);
    assert.equal(JSON.parse(row.content).encryption.version, 2);
});

test('2A.3: a v2 meta with NO caption is stored (the caption is optional)', async () => {
    const meta = v2Envelope(alice.id, carol.id, {}, 'aaaabbbbccccdddd');
    const res = await upload(carol, { attachment_meta: meta });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(rowOf(res.body.id).attachment_meta, meta);
});

// ---------------------------------------------------------------- refused: the rule

test('2A.3: a v2 meta for a min-1 recipient is refused, nothing stored, upload removed', async () => {
    const meta = v2Envelope(alice.id, bob.id);
    const before = rows();
    const filesBefore = fileCount();

    const res = await upload(bob, { attachment_meta: meta });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not enabled for DM v2/i);

    assert.equal(rows(), before, 'nothing may be stored');
    // the server unlinks the refused upload just after answering: let it settle
    const deadline = Date.now() + 3000;
    while (fileCount() !== filesBefore && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(fileCount(), filesBefore, 'the refused upload must leave no file behind');
});

test('2A.3: a v2 CAPTION only (v1 meta) for a min-1 recipient is refused too', async () => {
    const meta = v1Envelope('{"name":"a.png"}');
    const caption = v2Envelope(alice.id, bob.id, {}, '1111222233334444');
    const before = rows();

    const res = await upload(bob, { attachment_meta: meta, content: caption });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not enabled for DM v2/i, 'the caption must carry the same rule as the meta');
    assert.equal(rows(), before, 'nothing may be stored');
});

// ---------------------------------------------------------------- refused: the shape

test('2A.3: malformed v2 shapes are refused (bad iv, missing senderFp, missing msgId, version 3)', async () => {
    const cases = [
        ['bad iv length', v2Envelope(alice.id, carol.id, { iv: Buffer.alloc(11, 1).toString('base64') }), 'Invalid attachment_meta'],
        ['missing senderFp', v2Envelope(alice.id, carol.id, { __dropSenderFp: true }), 'Invalid attachment_meta'],
        ['missing msgId', v2Envelope(alice.id, carol.id, { __dropMsgId: true }), 'Invalid attachment_meta'],
        ['version 3', v2Envelope(alice.id, carol.id, { version: 3 }), 'Invalid attachment_meta']
    ];
    for (const [label, meta, expected] of cases) {
        const before = rows();
        const res = await upload(carol, { attachment_meta: meta });
        assert.equal(res.status, 400, `${label}: must be refused`);
        assert.equal(res.body.error, expected, `${label}: wrong error`);
        assert.equal(rows(), before, `${label}: nothing may be stored`);
    }

    // Same for the caption slot: the v2 shape check applies to both fields.
    const capBefore = rows();
    const capRes = await upload(carol, {
        attachment_meta: v1Envelope('{"name":"a.png"}'),
        content: v2Envelope(alice.id, carol.id, { version: 3 }, '5555666677778888')
    });
    assert.equal(capRes.status, 400);
    assert.equal(capRes.body.error, 'Caption must be end-to-end encrypted');
    assert.equal(rows(), capBefore, 'nothing may be stored');
});

// ---------------------------------------------------------------- unchanged

test('2A.3: v1 meta + v1 caption are accepted for everyone (min 1 and min 2)', async () => {
    for (const peer of [bob, carol]) {
        const meta = v1Envelope('{"name":"legacy.png"}');
        const caption = v1Envelope('legacy caption');
        const before = rows();
        const res = await upload(peer, { attachment_meta: meta, content: caption });
        assert.equal(res.status, 200, `${peer.name}: ${JSON.stringify(res.body)}`);
        assert.equal(rows(), before + 1);
        const row = rowOf(res.body.id);
        assert.equal(row.attachment_meta, meta, `${peer.name}: the v1 meta byte must be unchanged`);
        assert.equal(row.content, caption, `${peer.name}: the v1 caption byte must be unchanged`);
    }
});

test('2A.3: the recipient can read the row back through the normal history route', async () => {
    const meta = v2Envelope(alice.id, carol.id, {}, '9999aaaabbbbcccc');
    const res = await upload(carol, { attachment_meta: meta });
    assert.equal(res.status, 200);

    const seen = await authGet(server, carol, `/api/dm/messages/${alice.id}/recent`);
    assert.equal(seen.status, 200);
    const body = await seen.json();
    const rowsOut = Array.isArray(body) ? body : body.messages;
    const found = rowsOut.find((m) => m.id === res.body.id);
    assert.ok(found, 'the uploaded row must come back in history');
    assert.equal(found.attachment_meta, meta);
});

// ---------------------------------------------------------------- R2: content cap
//
// The cap rejects, it never truncates. Every 413 here uses the same shared
// constant (config/dm-stream.js) and code. The v2-to-a-min-1-recipient case
// proves the length check runs BEFORE dmV2RuleViolation: that rule would answer
// 400, so a 413 can only mean the cap was checked first.

test('R2: an over-cap text DM is refused with 413 before the v2 rule, nothing stored', async () => {
    const before = rows();
    // A well-formed v2 envelope, but addressed to bob (min 1): the v2 policy
    // would refuse it with 400 if it ran first.
    const content = v2Envelope(alice.id, bob.id, {
        ciphertext: Buffer.alloc(1600, 9).toString('base64'),
    });
    assert.ok(content.length > 2000);

    const res = await dmJson(alice, 'POST', '/api/dm/messages', {
        recipient_id: bob.id,
        content,
    });

    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'DM_CONTENT_TOO_LONG');
    assert.match(res.body.error, /max 2000 characters/);
    assert.equal(rows(), before, 'nothing may be stored');
});

test('R2: an over-cap edit is refused with 413 and leaves the stored row unchanged', async () => {
    const sent = await dmJson(alice, 'POST', '/api/dm/messages', {
        recipient_id: bob.id,
        content: 'short v1 text',
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const id = sent.body.id;
    assert.ok(Number.isInteger(id));

    const res = await dmJson(alice, 'PATCH', `/api/dm/messages/${id}`, {
        content: 'x'.repeat(2001),
    });

    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'DM_CONTENT_TOO_LONG');
    assert.equal(rowOf(id).content, 'short v1 text', 'the old row must not be truncated or partly overwritten');
});

test('R2: an over-cap encrypted-upload caption is refused with 413 and removes the upload', async () => {
    const before = rows();
    const filesBefore = fileCount();

    const res = await upload(carol, {
        attachment_meta: v2Envelope(alice.id, carol.id),
        content: 'x'.repeat(2001),
    });

    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'DM_CONTENT_TOO_LONG');
    assert.equal(rows(), before, 'nothing may be stored');

    const deadline = Date.now() + 3000;
    while (fileCount() !== filesBefore && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(fileCount(), filesBefore, 'the refused upload must leave no file behind');
});