// P0-3: a session can be revoked by bumping users.token_version. Every
// session-token check (HTTP authenticate, password-change token, the Bearer
// path of mediaAuth, and the Socket.IO handshake) must reject a token whose
// version no longer matches the account. Tokens minted before the column
// existed carry no `tv` claim and count as version 0.
//
// Runs against a real temporary SQLite database with the real schema and
// migrations, the real middleware, and a real Socket.IO server.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-token-version-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  DB_PATH: path.join(tmp, 'test.db'),
  USER_DATA_ROOT: path.join(tmp, 'user-data'),
  CHAT_UPLOAD_DIR: path.join(tmp, 'chat'),
  DM_UPLOAD_DIR: path.join(tmp, 'dm'),
  AVATAR_DIR: path.join(tmp, 'avatars'),
  BANNER_DIR: path.join(tmp, 'banners'),
  GROUP_UPLOAD_DIR: path.join(tmp, 'group'),
});
delete process.env.JWT_SECRET; // a per-process random secret is fine here

const constants = require(path.join(ROOT, 'config', 'constants.js'));
const jwt = require('jsonwebtoken');
const { initDatabase, getDb } = require(path.join(ROOT, 'config', 'database.js'));
const { signToken, signPasswordChangeToken } = require(path.join(ROOT, 'utils', 'jwt.js'));
const { authenticate, authenticatePasswordChange } = require(path.join(ROOT, 'middleware', 'authenticate.js'));
const { mediaAuth, avatarMediaAuth, folderFileMediaAuth } = require(path.join(ROOT, 'middleware', 'mediaAuth.js'));
const { setupSocketIO } = require(path.join(ROOT, 'config', 'socket.js'));
const { changeCredentialsV2 } = require(path.join(ROOT, 'services', 'user.service.js'));
const { changePassword } = require(path.join(ROOT, 'controllers', 'me.controller.js'));
const { hashPassword } = require(path.join(ROOT, 'utils', 'password.js'));
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
const bump = () =>
  db().prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);

// A session token minted at a given version, as login would mint it.
const sessionAt = (version) =>
  signToken({ id: userId, username: 'alice', is_admin: false, token_version: version });

// A token from before this change: no `tv` claim at all.
const legacyToken = () =>
  jwt.sign({ id: userId, username: 'alice', is_admin: false }, constants.JWT_SECRET, { expiresIn: '1h' });

function fakeRes() {
  return {
    code: 200,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// The three middlewares are synchronous: report whether next() ran.
function runSync(mw, req) {
  const res = fakeRes();
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, status: res.code, body: res.body };
}

const bearer = (token) => ({ headers: { authorization: 'Bearer ' + token }, query: {}, params: {}, baseUrl: '/api/files' });

function httpPasses(token) {
  return runSync(authenticate, bearer(token)).passed;
}

function mediaPasses(token) {
  return runSync(mediaAuth, bearer(token)).passed;
}

function socketConnects(token) {
  return new Promise((resolve) => {
    const s = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => { s.close(); resolve(true); });
    s.on('connect_error', () => { s.close(); resolve(false); });
  });
}

async function allThreePass(token) {
  return { http: httpPasses(token), media: mediaPasses(token), socket: await socketConnects(token) };
}

// ---- tests ------------------------------------------------------------

test('migration adds users.token_version as NOT NULL DEFAULT 0', () => {
  const col = db().prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'token_version');
  assert.ok(col, 'column missing');
  assert.equal(col.notnull, 1);
  assert.equal(col.dflt_value, '0');
});

test('signToken embeds the version as tv and refuses to sign without one', () => {
  const claims = jwt.decode(sessionAt(3));
  assert.equal(claims.tv, 3);
  assert.throws(() => signToken({ id: userId, username: 'alice' }), /token_version/);
});

test('current token works on all three paths before any bump', async () => {
  assert.equal(storedVersion(), 0);
  assert.deepEqual(await allThreePass(sessionAt(0)), { http: true, media: true, socket: true });
});

test('a token from before the migration (no tv claim) counts as version 0 and still works', async () => {
  assert.deepEqual(await allThreePass(legacyToken()), { http: true, media: true, socket: true });
});

test('after a bump, tokens from the old version are rejected on all three paths', async () => {
  bump();
  assert.equal(storedVersion(), 1);
  assert.deepEqual(await allThreePass(sessionAt(0)), { http: false, media: false, socket: false });
  assert.deepEqual(await allThreePass(legacyToken()), { http: false, media: false, socket: false });
});

test('a token minted at the new version is accepted on all three paths', async () => {
  assert.deepEqual(await allThreePass(sessionAt(storedVersion())), { http: true, media: true, socket: true });
});

test('password-change token is rejected once the version moves on', () => {
  db().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(userId);
  const pcr = (v) => signPasswordChangeToken({ id: userId, username: 'alice', token_version: v });
  const check = (t) => runSync(authenticatePasswordChange, bearer(t)).passed;

  assert.equal(check(pcr(storedVersion())), true);
  bump();
  assert.equal(check(pcr(storedVersion() - 1)), false);
  db().prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(userId);
});

test('changeCredentialsV2 bumps token_version and reports the new value', async () => {
  const before = storedVersion();
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
  assert.equal(result.tokenVersion, before + 1);
  // Restore the known auth key for the controller test below.
  await changeCredentialsV2(userId, {
    currentHash: db().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash,
    newAuthKey: AUTH_KEY,
    kdfSalt: Buffer.alloc(16, 3).toString('base64'),
    kdfIterations: 650000,
    identity: null,
  });
});

test('PUT /me/password answers with a fresh token so this device stays signed in', async () => {
  const stale = sessionAt(storedVersion());
  assert.equal(httpPasses(stale), true);

  const res = fakeRes();
  let body;
  res.json = (b) => { body = b; return res; };
  await changePassword(
    {
      body: {
        current_auth_key: AUTH_KEY,
        new_auth_key: 'C'.repeat(43),
        new_kdf_salt: Buffer.alloc(16, 4).toString('base64'),
        new_kdf_iterations: 650000,
      },
      user: { id: userId, username: 'alice', is_admin: false },
    },
    res
  );

  assert.equal(res.code, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.ok(body.token, 'response must carry a new session token');
  assert.equal(jwt.decode(body.token).tv, storedVersion());

  // The new token works; the one that was in use before the change does not.
  assert.equal(httpPasses(body.token), true);
  assert.equal(httpPasses(stale), false);
});

test('file-preview and avatar Bearer paths also reject a revoked token', () => {
  const current = storedVersion();
  const fileReq = (t) => ({ headers: { authorization: 'Bearer ' + t }, query: {}, params: { folderId: '1' }, baseUrl: '/api/files' });
  const avatarReq = (t) => ({ headers: { authorization: 'Bearer ' + t }, query: {}, params: { userId: String(userId) }, baseUrl: '/api/me' });

  assert.equal(runSync(folderFileMediaAuth, fileReq(sessionAt(current))).passed, true);
  assert.equal(runSync(avatarMediaAuth, avatarReq(sessionAt(current))).passed, true);

  bump();
  const stale = sessionAt(current);
  assert.equal(runSync(folderFileMediaAuth, fileReq(stale)).passed, false);
  assert.equal(runSync(avatarMediaAuth, avatarReq(stale)).passed, false);
});
