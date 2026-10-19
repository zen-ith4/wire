// tests/groups/group-attachment-server.test.mjs
//
// STEP 3C item 2: the group upload SERVER side.
//
//   (a) a first-ever upload into a FRESH GROUP_UPLOAD_DIR works (the
//       directory is created by the server, not by the test);
//   (b) a file of exactly GROUP_UPLOAD_MAX_MB plaintext (+ the 16-byte GCM
//       tag of ciphertext) is accepted, one byte more is rejected;
//   (c) the stored row carries the NEUTRAL values even when the client sends
//       real ones (name, mime, width, height, voice flag);
//   (d) the stored on-disk name does not contain the client's name;
//   (e) the stored blob holds no plaintext (the acceptance-no-plaintext
//       style check);
//   (f) a non-member and a removed member cannot download the file.
//
// Real server, real HTTP, real SQLite. ONE scenario for the whole file (each
// test would otherwise register its own accounts and hit the registration rate
// limiter). The upload goes through the real multipart route; the client-side
// encryption is NOT part of this file (it is in
// group-attachment-binding.test.mjs) - here the "ciphertext" is opaque bytes,
// which is exactly what the server sees.

import './_env-3c.mjs';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createScenario } from './_scenario.mjs';

const MAX_MB = Number(process.env.GROUP_UPLOAD_MAX_MB);
const MAX_PLAIN = MAX_MB * 1024 * 1024;
const GCM_TAG = 16;
const UPLOAD_DIR = process.env.GROUP_UPLOAD_DIR;

const IV_B64 = 'AAAAAAAAAAAAAAAA';     // 12 bytes, base64
const ENVELOPE = JSON.stringify({ v: 2, alg: 'AES-GCM', senderKeyId: 'a'.repeat(64), counter: 1, iv: IV_B64, ciphertext: 'Y2lwaGVydGV4dA==', reply_to_id: null, sig: 'B'.repeat(86) });

// The control for (a): BEFORE the server starts, the directory must not exist.
const DIR_MISSING_BEFORE_SERVER = !fs.existsSync(UPLOAD_DIR);

let S = null;
async function scenario() {
    if (!S) S = await createScenario(['alice', 'bob', 'carol']);
    return S;
}
after(async () => { await S?.stop(); });

async function upload(s, u, groupId, { fields = {}, bytes = Buffer.from('opaque ciphertext bytes'), filename = 'client-name.png', attachmentIv = IV_B64, content = ENVELOPE } = {}) {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'application/octet-stream' }), filename);
    fd.append('attachment_iv', attachmentIv);
    fd.append('content', content);
    for (const [k, v] of Object.entries(fields)) {
        if (k === 'content' || k === 'attachment_iv') continue;
        fd.append(k, v);
    }
    const res = await globalThis.__nodeFetch(`${s.server.origin}/api/groups/${groupId}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${u.ident.token}`, 'X-Wire-Group-Proto': '2' },
        body: fd,
    });
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
}

function row(s, groupId) {
    return s.server.db
        .prepare('SELECT id, attachment_path, attachment_name, attachment_mime, attachment_size, attachment_width, attachment_height, is_voice_message, attachment_iv FROM group_messages WHERE group_id = ? ORDER BY id DESC LIMIT 1')
        .get(groupId);
}

async function groupWith(s, name) {
    const alice = s.users.alice;
    const bob = s.users.bob;
    const g = await s.createGroup(alice, name);
    await s.addMember(alice, g.id, bob);
    return { g, alice, bob };
}

test('3C-2a: a first-ever upload into a FRESH GROUP_UPLOAD_DIR works (the server creates the directory)', async () => {
    // Control: BEFORE the server starts, the directory does not exist (the env
    // module removed it). The server must create it when it loads its multer
    // config - that is the STEP 3C fix for the 500 on a first-ever upload.
    assert.equal(DIR_MISSING_BEFORE_SERVER, true, 'control: the upload directory must not exist before the server starts');

    const s = await scenario();
    assert.ok(fs.existsSync(UPLOAD_DIR), 'the server must have created the group upload directory');

    const { g, alice } = await groupWith(s, '3c-2a');
    const res = await upload(s, alice, g.id);
    assert.equal(res.status, 200, `upload failed: ${JSON.stringify(res.body)}`);
    assert.ok(row(s, g.id)?.attachment_path, 'the row must have an attachment path');
});

test('3C-2b: exactly MAX plaintext + the 16-byte GCM tag is accepted; one byte more is rejected', async () => {
    const s = await scenario();
    const { g, alice } = await groupWith(s, '3c-2b');

    const exact = Buffer.alloc(MAX_PLAIN + GCM_TAG, 7);
    const ok = await upload(s, alice, g.id, { bytes: exact });
    assert.equal(ok.status, 200, `a file of exactly the cap + tag must be accepted: ${JSON.stringify(ok.body)}`);
    assert.equal(row(s, g.id).attachment_size, MAX_PLAIN + GCM_TAG);

    const oneMore = Buffer.alloc(MAX_PLAIN + GCM_TAG + 1, 7);
    const tooBig = await upload(s, alice, g.id, { bytes: oneMore });
    assert.equal(tooBig.status, 400, 'one byte over the cap must be rejected');
    assert.match(JSON.stringify(tooBig.body), /upload failed|too large|limit/i);
});

test('3C-2c: the stored row carries the NEUTRAL values even when the client sends real ones', async () => {
    const s = await scenario();
    const { g, alice } = await groupWith(s, '3c-2c');

    const res = await upload(s, alice, g.id, {
        fields: {
            mime: 'image/png',
            width: '800',
            height: '600',
            is_voice_message: '1',
            name: 'secret-real-name.png',
        },
        bytes: Buffer.from('opaque ciphertext bytes'),
        filename: 'secret-real-name.png',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const r = row(s, g.id);
    assert.equal(r.attachment_name, 'encrypted-attachment', 'the row must not carry the client name');
    assert.equal(r.attachment_mime, 'application/octet-stream', 'the row must not carry the client mime');
    assert.equal(r.attachment_width, null, 'the row must not carry the client width');
    assert.equal(r.attachment_height, null, 'the row must not carry the client height');
    assert.equal(r.is_voice_message, 0, 'the row must not carry the voice flag');
    assert.equal(r.attachment_iv, IV_B64, 'the attachment_iv is still stored (and still unsigned)');
});

test('3C-2d: the stored on-disk name does not contain the client name', async () => {
    const s = await scenario();
    const { g, alice } = await groupWith(s, '3c-2d');

    const res = await upload(s, alice, g.id, { bytes: Buffer.from('opaque ciphertext bytes'), filename: 'secret-real-name.png' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const r = row(s, g.id);
    assert.ok(!r.attachment_path.includes('secret-real-name'), `the stored name must be opaque, got ${r.attachment_path}`);
    assert.ok(!r.attachment_path.includes('.png'), 'the stored name must not even keep the extension');
    const onDisk = path.join(UPLOAD_DIR, r.attachment_path);
    assert.ok(fs.existsSync(onDisk), 'the file must be on disk');
    assert.ok(!fs.readdirSync(UPLOAD_DIR).some((n) => n.includes('secret-real-name')), 'no file in the dir may carry the client name');
});

test('3C-2e: the REAL encrypt path leaves only ciphertext on disk (acceptance-no-plaintext style)', async () => {
    const s = await scenario();
    const { g, alice, bob } = await groupWith(s, '3c-2e');

    // The REAL encryption path: Alice's REAL Sender Key, the real group
    // attachment encryptor. Only then does "no plaintext on disk" mean
    // anything - the server cannot tell ciphertext from plaintext, it just
    // stores what it is given.
    await s.mount(alice); await s.open(alice, g.id);
    await s.mount(bob); await s.open(bob, g.id);
    alice.actor.use();
    const groupCrypto = await alice.actor.importModule('crypto/messages/group-message-crypto.js');
    const senderKey = await alice.actor.importModule('crypto/groups/sender-key.js');
    const mine = await senderKey.getMySenderKey(groupCrypto.getGroupIdentity(), g.id);
    assert.ok(mine?.senderKeyId, 'Alice must have a Sender Key for the group');
    const attach = await alice.actor.importModule('crypto/messages/attachment-crypto.js');

    const marker = 'ZXQ-GRP-SERVER-PLAINTEXT-MARKER';
    const plaintext = new Uint8Array(Buffer.from(marker.repeat(40), 'utf8'));
    const { ivBase64, ciphertext } = await attach.encryptAttachmentForGroup(g.id, plaintext.buffer);

    const res = await upload(s, alice, g.id, { bytes: Buffer.from(ciphertext), attachmentIv: ivBase64 });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const r = row(s, g.id);
    const onDisk = fs.readFileSync(path.join(UPLOAD_DIR, r.attachment_path));
    assert.equal(onDisk.length, plaintext.length + 16, 'the stored bytes are the plaintext plus the GCM tag');
    assert.ok(!onDisk.includes(Buffer.from(marker)), 'the plaintext marker must not be in the stored bytes');
    assert.equal(r.attachment_size, plaintext.length + 16);
});

test('3C-3D-0: an oversize content is refused with 400 and leaves NO orphan file on disk', async () => {
    // STEP 3D item 0: the server refuses a `content` above 90,000 characters.
    // The multer file has already been written to disk when the handler runs,
    // so the handler must delete it (controllers/groups.controller.js: the
    // `cleanup()` helper) - otherwise every rejected upload leaves an orphan
    // file behind.
    const s = await scenario();
    const { g, alice } = await groupWith(s, '3d-0');

    const before = fs.readdirSync(UPLOAD_DIR).sort();
    const res = await upload(s, alice, g.id, { content: 'x'.repeat(90001) });
    assert.equal(res.status, 400, `an oversize content must be refused: ${JSON.stringify(res.body)}`);

    // The unlink is asynchronous (fs.unlink with a callback).
    await new Promise((r) => setTimeout(r, 400));
    const after = fs.readdirSync(UPLOAD_DIR).sort();
    assert.deepEqual(after, before, `the rejected upload must not leave a file behind (before=${before} after=${after})`);

    // And no message row.
    assert.equal(row(s, g.id), undefined, 'no message row must be created');
});

test('3C-2f: a non-member and a removed member cannot download the file', async () => {
    const s = await scenario();
    const { g, alice, bob } = await groupWith(s, '3c-2f');

    const res = await upload(s, alice, g.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const messageId = row(s, g.id).id;

    // A member can download.
    const member = await globalThis.__nodeFetch(`${s.server.origin}/api/groups/${g.id}/attachments/${messageId}`, {
        headers: { Authorization: `Bearer ${bob.ident.token}` },
    });
    assert.equal(member.status, 200, 'a member must be able to download');

    // A non-member cannot.
    const outsider = await globalThis.__nodeFetch(`${s.server.origin}/api/groups/${g.id}/attachments/${messageId}`, {
        headers: { Authorization: `Bearer ${s.users.carol.ident.token}` },
    });
    assert.ok([403, 404].includes(outsider.status), `a non-member must be refused, got ${outsider.status}`);

    // A removed member cannot either.
    await s.removeMember(alice, g.id, bob);
    const removed = await globalThis.__nodeFetch(`${s.server.origin}/api/groups/${g.id}/attachments/${messageId}`, {
        headers: { Authorization: `Bearer ${bob.ident.token}` },
    });
    assert.ok([403, 404].includes(removed.status), `a removed member must be refused, got ${removed.status}`);
});
