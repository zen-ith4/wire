// findUserByUsername used SELECT *, so every caller received credential
// columns (password_hash, kdf_salt, token_version, ...). It now selects only
// id, username, is_admin and is_active. These tests check the returned row
// has no credential columns and that lookup behaviour is unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-user-lookup-'));
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
const { findUserByUsername } = require(path.join(ROOT, 'services', 'user.service.js'));

const CREDENTIAL_COLUMNS = ['password_hash', 'kdf_salt', 'kdf_iterations', 'token_version', 'email', 'auth_scheme'];

before(() => {
  initDatabase();
  getDb().prepare(`
    INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, token_version)
    VALUES ('lookup_alice', 'alice@example.test', 'secret-hash', 2, 'c2FsdA==', 600000, 1, 1, 7)
  `).run();
});

after(() => {
  getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the returned row carries no credential columns', () => {
  const user = findUserByUsername('lookup_alice');

  assert.ok(user, 'user should be found');
  for (const col of CREDENTIAL_COLUMNS) {
    assert.equal(Object.prototype.hasOwnProperty.call(user, col), false, `must not expose ${col}`);
  }
});

test('the returned row has the columns callers need', () => {
  const user = findUserByUsername('lookup_alice');

  assert.deepEqual(Object.keys(user).sort(), ['id', 'is_active', 'is_admin', 'username']);
  assert.equal(user.username, 'lookup_alice');
  assert.equal(user.is_admin, 1);
  assert.equal(user.is_active, 1);
});

test('lookup stays case-insensitive and returns undefined for unknown names', () => {
  assert.equal(findUserByUsername('LOOKUP_ALICE').id, findUserByUsername('lookup_alice').id);
  assert.equal(findUserByUsername('no_such_user'), undefined);
});
