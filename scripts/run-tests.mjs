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

const r = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--env-file=tests/test.env', '--test', ...files],
    { cwd: ROOT, stdio: 'inherit' }
);
process.exit(r.status ?? 1);
