// tests/cors-config.test.mjs
//
// server.js wires HTTP CORS via a single middleware (middleware/cors.js) that
// reflects the requesting Origin and sends NO credentials. This test proves
// that setup actually works for both supported external client types, and that
// the unnecessary `credentials: true` has been dropped now that auth is purely
// header-based (Authorization: Bearer — see middleware/authenticate.js; no
// route in this app sets or reads a cookie).
//
// The test imports the REAL middleware module server.js uses, so it exercises
// the exact options rather than a copy that could drift.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { corsMiddleware } = await import(
    pathToFileURL(path.join(ROOT, 'middleware', 'cors.js')).href
);

// Capacitor's webview origin. Electron has no fixed origin — it loads the page
// straight from whatever server the user connected to (electron-client/main.js),
// so this arbitrary host:port stands in for "an Electron Origin".
const CAPACITOR_ORIGIN = 'https://localhost';
const ELECTRON_ORIGIN = 'http://192.168.1.100:3000';

let server;
let port;

before(async () => {
    const app = express();
    // Identical to server.js: the CORS middleware runs before every route.
    app.use(corsMiddleware);
    app.get('/api/resource', (req, res) => res.json({ ok: true }));

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function request({ method = 'GET', origin, headers = {} }) {
    const res = await fetch(`http://127.0.0.1:${port}/api/resource`, {
        method,
        headers: {
            ...(origin ? { Origin: origin } : {}),
            ...headers,
        },
    });
    return res;
}

test('Capacitor origin (https://localhost) is allowed on a normal request', async () => {
    const res = await request({ origin: CAPACITOR_ORIGIN });
    assert.equal(res.status, 200);
    assert.equal(
        res.headers.get('access-control-allow-origin'),
        CAPACITOR_ORIGIN,
        'the Capacitor origin must be reflected back'
    );
});

test('Capacitor preflight (OPTIONS) is allowed', async () => {
    const res = await request({
        method: 'OPTIONS',
        origin: CAPACITOR_ORIGIN,
        headers: { 'access-control-request-method': 'GET' },
    });
    assert.equal(res.status, 204);
    assert.equal(
        res.headers.get('access-control-allow-origin'),
        CAPACITOR_ORIGIN,
        'preflight must reflect the Capacitor origin'
    );
});

test('Electron origin (arbitrary host:port) is allowed on a normal request', async () => {
    const res = await request({ origin: ELECTRON_ORIGIN });
    assert.equal(res.status, 200);
    assert.equal(
        res.headers.get('access-control-allow-origin'),
        ELECTRON_ORIGIN,
        'Electron can connect from any server origin; it must be reflected'
    );
});

test('Electron preflight (OPTIONS) is allowed', async () => {
    const res = await request({
        method: 'OPTIONS',
        origin: ELECTRON_ORIGIN,
        headers: { 'access-control-request-method': 'GET' },
    });
    assert.equal(res.status, 204);
    assert.equal(
        res.headers.get('access-control-allow-origin'),
        ELECTRON_ORIGIN,
        'preflight must reflect the Electron origin'
    );
});

test('credentials are NOT sent (no Access-Control-Allow-Credentials header)', async () => {
    // No cookie is used anywhere in this app, so neither request type may emit
    // a credentials header. Assert on both a normal and a preflight response.
    const normal = await request({ origin: CAPACITOR_ORIGIN });
    const preflight = await request({
        method: 'OPTIONS',
        origin: ELECTRON_ORIGIN,
        headers: { 'access-control-request-method': 'GET' },
    });

    assert.equal(
        normal.headers.get('access-control-allow-credentials'),
        null,
        'credentials:false must not emit an Access-Control-Allow-Credentials header'
    );
    assert.equal(
        preflight.headers.get('access-control-allow-credentials'),
        null,
        'preflight must not emit an Access-Control-Allow-Credentials header'
    );
});
