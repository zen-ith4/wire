// In-page check suite, evaluated inside the real Electron renderer over CDP
// by e2e/run-e2e-test.js. Kept as a string so the harness can pass it to
// Runtime.evaluate; it runs with the page's real window.electronAPI bridge.
//
// Returns { failures, total, failures_detail, results }.

'use strict';

module.exports = String.raw`
(async () => {
  const results = [];
  const add = (name, status, detail) => {
    results.push({ name: name, status: status, detail: detail || '' });
  };
  const ok = (name, detail) => add(name, 'PASS', detail);
  const bad = (name, detail) => add(name, 'FAIL', detail);
  const skip = (name, detail) => add(name, 'SKIP', detail);

  const API = window.electronAPI;
  const cfg = window.__E2E__ || {};

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)
      ),
    ]);

  if (!API) {
    bad('preload:electronAPI', 'window.electronAPI is missing on the server page');
    return { failures: 1, total: 1, failures_detail: results, results: results };
  }
  ok('preload:electronAPI', 'exposed on server page');

  // The connect-screen-only bridge must NOT exist on a remote page.
  if (typeof window.wireClient === 'undefined') {
    ok('preload:connect-screen-api-hidden', 'window.wireClient is undefined');
  } else {
    bad('preload:connect-screen-api-hidden', 'window.wireClient leaked to the server page');
  }

  // --- 1. IPC round-trip -------------------------------------------------
  try {
    const before = await API.getHardwareAcceleration();
    const set = await API.setHardwareAcceleration(!before);
    const after = await API.getHardwareAcceleration();
    if (set && set.success === true && after === !before) {
      ok('ipc:channel-alive', 'hardware acceleration get/set/get round-trip');
    } else {
      bad('ipc:channel-alive', 'before=' + before + ' set=' + JSON.stringify(set) + ' after=' + after);
    }
    await API.setHardwareAcceleration(before);
  } catch (e) {
    bad('ipc:channel-alive', e && e.message ? e.message : String(e));
  }

  // --- 2. Remember-me: legacy (pre-Phase-2, sync-encrypted) key ----------
  const origin = window.location.origin;
  try {
    const legacy = await API.getIdentityUnlockKey(origin, cfg.legacyUser);
    if (legacy && legacy.unlockKey === cfg.legacyKey) {
      ok('identity:legacy-key-opens', 'pre-Phase-2 sync-encrypted key decrypted');
    } else {
      bad('identity:legacy-key-opens', 'expected legacy key, got ' + JSON.stringify(legacy));
    }
  } catch (e) {
    bad('identity:legacy-key-opens', e && e.message ? e.message : String(e));
  }

  // --- 3. Remember-me: store / get / clear -------------------------------
  const userId = 'e2e-user-' + Date.now();
  const unlockKey = 'e2e-unlock-key-' + Date.now();
  try {
    const stored = await API.storeIdentityUnlockKey(origin, userId, unlockKey);
    if (stored && stored.success === true) {
      ok('identity:store', 'store succeeded');
    } else {
      bad('identity:store', 'store returned ' + JSON.stringify(stored));
    }

    const got = await API.getIdentityUnlockKey(origin, userId);
    if (got && got.unlockKey === unlockKey) {
      ok('identity:get', 'returned the stored key');
    } else {
      bad('identity:get', 'got ' + JSON.stringify(got));
    }

    const cleared = await API.clearIdentityUnlockKey(origin, userId);
    if (cleared === true) {
      ok('identity:clear', 'clear returned true');
    } else {
      bad('identity:clear', 'clear returned ' + JSON.stringify(cleared));
    }

    const afterClear = await API.getIdentityUnlockKey(origin, userId);
    if (!afterClear) {
      ok('identity:get-after-clear', 'returns null after clear');
    } else {
      bad('identity:get-after-clear', 'got ' + JSON.stringify(afterClear));
    }
  } catch (e) {
    bad('identity:store-get-clear', e && e.message ? e.message : String(e));
  }

  // --- 4. Claimed-origin spoofing is ignored (main re-derives origin) ----
  try {
    const spoof = await API.storeIdentityUnlockKey('https://evil.example', 'spoof-user', 'spoof-key');
    if (spoof && spoof.success === true) {
      ok('identity:claimed-origin-ignored', 'stored under the real origin (verified on disk by harness)');
    } else {
      bad('identity:claimed-origin-ignored', 'store returned ' + JSON.stringify(spoof));
    }
  } catch (e) {
    bad('identity:claimed-origin-ignored', e && e.message ? e.message : String(e));
  }

  // --- 5. Desktop notification via IPC -----------------------------------
  try {
    if (typeof API.showDmNotification !== 'function') {
      bad('notification:dm', 'showDmNotification is not exposed');
    } else {
      API.showDmNotification({
        conversationId: 42,
        senderName: 'E2E Test',
        preview: 'hello',
      });
      ok('notification:dm', 'showDmNotification accepted by main (see harness log)');
    }
  } catch (e) {
    bad('notification:dm', e && e.message ? e.message : String(e));
  }

  // --- 6. window.open file: / smb: must never reach the OS --------------
  const deniedPopup = (name, url) => {
    try {
      const win = window.open(url, '_blank');
      if (win === null) {
        ok(name, 'window.open returned null');
      } else {
        bad(name, 'window.open returned a window');
        try { win.close(); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      ok(name, 'threw: ' + (e && e.message ? e.message : String(e)));
    }
  };
  deniedPopup('window-open:file-denied', 'file:///etc/passwd');
  deniedPopup('window-open:smb-denied', 'smb://server/share');

  // --- 7. Clipboard write (allowed for the current server origin) --------
  try {
    await withTimeout(navigator.clipboard.writeText('wire-e2e-clipboard'), 5000, 'clipboard.writeText');
    ok('permission:clipboard-write', 'writeText resolved');
  } catch (e) {
    bad('permission:clipboard-write', e && e.message ? e.message : String(e));
  }

  // --- 8. Fullscreen (allowed for the current server origin) ------------
  try {
    await withTimeout(document.documentElement.requestFullscreen(), 5000, 'requestFullscreen');
    const isFs = !!document.fullscreenElement;
    if (isFs) {
      ok('permission:fullscreen', 'document entered fullscreen');
      try { await document.exitFullscreen(); } catch (e) { /* ignore */ }
    } else {
      bad('permission:fullscreen', 'requestFullscreen resolved but fullscreenElement is null');
    }
  } catch (e) {
    bad('permission:fullscreen', e && e.message ? e.message : String(e));
  }

  // --- 9. Camera must be denied ------------------------------------------
  try {
    const status = await withTimeout(
      navigator.permissions.query({ name: 'camera' }),
      5000,
      'permissions.query(camera)'
    );
    if (status.state === 'denied') {
      ok('permission:camera-denied', 'permissions.query(camera) -> denied');
    } else {
      bad('permission:camera-denied', 'permissions.query(camera) -> ' + status.state);
    }
  } catch (e) {
    bad('permission:camera-denied', 'permissions.query(camera) failed: ' + (e && e.message ? e.message : String(e)));
  }

  // No camera stream may ever be acquired either.
  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ video: true, audio: false }),
      8000,
      'getUserMedia(video)'
    );
    stream.getTracks().forEach((t) => t.stop());
    bad('permission:camera-stream-denied', 'camera stream was GRANTED (should be denied)');
  } catch (e) {
    const name = e && e.name ? e.name : 'Error';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      ok('permission:camera-stream-denied', 'rejected with ' + name);
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      ok('permission:camera-stream-denied', 'no camera device present; permission already denied');
    } else {
      bad('permission:camera-stream-denied', 'unexpected rejection: ' + name + ': ' + (e && e.message));
    }
  }

  // --- 10. Microphone must be allowed -----------------------------------
  try {
    const status = await withTimeout(
      navigator.permissions.query({ name: 'microphone' }),
      5000,
      'permissions.query(microphone)'
    );
    if (status.state === 'granted') {
      ok('permission:microphone-state', 'permissions.query(microphone) -> granted');
    } else {
      bad('permission:microphone-state', 'permissions.query(microphone) -> ' + status.state);
    }
  } catch (e) {
    bad('permission:microphone-state', 'permissions.query(microphone) failed: ' + (e && e.message ? e.message : String(e)));
  }

  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ video: false, audio: true }),
      8000,
      'getUserMedia(audio)'
    );
    ok('permission:microphone', 'microphone stream acquired');
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    const name = e && e.name ? e.name : 'Error';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      // Permission was granted (Chromium checks permission before devices);
      // the container simply has no capture device.
      ok('permission:microphone', 'granted, no audio device present (' + name + ')');
    } else {
      bad('permission:microphone', name + ': ' + (e && e.message));
    }
  }

  // --- 11. Renderer Web Notification API must be denied -----------------
  try {
    const perm = await withTimeout(Notification.requestPermission(), 5000, 'Notification.requestPermission');
    if (perm === 'denied') {
      ok('permission:renderer-notification-denied', 'Notification.requestPermission() -> denied');
    } else {
      bad('permission:renderer-notification-denied', 'got ' + perm);
    }
  } catch (e) {
    bad('permission:renderer-notification-denied', e && e.message ? e.message : String(e));
  }

  const failures = results.filter((r) => r.status === 'FAIL').length;
  return {
    failures: failures,
    total: results.length,
    failures_detail: results.filter((r) => r.status === 'FAIL'),
    results: results,
  };
})()
`;
