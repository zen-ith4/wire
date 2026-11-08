// tests/admin/admin-single-root.test.mjs
//
// Acceptance checks for "single site admin with transfer" (see the task
// document). Boots the real admin + DM routers on a temporary database.
//
// Not covered here (needs group fixtures): an admin who is only a group
// member cannot delete other members' group messages. That is a one-line
// change in groups.controller.js and is worth its own test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Environment must be in place before config/constants.js is loaded.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-admin-'));
const userRoot = path.join(tmp, 'user-data');
fs.mkdirSync(path.join(userRoot, 'share'), { recursive: true });
fs.symlinkSync('/etc', path.join(userRoot, 'share', 'escape-link'));

process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.JWT_SECRET = 'a'.repeat(48);
process.env.USER_DATA_ROOT = userRoot;
delete process.env.ALLOWED_FOLDER_ROOTS;

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const R = (p) => require(path.join(ROOT, p));

const express = require(path.join(ROOT, 'node_modules/express'));
const { initDatabase, getDb } = R('config/database');
const { deriveCredentialsNode, newKdfSalt, KDF_ITERATIONS } = R('utils/credentials');
const { hashPassword } = R('utils/password');
const { signToken } = R('utils/jwt');
const { errorHandler } = R('middleware/errorHandler');

const PASSWORD = 'correct-horse-battery';
let server;
let io;
let base;
let db;
const users = {};

async function makeUser(name, isAdmin = false) {
  const salt = newKdfSalt();
  const { authKey } = deriveCredentialsNode(PASSWORD, salt, KDF_ITERATIONS);
  const hash = await hashPassword(authKey);
  const r = db
    .prepare(`
      INSERT INTO users (username, password_hash, is_admin, auth_scheme, kdf_salt, kdf_iterations, is_active)
      VALUES (?, ?, ?, 2, ?, ?, 1)
    `)
    .run(name, hash, isAdmin ? 1 : 0, salt, KDF_ITERATIONS);

  return {
    id: Number(r.lastInsertRowid),
    username: name,
    token_version: 0,
    authKey,
    token: null,
  };
}

function tokenFor(user) {
  return signToken(user);
}

async function call(method, urlPath, token, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }

  return { status: res.status, json };
}

before(async () => {
  initDatabase();
  db = getDb();

  users.boss = await makeUser('boss', true);
  users.bob = await makeUser('bob');
  users.carol = await makeUser('carol');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', R('routes/admin.routes'));
  app.use('/api/dm', R('routes/dm.routes'));
  app.use(errorHandler);

  server = http.createServer(app);
  // DM deletes emit a socket event, so Socket.IO must be running (as in tests/groups/_test-server.mjs).
  io = R('config/socket').setupSocketIO(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (io) await new Promise((resolve) => io.close(() => resolve()));
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function passwordBody(user, password = PASSWORD) {
  const salt = db.prepare('SELECT kdf_salt FROM users WHERE id = ?').get(user.id).kdf_salt;
  const { authKey } = deriveCredentialsNode(password, salt, KDF_ITERATIONS);
  return { current_auth_key: authKey };
}

// ---------- transfer ----------

test('transfer with a wrong password is refused (403)', async () => {
  const r = await call('POST', '/api/admin/transfer', tokenFor(users.boss), {
    userId: users.bob.id,
    ...passwordBody(users.boss, 'wrong-password-xyz'),
  });
  assert.equal(r.status, 403);
});

test('transfer to yourself is refused (400)', async () => {
  const r = await call('POST', '/api/admin/transfer', tokenFor(users.boss), {
    userId: users.boss.id,
    ...passwordBody(users.boss),
  });
  assert.equal(r.status, 400);
});

test('transfer leaves exactly one admin, and the old admin loses rights at once', async () => {
  const r = await call('POST', '/api/admin/transfer', tokenFor(users.boss), {
    userId: users.bob.id,
    ...passwordBody(users.boss),
  });
  assert.equal(r.status, 200);

  const admins = db.prepare('SELECT username FROM users WHERE is_admin = 1').all();
  assert.deepEqual(admins.map(a => a.username), ['bob']);

  // The old admin's token is still valid, but the next request is no longer admin.
  const after1 = await call('GET', '/api/admin/users', tokenFor(users.boss));
  assert.equal(after1.status, 403);

  const bobList = await call('GET', '/api/admin/users', tokenFor(users.bob));
  assert.equal(bobList.status, 200);
});

// Hand the role back so the rest of the file has a known admin.
test('setup: give the admin role back to boss for the remaining checks', async () => {
  db.prepare('UPDATE users SET is_admin = 0 WHERE is_admin = 1').run();
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(users.boss.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n, 1);
});

// ---------- one admin, enforced by the database ----------

test('the database refuses a second admin row', () => {
  assert.throws(
    () => db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('evil', 'x', 1)").run(),
    /UNIQUE constraint failed/
  );
});

test('createUser never creates an admin, even when asked', async () => {
  const salt = newKdfSalt();
  const { authKey } = deriveCredentialsNode('temporary-pass-1', salt, KDF_ITERATIONS);
  const r = await call('POST', '/api/admin/users', tokenFor(users.boss), {
    username: 'newhire',
    email: 'newhire@x.invalid',
    auth_key: authKey,
    kdf_salt: salt,
    kdf_iterations: KDF_ITERATIONS,
    is_admin: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.is_admin, false);
});

test('an admin cannot delete themselves (400)', async () => {
  const r = await call('DELETE', `/api/admin/users/${users.boss.id}`, tokenFor(users.boss), passwordBody(users.boss));
  assert.equal(r.status, 400);
});

test('deleting a user requires the password (403 when wrong)', async () => {
  const r = await call('DELETE', `/api/admin/users/${users.carol.id}`, tokenFor(users.boss), {
    ...passwordBody(users.boss, 'not-the-password-at-all'),
  });
  assert.equal(r.status, 403);
  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(users.carol.id), 'carol must still exist');
});

// ---------- folder path policy ----------

test('folder at /etc is refused (400)', async () => {
  const r = await call('POST', '/api/admin/folders', tokenFor(users.boss), { path: '/etc' });
  assert.equal(r.status, 400);
});

test('folder that is a symlink pointing outside the allowed root is refused (400)', async () => {
  const r = await call('POST', '/api/admin/folders', tokenFor(users.boss), {
    path: path.join(userRoot, 'share', 'escape-link'),
  });
  assert.equal(r.status, 400);
});

test('folder with .. that leaves the allowed root is refused (400)', async () => {
  const r = await call('POST', '/api/admin/folders', tokenFor(users.boss), {
    path: path.join(userRoot, 'share', '..', '..'),
  });
  assert.equal(r.status, 400);
});

test('folder inside the allowed root is accepted (200)', async () => {
  const r = await call('POST', '/api/admin/folders', tokenFor(users.boss), {
    path: path.join(userRoot, 'share'),
  });
  assert.equal(r.status, 200);
});

// ---------- audit log ----------

test('destructive admin actions write audit rows, with no secrets', async () => {
  const r = await call('GET', '/api/admin/audit?limit=100', tokenFor(users.boss));
  assert.equal(r.status, 200);

  const actions = r.json.map(e => e.action);
  assert.ok(actions.includes('transfer_admin'), 'transfer recorded');
  assert.ok(actions.includes('create_user'), 'create recorded');
  assert.ok(actions.includes('create_folder'), 'folder recorded');

  const dump = JSON.stringify(r.json);
  assert.doesNotMatch(dump, /correct-horse|temporary-pass|authKey|password_hash|kdf_salt/);
});

// ---------- DM: the admin has no power over message content ----------

test('the admin cannot delete someone else\'s DM (403), the sender can (200)', async () => {
  const insert = db.prepare(`
    INSERT INTO direct_messages (sender_id, recipient_id, content) VALUES (?, ?, 'hi')
  `);
  const msgId = Number(insert.run(users.carol.id, users.bob.id).lastInsertRowid);

  const denied = await call('DELETE', `/api/dm/messages/${msgId}`, tokenFor(users.boss));
  assert.equal(denied.status, 403);
  assert.ok(db.prepare('SELECT id FROM direct_messages WHERE id = ?').get(msgId), 'message must still exist');

  // carol is no longer deleted above; the sender check is the point here.
  const sender = await call('DELETE', `/api/dm/messages/${msgId}`, tokenFor(users.carol));
  assert.equal(sender.status, 200);
});

// ---------- migration: keeps the oldest admin ----------

test('migration on a database with several admins keeps the oldest and demotes the rest', async () => {
  const { Database } = { Database: require(path.join(ROOT, 'node_modules/better-sqlite3')) };
  const { ensureSchema } = R('database/schema');

  const legacy = new Database(':memory:');
  ensureSchema(legacy);
  legacy.exec('DROP INDEX IF EXISTS idx_users_one_admin');
  legacy.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('first', 'x', 1)").run();
  legacy.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('second', 'x', 1)").run();
  legacy.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('third', 'x', 1)").run();

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    ensureSchema(legacy);
  } finally {
    console.warn = originalWarn;
  }

  const admins = legacy.prepare('SELECT username FROM users WHERE is_admin = 1').all();
  assert.deepEqual(admins.map(a => a.username), ['first']);
  assert.ok(warnings.some(w => w.includes('"second"') && w.includes('"third"')), 'warning lists the demoted accounts');

  legacy.close();
});
