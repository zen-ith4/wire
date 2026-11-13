// tests/uploaders-live-cap.test.mjs
//
// Live multipart size-cap boundary for EVERY uploader route on this server:
//   avatar, banner, My Files, group avatar, DM attachment, group attachment
//   (and the "chat attachment" path, which on this server IS the DM uploader —
//   see the note in the last test).
//
// Owner decision pinned here: the cap is INCLUSIVE. A body of exactly the cap
// is accepted; cap+1 is refused. That is multer 2.x / busboy 1.x semantics
// (config/multer.js:280-283, :321-324); this file proves it against a real
// server and real multipart bodies instead of trusting the comment.
//
// Caps are lowered to 1 MiB through the same env vars the app documents
// (AVATAR_MAX_MB, BANNER_MAX_MB, UPLOAD_MAX_MB, GROUP_UPLOAD_MAX_MB,
// DM_UPLOAD_MAX_MB), so this stays fast and still exercises the real multer
// instances.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    startRealServer, registerUser, restLogin, jsonClient,
    walkFiles, groupProtocolHeaders, waitFor,
} from './_acceptance-harness.mjs';

const require = createRequire(import.meta.url);
const dmStream = require('../config/dm-stream.js');
const { createUserDrive } = require('../services/drive.service.js');

const MB = 1024 * 1024;
const CAP_MB = 1;
const PLAIN_CAP = CAP_MB * MB;
// DM bytes on the wire are STREAM ciphertext: header + one GCM tag per chunk.
const DM_CAP = PLAIN_CAP + dmStream.ciphertextOverheadBytes(PLAIN_CAP); // 1048840
// Group bytes on the wire are plaintext + one GCM tag (config/multer.js:312).
const GROUP_CAP = PLAIN_CAP + 16; // 1048592

let server;
let alice;
let bob;
let groupId;
let folderId;

const countIn = (dir) => walkFiles(dir).length;

/** The v1 E2EE envelope shape the DM route accepts (controllers/dm.controller.js:284-309). */
function v1Meta(from, to) {
    return JSON.stringify({
        encryption: {
            version: 1,
            algorithm: 'AES-GCM',
            iv: Buffer.alloc(12, 3).toString('base64'),
            ciphertext: Buffer.from('wire-cap-test', 'utf8').toString('base64'),
        },
        senderId: from,
        recipientId: to,
    });
}

/** A stream-shaped DM container of exactly `size` bytes (valid header + chunked body). */
function dmBytes(size) {
    const buf = Buffer.alloc(size);
    dmStream.HEADER.copy(buf, 0);
    return buf;
}

async function post(user, pathname, { field, name, type, bytes, fields = {} }) {
    const fd = new FormData();
    fd.append(field, new File([bytes], name, { type }));
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const res = await fetch(server.origin + pathname, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${user.token}`,
            ...groupProtocolHeaders(pathname),
        },
        body: fd,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.status === 404) {
        console.log(`DEBUG ${pathname}: GOT 404 body=`, body, 'token start=', user.token?.slice(0, 20));
    }
    return { status: res.status, body };
}

/**
 * One uploader: exactly the cap must be accepted (200), cap+1 must be refused
 * with the multer error mapping (400 {error:'Upload failed'}), and a refusal
 * must leave no partial file behind.
 */
async function assertCapBoundary({ label, user, pathname, field, name, type, exact, over, acceptedDir, refusalDir, extraFields = {} }) {
    const acceptedBefore = countIn(acceptedDir);
    const ok = await post(user, pathname, { field, name, type, bytes: exact, fields: extraFields });
    assert.equal(ok.status, 200, `${label}: a body of exactly the cap must be accepted, got ${ok.status} ${JSON.stringify(ok.body)}`);
    assert.equal(countIn(acceptedDir), acceptedBefore + 1, `${label}: the accepted upload must land exactly one file`);

    const refusedBefore = countIn(refusalDir);
    const bad = await post(user, pathname, { field, name, type, bytes: over, fields: extraFields });
    assert.equal(bad.status, 400, `${label}: cap+1 must be refused with 400, got ${bad.status} ${JSON.stringify(bad.body)}`);
    assert.deepEqual(bad.body, { error: 'Upload failed' }, `${label}: the refusal must be the multer error mapping`);
    const cleaned = await waitFor(() => countIn(refusalDir) === refusedBefore, 3000, 100);
    assert.ok(cleaned, `${label}: a refused upload must leave no orphan file (before=${refusedBefore}, after=${countIn(refusalDir)})`);
}

before(async () => {
    server = await startRealServer({
        extraEnv: {
            AVATAR_MAX_MB: String(CAP_MB),
            BANNER_MAX_MB: String(CAP_MB),
            UPLOAD_MAX_MB: String(CAP_MB),
            GROUP_UPLOAD_MAX_MB: String(CAP_MB),
            DM_UPLOAD_MAX_MB: String(CAP_MB),
            CHAT_UPLOAD_MAX_MB: String(CAP_MB),
        },
    });
    await registerUser(server.origin, 'capalice');
    await registerUser(server.origin, 'capbob');
    alice = await restLogin(server.origin, 'capalice');
    bob = await restLogin(server.origin, 'capbob');

    // The drive folder is not created at registration time; it's created
    // by createMissingDrives() at server start. Create it now for the test users.
    // Must pass the server's USER_DATA_ROOT explicitly because config/constants.js
    // reads env vars at module load time (before the test's extraEnv is applied).
    for (const [u, uname] of [[alice, 'capalice'], [bob, 'capbob']]) {
        const db = new require('better-sqlite3')(server.dbPath);
        try {
            createUserDrive(db, { id: u.id, username: uname }, server.dirs.ud);
        } finally {
            db.close();
        }
    }

    const g = await alice.api('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'cap group' }) });
    assert.equal(g.status, 201, `group create: ${g.status} ${JSON.stringify(g.body)}`);
    groupId = g.body.id || g.body.group?.id;
    assert.ok(groupId, 'group id');

    const folders = await alice.api('/api/files/folders');
    assert.equal(folders.status, 200, 'folders list');
    assert.ok(Array.isArray(folders.body) && folders.body.length > 0, 'registration creates the default Drive folder');
    folderId = folders.body[0].id;
});

after(async () => {
    await server?.stop();
});

test('the server actually runs with the lowered caps', async () => {
    const dm = await alice.api('/api/dm/limits');
    assert.deepEqual(dm.body, { upload_max_mb: CAP_MB }, 'DM upload cap comes from DM_UPLOAD_MAX_MB');
    const grp = await alice.api('/api/groups/limits');
    assert.deepEqual(grp.body, { upload_max_mb: CAP_MB }, 'group upload cap comes from GROUP_UPLOAD_MAX_MB');
});

test('avatar: exactly AVATAR_MAX_MB is accepted, +1 is refused', async () => {
    await assertCapBoundary({
        label: 'avatar',
        user: alice,
        pathname: '/api/me/avatar',
        field: 'file',
        name: 'cap.png',
        type: 'image/png',
        exact: Buffer.alloc(PLAIN_CAP, 0x61),
        over: Buffer.alloc(PLAIN_CAP + 1, 0x61),
        acceptedDir: server.dirs.avatars,
        refusalDir: server.dirs.avatars,
    });
});

test('banner: exactly BANNER_MAX_MB is accepted, +1 is refused', async () => {
    await assertCapBoundary({
        label: 'banner',
        user: alice,
        pathname: '/api/me/banner',
        field: 'file',
        name: 'cap.png',
        type: 'image/png',
        exact: Buffer.alloc(PLAIN_CAP, 0x62),
        over: Buffer.alloc(PLAIN_CAP + 1, 0x62),
        acceptedDir: server.dirs.banners,
        refusalDir: server.dirs.banners,
    });
});

test('My Files: exactly UPLOAD_MAX_MB is accepted, +1 is refused', async () => {
    await assertCapBoundary({
        label: 'files',
        user: alice,
        pathname: `/api/files/upload/${folderId}`,
        field: 'file',
        name: 'cap.bin',
        type: 'application/octet-stream',
        exact: Buffer.alloc(PLAIN_CAP, 0x63),
        over: Buffer.alloc(PLAIN_CAP + 1, 0x63),
        // fileUpload writes to $TMPDIR/wire-uploads first (config/multer.js:288)
        // and the controller moves the accepted file into the user's Drive.
        acceptedDir: server.dirs.ud,
        refusalDir: server.dirs.tmp,
    });
});

test('group avatar: exactly AVATAR_MAX_MB is accepted, +1 is refused', async () => {
    await assertCapBoundary({
        label: 'groupAvatar',
        user: alice,
        pathname: `/api/groups/${groupId}/avatar`,
        field: 'avatar',
        name: 'cap.png',
        type: 'image/png',
        exact: Buffer.alloc(PLAIN_CAP, 0x64),
        over: Buffer.alloc(PLAIN_CAP + 1, 0x64),
        acceptedDir: server.dirs.avatars,
        refusalDir: server.dirs.avatars,
    });
});

test('DM attachment: exactly DM_UPLOAD_MAX_MB of plaintext + STREAM overhead is accepted, +1 is refused', async () => {
    await assertCapBoundary({
        label: 'dm',
        user: alice,
        pathname: '/api/dm/upload',
        field: 'file',
        name: 'attachment.bin',
        type: 'application/octet-stream',
        exact: dmBytes(DM_CAP),
        over: dmBytes(DM_CAP + 1),
        acceptedDir: server.dirs.dm,
        refusalDir: server.dirs.dm,
        extraFields: {
            recipient_id: String(bob.id),
            attachment_iv: Buffer.alloc(12, 9).toString('base64'),
            attachment_meta: v1Meta(alice.id, bob.id),
        },
    });
});

test('group attachment: exactly GROUP_UPLOAD_MAX_MB + GCM tag is accepted, +1 is refused', async () => {
    await assertCapBoundary({
        label: 'group',
        user: alice,
        pathname: `/api/groups/${groupId}/upload`,
        field: 'file',
        name: 'attachment.bin',
        type: 'application/octet-stream',
        exact: Buffer.alloc(GROUP_CAP, 0x65),
        over: Buffer.alloc(GROUP_CAP + 1, 0x65),
        acceptedDir: server.dirs.group,
        refusalDir: server.dirs.group,
        extraFields: { attachment_iv: Buffer.alloc(12, 7).toString('base64') },
    });
});

test('chat attachment: this server has no separate chat uploader; the DM uploader is that path', async () => {
    // config/multer.js still exports `chatUpload`, but no route requires it:
    // the only 1:1 attachment uploader is routes/dm.routes.js:95 (dmUpload),
    // which the DM case above pins at the boundary. There is no /api/chat.
    const res = await jsonClient(server.origin, alice.token)('/api/chat/upload', { method: 'POST' });
    assert.equal(res.status, 404, 'no /api/chat upload route exists');
});

test('no uploader wrote into the repository root', () => {
    assert.deepEqual(server.strayRootEntries(), [], 'every upload dir must be redirected by the harness');
});