/**
 * Q5 spike (THROWAWAY): Service Worker registration from wire-bundled://app
 * Run: xvfb-run -a node_modules/electron/dist/electron --no-sandbox --disable-gpu spike/test-q5-sw.js
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = 'wire-bundled://app';

protocol.registerSchemesAsPrivileged([{
  scheme: 'wire-bundled',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

app.whenReady().then(async () => {
  protocol.handle('wire-bundled', () => new Response(
`<!doctype html><title>Q5 SW Test</title>
<script>
async function run() {
  const out = { isSecureContext: window.isSecureContext, tests: [] };
  
  // Test 1: Check if navigator.serviceWorker exists
  out.tests.push({ name: 'navigator.serviceWorker exists', ok: 'serviceWorker' in navigator });
  
  // Test 2: Try to register a SW
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    out.tests.push({ name: 'SW register attempt', ok: true, scope: reg.scope });
    console.log('SW registered:', reg.scope);
  } catch (e) {
    out.tests.push({ name: 'SW register attempt', ok: false, error: String(e) });
    console.log('SW register failed:', e);
  }
  
  // Test 3: Check if SW registration is skipped in public/sw.js
  try {
    const resp = await fetch('wire-bundled://app/sw.js');
    const text = await resp.text();
    const skips = text.includes('MEDIA_STREAM_ENABLED') || text.includes('navigator.serviceWorker') || text.includes('self.clients');
    out.tests.push({ name: 'public/sw.js mentions SW', ok: skips, textPreview: text.slice(0, 200) });
  } catch (e) {
    out.tests.push({ name: 'public/sw.js fetch', ok: false, error: String(e) });
  }
  
  return out;
}
// Wait for run() to complete
run().then(r => { window.__q5_result = r; console.log('RESULT READY'); });
</script>`, { headers: { 'content-type': 'text/html' } }));

  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  await win.loadURL(BUNDLED_ORIGIN + '/index.html');
  
  // Wait for result
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    const r = await win.webContents.executeJavaScript('window.__q5_result');
    if (r) {
      console.log('[q5] isSecureContext:', r.isSecureContext);
      r.tests.forEach(t => console.log(`[q5] ${t.name} -> ${t.ok ? 'PASS' : 'FAIL'} ${t.error || ''} ${t.scope ? 'scope=' + t.scope : ''} ${t.textPreview ? 'preview=' + t.textPreview : ''}`));
      break;
    }
  }
  
  win.close();
  app.exit(0);
});
