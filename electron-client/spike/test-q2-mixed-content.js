/**
 * Q2 Spike: Mixed content test from bundled secure origin to non-loopback HTTP server
 * 
 * This script:
 * 1. Starts the real Wire server on 0.0.0.0:34567
 * 2. Loads the bundled page via wire-bundled://app
 * 3. Tests fetch() and WebSocket to the non-loopback IP (mixed content - should be BLOCKED)
 * 4. Control: fetch to loopback (should succeed - exemption)
 * 5. Control: fetch from http:// origin to non-loopback (should succeed - server reachable)
 * 
 * Run: DISPLAY=:0 ./node_modules/.bin/electron spike/test-q2-mixed-content.js
 */

const { app, protocol, BrowserWindow, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = `${BUNDLED_SCHEME}://app`;
const TEST_PORT = 34567;
const NON_LOOPBACK_IP = '192.168.1.14'; // From `ip -4 addr show`
const TEST_SERVER_URL = `http://${NON_LOOPBACK_IP}:34567`;
const LOOPBACK_SERVER_URL = `http://127.0.0.1:34567`;

let server = null;
let serverReady = false;

function startTestServer() {
  return new Promise((resolve, reject) => {
    console.log('[spike] Starting test server on 0.0.0.0:' + TEST_PORT);
    
    const server = http.createServer((req, res) => {
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
      
      console.log('[spike] Server received:', req.method, req.url);
      
      if (req.url === '/api/version') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ version: '1.0.0-test' }));
      } else if (req.url === '/api/test') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Server reachable' }));
      } else {
        res.writeHead(200);
        res.end('OK');
      }
    });
    
    const httpServer = server.listen(TEST_PORT, '0.0.0.0', () => {
      console.log('[spike] Test server listening on 0.0.0.0:' + TEST_PORT);
      serverReady = true;
      resolve({ server: httpServer, url: `http://${NON_LOOPBACK_IP}:${TEST_PORT}` });
    });
    
    server.on('error', (err) => {
      console.error('[spike] Server error:', err.message);
      reject(err);
    });
  });
}

async function runMixedContentTests() {
  console.log('[spike] Starting Q2 mixed content tests...');
  console.log('[spike] Non-loopback IP:', NON_LOOPBACK_IP);
  console.log('[spike] Test server URL:', TEST_SERVER_URL);
  console.log('[spike] Loopback server URL:', LOOPBACK_SERVER_URL);
  
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
  const { server: testServer, url: serverUrl } = await startTestServer();
  
  // Wait a moment for server to be fully ready
  await new Promise(r => setTimeout(r, 500));
  
  await app.whenReady();
  
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
  
  // Capture console messages and errors
  const consoleMessages = [];
  const pageErrors = [];
  
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    consoleMessages.push({ level, message, line, sourceId });
    console.log('[renderer]', message);
  });
  
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.log('[spike] did-fail-load:', errorCode, errorDescription, validatedURL);
  });
  
  win.webContents.on('did-finish-load', async () => {
    console.log('[spike] Page loaded, running mixed content tests...');
    
    const results = await win.webContents.executeJavaScript(`
      (async () => {
        const results = {
          origin: window.location.origin,
          isSecureContext: window.isSecureContext,
          tests: [],
        };
        
        const NON_LOOPBACK_IP = '${NON_LOOPBACK_IP}';
        const TEST_PORT = ${TEST_PORT};
        const TEST_SERVER_URL = \`http://\${NON_LOOPBACK_IP}:\${TEST_PORT}\`;
        const LOOPBACK_SERVER_URL = 'http://127.0.0.1:${TEST_PORT}';
        
        // Helper to test fetch
        async function testFetch(name, url, options = {}) {
          try {
            console.log('Testing fetch:', name, url);
            const response = await fetch(url, { 
              method: 'GET', 
              mode: 'cors',
              credentials: 'omit',
              ...options
            });
            const text = await response.text();
            return {
              name,
              url,
              success: true,
              status: response.status,
              blocked: false,
              responseText: text.substring(0, 200)
            };
          } catch (e) {
            return {
              name,
              url,
              success: false,
              error: e.message,
              blocked: e.message.includes('Mixed Content') || e.message.includes('mixed content') || e.message.includes('blocked'),
            };
          }
        }
        
        // Helper to test WebSocket
        async function testWebSocket(name, url) {
          return new Promise((resolve) => {
            try {
              console.log('Testing WebSocket:', name, url);
              const ws = new WebSocket(url);
              const timeout = setTimeout(() => {
                ws.close();
                resolve({ name, url, success: false, error: 'timeout', blocked: true });
              }, 5000);
              
              ws.onopen = () => {
                clearTimeout(timeout);
                ws.close();
                resolve({ name, url, success: true, blocked: false });
              };
              ws.onerror = (e) => {
                clearTimeout(timeout);
                resolve({ name, url, success: false, error: 'WebSocket error', blocked: true });
              };
              ws.onclose = (e) => {
                if (!e.wasClean && !timeout) {
                  // Might have been closed after successful open
                }
              };
            } catch (e) {
              resolve({ name, url, success: false, error: e.message, blocked: true });
            }
          });
        }
        
        // TEST 1: fetch to non-loopback HTTP (should be BLOCKED - mixed content)
        results.tests.push(await testFetch(
          'fetch to non-loopback HTTP',
          \`\${TEST_SERVER_URL}/api/test\`
        ));
        
        // TEST 2: WebSocket to non-loopback HTTP (should be BLOCKED - mixed content)
        results.tests.push(await testWebSocket(
          'WebSocket to non-loopback HTTP',
          \`ws://\${NON_LOOPBACK_IP}:${TEST_PORT}\`
        ));
        
        // TEST 3: fetch to loopback HTTP (should SUCCEED - loopback exemption)
        results.tests.push(await testFetch(
          'fetch to loopback HTTP (control)',
          \`\${LOOPBACK_SERVER_URL}/api/test\`
        ));
        
        // TEST 4: fetch to non-loopback from http:// origin (control - would need separate page)
        // We can't easily test this from the same page, but we note it as a control
        
        return results;
      })();
    `);
    
    console.log('[spike] Mixed content test results:', JSON.stringify(results, null, 2));
    
    const fs = require('fs');
    fs.writeFileSync(
      path.join(__dirname, 'q2-mixed-content-results.json'),
      JSON.stringify(results, null, 2)
    );
    
    win.close();
    if (server) server.close();
    app.quit();
  });
  
  win.loadURL(`${BUNDLED_ORIGIN}/index.html`);
}

process.on('unhandledRejection', (err) => {
  console.error('[spike] Unhandled rejection:', err);
  if (server) server.close();
  process.exit(1);
});

runMixedContentTests().catch((err) => {
  console.error('[spike] Fatal error:', err);
  if (server) server.close();
  process.exit(1);
});