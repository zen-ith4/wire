// statEntriesLimited stats every entry of a directory after readdir. A file
// removed between readdir and stat makes stat throw ENOENT. That used to reject
// Promise.all and turn the whole listing into a 500. These tests replace stat
// for one name (the real race cannot be made deterministic) and check that the
// vanished entry is skipped, the rest are returned in order, no null is left
// behind, and any other error still propagates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-stat-enoent-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  DB_PATH: path.join(tmp, 'test.db'),
  USER_DATA_ROOT: path.join(tmp, 'user-data'),
  CHAT_UPLOAD_DIR: path.join(tmp, 'chat'),
  DM_UPLOAD_DIR: path.join(tmp, 'dm'),
  AVATAR_DIR: path.join(tmp, 'avatars'),
  BANNER_DIR: path.join(tmp, 'banners'),
  GROUP_UPLOAD_DIR: path.join(tmp, 'group'),
});

const { statEntriesLimited } = require(path.join(ROOT, 'controllers', 'files.controller.js'));
const fsp = require('fs/promises');

// Replace fs/promises.stat for names in `fail` (a Map of name -> error code).
// The controller reads fsp.stat at call time, so this is what it calls.
async function withStatFailures(fail, fn) {
  const original = fsp.stat;
  fsp.stat = async (p, ...rest) => {
    const name = path.basename(p);
    if (fail.has(name)) {
      const err = new Error(`${fail.get(name)}: simulated for ${name}`);
      err.code = fail.get(name);
      throw err;
    }
    return original(p, ...rest);
  };
  try {
    return await fn();
  } finally {
    fsp.stat = original;
  }
}

function makeDir(names) {
  const dir = fs.mkdtempSync(path.join(tmp, 'dir-'));
  for (const n of names) fs.writeFileSync(path.join(dir, n), n);
  return dir;
}

const direntsOf = (dir) => fs.readdirSync(dir, { withFileTypes: true });

test('an entry removed between readdir and stat is skipped, not a 500', async () => {
  const dir = makeDir(['a.txt', 'gone.txt', 'c.txt']);
  const dirents = direntsOf(dir);

  const entries = await withStatFailures(new Map([['gone.txt', 'ENOENT']]), () =>
    statEntriesLimited(dirents, dir)
  );

  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'c.txt']);
});

test('the result never contains null holes and keeps the input order', async () => {
  const names = ['1.txt', '2.txt', '3.txt', '4.txt', '5.txt', '6.txt'];
  const dir = makeDir(names);
  const dirents = direntsOf(dir);

  const entries = await withStatFailures(
    new Map([['2.txt', 'ENOENT'], ['5.txt', 'ENOENT']]),
    () => statEntriesLimited(dirents, dir)
  );

  assert.ok(entries.every((e) => e && typeof e === 'object'), 'no null entries');
  assert.deepEqual(entries.map((e) => e.name), ['1.txt', '3.txt', '4.txt', '6.txt']);
});

test('a directory where every entry vanished returns an empty array, not an error', async () => {
  const dir = makeDir(['x.txt', 'y.txt']);
  const dirents = direntsOf(dir);

  const entries = await withStatFailures(
    new Map([['x.txt', 'ENOENT'], ['y.txt', 'ENOENT']]),
    () => statEntriesLimited(dirents, dir)
  );

  assert.deepEqual(entries, []);
});

test('a non-ENOENT stat error still propagates (only vanished files are tolerated)', async () => {
  const dir = makeDir(['ok.txt', 'denied.txt']);
  const dirents = direntsOf(dir);

  await assert.rejects(
    withStatFailures(new Map([['denied.txt', 'EACCES']]), () =>
      statEntriesLimited(dirents, dir)
    ),
    (err) => err.code === 'EACCES'
  );
});

test('normal listing is unchanged: type, size and modified are populated', async () => {
  const dir = makeDir(['plain.txt']);
  fs.mkdirSync(path.join(dir, 'sub'));
  const entries = await statEntriesLimited(direntsOf(dir), dir);

  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName['plain.txt'].type, 'file');
  assert.equal(byName['plain.txt'].size, 'plain.txt'.length);
  assert.equal(byName['sub'].type, 'dir');
  assert.match(byName['sub'].modified, /^\d{4}-\d{2}-\d{2}T/);
});

process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
