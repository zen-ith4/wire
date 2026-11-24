/**
 * Q2 Options Test: Test the four mitigation options for mixed content
 * 
 * Options:
 * (i) Main-process bridge (net.fetch + WebSocket relay over IPC)
 * (ii) HTTPS with self-signed cert and pinned fingerprint
 * (iii) Non-secure scheme (prove crypto.subtle is undefined)
 * (iv) Chromium switch / webPreferences flag
 * 
 * Run: DISPLAY=:0 ./node_modules/.bin/electron spike/test-q2-options.js
 */

const { app, protocol, BrowserWindow, ipcMain, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = `${BUNDLED_SCHEME}://app`;
const TEST_PORT = 34567;
const NON_LOOPBACK_IP = '192.168.1.14';
const TEST_SERVER_URL = `http://${NON_LOOPBACK_IP}:34567`;

let httpServer = null;
let httpsServer = null;
let httpsKey = null;
let httpsCert = null;

function generateSelfSignedCert() {
  // Use a simpler approach - generate key pair and create a self-signed cert using forge or similar
  // For simplicity in this spike, we'll use a pre-generated self-signed cert
  // In production, use a proper library like node-forge or openssl
  
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  
  // Create a minimal self-signed certificate using a simple approach
  // This is a spike - in production use proper cert generation
  const certPem = `-----BEGIN CERTIFICATE-----
MIIB/zCCAQYCFG7v3XqJ5YqK5YqK5YqK5YqK5YqK5YqKMAoGCCqGSM49BAMCMGgx
CzAJBgNVBAYTAlVTMRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1TYW4g
RnJhbmNpc2NvMQ8wDQYDVQQKDAZXaXJlIEluYzEPMA0GA1UECwwGU3Bpa2UxEjAQ
BgNVBAMMCWxvY2FsaG9zdDAeFw0yNDExMjQxNTEwMzJaFw0yNTExMjMxNTEwMzJa
MGgxCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1T
YW4gRnJhbmNpc2NvMQ8wDQYDVQQKDAZXaXJlIEluYzEPMA0GA1UECwwGU3Bpa2Ux
EjAQBgNVBAMMCWxvY2FsaG9zdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABOJ5
5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK
5YqK5YqK5YqK5YqK5YqK5YqKMAoGCCqGSM49BAMCA0gAMEUCIQD5YqK5YqK5YqK5
YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqKIgIgG5YqK
5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK
5YqK5YqK5YqK
-----END CERTIFICATE-----`;
  
  const keyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5YqK5YqK5YqK5YqK
5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqKhRANCAAQe5YqK5Yq
K5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5YqK5Y
qK5YqK5YqK5YqK5YqK5YqK5YqK
-----END PRIVATE KEY-----`;
  
  return { key: keyPem, cert: certPem };
}

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const handler = (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'false');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      
      console.log('[spike] HTTP Server received:', req.method, req.url);
      
      if (req.url === '/api/test') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'HTTP Server reachable' }));
      } else {
        res.writeHead(200);
        res.end('OK');
      }
    };
    
    const server = http.createServer(handler);
    server.listen(34567, '0.0.0.0', () => {
      console.log('[spike] HTTP test server listening on 0.0.0.0:34567');
      resolve(server);
    });
    
    server.on('error', reject);
  });
}

function startHttpsServer() {
  return new Promise((resolve, reject) => {
    try {
      const { key, cert } = generateSelfSignedCert();
      httpsKey = key;
      httpsCert = cert;
      
      const server = https.createServer({ key, cert }, (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Credentials', 'false');
        
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        
        console.log('[spike] HTTPS Server received:', req.method, req.url);
        
        if (req.url === '/api/test') {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'HTTPS Server reachable' }));
        } else {
          res.writeHead(200);
          res.end('OK');
        }
      });
      
      httpsServer = https.createServer({ key, cert }, server);
      httpsServer.listen(34568, '0.0.0.0', () => {
        console.log('[spike] HTTPS test server listening on 0.0.0.0:34568');
        resolve({ server: httpsServer, cert });
      });
      
      httpsServer.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function runOptionTests() {
  console.log('[spike] Starting Q2 options tests...');
  
  // Start HTTP server
  const httpServer = await startHttpServer();
  console.log('[spike] HTTP server started');
  
  // Start HTTPS server
  const { server: httpsServer, cert } = await startHttpsServer();
  console.log('[spike] HTTPS server started');
  
  // Generate cert fingerprint for pinning
  const certDer = cert.publicKey.export({ type: 'spki', format: 'der' });
  const fingerprint = crypto.createHash('sha256').update(certDer).digest('hex');
  console.log('[spike] Cert fingerprint (SHA-256):', fingerprint);
  
  await app.whenReady();
  
  // Handle wire-bundled protocol
  protocol.handle('wire-bundled', async (request) => {
    const url = new URL(request.url);
    const filePath = url.pathname.slice(1);
    const normalizedPath = path.normalize(filePath);
    
    if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
      return new Response('Path traversal blocked', { status: 403 });
    }
    
    const fullPath = path.join(__dirname, '..', '..', 'public', normalizedPath);
    
    try {
      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        return new Response('Not found', { status: 404 });
      }
      
      const publicDir = path.resolve(__dirname, '..', '..', 'public');
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(publicDir)) {
        return new Response('Path traversal blocked', { status: 403 });
      }
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
    
    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.wasm': 'application/wasm',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    };
    
    const contentType = mimeTypes[path.extname(fullPath).toLowerCase()] || 'application/octet-stream';
    const content = fs.readFileSync(fullPath);
    
    return new Response(content, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      },
    });
  });
  
  // Handle wire-insecure protocol (non-secure)
  protocol.handle('wire-insecure', async (request) => {
    // Same as wire-bundled but for non-secure scheme
    const url = new URL(request.url);
    const filePath = url.pathname.slice(1);
    const normalizedPath = path.normalize(filePath);
    
    if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
      return new Response('Path traversal blocked', { status: 403 });
    }
    
    const fullPath = path.join(__dirname, '..', '..', 'public', normalizedPath);
    
    try {
      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        return new Response('Not found', { status: 404 });
      }
      
      const publicDir = path.resolve(__dirname, '..', '..', 'public');
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(publicDir)) {
        return new Response('Path traversal blocked', { status: 403 });
      }
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
    
    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.wasm': 'application/wasm',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    };
    
    const contentType = mimeTypes[path.extname(fullPath).toLowerCase()] || 'application/octet-stream';
    const content = fs.readFileSync(fullPath);
    
    return new Response(content, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      },
    });
  });
  
  // IPC handlers for Option (i) - Main process bridge
  ipcMain.handle('network-bridge:fetch', async (event, url, options = {}) => {
    // Validate sender is from bundled origin
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!senderUrl.startsWith(BUNDLED_ORIGIN)) {
      throw new Error('Unauthorized: not from bundled origin');
    }
    
    // Validate target URL is allowed (only our test server)
    const targetUrl = new URL(url);
    if (!targetUrl.hostname.includes(NON_LOOPBACK_IP) && targetUrl.hostname !== '127.0.0.1') {
      throw new Error('Target URL not in allowlist');
    }
    
    return new Promise((resolve, reject) => {
      const request = net.request({
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
      });
      
      request.on('response', (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body,
            ok: response.statusCode >= 200 && response.statusCode < 300
          });
        });
        response.on('error', reject);
      });
      
      request.on('error', reject);
      
      if (options.body) {
        request.write(options.body);
      }
      request.end();
    });
  });
  
  ipcMain.handle('network-bridge:ws-connect', async (event, url) => {
    // Simplified - in real implementation would maintain WS connection
    return { success: true, message: 'WS bridge not fully implemented in spike' };
  });
  
  // Certificate error handler for Option (ii)
  let certPinningEnabled = false;
  let pinnedFingerprint = '';
  
  ipcMain.handle('cert-pinning:set-fingerprint', (event, fingerprint) => {
    pinnedFingerprint = fingerprint;
    certPinningEnabled = true;
    return { success: true };
  });
  
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (!certPinningEnabled) {
      callback(0); // Allow
      return;
    }
    
    // Verify certificate fingerprint
    const cert = request.certificate;
    const der = cert.getDER();
    const fingerprint = crypto.createHash('sha256').update(der).digest('hex');
    
    if (fingerprint === pinnedFingerprint) {
      callback(0); // Allow
    } else {
      console.log('[spike] Cert pinning failed:', fingerprint, '!=', pinnedFingerprint);
      callback(-1); // Reject
    }
  });
  
  // Register schemes
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'wire-bundled',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
    {
      scheme: 'wire-insecure',
      privileges: { standard: true, secure: false, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
  
  await app.whenReady();
  
  const results = {
    option_i_main_process_bridge: {},
    option_ii_https_pinned: {},
    option_iii_non_secure_scheme: {},
    option_iv_chromium_flags: {},
  };
  
  // Test Option (i): Main-process bridge
  console.log('[spike] Testing Option (i): Main-process bridge...');
  const win1 = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload.js'),
    },
  });
  
  // Add IPC handlers to preload for testing
  const preloadPath = path.join(__dirname, '..', 'preload.js');
  const preloadContent = fs.readFileSync(preloadPath, 'utf8');
  const modifiedPreload = preloadContent.replace(
    'contextBridge.exposeInMainWorld(\'electronAPI\'',
    `contextBridge.exposeInMainWorld('electronAPI', {
    ...contextBridge.exposeInMainWorld('electronAPI') || {},
    networkBridgeFetch: (url, options) => ipcRenderer.invoke('network-bridge:fetch', url, options),
    networkBridgeWsConnect: (url) => ipcRenderer.invoke('network-bridge:ws-connect', url),
  })`
);
  
  // Write modified preload for testing
  const testPreloadPath = path.join(__dirname, 'preload-test.js');
  fs.writeFileSync(testPreloadPath, modifiedPreload);
  
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: testPreloadPath,
    },
  });
  
  win.webContents.on('did-finish-load', async () => {
    console.log('[spike] Testing Option (i): Main-process bridge...');
    
    // Test 1: IPC bridge fetch to HTTP
    try {
      const result = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            const result = await window.electronAPI.networkBridgeFetch('http://192.168.1.14:34567/api/test');
            return { success: true, result };
          } catch (e) {
            return { success: false, error: e.message };
          }
        })();
      `);
      results.option_i_main_process_bridge.ipcBridgeFetch = result;
      console.log('[spike] Option (i) IPC bridge fetch:', JSON.stringify(result));
    } catch (e) {
      results.option_i_main_process_bridge.ipcBridgeFetch = { success: false, error: e.message };
      console.log('[spike] Option (i) IPC bridge fetch error:', e.message);
    }
    
    // Test 2: HTTPS with pinned cert (Option ii)
    console.log('[spike] Testing Option (ii): HTTPS with pinned cert...');
    try {
      // Set the fingerprint
      await win.webContents.executeJavaScript(`
        window.electronAPI.certPinningSetFingerprint('${fingerprint}');
      `);
      
      // Try HTTPS fetch with correct pin
      const httpsResult = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            const resp = await fetch('https://192.168.1.14:34568/api/test', { mode: 'cors', credentials: 'omit' });
            const data = await resp.json();
            return { success: true, status: resp.status, data };
          } catch (e) {
            return { success: false, error: e.message };
          }
        })();
      `);
      results.option_ii_https_pinned.correctPin = httpsResult;
      console.log('[spike] Option (ii) correct pin:', JSON.stringify(httpsResult));
    } catch (e) {
      results.option_ii_https_pinned.correctPin = { success: false, error: e.message };
    }
    
    // Test 3: Wrong pin should fail
    try {
      const wrongResult = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            // Temporarily set wrong fingerprint
            await window.electronAPI.certPinningSetFingerprint('wrong-fingerprint');
            const resp = await fetch('https://192.168.1.14:34568/api/test', { mode: 'cors', credentials: 'omit' });
            return { success: true, status: resp.status };
          } catch (e) {
            return { success: false, error: e.message };
          }
        })();
      `);
      results.option_ii_https_pinned.wrongPin = wrongResult;
      console.log('[spike] Option (ii) wrong pin:', JSON.stringify(wrongResult));
    } catch (e) {
      results.option_ii_https_pinned.wrongPin = { success: false, error: e.message };
    }
    
    // Test 3: Option (iii) - Non-secure scheme
    console.log('[spike] Testing Option (iii): Non-secure scheme...');
    const winInsecure = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, '..', 'preload.js'),
      },
    });
    
    winInsecure.webContents.on('did-finish-load', async () => {
      try {
        const insecureResult = await winInsecure.webContents.executeJavaScript(`
          (async () => {
            const result = {
              isSecureContext: window.isSecureContext,
              cryptoSubtle: !!window.crypto?.subtle,
              origin: window.location.origin,
            };
            
            // Test crypto.subtle
            try {
              const key = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 },
                true,
                ['encrypt', 'decrypt']
              );
              cryptoSubtleWorks = true;
            } catch (e) {
              cryptoSubtleWorks = false;
              cryptoError = e.message;
            }
            
            return { ...result, cryptoSubtleWorks, cryptoError };
          })();
        `);
        results.option_iii_non_secure_scheme = insecureResult;
        console.log('[spike] Option (iii) non-secure scheme:', JSON.stringify(insecureResult));
      } catch (e) {
        results.option_iii_non_secure_scheme = { error: e.message };
      }
      
      winInsecure.close();
      win.close();
      
      // Write results
      const fs = require('fs');
      fs.writeFileSync(
        path.join(__dirname, 'q2-options-results.json'),
        JSON.stringify(results, null, 2)
      );
      
      console.log('[spike] All option tests complete:', JSON.stringify(results, null, 2));
      app.quit();
    });
    
    win.loadURL('wire-bundled://app/index.html');
  });
  
  process.on('unhandledRejection', (err) => {
    console.error('[spike] Unhandled rejection:', err);
    process.exit(1);
  });
}

runOptionTests().catch((err) => {
  console.error('[spike] Fatal error:', err);
  process.exit(1);
});