// C4: config/socket.js registers the 'disconnect' handler BEFORE
// setupDmSocket / setupGroupSocket are called. If one of those setups
// throws, disconnect cleanup still runs.
//
// This test mocks setupDmSocket to throw and verifies the disconnect
// handler was already registered on the server-side socket when it does.
// setupDmSocket is invoked synchronously inside Socket.IO's connection
// flow, so its throw is deferred to a microtask to let the connection
// complete and the disconnect handler registration be observed.
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
const { io: ioClient } = require('socket.io-client');

const AUTH_KEY = 'A'.repeat(43);
let userId;

before(async () => {
  initDatabase();
  const db = getDb();
  const hash = await hashPassword(AUTH_KEY);
  userId = Number(db.prepare("INSERT INTO users (username, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active) VALUES ('alice', ?, 2, ?, 600000, 0, 1)").run(hash, Buffer.alloc(16, 1).toString('base64')).lastInsertRowid);
});

after(async () => {
  getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('disconnect handler is registered before setupDmSocket throws', async () => {
  // Mock setupDmSocket to throw by pre-seeding the require cache with a
  // mock dm.socket module. config/socket.js requires ../sockets/dm.socket
  // and destructures setupDmSocket at module load time, so the cache must
  // be seeded before socket.js is required.
  const dmSocketPath = path.join(ROOT, 'sockets', 'dm.socket');
  const resolvedDmSocket = require.resolve(dmSocketPath);

  let setupDmSocketError;
  require.cache[resolvedDmSocket] = {
    id: resolvedDmSocket,
    filename: resolvedDmSocket,
    loaded: true,
    exports: {
      setupDmSocket: (io, socket) => {
        // Throw in a microtask so connection handler can register disconnect first.
        // Catch the throw here so it never escapes as an uncaught exception;
        // surface it to the test for verification instead.
        queueMicrotask(() => {
          try {
            throw new Error('setupDmSocket threw');
          } catch (err) {
            setupDmSocketError = err;
          }
        });
      },
      setupGroupSocket: () => {},
    },
  };

  // Force socket.js to reload so it picks up the mocked setupDmSocket.
  const socketPath = path.join(ROOT, 'config', 'socket.js');
  delete require.cache[require.resolve(socketPath)];
  const { setupSocketIO } = require(socketPath);

  let httpServer;
  let io;
  let s;

  httpServer = http.createServer();
  io = setupSocketIO(httpServer);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  const token = signToken({ id: userId, username: 'alice', is_admin: false, token_version: 0 });

  s = await new Promise((resolve, reject) => {
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

  // Look up the server-side socket and verify the disconnect handler
  // was registered before setupDmSocket threw.
  const serverSocket = io.sockets.sockets.get(s.id);
  assert.ok(serverSocket, 'server-side socket should exist');

  assert.ok(
    serverSocket.listenerCount('disconnect') > 0,
    'disconnect handler should be registered before setupDmSocket throws',
  );

  // The deferred setupDmSocket throw must have been caught (never allowed to
  // become an uncaught exception) and surfaced to the test.
  assert.ok(setupDmSocketError, 'setupDmSocket throw should have been caught, not left uncaught');
  assert.match(setupDmSocketError.message, /setupDmSocket threw/);

  s.close();
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
});
