// A direct message to a deactivated account (is_active = 0) was accepted and
// stored. Such accounts cannot log in, so they must not receive new content.
// sendMessage now looks the recipient up with findActiveUserById, which returns
// the same 404 'User not found' an unknown user gets. These tests call the real
// handler against a real temporary database and a real Socket.IO server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-dm-inactive-'));
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
const { setupSocketIO } = require(path.join(ROOT, 'config', 'socket.js'));
const { sendMessage } = require(path.join(ROOT, 'controllers', 'dm.controller.js'));

const HASH = 'x'.repeat(60);
const KDF_SALT = Buffer.alloc(16, 1).toString('base64');

let httpServer;
let io;
let aliceId;
let activeBobId;
let inactiveCarolId;

before(async () => {
  initDatabase();
  const db = getDb();
  const insert = (name, active) => Number(db.prepare(`
    INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, email_verified)
    VALUES (?, ?, ?, 2, ?, 600000, 0, ?, 1)
  `).run(name, `${name}@example.test`, HASH, KDF_SALT, active).lastInsertRowid);

  aliceId = insert('dmi_alice', 1);
  activeBobId = insert('dmi_bob', 1);
  inactiveCarolId = insert('dmi_carol', 0);

  httpServer = http.createServer();
  io = setupSocketIO(httpServer);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
  getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Calls the real handler and captures the response.
function send(recipientId, content) {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  sendMessage({ body: { recipient_id: recipientId, content }, user: { id: aliceId } }, res);
  return { status, body };
}

function countDmsTo(recipientId) {
  return getDb().prepare(
    'SELECT COUNT(*) AS n FROM direct_messages WHERE sender_id = ? AND recipient_id = ?'
  ).get(aliceId, recipientId).n;
}

test('a DM to a deactivated user gets 404 User not found and no row is written', () => {
  const before = countDmsTo(inactiveCarolId);

  const result = send(inactiveCarolId, 'are you there?');

  assert.equal(result.status, 404, JSON.stringify(result.body));
  assert.equal(result.body.error, 'User not found');
  assert.equal(countDmsTo(inactiveCarolId), before, 'no message row may be inserted');
});

test('a DM to an active user is still delivered (row written, 200 response)', () => {
  const before = countDmsTo(activeBobId);

  const result = send(activeBobId, 'hello bob');

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(countDmsTo(activeBobId), before + 1);
});

test('an unknown recipient id still gets the same 404', () => {
  const result = send(987654, 'anyone?');

  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'User not found');
});
