'use strict';

/**
 * Stores exactly one kind of secret: the PBKDF2-derived E2EE
 * identity-unlock key produced by public/js/crypto/identity.js
 * (deriveIdentityUnlockKey). Never the account password, never the
 * raw private key.
 *
 * Backed by Electron's safeStorage, which hands off to the OS
 * keychain (macOS Keychain, Windows DPAPI, libsecret on Linux).
 * The blob this module writes to disk is itself opaque without
 * that OS-level key, which only unlocks for the same OS user
 * account on the same machine.
 *
 * Keyed by "<server origin>::<user id>" so switching servers, or a
 * different account on the same server, never reads another
 * account's cached material.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const STORE_FILE_NAME = 'identity-unlock.json';

function getStorePath() {
  return path.join(app.getPath('userData'), STORE_FILE_NAME);
}

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readAll() {
  try {
    const raw = fs.readFileSync(getStorePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Missing file, first run, or corrupt JSON - treat identically
    // to "nothing cached yet".
    return {};
  }
}

function writeAll(record) {
  const storePath = getStorePath();
  const tmpPath = `${storePath}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmpPath, storePath);
    return true;
  } catch (err) {
    console.error('[secure-store] Failed to write:', err.message);
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Encrypts and persists `plaintextBase64` under `key`.
 * Returns false (and stores nothing) if OS-level encryption isn't
 * available - this never falls back to writing anything
 * unencrypted.
 */
function save(key, plaintextBase64) {
  if (!isAvailable()) return false;
  if (typeof key !== 'string' || !key) return false;
  if (typeof plaintextBase64 !== 'string' || !plaintextBase64) return false;

  const record = readAll();

  try {
    record[key] = safeStorage.encryptString(plaintextBase64).toString('base64');
  } catch (err) {
    console.error('[secure-store] Failed to encrypt:', err.message);
    return false;
  }

  return writeAll(record);
}

/**
 * Returns the decrypted string for `key`, or null if there's
 * nothing stored, OS encryption isn't available, or the stored
 * blob fails to decrypt (e.g. moved to a different machine/user -
 * safeStorage's key material doesn't travel with the file).
 */
function load(key) {
  if (!isAvailable()) return null;
  if (typeof key !== 'string' || !key) return null;

  const record = readAll();
  const encoded = record[key];
  if (typeof encoded !== 'string' || !encoded) return null;

  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch (err) {
    console.error('[secure-store] Failed to decrypt:', err.message);
    return null;
  }
}

function clear(key) {
  if (typeof key !== 'string' || !key) return;

  const record = readAll();
  if (!(key in record)) return;

  delete record[key];
  writeAll(record);
}

module.exports = { isAvailable, save, load, clear };
