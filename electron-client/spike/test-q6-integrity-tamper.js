/**
 * Q6 Spike: Integrity manifest tamper tests
 * Tests that protocol handler verifies integrity and rejects tampered files
 */

const { app, protocol, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = `${BUNDLED_SCHEME}://app`;

const manifest = { version: '1.0', algorithm: 'SHA-256', files: {} };
function walkDir(dir, basePath = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) walkDir(fullPath, relativePath);
    else if (entry.isFile() && !entry.name.endsWith('.map')) {
      const content = fs.readFileSync(fullPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      manifest.files[relativePath] = { hash: `sha256-${hash}`, size: entry.size, rawHash: hash };
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

app.whenReady().then(async () => {
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
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "connect-src 'self' wire-bundled:* http://192.168.1.14:* http://127.0.0.1:*;",
        },
      });
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });

  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, '..', 'preload.js') },
  });

  win.webContents.on('did-finish-load', async () => {
    console.log('[spike] Page loaded, running integrity tamper tests...');
    const results = { manifestGenerated: true, fileCount: Object.keys(manifest.files).length, tests: [] };
    
    // Test 1: Valid file
    try { const resp = await win.webContents.executeJavaScript('fetch("wire-bundled://app/index.html").then(r => ({status: resp.status, ok: resp.ok}))'); results.tests.push({ name: 'Valid file request', status: resp.status, success: resp.status === 200 }); }
    catch (e) { results.tests.push({ name: 'Valid file request', success: false, error: e.message }); }
    
    // Test 2: Tampered file
    console.log('[spike] Testing tampered file...');
    const fullPath = path.join(__dirname, '..', '..', 'public', 'js', 'core', 'api.js');
    const originalContent = fs.readFileSync(fullPath);
    fs.copyFileSync(fullPath, fullPath + '.bak');
    const modified = Buffer.from(originalContent);
    modified[0] = modified[0] ^= 0xFF;
    fs.writeFileSync(fullPath, modified);
    try {
      const resp = await win.webContents.executeJavaScript('fetch("wire-bundled://app/js/core/api.js").then(r => ({status: resp.status, ok: resp.ok}))');
      results.tests.push({ name: 'Tampered file (1 byte flipped)', status: resp.status, success: resp.status === 500 });
    } catch (e) {
      results.tests.push({ name: 'Tampered file (1 byte flipped)', success: false, error: e.message });
    }
    fs.copyFileSync(fullPath + '.bak', fullPath);
    fs.unlinkSync(fullPath + '.bak');
    
    // Test 3: Path outside manifest
    try { const resp = await win.webContents.executeJavaScript('fetch("wire-bundled://app/nonexistent.js").then(r => ({status: resp.status, ok: resp.ok}))'); results.tests.push({ name: 'Path outside manifest', status: resp.status, success: resp.status === 404 }); }
    catch (e) { results.tests.push({ name: 'Path outside manifest', success: false, error: e.message }); }
    
    // Test 4: Path traversal attempts
    const traversalPaths = ['../etc/passwd', '..%2fetc%2fpasswd', '..%252fetc%252fpasswd', '..\\\\..\\\\windows\\\\system32', '/etc/passwd', 'js/../../etc/passwd'];
    for (let i = 0; i < traversalPaths.length; i++) {
      const travPath = traversalPaths[i];
      try { const resp = await win.webContents.executeJavaScript('fetch("wire-bundled://app/' + travPath + '").then(r => ({status: resp.status, ok: resp.ok}))'); results.tests.push({ name: 'Path traversal: ' + travPath, status: resp.status, success: !resp.ok }); }
      catch (e) { results.tests.push({ name: 'Path traversal: ' + travPath, success: true }); }
    }
    
    // Test 5: Path traversal via fetch
    try { const resp = await win.webContents.executeJavaScript('fetch("wire-bundled://app/../../etc/passwd").then(r => ({status: resp.status, ok: resp.ok}))'); results.tests.push({ name: 'Path traversal via fetch', status: resp.status, success: !resp.ok }); }
    catch (e) { results.tests.push({ name: 'Path traversal via fetch', success: true }); }
    
    fs.writeFileSync(path.join(__dirname, 'q6-tamper-results.json'), JSON.stringify({ manifestGenerated: true, fileCount: Object.keys(manifest.files).length, tests: results.tests }, null, 2));
    console.log('[spike] Integrity tamper test results:', JSON.stringify({ manifestGenerated: true, fileCount: Object.keys(manifest.files).length, tests: results.tests }, null, 2));
    app.quit();
  });

  win.loadURL(`${BUNDLED_ORIGIN}/index.html`);
});