/**
 * Spike test: API base resolution and CORS
 * Tests how the existing client resolves API base URLs
 */

const { app, protocol, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const BUNDLED_SCHEME = 'wire-bundled';
const BUNDLED_ORIGIN = `${BUNDLED_SCHEME}://app`;

async function testApiResolution() {
  console.log('[spike] Testing API base resolution...');
  
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
    console.log('[spike] Page loaded, analyzing API resolution...');
    
    // Inject our analysis script
    const results = await win.webContents.executeJavaScript(`
      (async () => {
        // Load the actual client's server.js and api.js modules
        const results = {
          origin: window.location.origin,
          isNativeApp: null,
          getServerEndpoint: null,
          resolveServerUrl: null,
          fetchBehavior: [],
          socketIoBehavior: null,
        };
        
        // Import the actual server.js module
        try {
          const serverModule = await import('/js/core/server.js');
          results.isNativeApp = serverModule.isNativeApp();
          results.getServerEndpoint = serverModule.getServerEndpoint();
          results.resolveServerUrl = serverModule.resolveServerUrl('/api/test');
          
          console.log('server.js module loaded:', results.isNativeApp, results.getServerEndpoint, results.resolveServerUrl);
        } catch (e) {
          console.error('Failed to import server.js:', e);
          results.serverModuleError = e.message;
        }
        
        // Check how fetch resolves URLs
        try {
          const response = await fetch('/api/version', { method: 'GET' });
          results.fetchBehavior.push({
            url: '/api/version',
            resolved: 'relative',
            status: 'would fail - no server',
            note: 'Relative URL resolves against page origin (wire-bundled://app)'
          });
        } catch (e) {
          results.fetchBehavior.push({
            url: '/api/version',
            error: e.message,
          });
        }
        
        // Check absolute URL
        try {
          const absResponse = await fetch('http://127.0.0.1:3000/api/version', { method: 'GET' });
          results.fetchBehavior.push({
            url: 'http://127.0.0.1:3000/api/version',
            resolved: 'absolute',
            status: 'would fail - no server',
            note: 'Absolute URL works but CORS may block'
          });
        } catch (e) {
          results.fetchBehavior.push({
            url: 'http://127.0.0.1:3000/api/version',
            error: e.message,
          });
        }
        
        // Check Socket.IO behavior
        try {
          const { io } = await import('/js/vendor/socket.io-client.js');
          results.socketIoBehavior = 'socket.io-client available';
        } catch (e) {
          results.socketIoBehavior = 'socket.io-client not loaded: ' + e.message;
        }
        
        // Check Capacitor detection
        results.isCapacitor = typeof window.Capacitor !== 'undefined';
        results.windowLocation = window.location.href;
        results.windowProtocol = window.location.protocol;
        
        // Check resolveServerUrl behavior for different URL patterns
        if (typeof resolveServerUrl === 'function') {
          results.resolveServerUrlTests = {
            relative: resolveServerUrl('/api/test'),
            absoluteHttp: resolveServerUrl('http://example.com/api/test'),
            absoluteHttps: resolveServerUrl('https://example.com/api/test'),
            rootRelative: resolveServerUrl('api/test'),
          };
        }
        
        return results;
      })();
    `);
    
    console.log('[spike] API resolution results:', JSON.stringify(results, null, 2));
    
    const fs = require('fs');
    fs.writeFileSync(
      path.join(__dirname, 'api-resolution-results.json'),
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

testApiResolution().catch((err) => {
  console.error('[spike] Fatal error:', err);
  process.exit(1);
});