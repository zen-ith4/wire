/**
 * Q6 Spike: Integrity manifest tamper tests
 */

const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = 'wire-bundled://app';

const manifest = { version: '1.0', algorithm: 'SHA-256', files: {} };
function walkDir(dir, basePath = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) walkDir(fullPath, relativePath);
    else if (entry.isFile() && !entry.name.endsWith('.map')) {
      const content = fs.readFileSync(fullPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      manifest.files[relativePath] = { hash: 'sha256-' + hash, size: entry.size, rawHash: hash };
    }
  }
}
walkDir(path.resolve(__dirname, '..', '..', 'public'));
fs.writeFileSync(path.join(__dirname, 'integrity-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('[spike] Integrity manifest generated with', Object.keys(manifest.files).length, 'files');

protocol.registerSchemesAsPrivileged([{
  scheme: 'wire-bundled',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

protocol.handle('wire-bundled', async (request) => {
  const url = new URL(request.url);
  const normalizedPath = path.normalize(url.pathname.slice(1));
  if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
    return new Response('Path traversal blocked', { status: 403 });
  }
  const expected = manifest.files[normalizedPath];
  if (!expected) return new Response('File not in manifest', { status: 404 });
  const fullPath = path.join(__dirname, '..', '..', 'public', normalizedPath);
  try {
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) return new Response('Not found', { status: 404 });
    const publicDir = path.resolve(__dirname, '..', '..', 'public');
    if (!path.resolve(fullPath).startsWith(publicDir)) {
      return new Response('Path traversal blocked', { status: 403 });
    }
    const content = fs.readFileSync(fullPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (hash !== expected.rawHash) {
      console.log('[spike] INTEGRITY MISMATCH:', normalizedPath);
      return new Response('Integrity check failed', { status: 500 });
    }
    const mimeTypes = {
      '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
      '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    };
    const contentType = mimeTypes[path.extname(fullPath).toLowerCase()] || 'application/octet-stream';
    return new Response(content, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
    });
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
});

ipcMain.handle('tamper:backup-file', async (_, relativePath) => {
  try { fs.copyFileSync(path.join(__dirname, '..', '..', 'public', relativePath), path.join(__dirname, '..', '..', 'public', relativePath) + '.bak'); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('tamper:modify-file', async (_, relativePath, modifier) => {
  try {
    const fullPath = path.join(__dirname, '..', '..', 'public', relativePath);
    const modified = Buffer.from(fs.readFileSync(fullPath));
    if (typeof modifier === 'function') modifier(modified);
    else if (typeof modifier === 'number') modified[0] ^= modifier;
    fs.writeFileSync(fullPath, modified);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('tamper:restore-file', async (_, relativePath) => {
  try {
    const fullPath = path.join(__dirname, '..', '..', 'public', relativePath);
    fs.copyFileSync(fullPath + '.bak', fullPath);
    fs.unlinkSync(fullPath + '.bak');
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

async function runTests() {
  console.log('[spike] Starting Q6 integrity tamper tests...');
  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, '..', 'preload.js') },
  });

  win.webContents.on('did-finish-load', async () => {
    console.log('[spike] Page loaded, running integrity tamper tests...');
    const results = { manifestGenerated: true, fileCount: Object.keys(manifest.files).length, tests: [] };
    try { const resp = await win.webContents.executeJavaScript('fetch("wire-bundled://app/index.html").then(r => ({status: resp.status, ok: resp.ok}))'); results.tests.push({ name: 'Valid file request', status: resp.status, success: resp.status === 200 }); }
    catch (e) { results.tests.push({ name: 'Valid file request', success: false, error: e.message }); }
    console.log('[spike] Testing tampered file...');
    const backupResult = await ipcMain.handle('tamper:backup-file', null, 'js/core/api.js');
    if (backupResult.success) {
      const tamperResult = await ipcMain.handle('tamper:modify-file', null, 'js/core/api.js', 0xFF);
      if (tamperResult.success) {
        try { const resp = await fetch('wire-bundled://app/js/core/api.js'); results.tests.push({ name: 'Tampered file (1 byte flipped)', status: resp.status, success: !resp.ok }); }
        catch (e) { results.tests.push({ name: 'Tampered file (1 byte flipped)', success: false, error: e.message }); }
      } else { results.tests.push({ name: 'Backup original file', success: false, error: backupResult.error }); }
    }
    try { const resp = await win.webContents.executeJavaScript('fetch("wire-bundled://app/nonexistent.js").then(r => ({status: resp.status, ok: resp.ok}))'); results.tests.push({ name: 'Path outside manifest', status: resp.status, success: !resp.ok }); }
    catch (e) { results.tests.push({ name: 'Path outside manifest', success: false, error: e.message }); }
    const traversalPaths = ['../etc/passwd', '..%2fetc%2fpasswd', '..%252fetc%252fpasswd', '..\\\\..\\\\windows\\\\system32', '/etc/passwd', 'js/../../etc/passwd'];
    for (let i = 0; i < traversalPaths.length; i++) {
      const travPath = traversalPaths[i];
      try { const resp = await win.webContents.executeJavaScript('fetch("wire-bundled://app/' + travPath + '").then(r => ({status: resp.status, ok: resp.ok}))'); results.tests.push({ name: 'Path traversal: ' + travPath, status: resp.status, success: !resp.ok }); }
      catch (e) { results.tests.push({ name: 'Path traversal: ' + travPath, success: true }); }
    }
    try { const resp = await win.webContents.executeJavaScript('fetch("wire-bundled://app/../../etc/passwd").then(r => ({status: resp.status, ok: resp.ok}))'); results.tests.push({ name: 'Path traversal via fetch', status: resp.status, success: !resp.ok }); }
    catch (e) { results.tests.push({ name: 'Path traversal via fetch', success: true }); }
    fs.writeFileSync(path.join(__dirname, 'q6-tamper-results.json'), JSON.stringify({ manifestGenerated: true, fileCount: Object.keys(manifest.files).length, tests: results.tests }, null, 2));
    console.log('[spike] Integrity tamper test results:', JSON.stringify({ manifestGenerated: true, fileCount: Object.keys(manifest.files).length, tests: results.tests }, null, 2));
    app.quit();
  });

  win.loadURL(BUNDLED_ORIGIN + '/index.html');
}

app.whenReady().then(() => {
  runTests();
});
