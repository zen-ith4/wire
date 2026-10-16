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
    for (const d of [outsideDir, server?.work]) {
        if (d) fs.rmSync(d, { recursive: true, force: true });
    }
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
    assert.ok(sub.modified, 'entries must keep carrying modified');

    // A listed size is whatever stat() says about the entry: 0 on win32, a few
    // KB on Linux, and it has always been one fs.stat() call per entry. So the
    // invariant is "it is the real stat", not a fixed number - pinning 0 here
    // would have passed on Windows and failed on Linux for no reason.
    const subOnDisk = fs.statSync(path.join(folderPath, 'sub'));
    assert.equal(sub.size, subOnDisk.size, 'a directory entry reports its real stat size');

    const file = res.body.entries.find((e) => e.name === 'hello.txt');
    assert.equal(file.type, 'file');
    assert.equal(file.size, INSIDE_BYTES.length);
    assert.equal(
        file.modified,
        fs.statSync(path.join(folderPath, 'hello.txt')).mtime.toISOString(),
        'modified is the entry mtime, unchanged'
    );
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

/**
 * Create a symlink, run `fn`, and ALWAYS remove it.
 *
 * Every one of these tests used to unlink at the end of the body, which meant a
 * failing assertion left the link behind for the rest of the run - and the
 * listing tests that follow would then see a stray entry and fail for the wrong
 * reason. A cleanup that only runs on success is not cleanup.
 */
async function withSymlinks(links, fn) {
    try {
        for (const { link, target, type } of links) {
            fs.symlinkSync(target, link, type);
        }
        return await fn();
    } finally {
        for (const { link } of links) {
            try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* already gone */ }
        }
    }
}

test('a symlink to a file outside the root serves neither download nor preview', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    await withSymlinks([
        { link: path.join(folderPath, 'leak.txt'), target: path.join(outsideDir, 'secret.txt'), type: 'file' },
    ], async () => {
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
    });
});

test('a symlinked sub-folder out of the root cannot be listed or entered', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    await withSymlinks([
        { link: path.join(folderPath, 'out'), target: outsideDir, type: 'dir' },
    ], async () => {
        const listed = await rawGet(owner.token, `/api/files/list/${folderId}?subpath=${encodeURIComponent('out')}`);
        const listText = await assertGeneric404(listed, 'listing a symlinked folder pointing out of the root');
        assert.ok(!listText.includes('secret.txt'), 'the listing enumerated a directory outside the root');

        const res = await rawGet(owner.token, `/api/files/download/${folderId}${q('out', 'secret.txt')}`);
        const text = await assertGeneric404(res, 'download through a symlinked folder');
        assert.ok(!text.includes('SECRET-OUTSIDE'), 'download through a symlinked folder leaked bytes');
    });
});

test('a symlink pointing INSIDE the root keeps working', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    // The fix is containment, not a blanket ban on links: an internal symlink
    // resolves to a path still inside the real root and must keep serving, or
    // this change would have broken real folders.
    await withSymlinks([
        { link: path.join(folderPath, 'alias.txt'), target: path.join(folderPath, 'hello.txt'), type: 'file' },
    ], async () => {
        const res = await rawGet(owner.token, `/api/files/download/${folderId}${q('', 'alias.txt')}`);
        assert.equal(res.status, 200, 'an internal symlink must still download');
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), INSIDE_BYTES);
    });
});

test('a symlink pointing out of the root is not listed at all', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    await withSymlinks([
        { link: path.join(folderPath, 'ghost.txt'), target: path.join(outsideDir, 'secret.txt'), type: 'file' },
        { link: path.join(folderPath, 'real-link.txt'), target: path.join(folderPath, 'hello.txt'), type: 'file' },
    ], async () => {
        const res = await owner.api(`/api/files/list/${folderId}`);
        assert.equal(res.status, 200);
        const names = res.body.entries.map((e) => e.name);

        // Omitted, not "listed but un-downloadable": listing a name the caller
        // can never fetch is a free oracle for what exists on disk outside it.
        assert.ok(!names.includes('ghost.txt'), `an escaping symlink must not be listed: ${JSON.stringify(names)}`);
        assert.ok(names.includes('real-link.txt'), `an internal symlink must stay listed: ${JSON.stringify(names)}`);
    });
});

test('a dangling symlink does not break the listing', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    await withSymlinks([
        { link: path.join(folderPath, 'dangling.txt'), target: path.join(outsideDir, 'does-not-exist.txt'), type: 'file' },
    ], async () => {
        const res = await owner.api(`/api/files/list/${folderId}`);
        assert.equal(res.status, 200, 'a dangling link must not 500 the listing');
        const names = res.body.entries.map((e) => e.name);
        assert.ok(!names.includes('dangling.txt'));
        assert.ok(names.includes('hello.txt'), 'the rest of the listing is unaffected');
    });
});


// ------------------------------------------------------------------- uploads
//
// The read paths were covered above; the WRITE path had no coverage at all.
// resolveRegularDirectory() guards both listFile() and uploadFile(), so a
// symlink planted inside the folder would let an upload write outside the user's
// storage - and unlike a read, that is a write whose contents the attacker chose.
//
// The rate limiter allows 20 uploads a minute and these tests are not exempt, so
// the whole section is held to 10 requests. Adding more will start returning 429
// and the failures will look like security assertions.

const UPLOAD_BYTES = Buffer.from('UPLOAD-BODY-MARKER\n', 'utf8');

/**
 * POST /api/files/upload/:folderId as multipart/form-data.
 *
 * Hand-rolled rather than reusing owner.api(), which speaks JSON: the point is
 * to send exactly what a browser sends, including a file name with a directory
 * part in it.
 */
function upload(folderId, {
    token = owner.token,
    filename = 'upload.txt',
    subpath = '',
    bytes = UPLOAD_BYTES,
} = {}) {
    const form = new FormData();
    if (subpath !== null) form.set('subpath', subpath);
    form.set('file', new Blob([bytes]), filename);

    return fetch(`${server.origin}/api/files/upload/${folderId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });
}

/** Every path under `dir`, recursively. Symlinked directories are not followed. */
function walk(dir, acc = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        acc.push(full);
        if (entry.isDirectory()) walk(full, acc);
    }
    return acc;
}

/**
 * The upload endpoint's own rejection, asserted exactly.
 *
 * A bare `status !== 200` would be satisfied by a 403 (no write access) or a
 * 429 (the limiter) or a 401, none of which test anything about path handling.
 * Pinning the status AND the body proves the request got past auth, past the
 * folder lookup and past the limiter, and was actually turned away by
 * resolveRegularDirectory() - which is the thing under test.
 */
async function assertBadDestination(res, what) {
    const body = await bodyText(res);
    assert.equal(res.status, 404, `${what}: expected 404, got ${res.status} - ${body.slice(0, 200)}`);
    assert.equal(body, JSON.stringify({ error: 'Destination folder not found' }),
        `${what}: unexpected body - the request may not have reached the resolver`);
    assert.ok(!/ at .+:\d+:\d+|TypeError|Error:|statSync|node_modules/.test(body),
        `${what}: body leaked an implementation detail: ${body.slice(0, 200)}`);
    return body;
}

test('an upload into a symlinked directory that leaves the root is refused, and nothing lands outside', { skip: SYMLINK.available ? false : SYMLINK.reason }, async () => {
    const marker = 'escaped-upload.txt';
    const before = walk(outsideDir).sort();

    await withSymlinks([
        { link: path.join(folderPath, 'escape'), target: outsideDir, type: 'dir' },
    ], async () => {
        const res = await upload(folderId, { subpath: 'escape', filename: marker });
        await assertBadDestination(res, 'upload through a symlinked folder pointing out of the root');
    });

    assert.deepEqual(walk(outsideDir).sort(), before,
        `the refused upload still wrote outside the folder root (${marker})`);
    assert.ok(!fs.existsSync(path.join(outsideDir, marker)),
        `${marker} was created outside the folder root`);
});

test('"..", a hidden segment and a NUL byte in the upload subpath are all refused, and nothing is written', async () => {
    const vectors = [
        ['..', 'a bare parent reference'],
        ['sub/../../..', 'a traversal that goes through a real sub-folder first'],
        ['sub/..', 'a single level back out of a real sub-folder'],
        ['.secret', 'a hidden segment'],
        ['sub/.hidden', 'a hidden segment after a real one'],
        ['sub\0.txt', 'a NUL byte'],
    ];

    // What each of these pins, and what it does NOT pin - established by
    // mutation, not assumed:
    //
    //   '..' / 'sub/../../..'  would also be refused by the lexical safeSubPath()
    //                          check alone.
    //   'sub/..'               is ALSO caught by hasHiddenSegment(), because a
    //                          '..' segment starts with '.'. hasDotSegment() is
    //                          therefore redundant here - removing it does not
    //                          turn this test red. That is what redundant
    //                          defence in depth looks like; it is reported, not
    //                          quietly relied on.
    //   'sub\0.txt'           would ALSO be refused, by the realpath() throwing
    //                          on a NUL and the catch-all answering NOT_FOUND.
    //                          So this asserts no 500 and a uniform 404, which is
    //                          what the resolver's comment actually promises.
    //   '.secret' / 'sub/.hidden' are caught by hasHiddenSegment() alone, and
    //                          removing it DOES turn this test red.
    //
    // The symlink case in the test above is the one that isolates a single guard
    // (the realpath containment check) and goes red without it.
    const outsideBefore = walk(outsideDir).sort();
    const rootBefore = walk(folderPath).sort();

    for (const [i, [subpath, what]] of vectors.entries()) {
        const res = await upload(folderId, { subpath, filename: `vector-${i}.txt` });
        await assertBadDestination(res, `upload with ${what} in subpath`);
    }

    assert.deepEqual(walk(folderPath).sort(), rootBefore,
        'a refused upload still created a file inside the folder root');
    assert.deepEqual(walk(outsideDir).sort(), outsideBefore,
        'a refused upload still wrote outside the folder root');
    assert.ok(!/\0/.test([...walk(folderPath)].join('\n')),
        'a NUL byte reached a path on disk');
});

test('a normal upload still works, into the root and into a real sub-folder', async () => {
    const rootRes = await upload(folderId, { filename: 'plain.txt', subpath: '', bytes: INSIDE_BYTES });
    const rootBody = await bodyText(rootRes);
    assert.equal(rootRes.status, 200, `plain upload: ${rootRes.status} - ${rootBody.slice(0, 200)}`);
    assert.deepEqual(JSON.parse(rootBody), { success: true, name: 'plain.txt' });
    assert.deepEqual(fs.readFileSync(path.join(folderPath, 'plain.txt')), INSIDE_BYTES,
        'the bytes on disk are not what was sent');

    const subRes = await upload(folderId, { filename: 'nested-upload.txt', subpath: 'sub', bytes: INSIDE_BYTES });
    const subBody = await bodyText(subRes);
    assert.equal(subRes.status, 200, `sub-folder upload: ${subRes.status} - ${subBody.slice(0, 200)}`);
    assert.deepEqual(JSON.parse(subBody), { success: true, name: 'nested-upload.txt' });
    assert.deepEqual(fs.readFileSync(path.join(folderPath, 'sub', 'nested-upload.txt')), INSIDE_BYTES);

    // And the write is durable: the read path must serve it back.
    const dl = await rawGet(owner.token, `/api/files/download/${folderId}${q('sub', 'nested-upload.txt')}`);
    assert.equal(dl.status, 200, `download of the freshly uploaded file: ${dl.status}`);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), INSIDE_BYTES);

    fs.rmSync(path.join(folderPath, 'plain.txt'), { force: true });
    fs.rmSync(path.join(folderPath, 'sub', 'nested-upload.txt'), { force: true });
});

test('a directory part in the upload file name is stripped, and a hidden file name is refused', async () => {
    const res = await upload(folderId, { filename: '../../escaped.txt', subpath: '' });
    const body = await bodyText(res);
    assert.equal(res.status, 200, `upload with a directory part: ${res.status} - ${body.slice(0, 200)}`);

    // basename() must reduce it to a single segment, whatever the transport did
    // to the name on the way in. Either way the assertion is the same fact:
    // it landed directly in the folder root.
    assert.deepEqual(JSON.parse(body), { success: true, name: 'escaped.txt' });
    assert.ok(fs.existsSync(path.join(folderPath, 'escaped.txt')),
        'the upload did not land in the folder root');
    assert.ok(!fs.existsSync(path.join(path.dirname(folderPath), 'escaped.txt')),
        'the directory part of the file name was honoured instead of stripped');

    fs.rmSync(path.join(folderPath, 'escaped.txt'), { force: true });

    const hidden = await upload(folderId, { filename: '.hidden.txt', subpath: '' });
    const hiddenBody = await bodyText(hidden);
    assert.equal(hidden.status, 400, `a dot-prefixed file name must be 400, got ${hidden.status}`);
    assert.equal(hiddenBody, JSON.stringify({ error: 'Invalid file name' }));
    assert.ok(!fs.existsSync(path.join(folderPath, '.hidden.txt')),
        'a dot-prefixed upload was written to disk anyway');
});
