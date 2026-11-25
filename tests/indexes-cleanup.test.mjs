// C7: Duplicate indexes removed. idx_messages_user_id duplicates idx_messages_user,
// idx_dm_conversation duplicates idx_dm_sender_recipient. DROP IF EXISTS cleans
// existing databases; CREATE INDEX IF NOT EXISTS keeps the canonical ones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-indexes-'));
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
delete process.env.JWT_SECRET;

const { initDatabase, getDb } = require(path.join(ROOT, 'config', 'database.js'));
const { createIndexes } = require(path.join(ROOT, 'database', 'indexes.js'));

let db;

before(() => {
  initDatabase();
  db = getDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('duplicate indexes are dropped, canonical ones remain', () => {
  // First, create the duplicate indexes manually to simulate an older DB.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_dm_conversation ON direct_messages(sender_id, recipient_id);
  `);

  // Verify they exist before running createIndexes.
  const beforeMsgUserId = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_user_id'"
  ).get();
  const beforeDmConv = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dm_conversation'"
  ).get();
  assert.ok(beforeMsgUserId, 'idx_messages_user_id exists before cleanup');
  assert.ok(beforeDmConv, 'idx_dm_conversation exists before cleanup');

  // Run createIndexes - should drop the duplicates and create the canonical ones.
  createIndexes(db);

  // Verify duplicates are gone.
  const afterMsgUserId = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_user_id'"
  ).get();
  const afterDmConv = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dm_conversation'"
  ).get();
  assert.equal(afterMsgUserId, undefined, 'idx_messages_user_id dropped');
  assert.equal(afterDmConv, undefined, 'idx_dm_conversation dropped');

  // Verify canonical indexes remain.
  const afterMsgUser = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_user'"
  ).get();
  const afterDmSenderRecipient = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dm_sender_recipient'"
  ).get();
  assert.ok(afterMsgUser, 'idx_messages_user remains');
  assert.ok(afterDmSenderRecipient, 'idx_dm_sender_recipient remains');
});
