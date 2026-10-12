// tests/sw-manifest.test.mjs
//
// public/sw-manifest.js holds a SHA-256 of the RAW BYTES of every shell file
// (scripts/build-sw-manifest.mjs). public/sw.js re-hashes what the server sends on install and
// throws on the first mismatch, so ONE differing byte in ONE file fails the whole install.
// Consequence: the manifest is only valid for byte-identical files. A stale manifest (rebuilt
// from older files) or a checkout that rewrites line endings (CRLF <-> LF) both break it.
//
// What is checked (builtins only; no node_modules, no browser):
//   1. the shipped manifest is current            (`--check` exits 0)           [stale manifest]
//   2. `--check` really fails when it should      (changed byte / flipped EOLs / missing file)
//   3. the LF policy holds                        (.gitattributes + no CR in hashed text files)
//   4. the REAL sw.js install path, executed in a vm with stubbed caches/fetch:
//        - succeeds when served bytes match the manifest
//        - rejects (and never calls skipWaiting) when any served file's bytes differ,
//          including the exact "same file, other line endings" case
//
// Limits: step 4 runs sw.js's own code, not a browser. Update/activation scheduling in
// Chromium is not covered.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, runSwInstall } from './_sw-install-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const BUILD = path.join(ROOT, 'scripts', 'build-sw-manifest.mjs');
const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.svg']); // text subset of the script's INCLUDE_EXT

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Fresh copy of public/ that a test may mutate freely. */
function copyPublic() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-sw-'));
    tmpDirs.push(dir);
    const dest = path.join(dir, 'public');
    fs.cpSync(PUBLIC, dest, { recursive: true });
    return dest;
}

function runCheck(dir) {
    const r = spawnSync(process.execPath, [BUILD, '--check', '--dir', dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The same bytes with the opposite line-ending convention. */
function flipEol(buf) {
    const s = buf.toString('latin1');
    return Buffer.from(s.includes('\r\n') ? s.replace(/\r\n/g, '\n') : s.replace(/\n/g, '\r\n'), 'latin1');
}

// ---------------------------------------------------------------------------------------- 1
test('SW-1: the shipped sw-manifest.js is current for public/', () => {
    const r = runCheck(PUBLIC);
    assert.equal(r.status, 0, `${r.out}\nRegenerate with: node scripts/build-sw-manifest.mjs`);
});

// ---------------------------------------------------------------------------------------- 2
test('SW-2a: --check passes on an untouched copy, fails when one shell file changes by one byte', () => {
    const dir = copyPublic();
    assert.equal(runCheck(dir).status, 0, 'precondition: untouched copy must pass');
    fs.appendFileSync(path.join(dir, 'index.html'), ' ');
    const r = runCheck(dir);
    assert.equal(r.status, 1);
    assert.match(r.out, /out of date/);
});

test('SW-2b: --check fails when a shell file only changes line endings (CRLF <-> LF)', () => {
    const dir = copyPublic();
    const file = path.join(dir, 'index.html');
    fs.writeFileSync(file, flipEol(fs.readFileSync(file)));
    const r = runCheck(dir);
    assert.equal(r.status, 1, 'hashes are over raw bytes, so an EOL-only change must be detected');
    assert.match(r.out, /out of date/);
});

test('SW-2c: --check fails when sw-manifest.js itself had its line endings rewritten', () => {
    // An autocrlf checkout rewrites the manifest too; --check compares text exactly.
    const dir = copyPublic();
    const file = path.join(dir, 'sw-manifest.js');
    const orig = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.from(orig.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1'));
    assert.equal(runCheck(dir).status, 1);
});

test('SW-2d: --check fails when sw-manifest.js is missing', () => {
    const dir = copyPublic();
    fs.rmSync(path.join(dir, 'sw-manifest.js'));
    assert.equal(runCheck(dir).status, 1);
});

// ---------------------------------------------------------------------------------------- 3
test('SW-3a: .gitattributes enforces LF checkout on every platform', () => {
    const file = path.join(ROOT, '.gitattributes');
    assert.ok(fs.existsSync(file), '.gitattributes is missing');
    assert.match(fs.readFileSync(file, 'utf8'), /^\*\s+text=auto\s+eol=lf\s*$/m);
});

test('SW-3b: every text file listed in the manifest is LF on disk (no CR bytes)', () => {
    const offenders = readManifest(PUBLIC).files
        .filter(({ url }) => TEXT_EXT.has(path.extname(url).toLowerCase()))
        .filter(({ url }) => fs.readFileSync(path.join(PUBLIC, url)).includes(0x0d))
        .map(({ url }) => url);
    assert.deepEqual(
        offenders, [],
        `${offenders.length} manifest file(s) contain CR. Their hash only matches a CRLF checkout.\n` +
        `First: ${offenders.slice(0, 8).join(', ')}\n` +
        'Fix: git add --renormalize . (with .gitattributes in place), re-checkout, then node scripts/build-sw-manifest.mjs',
    );
});

// ---------------------------------------------------------------------------------------- 4
test('SW-4a: real sw.js install succeeds when the served bytes match the manifest', async () => {
    const dir = copyPublic();
    const { error, skipWaitingCalled, cachedCount } = await runSwInstall(dir);
    assert.equal(error, null, error && error.message);
    assert.equal(skipWaitingCalled, true);
    assert.equal(cachedCount, readManifest(dir).files.length);
});

test('SW-4b: real sw.js install is rejected when one served file has different line endings', async () => {
    const dir = copyPublic();
    const target = readManifest(dir).files.map((f) => f.url).find((u) => TEXT_EXT.has(path.extname(u)));
    const served = flipEol(fs.readFileSync(path.join(dir, target)));
    const { error, skipWaitingCalled } = await runSwInstall(dir, { [target]: served });
    assert.ok(error, 'install must reject');
    assert.match(error.message, /content does not match manifest/);
    assert.ok(error.message.includes('precache '), 'error should name the failing url');
    assert.equal(skipWaitingCalled, false, 'a failed install must never activate');
});

test('SW-4c: real sw.js install is rejected when a listed file is missing from the server', async () => {
    const dir = copyPublic();
    const target = readManifest(dir).files[0].url;
    fs.rmSync(path.join(dir, target));
    const { error, skipWaitingCalled } = await runSwInstall(dir);
    assert.ok(error);
    assert.match(error.message, /HTTP 404/);
    assert.equal(skipWaitingCalled, false);
});
