// One-shot Electron script: writes a "Remember me" unlock key exactly the way
// the pre-Phase-2 app did — sync safeStorage API only — into the app's
// userData dir, so the E2E can prove old keys still decrypt through the
// current read path.
//
// Usage:
//   electron seed-legacy-key.js
// with --user-data-dir pointing at the app's userData and
// E2E_LEGACY_RECORD_ID / E2E_LEGACY_KEY in the environment.
//
// The seed must NOT call app.setName(): os_crypt on Linux scopes its keyring
// entry by application name. The app under test is launched as
// `electron main.js`, whose app name is "Electron"; setting a different name
// here would write to a different keyring entry and the app could not decrypt
// it. The harness compares the two logged names.
//
// It must always exit: a missing keyring or a hung keyring prompt would
// otherwise leave the whole E2E run waiting forever.

'use strict';

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const WATCHDOG_MS = 20000;
const watchdog = setTimeout(() => {
  console.error('[seed] timeout after ' + WATCHDOG_MS + 'ms');
  app.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

function finish(code) {
  clearTimeout(watchdog);
  try {
    app.exit(code);
  } catch (e) {
    process.exit(code);
  }
}

app.whenReady().then(() => {
  try {
    const recordId = process.env.E2E_LEGACY_RECORD_ID;
    const key = process.env.E2E_LEGACY_KEY;

    console.log('[seed] app-name=' + app.getName());

    if (!recordId || !key) {
      console.error('[seed] E2E_LEGACY_RECORD_ID and E2E_LEGACY_KEY are required');
      finish(1);
      return;
    }

    // Pre-Phase-2 code path: sync availability check + sync encryptString.
    // Deliberately no async call here.
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('[seed] sync safeStorage encryption is not available');
      finish(2);
      return;
    }

    const encrypted = safeStorage.encryptString(key);
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      console.error('[seed] encryptString returned no ciphertext');
      finish(4);
      return;
    }
    if (encrypted.subarray(0, 3).toString('latin1') === 'v10') {
      console.error('[seed] refusing to write unprotected v10 ciphertext');
      finish(5);
      return;
    }

    const storePath = path.join(app.getPath('userData'), 'identity-unlock-keys.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({ [recordId]: encrypted.toString('base64') }),
      'utf-8'
    );
    console.log('[seed] wrote legacy key for ' + recordId + ' to ' + storePath);
    finish(0);
  } catch (err) {
    console.error('[seed] failed: ' + (err && err.message ? err.message : err));
    finish(6);
  }
});

// If whenReady never resolves (e.g. Electron cannot start), the watchdog
// above still fires and exits.
