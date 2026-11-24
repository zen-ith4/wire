/**
 * Spike test: Service Worker behavior in Electron (simplified)
 */

const { app, protocol, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = `${BUNDLED_SCHEME}://app`;

async function testServiceWorker() {
  console.log('[spike] Testing Service Worker behavior...');
  
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
  
  await app.whenReady();
  
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
    console.log('[spike] Page loaded, testing Service Worker...');
    
    // Use evaluate instead of executeJavaScript to avoid import issues
    const results = await win.webContents.executeJavaScript(`
      (() => {
        const results = {
          origin: window.location.origin,
          isSecureContext: window.isSecureContext,
          serviceWorker: {
            supported: 'serviceWorker' in navigator,
            controller: navigator.serviceWorker.controller ? 'active' : 'none',
          },
          isNativeApp: null,
          locationProtocol: window.location.protocol,
          locationOrigin: window.location.origin,
        };
        
        // Check isNativeApp from server.js (inline check)
        results.isNativeApp = typeof window.Capacitor !== 'undefined' && 
          typeof window.Capacitor.isNativePlatform === 'function' && 
          window.Capacitor.isNativePlatform();
        
        // Check service worker registration
        if ('serviceWorker' in navigator) {
          results.serviceWorker.supported = true;
          
          navigator.serviceWorker.ready.then(reg => {
            console.log('SW ready:', reg.scope);
          }).catch(e => console.log('SW ready error:', e.message));
          
          // Try to register
          navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
            .then(reg => {
              console.log('SW registered:', reg.scope);
            })
            .catch(e => console.log('SW register error:', e.message));
        } else {
          results.serviceWorker.supported = false;
        }
        
        // Check isSecureContext
        results.isSecureContext = window.isSecureContext;
        results.locationProtocol = window.location.protocol;
        results.locationOrigin = window.location.origin;
        
        return results;
      })();
    `);
    
    console.log('[spike] Service Worker test results:', JSON.stringify(results, null, 2));
    
    const fs = require('fs');
    fs.writeFileSync(
      path.join(__dirname, 'sw-results.json'),
      JSON.stringify(results, null, 2)
    );
    
    win.close();
    app.quit();
  });
  
  win.loadURL('wire-bundled://app/index.html');
}

process.on('unhandledRejection', (err) => {
  console.error('[spike] Unhandled rejection:', err);
  process.exit(1);
});

testServiceWorker().catch((err) => {
  console.error('[spike] Fatal error:', err);
  process.exit(1);
});