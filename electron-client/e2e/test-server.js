// E2E test HTTP server for the Electron Phase 2 hardening tests.
//
// Two roles, selected with E2E_ROLE:
//
//   main (default)
//     GET /                     -> test-page.html
//     GET /api/version          -> 302 /api/version-ok          (E2E_VERSION_MODE=same)
//                                 302 http://127.0.0.1:CROSS/leak-version (E2E_VERSION_MODE=cross)
//     GET /api/version-ok       -> {"version":"0.0.0"}
//     GET /redirect-same        -> 302 /?afterRedirect=1        (same-origin, must be followed)
//     GET /redirect-cross       -> 302 http://127.0.0.1:CROSS/leak-nav (must be blocked)
//     GET /api/media-token/1    -> media token JSON
//
//   cross-target
//     Any request is logged as "[cross-target] HIT ..." and answered 200.
//     The harness asserts this log stays empty: a hit means a redirect to a
//     different origin was followed.
//
// Binds to 127.0.0.1 only.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROLE = process.env.E2E_ROLE || 'main';
const PORT = Number(process.env.E2E_PORT || 47111);
const CROSS_PORT = Number(process.env.E2E_CROSS_PORT || 0);
const VERSION_MODE = process.env.E2E_VERSION_MODE || 'same';
const HOST = '127.0.0.1';

const PAGE = fs.readFileSync(path.join(__dirname, 'test-page.html'), 'utf8');

function crossUrl(pathname) {
  return 'http://' + HOST + ':' + CROSS_PORT + pathname;
}

const server = http.createServer((req, res) => {
  console.log('[test-server] ' + req.method + ' ' + req.url);

  if (ROLE === 'cross-target') {
    console.log('[cross-target] HIT ' + req.method + ' ' + req.url);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('cross-target');
    return;
  }

  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (url.pathname === '/api/version') {
    const location =
      VERSION_MODE === 'cross'
        ? crossUrl('/leak-version')
        : '/api/version-ok';
    res.writeHead(302, { Location: location });
    res.end();
    return;
  }

  if (url.pathname === '/api/version-ok') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '0.0.0' }));
    return;
  }

  if (url.pathname === '/redirect-same') {
    res.writeHead(302, { Location: '/?afterRedirect=1' });
    res.end();
    return;
  }

  if (url.pathname === '/redirect-cross') {
    res.writeHead(302, { Location: crossUrl('/leak-nav') });
    res.end();
    return;
  }

  if (url.pathname === '/api/media-token/1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        token: 'test-token',
        mime: 'audio/mpeg',
        size: 100,
        modified: Date.now(),
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(
    '[test-server] listening on http://' +
      HOST +
      ':' +
      PORT +
      ' role=' +
      ROLE +
      ' versionMode=' +
      VERSION_MODE +
      ' crossPort=' +
      CROSS_PORT
  );
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
