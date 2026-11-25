/**
 * Q1 spike (THROWAWAY): IndexedDB/localStorage persistence across restarts
 * Run 1: DISPLAY=:0 node_modules/electron/dist/electron --no-sandbox --disable-gpu spike/test-q1-persistence.js
 * Run 2: Q1_SECOND_RUN=1 DISPLAY=:0 node_modules/electron/dist/electron --no-sandbox --disable-gpu spike/test-q1-persistence.js
 * Uses a fixed --user-data-dir to persist data across app restarts.
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = 'wire-bundled://app';

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-q1-'));
console.log('[q1] userData dir:', ud);

app.commandLine.appendSwitch('user-data-dir', ud);

protocol.registerSchemesAsPrivileged([{
  scheme: 'wire-bundled',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

async function runTest(label) {
  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  await win.loadURL(BUNDLED_ORIGIN + '/index.html');
  const r = await win.webContents.executeJavaScript(`
    (async () => {
      const out = { isSecureContext: window.isSecureContext, subtle: !!(crypto && crypto.subtle), tests: [] };
      
      // Test 1: localStorage
      try {
        localStorage.setItem('q1-test-key', 'q1-test-value-' + Date.now());
        const v1 = localStorage.getItem('q1-test-key');
        out.tests.push({ name: 'localStorage write/read', ok: v1 && v1.startsWith('q1-test-value-'), value: v1 });
      } catch (e) { out.tests.push({ name: 'localStorage write/read', ok: false, error: String(e) }); }
      
      // Test 2: IndexedDB
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('q1-test-db', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('store');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('store', 'readwrite');
          tx.objectStore('store').put('q1-test-value-' + Date.now(), 'key1');
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        const v2 = await new Promise((resolve, reject) => {
          const tx = db.transaction('store', 'readonly');
          const req = tx.objectStore('store').get('key1');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        out.tests.push({ name: 'IndexedDB write/read', ok: v2 && v2.startsWith('q1-test-value-'), value: v2 });
        db.close();
      } catch (e) { out.tests.push({ name: 'IndexedDB write/read', ok: false, error: String(e) }); }
      
      return out;
    })()
  `);
  console.log(`[q1] ${label}: isSecureContext=${r.isSecureContext} subtle=${r.subtle}`);
  r.tests.forEach(t => console.log(`[q1] ${label}: ${t.name} -> ${t.ok ? 'PASS' : 'FAIL'} ${t.error ? t.error : ''}`));
  win.close();
  return r;
}

app.whenReady().then(async () => {
  protocol.handle('wire-bundled', () => new Response(
`<!doctype html><title>Q1 Persistence Test</title>`, { headers: { 'content-type': 'text/html' } }));

  if (process.env.Q1_SECOND_RUN === '1') {
    console.log('[q1] Run 2: read data after restart...');
    await runTest('RUN 2 (read after restart)');
  } else {
    console.log('[q1] Run 1: write data...');
    await runTest('RUN 1 (write)');
    console.log('[q1] Run 1 complete. Now run again with Q1_SECOND_RUN=1');
  }
  app.exit(0);
});
