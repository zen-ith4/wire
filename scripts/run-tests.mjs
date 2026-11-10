// Test runner for `npm test`.
//
// Runs every tests/**/*.test.mjs except the ones listed in
// tests/EXCLUDED_NOT_APPLICABLE.json (each with a documented reason). Node's
// own --test glob cannot express "all but these", and the exclusions must stay
// a visible, reviewable list rather than an implicit filename trick.
//
//   node scripts/run-tests.mjs                 # everything not excluded
//   node scripts/run-tests.mjs tests/groups    # only that directory
//   node scripts/run-tests.mjs --excluded      # ONLY the excluded ones (expected to fail)
//
// CSP_ENFORCE=true comes from tests/test.env (the CSP tests assert the
// ENFORCED header).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const onlyExcluded = args.includes('--excluded');
const dirArg = args.find((a) => !a.startsWith('--'));

const { excluded } = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tests/EXCLUDED_NOT_APPLICABLE.json'), 'utf8')
);
const excludedSet = new Set(excluded.map((e) => e.file));

function walk(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p, out);
        else if (ent.name.endsWith('.test.mjs')) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
    return out.sort();
}

let files = walk(path.join(ROOT, 'tests'));
for (const e of excluded) {
    if (!files.includes(e.file)) {
        console.error(`EXCLUDED_NOT_APPLICABLE.json lists a file that does not exist: ${e.file}`);
        process.exit(2);
    }
}
if (dirArg) files = files.filter((f) => f.startsWith(dirArg.replace(/\/?$/, '/')));
files = onlyExcluded ? files.filter((f) => excludedSet.has(f)) : files.filter((f) => !excludedSet.has(f));

if (!onlyExcluded && excluded.length) {
    console.log(`# excluded as not applicable to this tree (${excluded.length}): ${excluded.map((e) => e.file).join(', ')}`);
}

// --test-concurrency=1: the browser-test files under tests/ each launch the
// project's single @sparticuz/chromium binary (tests/_acceptance-harness.mjs and
// tests/groups/group-e2e-browser.test.mjs) and drive heavy full-page flows. Node's
// test runner launches test FILES IN PARALLEL by default, so two of them spawn that
// shared binary at the same time: the exec races with ETXTBSY ("executable file
// busy"), and the combined Chromium load exhausts memory/CPU. Either surfaces as a
// flaky failure that depends only on which file happens to win the race - e.g.
// tests/groups/group-attachment-browser.test.mjs:276 ("3 a hostile relay serves
// file A under message B") passes on its own but fails when run together with
// tests/groups/group-e2e-browser.test.mjs. Running files sequentially removes both
// the binary race and the contention, and means each file fully tears its browsers
// down before the next starts, so it passes in either order. The non-browser tests
// are far faster than a browser launch, so serialising the whole run costs little.
const r = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--env-file=tests/test.env', '--test-concurrency=1', '--test', ...files],
    { cwd: ROOT, stdio: 'inherit' }
);
process.exit(r.status ?? 1);
