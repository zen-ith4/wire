/**
 * Spike test: Mixed content / cross-origin fetch from bundled origin
 * Tests if bundled secure origin can connect to non-loopback HTTP server
 */

const { app, protocol, BrowserWindow, net, session } = require('electron');
const path = require('path');
const fs = require('fs');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = `${BUNDLED_SCHEME}://app`;

// Server configuration - use non-loopback IP
const SERVER_PORT = 34567;
const SERVER_HOST = '0.0.0.0'; // Bind to all interfaces
const SERVER_URL = `http://${require('os').networkInterfaces()['eth0']?.[0]?.address || '127.0.0.1'}:${SERVER_PORT}`;
// Use a known non-loopback IP for testing
const NON_LOOPBACK_IP = require('os').networkInterfaces()['eth0']?.[0]?.address || 
                       require('os').networkInterfaces()['en0']?.[0]?.address || 
                       '192.168.1.100'; // fallback
const TEST_SERVER_URL = `http://${NON_LOOPBACK_IP}:${SERVER_PORT}`;

let serverProcess = null;

async function startTestServer() {
  console.log('[spike] Starting test server on', TEST_SERVER_URL);
  
  // Create a simple HTTP server using net module
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        const request = data.toString();
        console.log('[spike] Server received request:', request.substring(0, 200));
        
        // Simple HTTP response with CORS headers
        const response = 
          'HTTP/1.1 200 OK\r\n' +
          'Content-Type: application/json\r\n' +
          'Access-Control-Allow-Origin: *\r\n' +
          'Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n' +
          'Access-Control-Allow-Headers: Content-Type, Authorization\r\n' +
          '\r\n' +
          JSON.stringify({ success: true, message: 'Server reachable', timestamp: Date.now() });
        
        socket.write(response);
        socket.end();
      });
      
      socket.on('error', (err) => {
        console.log('[spike] Socket error:', err.message);
      });
    });
    
    server.listen(SERVER_PORT, SERVER_HOST, () => {
      console.log('[spike] Test server listening on', TEST_SERVER_URL);
      resolve({ server, url: TEST_SERVER_URL });
    });
    
    server.on('error', (err) => {
      console.error('[spike] Server error:', err.message);
      reject(err);
    });
  });
}

async function testMixedContent() {
  console.log('[spike] Testing mixed content / cross-origin fetch...');
  
  // Register the scheme
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
  
  await app.whenReady();
  
  // Start test server
  const { server, url: serverUrl } = await startTestServer();
  console.log('[spike] Test server URL:', serverUrl);
  
  // Handle the custom protocol
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
  
  // Enable devtools for debugging
  win.webContents.openDevTools({ mode: 'detach' });
  
  win.webContents.on('did-finish-load', async () => {
    console.log('[spike] Page loaded, testing mixed content fetch...');
    
    const results = await win.webContents.executeJavaScript(`
      (async () => {
        const results = {
          origin: window.location.origin,
          isSecureContext: window.isSecureContext,
          tests: [],
        };
        
        // Test 1: fetch to HTTP server (should be blocked by mixed content)
        try {
          console.log('Testing fetch to:', '${TEST_SERVER_URL}');
          const response = await fetch('${TEST_SERVER_URL}', {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
          });
          const data = await response.json();
          results.tests.push({
            name: 'fetch to HTTP server',
            success: true,
            status: response.status,
            data,
            blocked: false,
          });
        } catch (e) {
          results.tests.push({
            name: 'fetch to HTTP server',
            success: false,
            error: e.message,
            blocked: true,
          });
        }
        
        // Test 2: WebSocket to HTTP server
        try {
          console.log('Testing WebSocket to:', 'ws://${NON_LOOPBACK_IP}:${SERVER_PORT}');
          const ws = new WebSocket('ws://${NON_LOOPBACK_IP}:${SERVER_PORT}');
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('WebSocket timeout')), 5000);
            ws.onopen = () => {
              clearTimeout(timeout);
              resolve();
            };
            ws.onerror = (e) => {
              clearTimeout(timeout);
              reject(e);
            };
          });
          results.tests.push({
            name: 'WebSocket to HTTP server',
            success: true,
            blocked: false,
          });
        } catch (e) {
          results.tests.push({
            name: 'WebSocket to HTTP server',
            success: false,
            error: e.message,
            blocked: true,
          });
        }
        
        // Test 3: fetch to HTTPS (if available)
        try {
          const httpsResponse = await fetch('https://httpbin.org/get', {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
          });
          results.tests.push({
            name: 'fetch to HTTPS server',
            success: true,
            status: httpsResponse.status,
            blocked: false,
          });
        } catch (e) {
          results.tests.push({
            name: 'fetch to HTTPS server',
            success: false,
            error: e.message,
            blocked: true,
          });
        }
        
        return results;
      })();
    `);
    
    console.log('[spike] Mixed content test results:', JSON.stringify(results, null, 2));
    
    // Write results
    const fs = require('fs');
    fs.writeFileSync(
      path.join(__dirname, 'mixed-content-results.json'),
      JSON.stringify(results, null, 2)
    );
    
    win.close();
    server.close();
    app.quit();
  });
  
  win.loadURL('wire-bundled://app/index.html');
}

process.on('unhandledRejection', (err) => {
  console.error('[spike] Unhandled rejection:', err);
  process.exit(1);
});

testMixedContent().catch((err) => {
  console.error('[spike] Fatal error:', err);
  process.exit(1);
});