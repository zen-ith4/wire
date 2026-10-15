// tests/files-path-traversal.test.mjs
//
// HTTP-level tests for the three endpoints that hand file bytes (or a
// directory listing) to a caller, against a REAL server and REAL files on disk.
//
// These three used to resolve `subpath` / `file` with safeSubPath(), which is a
// purely lexical check. It answers "does this string escape the root" and
// nothing else, so three things it did not cover were reachable:
//
//   - a symlink planted inside the folder. safeSubPath() resolved it
//     lexically, so the result stayed "inside" and the kernel then followed the
//     link to whatever it pointed at. A file outside the root was served.
//   - dotfiles. The listing filters names starting with ".", but download /
//     preview / list accepted one directly, so a crafted request reached
//     exactly what the UI never shows.
//   - a NUL byte. safeSubPath() passed it through to fs.existsSync /
//     fs.statSync, which throw on it, so the request came back as a 500 with a
//     stack rather than a 4xx.
//
// The endpoints now go through resolveRegularFile() (download, preview) and the
// new resolveRegularDirectory() (list, upload). Everything below asserts one
// property: bad input gets ONE generic 404, never a 500, never a stack, never a
// hint about which check rejected it - and normal use is unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startRealServer, registerUser, restLogin } from './_acceptance-harness.mjs';

const OWNER = 'ftrav-owner';
const OUTSIDER = 'ftrav-outsider';
const FOLDER = 'TravTest';

// Markers, so "the bytes leaked" is a fact and not an inference.
const INSIDE_BYTES = Buffer.from('inside-the-folder\n', 'utf8');
const SECRET_BYTES = Buffer.from('SECRET-OUTSIDE-THE-ROOT\n', 'utf8');
const DOTFILE_BYTES = Buffer.from('DOTFILE-SHOULD-BE-UNREACHABLE\n', 'utf8');

// Symlinks are a capability, not a platform label: on win32 an unprivileged
// process gets EPERM unless Developer Mode is on, and on Linux they work
// everywhere. Probe once, so the skip says what actually happened.
function probeSymlinks() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-symprobe-'));
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'link');
    fs.writeFileSync(target, 'x');
    try {
        fs.symlinkSync(target, link, 'file');
        fs.unlinkSync(link);
        fs.rmSync(dir, { recursive: true, force: true });
        return { available: true, reason: '' };
    } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        return {
            available: false,
            reason: `symlink creation is not permitted here (${process.platform}: ${e.code || e.message}); ` +
                `the lexical-only behaviour this file also covers (dotfiles, NUL, "..") is still tested on this platform`,
        };
    }
}

const SYMLINK = probeSymlinks();

let server;
let owner;
let outsider;
let folderId;
let folderPath;
let outsideDir;

// The vector tables below are built at module load, before `before` has made a
// temp directory, so they cannot hold the real path yet. They hold this token
// instead and it is substituted into the query string at request time.
const OUTSIDE = '@OUTSIDE@';
const resolveToken = (v) => String(v).split(OUTSIDE).join(outsideDir);

function rawGet(token, urlPath) {
    return fetch(`${server.origin}${urlPath}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
}

async function bodyText(res) {
    try {
        return await res.text();
    } catch {
        return '';
    }
}

/** Exactly what the endpoint sees, after query decoding. */
const q = (subpath, file) =>
    `?subpath=${encodeURIComponent(resolveToken(subpath))}&file=${encodeURIComponent(resolveToken(file))}`;

/**
 * The invariant the whole change is about: a rejected request is a 404 with a
 * short, uniform body. A 5xx, a stack trace, or a body that varies with the
 * vector all fail here, which is what stops a future edit from turning "not
 * found" into "here is why you were not found".
 */
async function assertGeneric404(res, what) {
    const text = await bodyText(res);
    assert.equal(res.status, 404, `${what}: expected 404, got ${res.status} - ${text.slice(0, 200)}`);
    assert.ok(
        !/ at .+:\d+:\d+|TypeError|Error:|statSync|\/srv\/|node_modules/.test(text),
        `${what}: 404 body leaked an implementation detail: ${text.slice(0, 300)}`
    );
    assert.ok(text.length < 200, `${what}: 404 body is too long to be generic: ${text.slice(0, 300)}`);
    return text;
}

before(async () => {
    server = await startRealServer();

    await registerUser(server.origin, OWNER);
    await registerUser(server.origin, OUTSIDER);
    owner = await restLogin(server.origin, OWNER);
    outsider = await restLogin(server.origin, OUTSIDER);

    const created = await owner.api('/api/share/folders', {
        method: 'POST',
        body: JSON.stringify({ name: FOLDER }),
    });
    assert.equal(created.status, 200, `create folder: ${created.status} ${JSON.stringify(created.body)}`);
    folderId = created.body.id;
    folderPath = created.body.path;
    assert.ok(folderPath && folderPath.includes(FOLDER), `folder path looks wrong: ${folderPath}`);

    // Real files, written directly into the folder on disk.
    fs.writeFileSync(path.join(folderPath, 'hello.txt'), INSIDE_BYTES);
    fs.writeFileSync(path.join(folderPath, '.env'), DOTFILE_BYTES);
    fs.mkdirSync(path.join(folderPath, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(folderPath, 'sub', 'nested.txt'), INSIDE_BYTES);

    // The prize an attacker would be after: a real file the account does not own,
    // sitting outside the folder root.
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), SECRET_BYTES);
});

after(async () => {
    if (server) await server.stop();
    if (outsideDir) fs.rmSync(outsideDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- normal use

test('a normal file at the folder root still downloads byte-identically', async () => {
    const res = await rawGet(owner.token, `/api/files/download/${folderId}${q('', 'hello.txt')}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), INSIDE_BYTES);
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
});

test('a normal file in a normal sub-folder still downloads and previews', async () => {
    const res = await rawGet(owner.token, `/api/files/download/${folderId}${q('sub', 'nested.txt')}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), INSIDE_BYTES);

    const listed = await owner.api(`/api/files/list/${folderId}?subpath=${encodeURIComponent('sub')}`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.entries.map((e) => e.name), ['nested.txt']);

    const prev = await rawGet(owner.token, `/api/files/preview/${folderId}${q('sub', 'nested.txt')}`);
    assert.equal(prev.status, 200);
    assert.deepEqual(Buffer.from(await prev.arrayBuffer()), INSIDE_BYTES);
});

test('listing the folder root still shows every ordinary entry', async () => {
    const res = await owner.api(`/api/files/list/${folderId}`);
    assert.equal(res.status, 200);
    const names = res.body.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['hello.txt', 'sub']);
    const sub = res.body.entries.find((e) => e.name === 'sub');
    assert.equal(sub.type, 'dir');
    assert.equal(sub.size, 0, 'directories must keep reporting size 0, as before');
    assert.ok(sub.modified, 'entries must keep carrying modified');
});

// -------------------------------------------------------------- access rules

test('a user with no access to the folder still gets 403, not 404', async () => {
    for (const p of [
        `/api/files/list/${folderId}`,
        `/api/files/download/${folderId}${q('', 'hello.txt')}`,
        `/api/files/preview/${folderId}${q('', 'hello.txt')}`,
    ]) {
        const res = await rawGet(outsider.token, p);
        assert.equal(res.status, 403, `${p}: expected 403, got ${res.status}`);
    }
});

// ------------------------------------------------------------- dotfile reach

test('a dotfile that the listing hides cannot be fetched by name', async () => {
    for (const [verb, p] of [
        ['download', `/api/files/download/${folderId}${q('', '.env')}`],
        ['preview', `/api/files/preview/${folderId}${q('', '.env')}`],
    ]) {
        const res = await rawGet(owner.token, p);
        const text = await assertGeneric404(res, `${verb} of a dotfile`);
        assert.ok(!text.includes('UNREACHABLE'), `${verb} leaked the dotfile body`);
    }
});

test('a hidden segment in subpath cannot be listed or downloaded through', async () => {
    fs.mkdirSync(path.join(folderPath, '.secret'), { recursive: true });
    fs.writeFileSync(path.join(folderPath, '.secret', 'inner.txt'), SECRET_BYTES);

    const listed = await owner.api(`/api/files/list/${folderId}?subpath=${encodeURIComponent('.secret')}`);
    assert.equal(listed.status, 404, `listing a hidden directory: ${JSON.stringify(listed.body)}`);

    const res = await rawGet(owner.token, `/api/files/download/${folderId}${q('.secret', 'inner.txt')}`);
    const text = await assertGeneric404(res, 'download through a hidden segment');
    assert.ok(!text.includes('SECRET-OUTSIDE'), 'hidden-segment download leaked bytes');

    fs.rmSync(path.join(folderPath, '.secret'), { recursive: true, force: true });
});

// ------------------------------------------------------- dot / NUL / escapes

// Every one of these used to be either served or turned into a 500. They are
// listed as data rather than as separate tests so the whole shape of the
// rejection is visible in one place.
const BAD_VECTORS = [
    { what: 'file is "."', subpath: '', file: '.' },
    { what: 'subpath is "."', subpath: '.', file: 'hello.txt' },
    { what: 'subpath is ".."', subpath: '..', file: 'hello.txt' },
    { what: 'file is ".."', subpath: '', file: '..' },
    { what: 'traversal out of a sub-folder', subpath: 'a/../../x', file: 'hello.txt' },
    { what: 'traversal out of the root', subpath: '../../..', file: 'hello.txt' },
    { what: 'NUL byte in file', subpath: '', file: 'hello\0.txt' },
    { what: 'NUL byte in subpath', subpath: 'he\0llo', file: 'hello.txt' },
    { what: 'backslash escape in file', subpath: '', file: '..\\..\\secret.txt' },
    { what: 'backslash escape in subpath', subpath: '..\\..', file: 'hello.txt' },
    { what: 'separator in file', subpath: '', file: 'sub/nested.txt' },
    { what: 'file is a directory', subpath: '', file: 'sub' },
    { what: 'subpath is a file', subpath: 'hello.txt', file: 'hello.txt' },
    { what: 'absolute path as subpath', subpath: OUTSIDE, file: 'secret.txt' },
    { what: 'absolute path as file', subpath: '', file: `${OUTSIDE}/secret.txt` },
];

for (const v of BAD_VECTORS) {
    test(`download rejects: ${v.what}`, async () => {
        const res = await rawGet(owner.token, `/api/files/download/${folderId}${q(v.subpath, v.file)}`);
        const text = await bodyText(res);
        await assertGeneric404(res, `download / ${v.what}`);
        assert.ok(!text.includes('SECRET-OUTSIDE'), `download / ${v.what} leaked bytes`);
    });

    test(`preview rejects: ${v.what}`, async () => {
        const res = await rawGet(owner.token, `/api/files/preview/${folderId}${q(v.subpath, v.file)}`);
        const text = await bodyText(res);
        await assertGeneric404(res, `preview / ${v.what}`);
        assert.ok(!text.includes('SECRET-OUTSIDE'), `preview / ${v.what} leaked bytes`);
    });
}

const BAD_SUBPATHS = [
    { what: 'subpath is "."', value: '.' },
    { what: 'subpath is ".."', value: '..' },
    { what: 'subpath escapes with "a/../../x"', value: 'a/../../x' },
    { what: 'subpath is a NUL byte', value: '\0' },
    { what: 'subpath is a backslash escape', value: '..\\..' },
    { what: 'subpath is a hidden segment', value: '.secret' },
    { what: 'subpath is a file, not a folder', value: 'hello.txt' },
    { what: 'subpath is an absolute path', value: OUTSIDE },
];

for (const v of BAD_SUBPATHS) {
    test(`list rejects: ${v.what}`, async () => {
        const res = await rawGet(owner.token, `/api/files/list/${folderId}?subpath=${encodeURIComponent(resolveToken(v.value))}`);
        const text = await bodyText(res);
        await assertGeneric404(res, `list / ${v.what}`);
        assert.ok(!text.includes('SECRET-OUTSIDE'), `list / ${v.what} leaked bytes`);
    });
}

test('percent-encoded traversal is rejected too, not just the literal spelling', async () => {
    // encodeURIComponent leaves "." alone, so "subpath=.." on the wire and
    // "subpath=%2e%2e" are different requests that happen to decode the same.
    // Only the raw one proves the server is not relying on a proxy to decode.
    for (const raw of ['%2e%2e', '%2E%2E%2F%2E%2E', '..%2f..%2f..', '%00']) {
        for (const p of [
            `/api/files/list/${folderId}?subpath=${raw}`,
            `/api/files/download/${folderId}?subpath=${raw}&file=hello.txt`,
            `/api/files/download/${folderId}?subpath=&file=${raw}`,
        ]) {
            const res = await rawGet(owner.token, p);
            await assertGeneric404(res, `raw vector ${raw} on ${p}`);
        }
    }
});

// ----------------------------------------------------------------- symlinks

test('a symlink to a file outside the root serves neither download nor preview', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(folderPath, 'leak.txt'), 'file');

    for (const verb of ['download', 'preview']) {
        const res = await rawGet(owner.token, `/api/files/${verb}/${folderId}${q('', 'leak.txt')}`);
        const text = await bodyText(res);
        await assertGeneric404(res, `${verb} through a symlink out of the root`);
        assert.ok(!text.includes('SECRET-OUTSIDE'), `${verb} leaked the symlinked file`);
        assert.ok(
            !res.headers.get('content-length') || res.headers.get('content-length') !== String(SECRET_BYTES.length),
            `${verb} leaked the symlinked file length`
        );
    }

    fs.unlinkSync(path.join(folderPath, 'leak.txt'));
});

test('a symlinked sub-folder out of the root cannot be listed or entered', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    fs.symlinkSync(outsideDir, path.join(folderPath, 'out'), 'dir');

    const listed = await rawGet(owner.token, `/api/files/list/${folderId}?subpath=${encodeURIComponent('out')}`);
    const listText = await assertGeneric404(listed, 'listing a symlinked folder pointing out of the root');
    assert.ok(!listText.includes('secret.txt'), 'the listing enumerated a directory outside the root');

    const res = await rawGet(owner.token, `/api/files/download/${folderId}${q('out', 'secret.txt')}`);
    const text = await assertGeneric404(res, 'download through a symlinked folder');
    assert.ok(!text.includes('SECRET-OUTSIDE'), 'download through a symlinked folder leaked bytes');

    fs.unlinkSync(path.join(folderPath, 'out'));
});

test('a symlink pointing INSIDE the root keeps working', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    // The fix is containment, not a blanket ban on links: an internal symlink
    // resolves to a path still inside the real root and must keep serving, or
    // this change would have broken real folders.
    fs.symlinkSync(path.join(folderPath, 'hello.txt'), path.join(folderPath, 'alias.txt'), 'file');

    const res = await rawGet(owner.token, `/api/files/download/${folderId}${q('', 'alias.txt')}`);
    assert.equal(res.status, 200, 'an internal symlink must still download');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), INSIDE_BYTES);

    fs.unlinkSync(path.join(folderPath, 'alias.txt'));
});

test('a symlink pointing out of the root is not listed at all', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(folderPath, 'ghost.txt'), 'file');
    fs.symlinkSync(path.join(folderPath, 'hello.txt'), path.join(folderPath, 'real-link.txt'), 'file');

    const res = await owner.api(`/api/files/list/${folderId}`);
    assert.equal(res.status, 200);
    const names = res.body.entries.map((e) => e.name);

    // Omitted, not "listed but un-downloadable": listing a name the caller can
    // never fetch is a free oracle for what exists on disk outside the root.
    assert.ok(!names.includes('ghost.txt'), `an escaping symlink must not be listed: ${JSON.stringify(names)}`);
    assert.ok(names.includes('real-link.txt'), `an internal symlink must stay listed: ${JSON.stringify(names)}`);

    fs.unlinkSync(path.join(folderPath, 'ghost.txt'));
    fs.unlinkSync(path.join(folderPath, 'real-link.txt'));
});

test('a dangling symlink does not break the listing', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    fs.symlinkSync(path.join(outsideDir, 'does-not-exist.txt'), path.join(folderPath, 'dangling.txt'), 'file');

    const res = await owner.api(`/api/files/list/${folderId}`);
    assert.equal(res.status, 200, 'a dangling link must not 500 the listing');
    const names = res.body.entries.map((e) => e.name);
    assert.ok(!names.includes('dangling.txt'));
    assert.ok(names.includes('hello.txt'), 'the rest of the listing is unaffected');

    fs.unlinkSync(path.join(folderPath, 'dangling.txt'));
});