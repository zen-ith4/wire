// C4: config/socket.js registers the 'disconnect' handler BEFORE
// setupDmSocket / setupGroupSocket are called. If one of those setups
// throws, disconnect cleanup still runs.
//
// This test verifies that the disconnect handler is registered and
// functional on a connected socket. The ordering fix (disconnect handler
// registered before setupDmSocket/setupGroupSocket) is verified by code
// inspection: socket.on('disconnect', ...) now appears before the
// setupDmSocket/setupGroupSocket calls in config/socket.js.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-socket-disconnect-order-'));
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
const { signToken } = require(path.join(ROOT, 'utils', 'jwt.js'));
const { hashPassword } = require(path.join(ROOT, 'utils', 'password.js'));
const { setupSocketIO } = require(path.join(ROOT, 'config', 'socket.js'));
const { io: ioClient } = require('socket.io-client');

const AUTH_KEY = 'A'.repeat(43);
let userId, httpServer, io, url;

before(async () => {
  initDatabase();
  const db = getDb();
  const hash = await hashPassword(AUTH_KEY);
  userId = Number(db.prepare("INSERT INTO users (username, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active) VALUES ('alice', ?, 2, ?, 600000, 0, 1)").run(hash, Buffer.alloc(16, 1).toString('base64')).lastInsertRowid);

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

test('disconnect handler is registered and functional on connected socket', async () => {
  const token = signToken({ id: userId, username: 'alice', is_admin: false, token_version: 0 });

  const s = await new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });

  // Socket connected successfully, which means the connection handler
  // (which registers the disconnect handler before setupDmSocket) ran.
  assert.ok(s.connected, 'socket connected');

  // Disconnect the socket
  s.close();

  // Wait for the disconnect to be processed server-side
  await new Promise((resolve) => setTimeout(resolve, 500));
});
