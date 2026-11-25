// P0-3 gap: after changeCredentialsV2 bumps token_version, the user's OTHER
// live sockets must be forcefully disconnected. An old socket must not keep
// talking after its token is revoked, and a reconnect with the old token must
// be refused while a reconnect with the new token works.
//
// Runs against a real temporary SQLite database with the real schema,
// migrations, middleware, and a real Socket.IO server.
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

// Isolate every on-disk location in a temp directory before any module loads.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-socket-disconnect-'));
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

const constants = require(path.join(ROOT, 'config', 'constants.js'));
const jwt = require('jsonwebtoken');
const { initDatabase, getDb } = require(path.join(ROOT, 'config', 'database.js'));
const { signToken } = require(path.join(ROOT, 'utils', 'jwt.js'));
const { hashPassword } = require(path.join(ROOT, 'utils', 'password.js'));
const { setupSocketIO } = require(path.join(ROOT, 'config', 'socket.js'));
const { changeCredentialsV2 } = require(path.join(ROOT, 'services', 'user.service.js'));
const { disconnectUserSockets } = require(path.join(ROOT, 'services', 'socket.service.js'));
const { io: ioClient } = require('socket.io-client');

const AUTH_KEY = 'A'.repeat(43);
let userId;
let httpServer;
let io;
let url;

before(async () => {
  initDatabase();
  const db = getDb();
  const hash = await hashPassword(AUTH_KEY);
  userId = Number(
    db.prepare(
      "INSERT INTO users (username, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active) VALUES ('alice', ?, 2, ?, 600000, 0, 1)"
    ).run(hash, Buffer.alloc(16, 1).toString('base64')).lastInsertRowid
  );

  httpServer = http.createServer();
  io = setupSocketIO(httpServer);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
  getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- helpers ----------------------------------------------------------

const db = () => getDb();
const storedVersion = () =>
  db().prepare('SELECT token_version FROM users WHERE id = ?').get(userId).token_version;

const sessionAt = (version) =>
  signToken({ id: userId, username: 'alice', is_admin: false, token_version: version });

// Open a real socket.io-client connection with the given token.
function openSocket(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { 'X-Forwarded-For': '10.10.0.5' },
    });
    let settled = false;
    s.on('connect', () => { if (!settled) { settled = true; resolve(s); } });
    s.on('connect_error', (err) => { if (!settled) { settled = true; reject(err); } });
    // safety timeout
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('socket connect timeout')); } }, 5000);
  });
}

// Wait for a socket to actually go disconnected (connected -> false).
function waitForDisconnected(socket) {
  return new Promise((resolve) => {
    if (!socket.connected) { resolve(); return; }
    const check = () => {
      if (!socket.connected) { resolve(); return; }
      setTimeout(check, 100);
    };
    setTimeout(check, 100);
    socket.once('disconnect', () => setTimeout(check, 0));
    setTimeout(() => resolve(), 10000);
  });
}

// ---- tests ------------------------------------------------------------

test('after password change, old socket is disconnected and old token is refused', async () => {
  const before = storedVersion();

  // Two live sockets on the old token.
  const oldToken = sessionAt(before);
  const sock1 = await openSocket(oldToken);
  const sock2 = await openSocket(oldToken);
  assert.ok(sock1.connected, 'socket 1 connected');
  assert.ok(sock2.connected, 'socket 2 connected');

  // Perform the password change (same auth key, fresh salt).
  const currentHash = db().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash;
  const result = await changeCredentialsV2(userId, {
    currentHash,
    newAuthKey: 'B'.repeat(43),
    kdfSalt: Buffer.alloc(16, 2).toString('base64'),
    kdfIterations: 650000,
    identity: null,
  });
  assert.equal(result.ok, true);
  assert.equal(storedVersion(), before + 1);

  // Simulate what the controller does after a successful password change:
  // forcefully disconnect the user's other live sockets.
  disconnectUserSockets(userId);

  // Both old sockets should be forcefully disconnected.
  await Promise.all([
    waitForDisconnected(sock1),
    waitForDisconnected(sock2),
  ]);
  assert.equal(sock1.connected, false, 'socket 1 disconnected');
  assert.equal(sock2.connected, false, 'socket 2 disconnected');

  // Reconnect with the OLD token must be refused (token_version no longer matches).
  const oldConnect = openSocket(oldToken).then(() => true, () => false);
  assert.equal(await oldConnect, false, 'old token reconnect refused');

  // Restore the known auth key for cleanliness (so the test db state is sane).
  await changeCredentialsV2(userId, {
    currentHash: db().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash,
    newAuthKey: AUTH_KEY,
    kdfSalt: Buffer.alloc(16, 3).toString('base64'),
    kdfIterations: 650000,
    identity: null,
  });
  assert.equal(storedVersion(), before + 2);

  // Reconnect with a NEW token at the current version must succeed.
  const newToken = sessionAt(storedVersion());
  const sock3 = await openSocket(newToken);
  assert.ok(sock3.connected, 'new token socket connected');
  sock3.close();
});

test('disconnectUserSockets exports and does not throw for a user with no sockets', () => {
  assert.equal(typeof disconnectUserSockets, 'function');
  assert.doesNotThrow(() => disconnectUserSockets(999999));
});
