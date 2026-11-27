// C4: config/socket.js registers the 'disconnect' handler BEFORE
// setupDmSocket / setupGroupSocket are called. If one of those setups
// throws SYNCHRONOUSLY, disconnect cleanup still runs.
//
// This test runs the real server in a CHILD PROCESS with only
// sockets/dm.socket.js mocked to throw synchronously. The child then runs the
// disconnect listeners the server actually registered and reports the REAL
// cleanup effect: the user is offline again and last_seen_at was written to
// the database. With the handler after setup, both are missing.
// The test passes with current order and fails when handler is moved after setup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = 'test-secret-key-that-is-at-least-32-chars-long';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

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

const { initDatabase, getDb } = require(path.join(ROOT, 'config', 'database.js'));
const { signToken } = require(path.join(ROOT, 'utils', 'jwt.js'));
const { hashPassword } = require(path.join(ROOT, 'utils', 'password.js'));
const { io: ioClient } = require('socket.io-client');
const { isOnline } = require(path.join(ROOT, 'services', 'presence.service.js'));

const AUTH_KEY = 'A'.repeat(43);
let userId;
let parentDb = null;

before(async () => {
  initDatabase();
  parentDb = getDb();
  const hash = await hashPassword(AUTH_KEY);
  userId = Number(parentDb.prepare("INSERT INTO users (username, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active) VALUES ('alice', ?, 2, ?, 600000, 0, 1)").run(hash, Buffer.alloc(16, 1).toString('base64')).lastInsertRowid);
  parentDb.pragma('wal_checkpoint = TRUNCATE');
});

after(async () => {
  if (parentDb) parentDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runSyncThrowTest() {
  return new Promise((resolve, reject) => {
    const serverScript = path.join(ROOT, 'tests', '_socket-test-server.mjs');
    let timeout = null;
    let waitForPort = null;
    const child = spawn(process.execPath, [
      '--experimental-test-module-mocks',
      '--env-file=tests/test.env',
      path.join(ROOT, 'tests', '_socket-test-server.mjs')
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        DB_PATH: path.join(tmp, 'test.db'),
        USER_DATA_ROOT: path.join(tmp, 'user-data'),
        CHAT_UPLOAD_DIR: path.join(tmp, 'chat'),
        DM_UPLOAD_DIR: path.join(tmp, 'dm'),
        AVATAR_DIR: path.join(tmp, 'avatars'),
        BANNER_DIR: path.join(tmp, 'banners'),
        GROUP_UPLOAD_DIR: path.join(tmp, 'group'),
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars-long'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let serverPort = null;
    let listenerCount = null;
    let cleanupOffline = null;
    let cleanupLastSeen = null;
    let childExited = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdoutBuffer += output;
      const listenerMatch = output.match(/DISCONNECT_LISTENER_COUNT:(\d+)/);
      if (listenerMatch) listenerCount = parseInt(listenerMatch[1], 10);
      const offlineMatch = output.match(/CLEANUP_OFFLINE:(true|false)/);
      if (offlineMatch) cleanupOffline = offlineMatch[1] === 'true';
      const lastSeenMatch = output.match(/CLEANUP_LAST_SEEN:(true|false)/);
      if (lastSeenMatch) cleanupLastSeen = lastSeenMatch[1] === 'true';
      const portMatch = output.match(/SERVER_PORT:(\d+)/);
      if (portMatch) serverPort = parseInt(portMatch[1], 10);
    });

    child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      console.error('[Child stderr]:', data.toString());
    });

    child.on('exit', (code, signal) => {
      childExited = true;
      clearTimeout(timeout);
      clearInterval(waitForPort);
      console.log('[Child exit] code:', code, 'signal:', signal);
      console.log('[Child stdout]:', stdoutBuffer);
      console.log('[Child stderr]:', stderrBuffer);
      if (code === 0) {
        if (serverPort && listenerCount !== null) resolve({ port: serverPort, listenerCount, cleanupOffline, cleanupLastSeen });
        else reject(new Error('Child exited without providing port or listener count'));
      } else {
        reject(new Error(`Child process exited with code ${code}, signal ${signal}`));
      }
    });

    child.on('error', reject);

    waitForPort = setInterval(() => {
      if (serverPort) {
        clearInterval(waitForPort);
        const token = signToken({ id: userId, username: 'alice', is_admin: false, token_version: 0 });
        const socket = ioClient(`http://127.0.0.1:${serverPort}`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
        socket.on('connect', () => console.log('[Parent] Connected'));
        socket.on('disconnect', () => console.log('[Parent] Disconnected'));
        socket.on('connect_error', (err) => console.log('[Parent] Connect error:', err.message));
      }
    }, 100);

    timeout = setTimeout(() => {
      clearInterval(waitForPort);
      if (!childExited) { child.kill('SIGTERM'); reject(new Error('Child process timeout')); }
    }, 15000);
  });
}

test('disconnect handler is registered before setupDmSocket throws synchronously', async () => {
  parentDb.prepare('UPDATE users SET last_seen_at = NULL WHERE id = ?').run(userId);
  const { listenerCount, cleanupOffline, cleanupLastSeen } = await runSyncThrowTest();
  assert.ok(listenerCount >= 1, `Disconnect handler should be registered before setupDmSocket is called (listenerCount was ${listenerCount})`);
  assert.equal(cleanupOffline, true, 'running the registered handlers must mark the user offline');
  assert.equal(cleanupLastSeen, true, 'running the registered handlers must write last_seen_at');
  const row = parentDb.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId);
  assert.ok(row.last_seen_at, 'last_seen_at was persisted to the real database by the disconnect cleanup');
});