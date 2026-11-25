// C1: deleteUser must remove the user's group_messages attachment files
// (GROUP_UPLOAD_DIR) and Drive folder files/directories, in addition to the
// already-handled avatar, banner, chat and DM attachments.
//
// Files must be collected BEFORE the DELETE transaction and removed AFTER it
// succeeds. Other users' files must remain untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-delete-user-'));
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
const { deleteUser } = require(path.join(ROOT, 'services', 'user.service.js'));
const constants = require(path.join(ROOT, 'config', 'constants.js'));

let db;

before(() => {
  initDatabase();
  db = getDb();

  // Create two users: one to delete, one whose files must remain.
  db.prepare("INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, token_version) VALUES ('delete_me', 'delete@example.test', 'hash1', 2, 'salt1', 600000, 0, 1, 0)").run();
  db.prepare("INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, token_version) VALUES ('keep_me', 'keep@example.test', 'hash2', 2, 'salt2', 600000, 0, 1, 0)").run();

  const deleteMeId = db.prepare("SELECT id FROM users WHERE username = 'delete_me'").get().id;
  const keepMeId = db.prepare("SELECT id FROM users WHERE username = 'keep_me'").get().id;

  // Create a group owned by delete_me.
  db.prepare("INSERT INTO groups (name, created_by, created_at) VALUES ('test-group', ?, datetime('now'))").run(deleteMeId);
  const groupId = db.prepare("SELECT last_insert_rowid() AS id").get().id;

  // Add both users as members.
  db.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', datetime('now')), (?, ?, 'member', datetime('now'))").run(groupId, deleteMeId, groupId, keepMeId);

  // Create group messages with attachments from both users.
  db.prepare("INSERT INTO group_messages (group_id, sender_id, content, attachment_path, attachment_size, created_at) VALUES (?, ?, '{}', 'delete_me_group_attach.bin', 100, datetime('now'))").run(groupId, deleteMeId);
  db.prepare("INSERT INTO group_messages (group_id, sender_id, content, attachment_path, attachment_size, created_at) VALUES (?, ?, '{}', 'keep_me_group_attach.bin', 200, datetime('now'))").run(groupId, keepMeId);

  // Create chat and DM attachments for both users.
  db.prepare("INSERT INTO messages (user_id, content, attachment_path, attachment_size, created_at) VALUES (?, '{}', 'delete_me_chat.bin', 300, datetime('now'))").run(deleteMeId);
  db.prepare("INSERT INTO messages (user_id, content, attachment_path, attachment_size, created_at) VALUES (?, '{}', 'keep_me_chat.bin', 400, datetime('now'))").run(keepMeId);

  db.prepare("INSERT INTO direct_messages (sender_id, recipient_id, content, attachment_path, attachment_size, created_at) VALUES (?, ?, '{}', 'delete_me_dm.bin', 500, datetime('now'))").run(deleteMeId, keepMeId);
  db.prepare("INSERT INTO direct_messages (sender_id, recipient_id, content, attachment_path, attachment_size, created_at) VALUES (?, ?, '{}', 'keep_me_dm.bin', 600, datetime('now'))").run(keepMeId, deleteMeId);

  // Create Drive folders for both users (DB rows + directories).
  const { createUserDrive } = require(path.join(ROOT, 'services', 'drive.service.js'));
  const deleteMeDriveDir = path.join(constants.USER_DATA_ROOT, String(deleteMeId), 'Drive');
  const keepMeDriveDir = path.join(constants.USER_DATA_ROOT, String(keepMeId), 'Drive');
  createUserDrive(db, { id: deleteMeId, username: 'delete_me' });
  createUserDrive(db, { id: keepMeId, username: 'keep_me' });

  // Create files inside the Drive directories.
  fs.writeFileSync(path.join(deleteMeDriveDir, 'delete_me_drive_file.txt'), 'delete me drive content');
  fs.mkdirSync(path.join(deleteMeDriveDir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(deleteMeDriveDir, 'subdir', 'nested.txt'), 'nested content');
  fs.writeFileSync(path.join(keepMeDriveDir, 'keep_me_drive_file.txt'), 'keep me drive content');

  // Create files in upload directories.
  fs.mkdirSync(constants.GROUP_UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(constants.CHAT_UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(constants.DM_UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(constants.GROUP_UPLOAD_DIR, 'delete_me_group_attach.bin'), 'group attach content');
  fs.writeFileSync(path.join(constants.GROUP_UPLOAD_DIR, 'keep_me_group_attach.bin'), 'keep group attach content');
  fs.writeFileSync(path.join(constants.CHAT_UPLOAD_DIR, 'delete_me_chat.bin'), 'chat content');
  fs.writeFileSync(path.join(constants.CHAT_UPLOAD_DIR, 'keep_me_chat.bin'), 'keep chat content');
  fs.writeFileSync(path.join(constants.DM_UPLOAD_DIR, 'delete_me_dm.bin'), 'dm content');
  fs.writeFileSync(path.join(constants.DM_UPLOAD_DIR, 'keep_me_dm.bin'), 'keep dm content');

  // Store IDs for assertions.
  global.testDeleteMeId = deleteMeId;
  global.testKeepMeId = keepMeId;
  global.testGroupId = groupId;
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('deleteUser removes group message attachments, Drive folders, and other attachments', () => {
  const deleteMeId = global.testDeleteMeId;
  const keepMeId = global.testKeepMeId;

  // Verify files exist before deletion.
  assert.ok(fs.existsSync(path.join(constants.GROUP_UPLOAD_DIR, 'delete_me_group_attach.bin')));
  assert.ok(fs.existsSync(path.join(constants.GROUP_UPLOAD_DIR, 'keep_me_group_attach.bin')));
  assert.ok(fs.existsSync(path.join(constants.CHAT_UPLOAD_DIR, 'delete_me_chat.bin')));
  assert.ok(fs.existsSync(path.join(constants.CHAT_UPLOAD_DIR, 'keep_me_chat.bin')));
  assert.ok(fs.existsSync(path.join(constants.DM_UPLOAD_DIR, 'delete_me_dm.bin')));
  assert.ok(fs.existsSync(path.join(constants.DM_UPLOAD_DIR, 'keep_me_dm.bin')));
  assert.ok(fs.existsSync(path.join(constants.USER_DATA_ROOT, String(deleteMeId), 'Drive', 'delete_me_drive_file.txt')));
  assert.ok(fs.existsSync(path.join(constants.USER_DATA_ROOT, String(deleteMeId), 'Drive', 'subdir', 'nested.txt')));
  assert.ok(fs.existsSync(path.join(constants.USER_DATA_ROOT, String(keepMeId), 'Drive', 'keep_me_drive_file.txt')));

  // Delete the user.
  const result = deleteUser(deleteMeId);
  assert.equal(result.changes, 1, 'user row deleted');

  // delete_me's files must be gone.
  assert.ok(!fs.existsSync(path.join(constants.GROUP_UPLOAD_DIR, 'delete_me_group_attach.bin')), 'delete_me group attachment removed');
  assert.ok(!fs.existsSync(path.join(constants.CHAT_UPLOAD_DIR, 'delete_me_chat.bin')), 'delete_me chat attachment removed');
  assert.ok(!fs.existsSync(path.join(constants.DM_UPLOAD_DIR, 'delete_me_dm.bin')), 'delete_me DM attachment removed');
  assert.ok(!fs.existsSync(path.join(constants.USER_DATA_ROOT, String(deleteMeId), 'Drive')), 'delete_me Drive directory removed');

  // keep_me's files must remain.
  assert.ok(fs.existsSync(path.join(constants.GROUP_UPLOAD_DIR, 'keep_me_group_attach.bin')), 'keep_me group attachment remains');
  assert.ok(fs.existsSync(path.join(constants.CHAT_UPLOAD_DIR, 'keep_me_chat.bin')), 'keep_me chat attachment remains');
  assert.ok(fs.existsSync(path.join(constants.DM_UPLOAD_DIR, 'keep_me_dm.bin')), 'keep_me DM attachment remains');
  assert.ok(fs.existsSync(path.join(constants.USER_DATA_ROOT, String(keepMeId), 'Drive', 'keep_me_drive_file.txt')), 'keep_me Drive file remains');
});
