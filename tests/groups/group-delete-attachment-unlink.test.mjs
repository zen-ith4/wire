// deleteMessageHandler (groups) used fs.unlink with a callback, so the 200 was
// sent while the ciphertext file still existed. The DM handler removes the file
// first. These tests call the real handler against a real temp database and a
// real Socket.IO server, and check the file is gone at the moment the response
// is sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-group-unlink-'));
const GROUP_DIR = path.join(tmp, 'group');
fs.mkdirSync(GROUP_DIR, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  DB_PATH: path.join(tmp, 'test.db'),
  USER_DATA_ROOT: path.join(tmp, 'user-data'),
  CHAT_UPLOAD_DIR: path.join(tmp, 'chat'),
  DM_UPLOAD_DIR: path.join(tmp, 'dm'),
  AVATAR_DIR: path.join(tmp, 'avatars'),
  BANNER_DIR: path.join(tmp, 'banners'),
  GROUP_UPLOAD_DIR: GROUP_DIR,
});
delete process.env.JWT_SECRET;

const { initDatabase, getDb } = require(path.join(ROOT, 'config', 'database.js'));
const { setupSocketIO } = require(path.join(ROOT, 'config', 'socket.js'));
const { deleteMessageHandler } = require(path.join(ROOT, 'controllers', 'groups.controller.js'));

const HASH = 'x'.repeat(60);
const KDF_SALT = Buffer.alloc(16, 1).toString('base64');

let httpServer;
let io;
let ownerId;
let groupId;

before(async () => {
  initDatabase();
  const db = getDb();
  ownerId = Number(db.prepare(`
    INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, email_verified)
    VALUES ('gdel_owner', 'gdel_owner@example.test', ?, 2, ?, 600000, 0, 1, 1)
  `).run(HASH, KDF_SALT).lastInsertRowid);
  groupId = Number(db.prepare(`
    INSERT INTO groups (name, created_by) VALUES ('gdel group', ?)
  `).run(ownerId).lastInsertRowid);
  db.prepare(`
    INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')
  `).run(groupId, ownerId);

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

function seedAttachmentMessage(fileName) {
  const db = getDb();
  const messageId = Number(db.prepare(`
    INSERT INTO group_messages (group_id, sender_id, content, attachment_path)
    VALUES (?, ?, '', ?)
  `).run(groupId, ownerId, fileName).lastInsertRowid);
  return messageId;
}

// Calls the real handler. `fileExistsAtResponse` records whether the file was
// still on disk at the moment res.json ran, which is what a client would see.
async function callDelete(messageId, fileName) {
  let fileExistsAtResponse;
  let body;
  let status = 200;
  const res = {
    status(code) { status = code; return this; },
    json(payload) {
      body = payload;
      fileExistsAtResponse = fileName ? fs.existsSync(path.join(GROUP_DIR, fileName)) : null;
      return this;
    },
  };
  await deleteMessageHandler(
    { params: { groupId: String(groupId), messageId: String(messageId) }, user: { id: ownerId, is_admin: 0 } },
    res
  );
  return { status, body, fileExistsAtResponse };
}

test('the attachment file is gone when the delete response is sent', async () => {
  const fileName = 'gdel-attach-1.bin';
  fs.writeFileSync(path.join(GROUP_DIR, fileName), 'ciphertext');
  const messageId = seedAttachmentMessage(fileName);

  // A real async fs.unlink usually finishes on the thread pool before the
  // handler's synchronous res.json runs, so the race can hide the bug. Make
  // fs.unlink a no-op for this test: a handler that relies on it leaves the
  // file behind, and only a synchronous removal passes.
  const originalUnlink = fs.unlink;
  fs.unlink = (p, cb) => { if (typeof cb === 'function') cb(null); };
  let result;
  try {
    result = await callDelete(messageId, fileName);
  } finally {
    fs.unlink = originalUnlink;
  }

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.fileExistsAtResponse, false, 'file must already be removed when 200 is sent');
  assert.equal(getDb().prepare('SELECT id FROM group_messages WHERE id = ?').get(messageId), undefined);
});

test('a missing attachment file (ENOENT) does not fail the delete', async () => {
  const fileName = 'gdel-attach-missing.bin'; // never written
  const messageId = seedAttachmentMessage(fileName);

  const result = await callDelete(messageId, fileName);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(getDb().prepare('SELECT id FROM group_messages WHERE id = ?').get(messageId), undefined);
});

test('a message without an attachment is deleted as before', async () => {
  const messageId = Number(getDb().prepare(`
    INSERT INTO group_messages (group_id, sender_id, content) VALUES (?, ?, 'hello')
  `).run(groupId, ownerId).lastInsertRowid);

  const result = await callDelete(messageId, null);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(getDb().prepare('SELECT id FROM group_messages WHERE id = ?').get(messageId), undefined);
});
