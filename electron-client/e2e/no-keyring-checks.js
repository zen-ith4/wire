// In-page checks for the no-keyring session (--password-store=basic).
//
// Evaluated inside the real Electron renderer over CDP, like page-checks.js.
// Proves that remember-me refuses to store or return an unlock key when
// Chromium's unprotected "basic_text" backend is selected, and that the
// renderer receives exactly the pre-Phase-2 failure shape.

'use strict';

module.exports = String.raw`
(async () => {
  const results = [];
  const add = (name, status, detail) => {
    results.push({ name: name, status: status, detail: detail || '' });
  };
  const ok = (name, detail) => add(name, 'PASS', detail);
  const bad = (name, detail) => add(name, 'FAIL', detail);

  const EXPECTED = 'OS-level secure storage is not available on this system.';
  const API = window.electronAPI;
  const origin = window.location.origin;

  if (!API) {
    bad('nokeyring:preload', 'window.electronAPI is missing');
    return { results: results };
  }

  // 1. store must fail with the same result the pre-Phase-2 sync check
  //    returned, and must not throw.
  try {
    const stored = await API.storeIdentityUnlockKey(origin, 'nokeyring-user', 'nokeyring-key');
    if (stored && stored.success === false && stored.error === EXPECTED) {
      ok('nokeyring:store-refused', JSON.stringify(stored));
    } else {
      bad('nokeyring:store-refused', 'got ' + JSON.stringify(stored));
    }
  } catch (e) {
    bad('nokeyring:store-refused', 'threw: ' + (e && e.message ? e.message : String(e)));
  }

  // 2. get must return null (not a key, not a throw).
  try {
    const got = await API.getIdentityUnlockKey(origin, 'nokeyring-user');
    if (got === null) {
      ok('nokeyring:get-null', 'returned null');
    } else {
      bad('nokeyring:get-null', 'got ' + JSON.stringify(got));
    }
  } catch (e) {
    bad('nokeyring:get-null', 'threw: ' + (e && e.message ? e.message : String(e)));
  }

  // 3. A pre-seeded unprotected v10 record must never be returned; the main
  //    process deletes it (the harness verifies the file afterwards).
  try {
    const legacy = await API.getIdentityUnlockKey(origin, 'v10-user');
    if (legacy === null) {
      ok('nokeyring:v10-not-returned', 'returned null for the v10 record');
    } else {
      bad('nokeyring:v10-not-returned', 'got ' + JSON.stringify(legacy));
    }
  } catch (e) {
    bad('nokeyring:v10-not-returned', 'threw: ' + (e && e.message ? e.message : String(e)));
  }

  return { results: results };
})()
`;
