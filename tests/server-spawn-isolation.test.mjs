// tests/server-spawn-isolation.test.mjs
//
// THE PROBLEM THIS EXISTS FOR
//
// The app's default upload dirs are relative, so a server booted without them
// redirected creates them in the CURRENT WORKING DIRECTORY. `npm test` runs from
// the repo root, so every such spawn left empty avatars/, banners/,
// chat-uploads/, dm-uploads/, group-uploads/ (and user-data/) in the repo root on
// every full run - on Linux as well as Windows.
//
// Six files spawn server.js. They each remembered a DIFFERENT subset of the
// redirect vars:
//
//   _acceptance-harness.mjs                    all eight  (the reference)
//   dm-csp-handlers-enforced-browser.test.mjs  six        missing GROUP_UPLOAD_DIR, BANNER_DIR
//   credentials/_server.mjs                    two        missing all five upload dirs + TMPDIR
//   credentials/f12-boot-legacy.test.mjs       three      missing all five upload dirs
//   credentials/f12-setup-seed.test.mjs        three      missing all five upload dirs
//   groups/group-hardening-f6-server-pruner    three      missing all five upload dirs
//
// It surfaced as a FAILURE, not as untidiness:
// tests/acceptance-no-plaintext.test.mjs scans the work dir to prove the server
// persisted nothing readable, and its control test asserts the repo root gained
// no new entries. A sibling spawn writing into the repo root fails that control.
// That assertion is NOT changed here; this file makes the cause go away and stops
// it coming back.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    ROOT,
    SERVER_DIR_VARS,
    makeServerDirs,
    serverEnv,
    startRealServer,
} from './_acceptance-harness.mjs';

let server = null;
after(async () => {
    if (server) await server.stop().catch(() => {});
});

/** Recursively list tests/, as repo-relative POSIX paths. */
function testFiles(dir = path.join(ROOT, 'tests'), out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) testFiles(p, out);
        else if (entry.name.endsWith('.mjs')) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
    return out;
}

/* =========================================================
 * 1. The helper always sets all eight, and never points one at the repo root
 * ========================================================= */

test('serverEnv() sets every redirect var, and each points inside the work dir', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-iso-'));
    try {
        const dirs = makeServerDirs(work);
        const env = serverEnv({ dirs, port: 4600 });

        for (const name of SERVER_DIR_VARS) {
            assert.ok(env[name], `${name} must be set by serverEnv()`);

            const value = path.resolve(env[name]);
            assert.ok(
                value.startsWith(path.resolve(work) + path.sep),
                `${name} points outside the work dir: ${value} (work dir is ${path.resolve(work)})`
            );
        }

        // The specific failure mode, named: any of these equal to the repo root
        // means the server will mkdir inside the repo.
        for (const name of SERVER_DIR_VARS) {
            assert.notEqual(
                path.resolve(env[name]).split(path.sep).slice(-1)[0], path.basename(path.resolve(work)),
                `${name} resolves back to the work dir's own name - redirection is a no-op`
            );
        }

        assert.equal(env.USER_DATA_ROOT, path.join(work, 'user-data'));
        assert.equal(env.AVATAR_DIR, path.join(work, 'avatars'));
        assert.equal(env.BANNER_DIR, path.join(work, 'banners'));
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

test('serverEnv() refuses to build an env without dirs or a port', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-iso-'));
    try {
        const dirs = makeServerDirs(work);
        assert.throws(() => serverEnv({ port: 4600 }), /dirs is required/);
        assert.throws(() => serverEnv({ dirs }), /port is required/);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

/* =========================================================
 * 2. No file spawns server.js without going through the helper
 *
 * This is the check that catches a NEW spawn site forgetting the vars, which is
 * the whole regression. It is a source scan rather than a runtime observation
 * because the pollution comes from OTHER files running concurrently - a runtime
 * check inside one file cannot see it.
 * ========================================================= */

test('every spawn of server.js gets a serverEnv()-built env, one for one', () => {
    const HARNESS = 'tests/_acceptance-harness.mjs';
    const RAW_SPAWN = /spawn(?:Sync)?\s*\(\s*process\.execPath\s*,\s*\[\s*['"]server\.js['"]/g;

    const offenders = [];
    const detail = [];
    let totalSpawns = 0;

    for (const rel of testFiles()) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

        const spawns = (src.match(RAW_SPAWN) || []).length;
        if (spawns === 0) continue;
        totalSpawns += spawns;

        // Count CALLS, not textual occurrences: the helper's own declaration
        // reads `serverEnv({` too.
        const calls = (src.match(/serverEnv\(\s*\{/g) || []).length
            - (src.match(/function\s+serverEnv\s*\(/g) || []).length;

        detail.push(`    ${rel}: ${spawns} spawn(s), ${calls} serverEnv() call(s)`);

        // The rule is ONE env per spawn. A weaker "does this file call serverEnv
        // somewhere" check passes a file that legitimately uses the helper and
        // then adds a SECOND spawn that bypasses it - which is exactly the bug
        // this file was written for, and it stayed green the first time.
        if (spawns > calls) {
            offenders.push(
                `${rel}: ${spawns} spawn(s) of server.js but only ${calls} serverEnv() ` +
                `call(s) - at least one spawn builds its env inline and will ` +
                `create upload dirs in the repo root`
            );
        }

        if (rel === HARNESS) continue;
        for (const name of SERVER_DIR_VARS) {
            if (!src.includes(name) && rel !== HARNESS) {
                // Fine: the names live in the helper now. Nothing to assert per
                // file; the helper test below covers them once.
            }
        }
    }

    assert.deepEqual(offenders, [],
        `these spawns would create upload dirs in the repo root:\n  ${offenders.join('\n  ')}\n` +
        `counts:\n${detail.join('\n')}`);

    // Guard against passing vacuously by matching no spawns at all.
    assert.ok(totalSpawns >= 6,
        `expected to find the known spawn sites, matched only ${totalSpawns}: ${JSON.stringify(detail)}`);

    // The helper must mention all eight, or the rule above protects nothing.
    const harness = fs.readFileSync(path.join(ROOT, HARNESS), 'utf8');
    for (const name of SERVER_DIR_VARS) {
        assert.ok(harness.includes(name), `_acceptance-harness.mjs must mention ${name}`);
    }
    assert.match(harness, /const env = serverEnv\(\{/,
        'the harness must build its own env with serverEnv({ ... })');
});

test('every spawn-site file builds its env with serverEnv()', () => {
    // The complementary check: the files that legitimately start a server must
    // all go through the helper, so a refactor that inlines an env again is
    // caught even if the raw spawn is added later.
    const expect = [
        'tests/_acceptance-harness.mjs',
        'tests/credentials/_server.mjs',
        'tests/credentials/f12-boot-legacy.test.mjs',
        'tests/credentials/f12-setup-seed.test.mjs',
        'tests/groups/group-hardening-f6-server-pruner.test.mjs',
        'tests/dm-csp-handlers-enforced-browser.test.mjs'
    ];

    const missing = [];
    for (const rel of expect) {
        const full = path.join(ROOT, rel);
        if (!fs.existsSync(full)) { missing.push(`${rel}: file is gone, re-check this list`); continue; }
        const src = fs.readFileSync(full, 'utf8');
        if (!/serverEnv\(\s*\{/.test(src)) missing.push(`${rel}: does not call serverEnv({ ... })`);
    }

    assert.deepEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});

test('no test file names a repo-root upload dir directly', () => {
    // A belt-and-braces scan: even if someone bypasses the helper, a literal
    // repo-root path here is the smell.
    const bad = [];
    for (const rel of testFiles()) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const dir of ['avatars', 'banners', 'chat-uploads', 'dm-uploads', 'group-uploads', 'user-data']) {
            if (new RegExp(`['"\`]\\./?${dir}['"\`]`).test(src)) {
                bad.push(`${rel}: contains a literal './${dir}'`);
            }
        }
    }
    assert.deepEqual(bad, [], `\n  ${bad.join('\n  ')}`);
});

/* =========================================================
 * 3. The real thing: a server booted through the helper leaves the root alone
 * ========================================================= */

test('a real server booted through the helper adds nothing to the repo root', async () => {
    server = await startRealServer();

    // Touch the endpoints whose storage would land in those dirs, so the dirs
    // are actually created if they are going to be created at all.
    const res = await fetch(`${server.origin}/api/version`);
    assert.ok(res.ok, `the server must be up: ${res.status}`);

    // Upload dirs are created lazily by multer's destination callback, so also
    // drive one upload attempt to force the mkdir.
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('isolation probe\n')]), 'probe.txt');
    await fetch(`${server.origin}/api/dm/upload/1`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-real-token' },
        body: form,
    }).catch(() => {});

    assert.deepEqual(server.strayRootEntries(), [],
        'a server booted through the harness must not create anything in the repo root');
});

test('the helper exposes every redirect var on the server handle', async () => {
    if (!server) server = await startRealServer();
    const files = fs.readdirSync(server.work).sort();
    for (const expected of ['avatars', 'banners', 'chat-uploads', 'dm-uploads', 'group-uploads', 'user-data']) {
        assert.ok(files.includes(expected),
            `the work dir must contain ${expected}; saw ${JSON.stringify(files)}`);
    }
});