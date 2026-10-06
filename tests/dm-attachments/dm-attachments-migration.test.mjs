// Migration of the DM attachment columns: additive and idempotent, on a
// DB created by the BASE code (before this change) and on a fresh DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Runs `script` in a clean child process rooted at `tree` against `dbPath`.
function run(tree, dbPath, script) {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: tree,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      JWT_SECRET: 'migration-test-secret-not-for-prod',
      DB_PATH: dbPath,
      USER_DATA_ROOT: path.dirname(dbPath),
      GROUPS_ENABLED: 'false',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const INIT = "const {initDatabase,getDb}=require('./config/database');initDatabase();";
const COLUMNS = INIT + "console.log(JSON.stringify(getDb().prepare('PRAGMA table_info(direct_messages)').all().map(c=>c.name)))";

function baseTree() {
  // Prefer a pristine checkout of the base tag when git history is here;
  // otherwise skip loudly rather than silently pass.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-base-'));
  try {
    const tar = execFileSync('git', ['archive', 'BASE_TAG'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
  } catch {
    return null;
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

test('upgrade: DB created by the base code gains the columns, keeps legacy rows, and migrates twice safely', (t) => {
  const tree = baseTree();
  if (!tree) return t.skip('BASE_TAG not available in this checkout');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-mig-'));
  const dbPath = path.join(work, 'wire.db');

  // 1. base code creates the DB and a legacy plaintext attachment row
  const baseCols = JSON.parse(run(tree, dbPath, COLUMNS).trim().split('\n').pop());
  assert.ok(!baseCols.includes('attachment_meta') && !baseCols.includes('attachment_iv'), 'base schema must not have the new columns');

  run(tree, dbPath, INIT + `
    const db=getDb();
    db.prepare("INSERT INTO users (username,password_hash) VALUES ('a','x'),('b','x')").run();
    db.prepare("INSERT INTO direct_messages (sender_id,recipient_id,content,created_at,attachment_path,attachment_name,attachment_size,attachment_mime,is_voice_message) VALUES (1,2,'',datetime('now'),'legacy-file.png','legacy.png',10,'image/png',0)").run();
  `);

  // 2. current code migrates it, twice (idempotent)
  const first = JSON.parse(run(ROOT, dbPath, COLUMNS).trim().split('\n').pop());
  const second = JSON.parse(run(ROOT, dbPath, COLUMNS).trim().split('\n').pop());
  for (const cols of [first, second]) {
    assert.ok(cols.includes('attachment_meta'));
    assert.ok(cols.includes('attachment_iv'));
    assert.equal(cols.filter((c) => c === 'attachment_meta').length, 1);
  }
  assert.deepEqual(first, second);

  // 3. the legacy row is untouched and has NULL for the new columns
  const row = JSON.parse(run(ROOT, dbPath, INIT + "console.log(JSON.stringify(getDb().prepare('SELECT attachment_path,attachment_name,attachment_mime,attachment_meta,attachment_iv FROM direct_messages WHERE id=1').get()))").trim().split('\n').pop());
  assert.deepEqual(row, { attachment_path: 'legacy-file.png', attachment_name: 'legacy.png', attachment_mime: 'image/png', attachment_meta: null, attachment_iv: null });

  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(tree, { recursive: true, force: true });
});

test('fresh DB: columns exist from the start and the migration is a no-op', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-fresh-'));
  const dbPath = path.join(work, 'wire.db');
  const a = JSON.parse(run(ROOT, dbPath, COLUMNS).trim().split('\n').pop());
  const b = JSON.parse(run(ROOT, dbPath, COLUMNS).trim().split('\n').pop());
  assert.ok(a.includes('attachment_meta') && a.includes('attachment_iv'));
  assert.deepEqual(a, b);
  fs.rmSync(work, { recursive: true, force: true });
});
