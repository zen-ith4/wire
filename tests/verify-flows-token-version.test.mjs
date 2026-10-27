// Regression: verifyEmail and verifyTwoFactor load the user row and then call
// issueSession(user). signToken/signPasswordChangeToken throw unless the row
// carries an integer token_version, so both SELECTs must include it. These
// tests drive the real handlers end to end against a real temporary database
// and assert that a valid token comes back (and a password-change token when
// must_change_password = 1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-verify-flows-'));
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
  EMAIL_ENABLED: 'true',
  EMAIL_VERIFICATION_SECRET: 'v'.repeat(32),
  EMAIL_2FA_SECRET: 't'.repeat(32),
});
delete process.env.JWT_SECRET;

const { initDatabase, getDb } = require(path.join(ROOT, 'config', 'database.js'));
const { verifySessionOrPasswordChangeToken } = require(path.join(ROOT, 'utils', 'jwt.js'));
const { verifyEmail, verifyTwoFactor } = require(path.join(ROOT, 'controllers', 'auth.controller.js'));

const HASH = 'x'.repeat(60);
const KDF_SALT = Buffer.alloc(16, 1).toString('base64');

function hmac(secret, code) {
  return crypto.createHmac('sha256', secret).update(code).digest('hex');
}

function insertUser({ name, verified = 1, twoFa = 0, mustChange = 0 }) {
  const db = getDb();
  const id = Number(
    db.prepare(`
      INSERT INTO users
        (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations,
         is_admin, is_active, email_verified, email_2fa_enabled, must_change_password)
      VALUES (?, ?, ?, 2, ?, 600000, 0, 1, ?, ?, ?)
    `).run(name, `${name}@example.test`, HASH, KDF_SALT, verified, twoFa, mustChange).lastInsertRowid
  );
  return id;
}

function insertEmailCode(userId, code) {
  getDb().prepare(`
    INSERT INTO email_verification_codes (user_id, code_hash, expires_at, attempts, created_at)
    VALUES (?, ?, ?, 0, ?)
  `).run(userId, hmac(process.env.EMAIL_VERIFICATION_SECRET, code), Date.now() + 600000, Date.now());
}

function insertTwoFaChallenge(userId, code) {
  return Number(
    getDb().prepare(`
      INSERT INTO email_2fa_codes (user_id, code_hash, expires_at, attempts, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).run(userId, hmac(process.env.EMAIL_2FA_SECRET, code), Date.now() + 600000, Date.now()).lastInsertRowid
  );
}

// Minimal Express-like res, enough for the handlers under test.
async function invoke(handler, body) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler({ body }, res);
  return res;
}

before(() => {
  initDatabase();
});

after(() => {
  getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('verifyEmail returns a session token for a normal account', async () => {
  const userId = insertUser({ name: 'vmail_normal', verified: 0 });
  insertEmailCode(userId, '123456');

  const res = await invoke(verifyEmail, { userId, code: '123456' });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.requiresPasswordChange, undefined);

  const { payload, isPasswordChangeToken } = verifySessionOrPasswordChangeToken(res.body.token);
  assert.equal(isPasswordChangeToken, false);
  assert.equal(payload.id, userId);
  const tv = getDb().prepare('SELECT token_version FROM users WHERE id = ?').get(userId).token_version;
  assert.equal(payload.tv, tv);
});

test('verifyEmail returns a password-change token when must_change_password = 1', async () => {
  const userId = insertUser({ name: 'vmail_mustchange', verified: 0, mustChange: 1 });
  insertEmailCode(userId, '654321');

  const res = await invoke(verifyEmail, { userId, code: '654321' });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.requiresPasswordChange, true);
  const { isPasswordChangeToken, payload } = verifySessionOrPasswordChangeToken(res.body.token);
  assert.equal(isPasswordChangeToken, true);
  assert.equal(payload.id, userId);
});

test('verifyTwoFactor returns a session token for a normal account', async () => {
  const userId = insertUser({ name: 'v2fa_normal', verified: 1, twoFa: 1 });
  const challengeId = insertTwoFaChallenge(userId, '111222');

  const res = await invoke(verifyTwoFactor, { userId, challengeId, code: '111222' });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.token, 'string');
  const { payload, isPasswordChangeToken } = verifySessionOrPasswordChangeToken(res.body.token);
  assert.equal(isPasswordChangeToken, false);
  assert.equal(payload.id, userId);
});

test('verifyTwoFactor returns a password-change token when must_change_password = 1', async () => {
  const userId = insertUser({ name: 'v2fa_mustchange', verified: 1, twoFa: 1, mustChange: 1 });
  const challengeId = insertTwoFaChallenge(userId, '333444');

  const res = await invoke(verifyTwoFactor, { userId, challengeId, code: '333444' });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.requiresPasswordChange, true);
  const { isPasswordChangeToken } = verifySessionOrPasswordChangeToken(res.body.token);
  assert.equal(isPasswordChangeToken, true);
});
