// utils/credentials.js
//
// Server side of the "the server never sees the password" scheme (F12).
//
// The browser (public/js/crypto/credentials.js) runs
//     master  = PBKDF2-SHA256(password, kdf_salt, 600000)
//     authKey = HKDF-SHA256(master, info "Wire-Auth-v1")          -> sent to the server
//     wrapKey = HKDF-SHA256(master, info "Wire-Identity-Wrap-v1") -> never leaves the browser
// The server only ever receives `authKey` (43 base64url chars), treats it exactly
// like a password (bcrypt, see utils/password.js) and cannot compute wrapKey from
// it: HKDF outputs under different info labels are independent.
//
// This file validates what the browser sends, serves the per-account salt, and
// contains a Node implementation of the same derivation for the two places where
// the SERVER HOST itself is handed a plaintext password by its operator (the
// first-run setup wizard and the DEFAULT_ADMIN_PASS seed). It must stay
// byte-identical to the browser module (tests/groups/group-hardening-f12 checks).

const crypto = require('crypto');
const constants = require('../config/constants');

const KDF_ITERATIONS = 600000;
const KDF_SALT_BYTES = 16;
const AUTH_INFO = 'Wire-Auth-v1';
const WRAP_INFO = 'Wire-Identity-Wrap-v1';
const IDENTITY_KDF_NAME = 'PBKDF2-SHA-256+HKDF-SHA-256';
const IDENTITY_VERSION = 2;

const AUTH_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

function isValidAuthKey(v) {
  return typeof v === 'string' && AUTH_KEY_RE.test(v);
}

function isValidKdfSalt(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(v)) return false;
  return Buffer.from(v, 'base64').length === KDF_SALT_BYTES;
}

function isValidIterations(n) {
  return Number.isInteger(n) && n >= KDF_ITERATIONS && n <= 10_000_000;
}

// Served before login for names that do not exist, so "unknown user" looks like
// "known user": a deterministic salt only the server can compute.
function fakeKdfSalt(username) {
  const key = crypto.createHash('sha256').update(`wire-fake-kdf-salt|${constants.JWT_SECRET}`).digest();
  const mac = crypto.createHmac('sha256', key).update(String(username).toLowerCase()).digest();
  return mac.subarray(0, KDF_SALT_BYTES).toString('base64');
}

function toB64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Node twin of public/js/crypto/credentials.js deriveCredentials().
function deriveCredentialsNode(password, saltB64, iterations = KDF_ITERATIONS) {
  const master = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(saltB64, 'base64'), iterations, 32, 'sha256');
  const zeroSalt = Buffer.alloc(32);
  const authKey = Buffer.from(crypto.hkdfSync('sha256', master, zeroSalt, Buffer.from(AUTH_INFO), 32));
  const wrapKey = Buffer.from(crypto.hkdfSync('sha256', master, zeroSalt, Buffer.from(WRAP_INFO), 32));
  master.fill(0);
  return { authKey: toB64Url(authKey), wrapKey };
}

function newKdfSalt() {
  return crypto.randomBytes(KDF_SALT_BYTES).toString('base64');
}

module.exports = {
  KDF_ITERATIONS,
  IDENTITY_KDF_NAME,
  IDENTITY_VERSION,
  isValidAuthKey,
  isValidKdfSalt,
  isValidIterations,
  fakeKdfSalt,
  newKdfSalt,
  deriveCredentialsNode,
};
