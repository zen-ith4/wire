// tests/safe-path-vectors.test.mjs
//
// Unit tests for the path layer, with no server and no browser, so they run
// anywhere `node --test` runs.
//
// Three functions, three jobs:
//
//   safeSubPath()            purely LEXICAL. path.resolve, then a prefix test.
//                            That is all it has ever been, and it is all it
//                            can be: it never touches the filesystem, so it
//                            cannot see a symlink and cannot see a NUL byte.
//                            The VECTORS table below pins down exactly what it
//                            does and does not promise.
//
//   resolveRegularFile()     strict, for endpoints that serve bytes.
//   resolveRegularDirectory() strict, for endpoints that list or write.
//
// The last two are what files.controller.js actually calls. They are tested
// here against a real temp tree, and end-to-end over HTTP in
// files-path-traversal.test.mjs; this file is the fast one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// resolve* now re-check the sharing policy on every read, so the temp dirs
// these vectors build must count as an allowed root. Set before first require.
process.env.ALLOWED_FOLDER_ROOTS = os.tmpdir();

const {
    safeSubPath,
    resolveRegularFile,
    resolveRegularDirectory,
    resolveDeletableEntry,
    hasHiddenSegment,
    hasDotSegment,
    splitRelPath,
} = require('../utils/safePath.js');

const IS_WIN = process.platform === 'win32';

// --------------------------------------------------------------- lexical layer

/**
 * `expected` is relative to a root the test controls:
 *   null  - safeSubPath must refuse
 *   ''    - the result must be the root itself
 *   str   - the result must be the root joined with str (posix-spelled)
 *
 * `note` says WHY, which is the part worth keeping. Several of these are
 * platform-dependent on purpose: a backslash is a separator on win32 and an
 * ordinary character in a file name on POSIX, and a vector that quietly
 * "passed" on both would be proving nothing.
 */
const VECTORS = [
    // ---- must escape the root ------------------------------------------------
    { in: '..', out: null, note: 'the parent itself' },
    { in: '../x', out: null, note: 'one level up' },
    { in: '../../x', out: null, note: 'two levels up' },
    { in: 'a/../../x', out: null, note: 'up out of a sub-folder and out of the root' },
    { in: 'a/b/../../../x', out: null, note: 'deeper tree, same escape' },
    { in: './../x', out: null, note: 'a "." segment must not launder the ".."' },
    { in: 'a/./../../b', out: null, note: '"." mixed into the escape' },
    { in: '../../../../../../../../etc/passwd', out: null, note: 'many levels up, still refused' },
    { in: '/etc/passwd', out: null, note: 'absolute POSIX path' },
    { in: '/', out: null, note: 'the filesystem root' },
    { in: 'sub/../..', out: null, note: 'resolves exactly to the parent' },
    { in: '..%2f..%2fx', out: '..%2f..%2fx', note: 'percent-encoded separators are NOT decoded here, so this is one ordinary file name - decoding is the HTTP layer\'s job and it does decode it' },

    // ---- must stay inside ----------------------------------------------------
    { in: '', out: '', note: 'the root itself' },
    { in: 'file.txt', out: 'file.txt', note: 'an ordinary name' },
    { in: 'a', out: 'a', note: 'one segment' },
    { in: 'a/b', out: 'a/b', note: 'two segments' },
    { in: 'a/b/c.txt', out: 'a/b/c.txt', note: 'three segments' },
    { in: 'a/./b', out: 'a/b', note: 'a "." segment that stays inside is harmless' },
    { in: 'sub/..', out: '', note: 'round-trips back to the root' },
    { in: 'a//b', out: 'a/b', note: 'an empty segment collapses' },
    { in: '.hidden', out: '.hidden', note: 'safeSubPath does NOT reject dotfiles - see the note below' },
    { in: 'file with spaces.txt', out: 'file with spaces.txt', note: 'spaces are ordinary' },
    { in: 'ünïcødé.txt', out: 'ünïcødé.txt', note: 'non-ASCII names are ordinary' },
    { in: "-';--", out: "-';--", note: 'shell-ish characters are just characters to path.resolve' },

    // ---- platform-dependent, asserted only where they mean something -------
    { in: 'a\\..\\..\\x', out: null, onlyIf: IS_WIN, note: 'backslash is a separator on win32, so this escapes' },
    { in: 'a\\..\\..\\x', out: 'a\\..\\..\\x', onlyIf: !IS_WIN, note: 'on POSIX the same string is a single odd file name and stays inside' },
    { in: 'C:\\Windows\\win.ini', out: null, onlyIf: IS_WIN, note: 'drive-absolute on win32' },
    { in: 'C:\\Windows\\win.ini', out: 'C:\\Windows\\win.ini', onlyIf: !IS_WIN, note: 'on POSIX "C:" is a directory name, not a drive' },
];

test('safeSubPath: every lexical vector resolves to exactly what it claims', () => {
    const base = path.resolve(os.tmpdir(), 'wire-safe-base');
    let ran = 0;

    for (const v of VECTORS) {
        // `onlyIf` is evaluated at module load on the RUNNING platform, so it
        // already means "this vector applies here" - do not compare it to IS_WIN
        // again. That second test inverts the pair on Linux, where it ran the two
        // win32-only vectors and skipped the two POSIX ones.
        if (v.onlyIf === false) continue;
        ran++;

        const got = safeSubPath(base, v.in);
        const label = `safeSubPath(${JSON.stringify(v.in)}) - ${v.note}`;

        if (v.out === null) {
            assert.equal(got, null, `${label}: expected a refusal, got ${got}`);
        } else {
            assert.notEqual(got, null, `${label}: expected a path, got a refusal`);
            assert.equal(
                path.relative(base, got).split(path.sep).join('/'),
                v.out,
                `${label}: resolved somewhere unexpected`
            );
        }
    }

    // The table is the deliverable; if it silently shrinks, the coverage shrinks
    // with it and nobody notices. A filter that skips too much must fail here
    // too, which is the whole point: the broken filter still ran 26 vectors, so
    // a count check alone would not have caught it.
    assert.ok(ran > 20, `only ${ran} vectors ran on ${process.platform}; the platform filter skipped too much`);
});

test('safeSubPath: a NUL byte passes straight through - this is why the resolvers exist', () => {
    const base = path.resolve(os.tmpdir(), 'wire-safe-base');
    const got = safeSubPath(base, 'a\0b');

    // Not an escape - it stays lexically inside. But the resulting string is not
    // a usable path: every fs call on it throws ERR_INVALID_ARG_VALUE, which is
    // how a NUL in a query parameter turned a 404 into a 500 before
    // resolveRegularFile / resolveRegularDirectory existed. Asserting it here
    // means nobody "simplifies" safeSubPath into believing it validates.
    assert.equal(got, path.join(base, 'a\0b'));
    assert.throws(() => fs.statSync(got), /null byte|ERR_INVALID_ARG_VALUE/i);
});

test('hasHiddenSegment / hasDotSegment cover the three separator spellings', () => {
    for (const v of ['.env', 'a/.env/b', 'a\\.env', '.a']) {
        assert.equal(hasHiddenSegment(v), true, `${JSON.stringify(v)} is hidden`);
    }
    for (const v of ['', 'a', 'a.b', 'a/b/c']) {
        assert.equal(hasHiddenSegment(v), false, `${JSON.stringify(v)} is not hidden`);
    }
    for (const v of ['.', '..', 'a/../b', 'a\\..']) {
        assert.equal(hasDotSegment(v), true, `${JSON.stringify(v)} has a dot segment`);
    }
    for (const v of ['', 'a', 'a/b', '...', 'a..b']) {
        assert.equal(hasDotSegment(v), false, `${JSON.stringify(v)} has no dot segment`);
    }
});

test('splitRelPath round-trips through resolveRegularFile', () => {
    assert.deepEqual(splitRelPath('a/b/c.txt'), { subpath: 'a/b', file: 'c.txt' });
    assert.deepEqual(splitRelPath('c.txt'), { subpath: '', file: 'c.txt' });
});

// -------------------------------------------------------------- strict layer

function makeTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-safepath-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-safetree-'));

    fs.writeFileSync(path.join(root, 'inside.txt'), 'inside');
    fs.writeFileSync(path.join(root, '.env'), 'hidden');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'nested.txt'), 'nested');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');

    let links = true;
    try {
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'), 'file');
        fs.symlinkSync(outside, path.join(root, 'out'), 'dir');
        fs.symlinkSync(path.join(root, 'inside.txt'), path.join(root, 'alias.txt'), 'file');
    } catch {
        links = false; // unprivileged win32; the callers skip these too
    }

    return {
        root,
        outside,
        links,
        cleanup: () => {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        },
    };
}

const REJECTED = [
    { subpath: '', file: '.env', why: 'dotfile' },
    { subpath: '.hidden', file: 'x', why: 'hidden segment' },
    { subpath: '', file: 'a\0b', why: 'NUL in file' },
    { subpath: 'a\0b', file: 'x', why: 'NUL in subpath' },
    { subpath: '', file: '.', why: '"." as the file' },
    { subpath: '', file: '..', why: '".." as the file' },
    { subpath: '.', file: 'inside.txt', why: '"." as the subpath' },
    { subpath: '..', file: 'inside.txt', why: '".." as the subpath' },
    { subpath: 'a/../../x', file: 'inside.txt', why: 'traversal' },
    { subpath: '', file: 'sub/nested.txt', why: 'separator in the file name' },
    { subpath: '', file: '..\\inside.txt', why: 'backslash in the file name' },
    { subpath: '', file: 'sub', why: 'a directory where a file is expected' },
    { subpath: 'inside.txt', file: 'inside.txt', why: 'a file where a directory is expected' },
    { subpath: 'missing', file: 'inside.txt', why: 'a directory that does not exist' },
    { subpath: '', file: '', why: 'an empty file name' },
];

for (const v of REJECTED) {
    test(`resolveRegularFile refuses: ${v.why}`, async () => {
        const tree = makeTree();
        try {
            assert.deepEqual(
                await resolveRegularFile(tree.root, v.subpath, v.file),
                { ok: false },
                `expected a refusal for ${JSON.stringify(v)}`
            );
        } finally {
            tree.cleanup();
        }
    });
}

test('resolveRegularFile accepts an ordinary file, inside or in a sub-folder', async () => {
    const tree = makeTree();
    try {
        const top = await resolveRegularFile(tree.root, '', 'inside.txt');
        assert.equal(top.ok, true);
        assert.equal(top.name, 'inside.txt');
        assert.equal(top.relPath, 'inside.txt');
        assert.equal(top.size, 'inside'.length);

        const nested = await resolveRegularFile(tree.root, 'sub', 'nested.txt');
        assert.equal(nested.ok, true);
        assert.equal(nested.relPath, 'sub/nested.txt');
        assert.equal(fs.readFileSync(nested.fullPath, 'utf8'), 'nested');
    } finally {
        tree.cleanup();
    }
});

test('resolveRegularDirectory accepts the root and a real sub-folder only', async () => {
    const tree = makeTree();
    try {
        const root = await resolveRegularDirectory(tree.root, '');
        assert.equal(root.ok, true);
        assert.equal(root.fullPath, fs.realpathSync(tree.root));

        const sub = await resolveRegularDirectory(tree.root, 'sub');
        assert.equal(sub.ok, true);
        assert.equal(sub.relPath, 'sub');
        assert.equal(fs.realpathSync(sub.fullPath), fs.realpathSync(path.join(tree.root, 'sub')));

        for (const bad of ['.', '..', 'a/../../x', 'a\0b', '.hidden', 'inside.txt', 'missing']) {
            assert.deepEqual(
                await resolveRegularDirectory(tree.root, bad),
                { ok: false },
                `expected a refusal for subpath ${JSON.stringify(bad)}`
            );
        }
    } finally {
        tree.cleanup();
    }
});

test('resolveDeletableEntry reports a symlink as a link, never its target', async () => {
    const tree = makeTree();
    try {
        const target = await resolveDeletableEntry(tree.root, '', 'inside.txt');
        assert.equal(target.type, 'file');

        const dir = await resolveDeletableEntry(tree.root, '', 'sub');
        assert.equal(dir.type, 'dir');

        if (!tree.links) return; // unprivileged win32; nothing to assert

        const link = await resolveDeletableEntry(tree.root, '', 'leak.txt');
        assert.equal(link.type, 'link', 'a symlink must be deletable as a link');
        assert.equal(link.fullPath, path.join(fs.realpathSync(tree.root), 'leak.txt'));
    } finally {
        tree.cleanup();
    }
});

test('a symlink out of the root is refused by both resolvers, an internal one is not', async (t) => {
    const tree = makeTree();
    try {
        if (!tree.links) {
            t.skip(`symlinks unavailable on ${process.platform}; unprivileged process cannot create them`);
            return;
        }

        for (const name of ['leak.txt', 'alias.txt']) {
            const r = await resolveRegularFile(tree.root, '', name);
            assert.equal(r.ok, name === 'alias.txt', `${name}: containment is the rule, not "no links"`);
        }

        const outDir = await resolveRegularDirectory(tree.root, 'out');
        assert.deepEqual(outDir, { ok: false }, 'a directory symlink out of the root must be refused');

        // The same target, reached without a symlink, is fine - so it is the
        // link and not the path that is being judged.
        const real = await resolveRegularDirectory(tree.root, 'sub');
        assert.equal(real.ok, true);
    } finally {
        tree.cleanup();
    }
});

test('every rejection is the same frozen value, so no caller can branch on the reason', () => {
    const tree = makeTree();
    return (async () => {
        try {
            const a = await resolveRegularFile(tree.root, '..', 'x');
            const b = await resolveRegularFile(tree.root, '', '.env');
            assert.equal(a, b, 'two different rejections must be indistinguishable to the caller');
            assert.deepEqual(Object.keys(a), ['ok']);
        } finally {
            tree.cleanup();
        }
    })();
});