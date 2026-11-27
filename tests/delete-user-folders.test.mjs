// A1 + A2: deleting a user must not escape the folder-share policy, and must
// not leave owner-less folder rows behind.
//
// A1: a Drive folder whose stored path no longer passes isStoredFolderAllowed
//     is left on disk (with a warning) while the account deletion succeeds.
//     A normal, app-created Drive folder is still removed recursively.
// A2: the folders the user OWNS are deleted in the same transaction as the
//     user row (their user_folders and share_links rows cascade away). Other
//     users' folders, and pre-existing orphan rows the user did not own, are
//     untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-delete-folders-'));
const userRoot = path.join(tmp, 'user-data');

process.env.NODE_ENV = 'development';
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.USER_DATA_ROOT = userRoot;
process.env.CHAT_UPLOAD_DIR = path.join(tmp, 'chat');
process.env.DM_UPLOAD_DIR = path.join(tmp, 'dm');
process.env.AVATAR_DIR = path.join(tmp, 'avatars');
process.env.BANNER_DIR = path.join(tmp, 'banners');
process.env.GROUP_UPLOAD_DIR = path.join(tmp, 'group');
delete process.env.ALLOWED_FOLDER_ROOTS;

const { initDatabase, getDb } = require(path.join(ROOT, 'config', 'database.js'));
const { deleteUser } = require(path.join(ROOT, 'services', 'user.service.js'));
const { createUserDrive } = require(path.join(ROOT, 'services', 'drive.service.js'));

let db;
let outsideOwner;
let cascadeOwner;
let keepOwner;
let normalDriveId;
let outsideFolderId;
let cascadeFolderId;
let keepFolderId;
let orphanFolderId;
let outsideDir;

const insertUser = (username) =>
  db.prepare(`
    INSERT INTO users
      (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations,
       is_admin, is_active, token_version)
    VALUES (?, ?, 'hash', 2, 'salt', 600000, 0, 1, 0)
  `).run(username, `${username}@example.test`);

before(() => {
  fs.mkdirSync(userRoot, { recursive: true });
  initDatabase();
  db = getDb();

  outsideOwner = Number(insertUser('outside_owner').lastInsertRowid);
  cascadeOwner = Number(insertUser('cascade_owner').lastInsertRowid);
  keepOwner = Number(insertUser('keep_owner').lastInsertRowid);

  // A normal, app-created Drive for outside_owner: this one must be removed.
  normalDriveId = Number(createUserDrive(db, { id: outsideOwner, username: 'outside_owner' }));
  const normalDriveDir = path.join(userRoot, String(outsideOwner), 'Drive');
  fs.writeFileSync(path.join(normalDriveDir, 'normal.txt'), 'normal drive content');

  // A row whose stored path is outside every allowed root: must stay on disk.
  outsideDir = path.join(tmp, 'outside-root');
  fs.mkdirSync(path.join(outsideDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'keep.txt'), 'must survive');
  fs.writeFileSync(path.join(outsideDir, 'nested', 'also-keep.txt'), 'must survive too');
  outsideFolderId = Number(
    db.prepare('INSERT INTO folders (path, display_name, owner_id) VALUES (?, ?, ?)')
      .run(outsideDir, 'outside', outsideOwner).lastInsertRowid
  );

  // A2 fixtures: cascade_owner owns one Drive folder with a share link and a
  // grant to keep_owner; keep_owner owns a folder shared with cascade_owner;
  // one row was already orphaned (owner_id NULL) before this deletion.
  cascadeFolderId = Number(createUserDrive(db, { id: cascadeOwner, username: 'cascade_owner' }));
  keepFolderId = Number(createUserDrive(db, { id: keepOwner, username: 'keep_owner' }));

  orphanFolderId = Number(
    db.prepare('INSERT INTO folders (path, display_name, owner_id) VALUES (?, ?, NULL)')
      .run(path.join(tmp, 'preexisting-orphan'), 'pre-existing orphan').lastInsertRowid
  );

  db.prepare('INSERT INTO user_folders (user_id, folder_id, can_write) VALUES (?, ?, 1)')
    .run(keepOwner, cascadeFolderId);
  db.prepare('INSERT INTO user_folders (user_id, folder_id, can_write) VALUES (?, ?, 0)')
    .run(cascadeOwner, keepFolderId);
  db.prepare('INSERT INTO user_folders (user_id, folder_id, can_write) VALUES (?, ?, 0)')
    .run(cascadeOwner, orphanFolderId);

  const addLink = (token, folderId, createdBy) =>
    db.prepare(`
      INSERT INTO share_links
        (token_hash, folder_id, rel_path, file_name, created_by, created_at)
      VALUES (?, ?, 'file.txt', 'file.txt', ?, datetime('now'))
    `).run(token, folderId, createdBy);

  addLink('a'.repeat(64), cascadeFolderId, cascadeOwner); // link into the folder being deleted
  addLink('b'.repeat(64), keepFolderId, cascadeOwner);     // link created by the deleted user, on another user's folder
  addLink('c'.repeat(64), keepFolderId, keepOwner);        // unrelated, must stay
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const count = (sql, ...args) => db.prepare(sql).get(...args).n;

test('A1: a disallowed Drive path stays on disk with a warning; a normal Drive is removed', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  let result;
  try {
    result = deleteUser(outsideOwner);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.changes, 1, 'user deletion still succeeds');

  // The directory outside the allowed roots is untouched, contents included.
  assert.ok(fs.existsSync(outsideDir), 'disallowed folder must stay on disk');
  assert.ok(fs.existsSync(path.join(outsideDir, 'keep.txt')), 'disallowed folder contents stay');
  assert.ok(fs.existsSync(path.join(outsideDir, 'nested', 'also-keep.txt')), 'nested contents stay');

  assert.ok(
    warnings.some((line) => line.includes(outsideDir) && line.includes('Refusing to remove')),
    'a warning names the path that was skipped'
  );

  // The normal app-created Drive folder is still removed recursively.
  assert.ok(!fs.existsSync(path.join(userRoot, String(outsideOwner), 'Drive')), 'normal Drive folder removed');

  // Both of this user's folder ROWS are gone; the files on disk are not the
  // test of A2 (that is checked below with a separate user).
  assert.equal(count('SELECT COUNT(*) AS n FROM folders WHERE id = ?', normalDriveId), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM folders WHERE id = ?', outsideFolderId), 0);
});

test('A2: owned folder rows and their grants/links go in the same transaction; others stay', () => {
  const keepDriveDir = path.join(userRoot, String(keepOwner), 'Drive');
  fs.writeFileSync(path.join(keepDriveDir, 'keep.txt'), 'keep me');

  const result = deleteUser(cascadeOwner);
  assert.equal(result.changes, 1, 'user deletion succeeds');

  // The deleted user's folder row is gone: no owner_id NULL orphan replaced it.
  assert.equal(count('SELECT COUNT(*) AS n FROM folders WHERE id = ?', cascadeFolderId), 0, 'owned folder row removed');
  assert.equal(count('SELECT COUNT(*) AS n FROM folders WHERE owner_id IS NULL'), 1, 'only the pre-existing orphan remains');
  assert.equal(count('SELECT COUNT(*) AS n FROM folders WHERE id = ?', orphanFolderId), 1, 'pre-existing orphan row untouched');

  // Grants and links tied to the deleted user or their folder are gone.
  assert.equal(count('SELECT COUNT(*) AS n FROM user_folders WHERE user_id = ?', cascadeOwner), 0, 'deleted user has no grants');
  assert.equal(count('SELECT COUNT(*) AS n FROM user_folders WHERE folder_id = ?', cascadeFolderId), 0, 'grants on the deleted folder are gone');
  assert.equal(count('SELECT COUNT(*) AS n FROM share_links WHERE created_by = ?', cascadeOwner), 0, 'links created by the deleted user are gone');
  assert.equal(count('SELECT COUNT(*) AS n FROM share_links WHERE folder_id = ?', cascadeFolderId), 0, 'links on the deleted folder are gone');

  // The other user's folder, its grant and its unrelated link are intact.
  assert.equal(count('SELECT COUNT(*) AS n FROM folders WHERE id = ?', keepFolderId), 1, 'other user folder row remains');
  assert.equal(count('SELECT COUNT(*) AS n FROM user_folders WHERE folder_id = ?', keepFolderId), 1, 'other user folder grant remains');
  assert.equal(count("SELECT COUNT(*) AS n FROM share_links WHERE token_hash = ?", 'c'.repeat(64)), 1, 'unrelated link remains');
  assert.ok(fs.existsSync(path.join(keepDriveDir, 'keep.txt')), 'other user files on disk remain');

  // The deleted user's own Drive directory is removed.
  assert.ok(!fs.existsSync(path.join(userRoot, String(cascadeOwner), 'Drive')), 'deleted user Drive removed');
});
