/**
 * Spike test: Service Worker behavior in Electron
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
    
    const results = await win.webContents.executeJavaScript(`
      (async () => {
        const results = {
          origin: window.location.origin,
          isSecureContext: window.isSecureContext,
          serviceWorker: {
            supported: 'serviceWorker' in navigator,
            controller: navigator.serviceWorker.controller ? 'active' : 'none',
            ready: null,
            registration: null,
            swScript: null,
          },
          isNativeApp: null,
          pwaModule: null,
        };
        
        // Check isNativeApp
        try {
          const serverModule = await import('/js/core/server.js');
          results.isNativeApp = serverModule.isNativeApp();
        } catch (e) {
          results.isNativeAppError = e.message;
        }
        
        // Check pwa.js behavior
        try {
          const pwaModule = await import('/js/core/pwa.js');
          results.pwaModule = 'loaded';
        } catch (e) {
          results.pwaModuleError = e.message;
        }
        
        // Check service worker registration
        if ('serviceWorker' in navigator) {
          results.serviceWorker.supported = true;
          
          try {
            const registration = await navigator.serviceWorker.ready;
            results.serviceWorker.ready = 'ready';
            results.serviceWorker.controller = navigator.serviceWorker.controller ? 'active' : 'none';
            results.serviceWorker.registration = {
              scope: registration.scope,
              updateViaCache: registration.updateViaCache,
            };
          } catch (e) {
            results.serviceWorker.readyError = e.message;
          }
          
          // Try to register
          try {
            const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
            results.serviceWorker.registration = {
              scope: reg.scope,
              updateViaCache: reg.updateViaCache,
              active: reg.active ? 'yes' : 'no',
              installing: reg.installing ? 'yes' : 'no',
              waiting: reg.waiting ? 'yes' : 'no',
            };
          } catch (e) {
            results.serviceWorker.registrationError = e.message;
          }
        } else {
          results.serviceWorker.supported = false;
        }
        
        // Check isSecureContext
        results.isSecureContext = window.isSecureContext;
        results.locationProtocol = window.location.protocol;
        results.locationOrigin = window.location.origin;
        
        // Check if MEDIA_STREAM_ENABLED is set in sw.js
        try {
          const swScript = await fetch('/sw.js').then(r => r.text());
          results.swScriptHasMediaStreamEnabled = swScript.includes('MEDIA_STREAM_ENABLED');
          results.swScriptMediaStreamValue = swScript.match(/MEDIA_STREAM_ENABLED\\s*=\\s*(true|false)/)?.[1] || 'not found';
        } catch (e) {
          results.swScriptError = e.message;
        }
        
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