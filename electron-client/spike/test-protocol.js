/**
 * Spike test: Custom protocol handler for bundled client
 * Tests if protocol.registerSchemesAsPrivileged + protocol.handle
 * provides secure context with crypto.subtle, IndexedDB, localStorage
 * Run with: DISPLAY=:0 ./node_modules/.bin/electron spike/test-protocol.js
 */

const { app, protocol, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Custom scheme for bundled client
const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = `${BUNDLED_SCHEME}://app`;

async function testProtocolHandler() {
  console.log('[spike] Testing custom protocol handler...');
  
  // Register the scheme before app ready
  protocol.registerSchemesAsPrivileged([
    {
      scheme: BUNDLED_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
  
  await app.whenReady();
  
  // Handle the custom protocol
  protocol.handle(BUNDLED_SCHEME, async (request) => {
    const url = new URL(request.url);
    const filePath = url.pathname.slice(1);
    
    // Path traversal protection
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
    
    const contentType = mimeTypes[ext] || 'application/octet-stream';
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
    console.log('[spike] Page loaded, running verification tests...');
    
    const results = await win.webContents.executeJavaScript(`
      (async () => {
        const results = {
          isSecureContext: window.isSecureContext,
          cryptoSubtle: !!window.crypto?.subtle,
          indexedDB: !!window.indexedDB,
          localStorage: !!window.localStorage,
          sessionStorage: !!window.sessionStorage,
          fetch: !!window.fetch,
          websocket: !!window.WebSocket,
          origin: window.location.origin,
        };
        
        // Test crypto.subtle
        try {
          const key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
          );
          results.cryptoSubtleWorks = true;
          results.keyGenerated = !!key;
        } catch (e) {
          results.cryptoSubtleWorks = false;
          results.cryptoError = e.message;
        }
        
        // Test IndexedDB with proper key path
        try {
          const dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open('spike-test-persist', 1);
            request.onupgradeneeded = (event) => {
              const db = event.target.result;
              if (!db.objectStoreNames.contains('test')) {
                db.createObjectStore('test', { keyPath: 'id', autoIncrement: true });
              }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const db = await dbPromise;
          const tx = db.transaction('test', 'readwrite');
          await tx.objectStore('test').put({ data: 'persist-test-' + Date.now() });
          await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = reject;
          });
          results.indexedDBWorks = true;
          
          // Test read back
          const db2 = await new Promise((resolve, reject) => {
            const req = indexedDB.open('spike-test-persist', 1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const tx2 = db2.transaction('test', 'readonly');
          const all = await new Promise((resolve, reject) => {
            const req = tx2.objectStore('test').getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          results.indexedDBReadback = all.length > 0;
          results.indexedDBItems = all.length;
          db2.close();
        } catch (e) {
          results.indexedDBWorks = false;
          results.indexedDBError = e.message;
        }
        
        // Test localStorage
        try {
          const testKey = 'spike-test-' + Date.now();
          localStorage.setItem(testKey, 'persist-value-' + Date.now());
          const val = localStorage.getItem(testKey);
          localStorage.removeItem(testKey);
          results.localStorageWorks = val && val.startsWith('persist-value-');
        } catch (e) {
          results.localStorageWorks = false;
          results.localStorageError = e.message;
        }
        
        // Test sessionStorage
        try {
          sessionStorage.setItem('session-test', 'session-value');
          const val = sessionStorage.getItem('session-test');
          sessionStorage.removeItem('session-test');
          results.sessionStorageWorks = val === 'session-value';
        } catch (e) {
          results.sessionStorageWorks = false;
          results.sessionStorageError = e.message;
        }
        
        // Test fetch
        try {
          const resp = await fetch(window.location.href, { method: 'HEAD' });
          results.fetchWorks = resp.ok || resp.status === 404; // 404 is ok for HEAD
        } catch (e) {
          results.fetchWorks = false;
          results.fetchError = e.message;
        }
        
        // Test WebSocket constructor
        results.websocketConstructor = typeof WebSocket === 'function';
        
        return results;
      })();
    `);
    
    console.log('[spike] Verification results:', JSON.stringify(results, null, 2));
    
    const fs = require('fs');
    fs.writeFileSync(
      path.join(__dirname, 'protocol-test-results.json'),
      JSON.stringify(results, null, 2)
    );
    
    win.close();
    app.quit();
  });
  
  // Load the bundled index.html
  win.loadURL(`${BUNDLED_ORIGIN}/index.html`);
}

process.on('unhandledRejection', (err) => {
  console.error('[spike] Unhandled rejection:', err);
  process.exit(1);
});

testProtocolHandler().catch((err) => {
  console.error('[spike] Fatal error:', err);
  process.exit(1);
});