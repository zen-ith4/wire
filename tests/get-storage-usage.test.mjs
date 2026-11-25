// C2: getStorageUsage must add group_messages attachment size to the total.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-storage-'));
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
const { getStorageUsage } = require(path.join(ROOT, 'services', 'user.service.js'));

let db;

before(() => {
  initDatabase();
  db = getDb();

  db.prepare("INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, token_version) VALUES ('alice', 'alice@example.test', 'hash', 2, 'salt', 600000, 0, 1, 0)").run();
  const aliceId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;

  db.prepare("INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, token_version) VALUES ('bob', 'bob@example.test', 'hash', 2, 'salt', 600000, 0, 1, 0)").run();
  const bobId = db.prepare("SELECT id FROM users WHERE username = 'bob'").get().id;

  db.prepare("INSERT INTO groups (name, created_by, created_at) VALUES ('g', ?, datetime('now'))").run(aliceId);
  const groupId = db.prepare("SELECT last_insert_rowid() AS id").get().id;

  db.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', datetime('now'))").run(groupId, aliceId);

  // alice's chat attachment: 100
  db.prepare("INSERT INTO messages (user_id, content, attachment_path, attachment_size, created_at) VALUES (?, '{}', 'a.bin', 100, datetime('now'))").run(aliceId);
  // alice's DM attachment: 200
  db.prepare("INSERT INTO direct_messages (sender_id, recipient_id, content, attachment_path, attachment_size, created_at) VALUES (?, ?, '{}', 'b.bin', 200, datetime('now'))").run(aliceId, bobId);
  // alice's group attachment: 300
  db.prepare("INSERT INTO group_messages (group_id, sender_id, content, attachment_path, attachment_size, created_at) VALUES (?, ?, '{}', 'c.bin', 300, datetime('now'))").run(groupId, aliceId);
  // bob's group attachment: 400 (should NOT count for alice)
  db.prepare("INSERT INTO group_messages (group_id, sender_id, content, attachment_path, attachment_size, created_at) VALUES (?, ?, '{}', 'd.bin', 400, datetime('now'))").run(groupId, bobId);
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('getStorageUsage includes group_messages attachment size', () => {
  const aliceId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
  const total = getStorageUsage(aliceId);
  // chat: 100 + dm: 200 + group: 300 = 600
  assert.equal(total, 600, 'alice storage should be 600 (100 chat + 200 DM + 300 group)');
});

test('getStorageUsage does not include other users group attachments', () => {
  const bobId = db.prepare("SELECT id FROM users WHERE username = 'bob'").get().id;
  const total = getStorageUsage(bobId);
  // bob only has group attachment: 400
  assert.equal(total, 400, 'bob storage should be 400 (group only)');
});
