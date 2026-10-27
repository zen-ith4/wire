// uploadFile had no length check on the name. A name longer than the
// filesystem allows made renameSync fail with ENAMETOOLONG and the request
// returned 500. The limit is 255 BYTES, not characters, so a multi-byte name
// can be short in characters and still too long. The " (N)" suffix added to
// resolve a duplicate can also push a valid name over the limit.
//
// Runs against a real server with real files on disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startRealServer, registerUser, restLogin } from './_acceptance-harness.mjs';

const OWNER = 'upname-owner';
const FOLDER = 'UpNameTest';
const BYTES = Buffer.from('payload\n', 'utf8');

let server;
let owner;
let folderId;
let folderPath;

before(async () => {
    server = await startRealServer();
    await registerUser(server.origin, OWNER);
    owner = await restLogin(server.origin, OWNER);

    const created = await owner.api('/api/share/folders', {
        method: 'POST',
        body: JSON.stringify({ name: FOLDER }),
    });
    assert.equal(created.status, 200, `create folder: ${created.status} ${JSON.stringify(created.body)}`);
    folderId = created.body.id;
    folderPath = created.body.path;
});

after(async () => {
    if (server) await server.stop();
});

function upload(filename) {
    const form = new FormData();
    form.set('subpath', '');
    form.set('file', new Blob([BYTES]), filename);
    return fetch(`${server.origin}/api/files/upload/${folderId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.token}` },
        body: form,
    });
}

async function json(res) {
    return { status: res.status, body: await res.json().catch(() => null) };
}

test('a name of exactly 255 bytes uploads successfully', async () => {
    const name = `${'a'.repeat(251)}.txt`; // 255 bytes
    assert.equal(Buffer.byteLength(name), 255);

    const res = await json(await upload(name));

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, name);
    assert.ok(fs.existsSync(path.join(folderPath, name)));
});

test('a name longer than 255 bytes is rejected with 400, not 500, and nothing is written', async () => {
    const name = `${'b'.repeat(296)}.txt`; // 300 bytes
    assert.equal(Buffer.byteLength(name), 300);

    const res = await json(await upload(name));

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'File name too long');
    assert.ok(!fs.existsSync(path.join(folderPath, name)));
});

test('a multi-byte (Persian) name under 255 characters but over 255 bytes is rejected', async () => {
    // Each Persian letter is 2 bytes in UTF-8: 130 letters = 260 bytes, plus ".txt".
    const name = `${'ب'.repeat(130)}.txt`;
    assert.ok(name.length < 255, 'precondition: fewer than 255 characters');
    assert.ok(Buffer.byteLength(name) > 255, 'precondition: more than 255 bytes');

    const res = await json(await upload(name));

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'File name too long');
});

test('a duplicate whose " (1)" suffix pushes it past 255 bytes is rejected with 400', async () => {
    const name = `${'c'.repeat(251)}.txt`; // 255 bytes, accepted the first time
    const first = await json(await upload(name));
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // The second upload would be stored as "<251 c> (1).txt" = 259 bytes.
    const second = await json(await upload(name));

    assert.equal(second.status, 400, JSON.stringify(second.body));
    assert.equal(second.body.error, 'File name too long');
    // The original file is untouched and no stray temp or renamed copy exists.
    assert.ok(fs.existsSync(path.join(folderPath, name)));
});

test('an ordinary duplicate still gets the " (1)" suffix', async () => {
    const name = 'report.txt';
    assert.equal((await json(await upload(name))).status, 200);

    const second = await json(await upload(name));

    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.name, 'report (1).txt');
});
