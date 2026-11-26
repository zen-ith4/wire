// C9: deleteUser must reject non-integer user ids ('0x10', '1e1', '01', '-5', '0')
// using the same strict integer regex as setUserAdmin (parseCanonicalId).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-delete-user-id-'));
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

let db;

before(() => {
  initDatabase();
  db = getDb();

  db.prepare("INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, token_version) VALUES ('alice', 'alice@example.test', 'hash', 2, 'salt', 600000, 0, 1, 0)").run();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('deleteUser rejects non-integer ids', () => {
  // These must all throw
  assert.throws(() => deleteUser('0x10'), /Invalid user id/);
  assert.throws(() => deleteUser('1e1'), /Invalid user id/);
  assert.throws(() => deleteUser('01'), /Invalid user id/);
  assert.throws(() => deleteUser('-5'), /Invalid user id/);
  assert.throws(() => deleteUser('0'), /Invalid user id/);
  assert.throws(() => deleteUser('abc'), /Invalid user id/);
  assert.throws(() => deleteUser(''), /Invalid user id/);
  assert.throws(() => deleteUser(null), /Invalid user id/);
});

test('deleteUser accepts valid integer ids (format validation passes)', () => {
  // A valid-format id that doesn't exist in the DB should pass validation
  // (it will fail later at the DB step, not by id validation).
  assert.doesNotThrow(() => deleteUser('999999'), 'valid integer id format passes validation');
});
