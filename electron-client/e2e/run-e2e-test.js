// Real-Electron end-to-end tests for the Phase 2 hardening.
//
// Runs three independent Electron sessions under xvfb, each with a fresh
// userData dir and a local HTTP test server, and drives the renderer over the
// Chrome DevTools Protocol (no test hooks in preload.js/main.js).
//
//   A. connect from the connect screen, saved server, forget server
//   B. auto-connect after restart + every Phase 2 check + redirect policy
//   C. cross-origin redirect on the first-connect version check is not
//      followed by net.request (the cross-target server must stay silent)
//
// Usage:  xvfb-run -a node e2e/run-e2e-test.js
// Exit:   0 = every assertion passed, 1 = at least one failed.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ELECTRON = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron');
const MAIN_JS = path.join(__dirname, '..', 'main.js');
const TEST_SERVER_JS = path.join(__dirname, 'test-server.js');
const SEED_JS = path.join(__dirname, 'seed-legacy-key.js');
const PAGE_CHECKS = require('./page-checks.js');

const LEGACY_USER = 'e2e-legacy-user';
const LEGACY_KEY = 'e2e-legacy-key-123';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function makeReporter() {
  const rows = [];
  const check = (name, condition, detail) => {
    const status = condition ? 'PASS' : 'FAIL';
    rows.push({ name, status, detail: detail || '' });
    const line = '  ' + status + '  ' + name + (detail ? '  — ' + detail : '');
    console.log(line);
    return condition;
  };
  const section = (title) => console.log('\n=== ' + title + ' ===');
  const summary = () => {
    const failures = rows.filter((r) => r.status === 'FAIL');
    console.log('\n========================================');
    console.log('E2E: ' + (rows.length - failures.length) + ' passed / ' + rows.length + ' total, ' + failures.length + ' failed');
    for (const f of failures) console.log('  FAIL: ' + f.name + ' — ' + f.detail);
    return failures.length;
  };
  return { check, section, summary, rows };
}

function captureOutput(child) {
  const lines = [];
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const line of parts) {
      lines.push(line);
      if (process.env.E2E_VERBOSE === '1') console.log('    | ' + line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return {
    lines,
    text: () => lines.join('\n'),
    has: (needle) => lines.some((l) => l.includes(needle)),
    count: (needle) => lines.filter((l) => l.includes(needle)).length,
    flush: () => {
      if (buffer) {
        lines.push(buffer);
        buffer = '';
      }
    },
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (e) {
      // keep polling
    }
    await sleep(250);
  }
  throw new Error('timed out waiting for ' + label);
}

function killTree(child) {
  if (!child || child.killed) return;
  // Spawned detached, so kill the whole process group (xvfb-run + Xvfb +
  // Electron renderer/GPU children). Fall back to the direct child.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (e) {
    try { child.kill('SIGTERM'); } catch (e2) { /* ignore */ }
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (e) {
      try { child.kill('SIGKILL'); } catch (e2) { /* ignore */ }
    }
  }, 1500).unref();
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

async function cdpTargets(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  if (!res.ok) throw new Error('CDP /json/list returned ' + res.status);
  return res.json();
}

async function waitForTarget(cdpPort, predicate, timeoutMs, label) {
  return waitFor(async () => {
    const targets = await cdpTargets(cdpPort);
    const match = targets.find((t) => t.type === 'page' && predicate(t));
    return match || null;
  }, timeoutMs, label);
}

function cdpEvaluate(wsUrl, expression, timeoutMs) {
  const budget = timeoutMs || 20000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      reject(new Error('CDP evaluate timed out after ' + budget + 'ms'));
    }, budget);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        },
      }));
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.id !== 1) return;
      if (msg.error) {
        finish(new Error('CDP error: ' + JSON.stringify(msg.error)));
        return;
      }
      const result = msg.result || {};
      if (result.exceptionDetails) {
        const ex = result.exceptionDetails.exception;
        finish(new Error('page exception: ' + ((ex && ex.description) || result.exceptionDetails.text)));
        return;
      }
      finish(null, result.result ? result.result.value : undefined);
    };

    ws.onerror = () => finish(new Error('CDP websocket error'));
  });
}

async function evaluateOnTarget(target, expression, timeoutMs) {
  return cdpEvaluate(target.webSocketDebuggerUrl, expression, timeoutMs);
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

function startTestServer(env) {
  const child = spawn(process.execPath, [TEST_SERVER_JS], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const out = captureOutput(child);
  return { child, out };
}

async function waitForServer(serverOut, port) {
  await waitFor(() => serverOut.has('[test-server] listening on http://127.0.0.1:' + port), 8000, 'test server on ' + port);
}

function electronCommand(electronArgs) {
  // Headless Linux (CI/container): no DISPLAY, so wrap in xvfb-run. On a
  // desktop session or Windows/macOS, launch Electron directly.
  if (process.env.DISPLAY) {
    return { cmd: ELECTRON, args: electronArgs };
  }
  return { cmd: 'xvfb-run', args: ['-a', '--', ELECTRON, ...electronArgs] };
}

function launchElectron({ userData, cdpPort, extraEnv }) {
  const { cmd, args } = electronCommand([
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-software-rasterizer',
    '--disable-features=VizDisplayCompositor,GpuProcess',
    '--no-sandbox',
    '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + userData,
    MAIN_JS,
  ]);
  const child = spawn(cmd, args, {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, WIRE_E2E: '1', ...(extraEnv || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const out = captureOutput(child);
  return { child, out };
}

async function seedLegacyKey({ userData, recordId }) {
  const { cmd, args } = electronCommand([
    '--no-sandbox',
    '--user-data-dir=' + userData,
    SEED_JS,
  ]);
  const child = spawn(cmd, args, {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, E2E_LEGACY_RECORD_ID: recordId, E2E_LEGACY_KEY: LEGACY_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const out = captureOutput(child);
  await new Promise((resolve) => child.on('exit', resolve));
  out.flush();
  return out;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function sessionA(report) {
  report.section('A. connect from the connect screen, saved server, forget server');

  const appPort = await findFreePort();
  const crossPort = await findFreePort();
  const cdpPort = await findFreePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-e2e-a-'));
  const configPath = path.join(userData, 'server-config.json');

  const cross = startTestServer({ E2E_ROLE: 'cross-target', E2E_PORT: String(crossPort), E2E_CROSS_PORT: String(crossPort) });
  const main = startTestServer({ E2E_ROLE: 'main', E2E_PORT: String(appPort), E2E_CROSS_PORT: String(crossPort), E2E_VERSION_MODE: 'same' });
  let app = null;

  try {
    await waitForServer(main.out, appPort);
    await waitForServer(cross.out, crossPort);

    app = launchElectron({ userData, cdpPort });
    const connectTarget = await waitForTarget(
      cdpPort,
      (t) => t.url.startsWith('file://') && t.url.includes('connect.html'),
      20000,
      'connect screen'
    );
    report.check('connect-screen:shown', true, connectTarget.url.replace(/^file:\/\/.*\/renderer\//, 'renderer/'));

    const apiPresent = await evaluateOnTarget(connectTarget, 'typeof window.wireClient');
    report.check('connect-screen:wireClient-exposed', apiPresent === 'object', 'typeof window.wireClient === ' + apiPresent);

    // Wait until connect.js has run and attached the submit listener.
    await waitFor(async () => {
      const state = await evaluateOnTarget(connectTarget, 'document.readyState');
      return state === 'complete';
    }, 10000, 'connect screen readyState complete');

    const serverUrl = 'http://127.0.0.1:' + appPort;
    await evaluateOnTarget(
      connectTarget,
      '(() => {' +
        'const i = document.getElementById("address");' +
        'i.value = ' + JSON.stringify(serverUrl) + ';' +
        'const f = document.getElementById("connect-form");' +
        'f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));' +
        'return i.value;' +
      '})()'
    );

    const serverTarget = await waitForTarget(
      cdpPort,
      (t) => t.url === serverUrl + '/',
      25000,
      'server page after connect-screen submit'
    );
    report.check('connect-screen:form-connect', true, serverTarget.url);

    await waitFor(() => fs.existsSync(configPath), 5000, 'server-config.json');
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(configPath, 'utf-8')).serverUrl; } catch (e) { /* ignore */ }
    report.check('connect-screen:config-saved', saved === serverUrl, 'serverUrl=' + saved);

    await evaluateOnTarget(serverTarget, 'window.electronAPI.showConnectScreen()');
    const backTarget = await waitForTarget(
      cdpPort,
      (t) => t.url.startsWith('file://') && t.url.includes('connect.html'),
      15000,
      'connect screen after showConnectScreen'
    );

    const savedServer = await evaluateOnTarget(backTarget, 'window.wireClient.getSavedServer()');
    report.check('connect-screen:get-saved', savedServer === serverUrl, 'getSavedServer()=' + savedServer);

    const forgot = await evaluateOnTarget(backTarget, 'window.wireClient.forgetServer()');
    const afterForget = await evaluateOnTarget(backTarget, 'window.wireClient.getSavedServer()');
    report.check('connect-screen:forget', afterForget === null || afterForget === undefined, 'forgetServer()=' + JSON.stringify(forgot) + ' then getSavedServer()=' + JSON.stringify(afterForget));
    report.check('connect-screen:config-removed', !fs.existsSync(configPath), 'server-config.json exists=' + fs.existsSync(configPath));
  } finally {
    killTree(app && app.child);
    killTree(main.child);
    killTree(cross.child);
    await sleep(800);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

async function sessionB(report) {
  report.section('B. auto-connect after restart + Phase 2 security checks');

  const appPort = await findFreePort();
  const crossPort = await findFreePort();
  const cdpPort = await findFreePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-e2e-b-'));
  const serverUrl = 'http://127.0.0.1:' + appPort;
  fs.writeFileSync(path.join(userData, 'server-config.json'), JSON.stringify({ serverUrl }, null, 2));

  const seed = await seedLegacyKey({ userData, recordId: serverUrl + '::' + LEGACY_USER });
  report.check('seed:legacy-key', seed.has('[seed] wrote legacy key'), 'sync safeStorage.encryptString key written');

  const cross = startTestServer({ E2E_ROLE: 'cross-target', E2E_PORT: String(crossPort), E2E_CROSS_PORT: String(crossPort) });
  const main = startTestServer({ E2E_ROLE: 'main', E2E_PORT: String(appPort), E2E_CROSS_PORT: String(crossPort), E2E_VERSION_MODE: 'same' });
  let app = null;

  try {
    await waitForServer(main.out, appPort);
    await waitForServer(cross.out, crossPort);

    app = launchElectron({ userData, cdpPort });
    const pageTarget = await waitForTarget(cdpPort, (t) => t.url === serverUrl + '/', 25000, 'server page (auto-connect)');
    report.check('auto-connect:after-restart', true, pageTarget.url);

    await evaluateOnTarget(pageTarget, 'window.__E2E__ = ' + JSON.stringify({ legacyUser: LEGACY_USER, legacyKey: LEGACY_KEY }) + '; "ok"');
    const checks = await evaluateOnTarget(pageTarget, PAGE_CHECKS, 90000);

    for (const r of checks.results) {
      report.check(r.name, r.status !== 'FAIL', r.status === 'SKIP' ? 'SKIP: ' + r.detail : r.detail);
    }

    // The claimed origin must be ignored: the record is keyed by the real
    // origin the main process connected to.
    const storePath = path.join(userData, 'identity-unlock-keys.json');
    let store = {};
    try { store = JSON.parse(fs.readFileSync(storePath, 'utf-8')); } catch (e) { /* ignore */ }
    report.check(
      'identity:stored-under-real-origin',
      Object.prototype.hasOwnProperty.call(store, serverUrl + '::spoof-user'),
      'record keys: ' + Object.keys(store).join(', ')
    );
    report.check(
      'identity:no-evil-origin-record',
      !Object.prototype.hasOwnProperty.call(store, 'https://evil.example::spoof-user'),
      'no https://evil.example::spoof-user record'
    );
    report.check(
      'identity:legacy-record-kept',
      Object.prototype.hasOwnProperty.call(store, serverUrl + '::' + LEGACY_USER),
      'legacy record still present'
    );

    // Same-origin redirect in the window must be followed.
    await evaluateOnTarget(pageTarget, 'location.href = "/redirect-same"; "ok"');
    const redirected = await waitForTarget(cdpPort, (t) => t.url === serverUrl + '/?afterRedirect=1', 15000, 'same-origin redirect');
    report.check('navigation:same-origin-redirect-followed', true, redirected.url);

    // Cross-origin redirect in the window must be blocked (page stays put).
    await evaluateOnTarget(redirected, 'location.href = "/redirect-cross"; "ok"');
    await sleep(3000);
    const targetsAfter = await cdpTargets(cdpPort);
    const pageAfter = targetsAfter.find((t) => t.type === 'page');
    report.check(
      'navigation:cross-origin-redirect-blocked',
      pageAfter && pageAfter.url === serverUrl + '/?afterRedirect=1',
      'url after attempt: ' + (pageAfter && pageAfter.url)
    );
    report.check(
      'navigation:cross-origin-target-never-hit',
      cross.out.count('[cross-target] HIT') === 0,
      'cross-target hits: ' + cross.out.count('[cross-target] HIT')
    );

    // net.request followed the same-origin /api/version redirect on first connect.
    report.check(
      'net-request:same-origin-version-redirect-followed',
      main.out.has('GET /api/version-ok'),
      'test server saw GET /api/version-ok'
    );

    // Main-process evidence for permission decisions and notification creation.
    report.check(
      'permission:audio-granted-in-main',
      /permission-request media allowed=true[^\n]*"audio"/.test(app.out.text()),
      'main log shows a granted audio request'
    );
    report.check(
      'permission:no-video-grant-in-main',
      !/permission-request media allowed=true[^\n]*"video"/.test(app.out.text()),
      'no video request was granted in the main process'
    );
    report.check('notification:created-in-main', app.out.has('[e2e] dm-notification-created'), 'main log: dm-notification-created');

    // window.open must reach the deny handler where Chromium allows the
    // scheme through (smb:), and no scheme may be handed to the OS browser.
    // Chromium itself blocks file: popups from an http page before
    // setWindowOpenHandler, so file: is covered by the page-level null
    // result plus the no-open-external assertion below.
    report.check('window-open:handler-saw-smb', app.out.has('[e2e] window-open smb://server/share'), 'main log: window-open smb:');
    report.check('window-open:no-external-call', !app.out.has('[e2e] open-external '), 'main log: no open-external line');
  } finally {
    killTree(app && app.child);
    killTree(main.child);
    killTree(cross.child);
    await sleep(800);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

async function sessionC(report) {
  report.section('C. cross-origin redirect on the first-connect version check (net.request)');

  const appPort = await findFreePort();
  const crossPort = await findFreePort();
  const cdpPort = await findFreePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-e2e-c-'));
  const serverUrl = 'http://127.0.0.1:' + appPort;
  fs.writeFileSync(path.join(userData, 'server-config.json'), JSON.stringify({ serverUrl }, null, 2));

  const cross = startTestServer({ E2E_ROLE: 'cross-target', E2E_PORT: String(crossPort), E2E_CROSS_PORT: String(crossPort) });
  const main = startTestServer({ E2E_ROLE: 'main', E2E_PORT: String(appPort), E2E_CROSS_PORT: String(crossPort), E2E_VERSION_MODE: 'cross' });
  let app = null;

  try {
    await waitForServer(main.out, appPort);
    await waitForServer(cross.out, crossPort);

    app = launchElectron({ userData, cdpPort });
    const pageTarget = await waitForTarget(cdpPort, (t) => t.url === serverUrl + '/', 25000, 'server page');
    report.check('cross-version:app-still-connects', true, pageTarget.url);

    await sleep(3000);
    report.check('net-request:cross-origin-redirect-not-followed', cross.out.count('[cross-target] HIT') === 0, 'cross-target hits: ' + cross.out.count('[cross-target] HIT'));
    report.check('net-request:version-check-attempted', main.out.has('GET /api/version'), 'test server saw GET /api/version');
  } finally {
    killTree(app && app.child);
    killTree(main.child);
    killTree(cross.child);
    await sleep(800);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const report = makeReporter();
  const all = { A: sessionA, B: sessionB, C: sessionC };
  const wanted = (process.env.E2E_SESSIONS || 'A,B,C').split(',').map((s) => s.trim().toUpperCase());
  const sessions = wanted.map((k) => all[k]).filter(Boolean);
  let crashed = 0;

  for (const session of sessions) {
    try {
      await session(report);
    } catch (err) {
      crashed++;
      console.error('  SESSION ERROR: ' + (err && err.message ? err.message : err));
      report.check(session.name + ':completed', false, err && err.message ? err.message : String(err));
    }
  }

  const failures = report.summary();
  process.exit(failures === 0 && crashed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[harness] fatal:', err);
  process.exit(1);
});
