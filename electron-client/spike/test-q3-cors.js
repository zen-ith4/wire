/**
 * Q3 Spike: CORS Origin header logging
 * Logs the actual Origin header received by the server from the bundled origin
 */

const { app, protocol, BrowserWindow, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = `${BUNDLED_SCHEME}://app`;
const TEST_PORT = 34567;
const NON_LOOPBACK_IP = '192.168.1.14';

let httpServer = null;

function startTestServer() {
  return new Promise((resolve, reject) => {
    const handler = (req, res) => {
      // Log the Origin header
      const origin = req.headers.origin || req.headers.Origin;
      console.log('[spike] Server received request:', req.method, req.url, 'Origin:', origin);
      
      // Enable CORS for all origins
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'false');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      
      if (req.url === '/api/test') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'CORS test server', origin }));
      } else {
        res.writeHead(200);
        res.end('OK');
      }
    };
    
    const server = http.createServer(handler);
    server.listen(TEST_PORT, '0.0.0.0', () => {
      console.log('[spike] CORS test server listening on 0.0.0.0:34567');
      resolve(server);
    });
    
    server.on('error', reject);
  });
}

async function runCorsTest() {
  console.log('[spike] Starting Q3 CORS Origin header test...');
  console.log('[spike] Non-loopback IP:', NON_LOOPBACK_IP);
  
  // Register the scheme BEFORE app.whenReady()
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'wire-bundled',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
  
  // Start test server
  const server = await startTestServer();
  await new Promise(r => setTimeout(r, 500));
  
  await app.whenReady();
  
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
  
  const win = new BrowserWindow({
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
  
  win.webContents.on('did-finish-load', async () => {
    console.log('[spike] Page loaded, testing CORS Origin header...');
    
    const results = await win.webContents.executeJavaScript(`
      (async () => {
        const results = {
          origin: window.location.origin,
          isSecureContext: window.isSecureContext,
          tests: [],
        };
        
        const TEST_SERVER_URL = 'http://192.168.1.14:34567';
        
        // Test 1: Simple fetch - check what Origin header server receives
        try {
          console.log('Testing fetch to:', 'http://192.168.1.14:34567/api/test');
          const response = await fetch('http://192.168.1.14:34567/api/test', {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
          });
          const data = await response.json();
          results.tests.push({
            name: 'fetch with CORS',
            url: 'http://192.168.1.14:34567/api/test',
            success: true,
            status: response.status,
            serverReportedOrigin: data.origin,
            blocked: false,
          });
        } catch (e) {
          results.tests.push({
            name: 'fetch with CORS',
            url: 'http://192.168.1.14:34567/api/test',
            success: false,
            error: e.message,
            blocked: true,
          });
        }
        
        // Test 2: Preflight request (OPTIONS)
        try {
          const response = await fetch('http://192.168.1.14:34567/api/test', {
            method: 'OPTIONS',
            mode: 'cors',
            credentials: 'omit',
          });
          results.tests.push({
            name: 'preflight OPTIONS',
            url: 'http://192.168.1.14:34567/api/test',
            success: true,
            status: response.status,
            blocked: false,
          });
        } catch (e) {
          results.tests.push({
            name: 'preflight OPTIONS',
            url: 'http://192.168.1.14:34567/api/test',
            success: false,
            error: e.message,
            blocked: true,
          });
        }
        
        // Test 3: fetch with Authorization header (simulates real API call)
        try {
          const response = await fetch('http://192.168.1.14:34567/api/test', {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            headers: {
              'Authorization': 'Bearer fake-token-for-testing',
              'Content-Type': 'application/json',
            },
          });
          const data = await response.json();
          results.tests.push({
            name: 'fetch with Authorization header',
            url: 'http://192.168.1.14:34567/api/test',
            success: true,
            status: response.status,
            serverReportedOrigin: data.origin,
            blocked: false,
          });
        } catch (e) {
          results.tests.push({
            name: 'fetch with Authorization header',
            url: 'http://192.168.1.14:34567/api/test',
            success: false,
            error: e.message,
            blocked: true,
          });
        }
        
        return results;
      })();
    `);
    
    console.log('[spike] CORS test results:', JSON.stringify(results, null, 2));
    
    const fs = require('fs');
    fs.writeFileSync(
      path.join(__dirname, 'q3-cors-results.json'),
      JSON.stringify(results, null, 2)
    );
    
    win.close();
    server.close();
    app.quit();
  });
  
  win.loadURL(`${BUNDLED_ORIGIN}/index.html`);
}

process.on('unhandledRejection', (err) => {
  console.error('[spike] Unhandled rejection:', err);
  process.exit(1);
});

runCorsTest().catch((err) => {
  console.error('[spike] Fatal error:', err);
  process.exit(1);
});