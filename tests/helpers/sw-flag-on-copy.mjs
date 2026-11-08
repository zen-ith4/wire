// tests/helpers/sw-flag-on-copy.mjs (helper, not a test)
//
// C5 needs a worker with MEDIA_STREAM_ENABLED = true, but the REPOSITORY must
// keep false for the whole task. This helper therefore copies the public tree
// into a temporary directory, flips exactly that one line IN THE COPY, proves
// the copy differs from the original by exactly one line, and regenerates the
// copy's SW manifest (the worker verifies every precached file's hash at
// install time, so a changed sw.js alone does not invalidate it, but the
// manifest is still rebuilt through the repo's own script to keep the copy
// self-consistent).
//
// The repository is never written to. `assertRepoFlagOff()` re-reads the
// repository's public/sw.js after every copy and throws if the flag changed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PUBLIC = path.join(ROOT, 'public');
export const MANIFEST_BUILD = path.join(ROOT, 'scripts', 'build-sw-manifest.mjs');

export const FLAG_LINE_OFF = 'const MEDIA_STREAM_ENABLED = false;';
export const FLAG_LINE_ON = 'const MEDIA_STREAM_ENABLED = true;';

/** Number of whole lines exactly equal to `line` (not substrings). */
export function countExactLine(source, line) {
    return source.split('\n').filter((candidate) => candidate === line).length;
}

/** Throws unless the repository's worker still has the flag OFF exactly once. */
export function assertRepoFlagOff() {
    const repoSw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
    assert.equal(
        countExactLine(repoSw, FLAG_LINE_OFF),
        1,
        `the repository's public/sw.js must contain exactly one "${FLAG_LINE_OFF}"`
    );
    assert.equal(
        countExactLine(repoSw, FLAG_LINE_ON),
        0,
        'the repository must never contain the flag ON'
    );
}

/**
 * Replaces the one flag line and asserts the ONLY difference between the two
 * texts is that line. Returns the one-line diff as text for the test log.
 */
export function flipFlagLine(original) {
    const offCount = countExactLine(original, FLAG_LINE_OFF);
    if (offCount !== 1) {
        throw new Error(`expected exactly one "${FLAG_LINE_OFF}" line, found ${offCount}`);
    }

    const before = original.split('\n');
    const after = [...before];
    const index = after.indexOf(FLAG_LINE_OFF);
    after[index] = FLAG_LINE_ON;
    const changed = after.join('\n');

    // The diff must be exactly one line: same line count, exactly one index
    // differs, and the two values are exactly OFF and ON.
    assert.equal(after.length, before.length, 'the copy must not add or remove lines');
    const differing = [];
    for (let i = 0; i < before.length; i += 1) {
        if (before[i] !== after[i]) differing.push(i);
    }
    assert.deepEqual(differing, [index], 'exactly one line may differ from the original');
    assert.equal(before[index], FLAG_LINE_OFF);
    assert.equal(after[index], FLAG_LINE_ON);

    return {
        text: changed,
        lineNumber: index + 1,
        diffLine: `${index + 1}: -${FLAG_LINE_OFF} +${FLAG_LINE_ON}`,
    };
}

/** Regenerate a copy's SW manifest through the repository's own build script. */
export function regenerateCopyManifest(publicDir) {
    const run = spawnSync(process.execPath, [MANIFEST_BUILD, '--dir', publicDir], {
        encoding: 'utf8',
    });
    if (run.status !== 0) {
        throw new Error(`build-sw-manifest failed for ${publicDir}: ${run.stderr || run.stdout}`);
    }
    return run.stdout.trim();
}

/**
 * Create the flag-ON copy.
 *
 * `C5_PUBLIC_DIR` lets the plant runs reuse a copy they have already mutated;
 * the helper then only validates it and does not clean it up.
 *
 * @param {{ log?: (line: string) => void, fresh?: boolean }} [options]
 *   fresh: ignore C5_PUBLIC_DIR and always build a new copy (test 10 mutates its copy).
 * @returns {{ dir: string, publicDir: string, diffLine: string, created: boolean, cleanup: () => void }}
 */
export function createFlagOnPublicCopy({ log = (line) => console.log(`# ${line}`), fresh = false } = {}) {
    const supplied = fresh ? null : process.env.C5_PUBLIC_DIR;
    if (supplied) {
        const publicDir = path.resolve(supplied);
        const swPath = path.join(publicDir, 'sw.js');
        const sw = fs.readFileSync(swPath, 'utf8');
        assert.equal(
            countExactLine(sw, FLAG_LINE_ON),
            1,
            `C5_PUBLIC_DIR=${publicDir} must contain exactly one "${FLAG_LINE_ON}"`
        );
        assert.equal(countExactLine(sw, FLAG_LINE_OFF), 0);
        log(`using prebuilt flag-ON public copy: ${publicDir}`);
        return { dir: publicDir, publicDir, diffLine: '(prebuilt copy)', created: false, cleanup: () => {} };
    }

    assertRepoFlagOff();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-c5-flag-on-'));
    const publicDir = path.join(dir, 'public');
    fs.cpSync(PUBLIC, publicDir, { recursive: true });

    const swPath = path.join(publicDir, 'sw.js');
    const original = fs.readFileSync(swPath, 'utf8');
    const flipped = flipFlagLine(original);
    fs.writeFileSync(swPath, flipped.text);

    // The copy differs from the repository by exactly that one line.
    const repoSw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
    const copySw = fs.readFileSync(swPath, 'utf8');
    assert.equal(
        copySw,
        repoSw.replace(FLAG_LINE_OFF, FLAG_LINE_ON),
        'the copy may differ from the repository only in the flag line'
    );

    const manifestLine = regenerateCopyManifest(publicDir);

    // And the repository itself is still OFF after all the copying.
    assertRepoFlagOff();

    log(`flag ON copy: ${publicDir}`);
    log(`one-line diff (copy vs repo public/sw.js): ${flipped.diffLine}`);
    log(manifestLine);

    return {
        dir,
        publicDir,
        diffLine: flipped.diffLine,
        created: true,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}
