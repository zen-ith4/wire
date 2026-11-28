// One-shot Electron script: writes a "Remember me" unlock key encrypted with
// the pre-Phase-2 *sync* safeStorage API into the app's userData dir, so the
// E2E run can prove old keys still decrypt through the new async API.
//
// Usage:
//   electron seed-legacy-key.js
// with --user-data-dir pointing at the app's userData and
// E2E_LEGACY_RECORD_ID / E2E_LEGACY_KEY in the environment.

'use strict';

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// os_crypt on Linux scopes its keyring entry by application name. The real
// app is launched as electron-client/main.js, so Electron derives the name
// from electron-client/package.json. This script lives in e2e/, so set the
// same name explicitly or the seed would use a different keyring entry and
// the app could not decrypt the key it wrote.
app.setName(require(path.join(__dirname, '..', 'package.json')).name);

app.whenReady().then(async () => {
  const recordId = process.env.E2E_LEGACY_RECORD_ID;
  const key = process.env.E2E_LEGACY_KEY;

  if (!recordId || !key) {
    console.error('[seed] E2E_LEGACY_RECORD_ID and E2E_LEGACY_KEY are required');
    app.exit(1);
    return;
  }

  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    console.error('[seed] safeStorage encryption is not available');
    app.exit(2);
    return;
  }

  const encrypted = safeStorage.encryptString(key);
  const storePath = path.join(app.getPath('userData'), 'identity-unlock-keys.json');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({ [recordId]: encrypted.toString('base64') }), 'utf-8');
  console.log('[seed] wrote legacy key for ' + recordId + ' to ' + storePath);
  app.exit(0);
});
