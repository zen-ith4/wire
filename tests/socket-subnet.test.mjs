// P0-4: the Socket.IO handshake must apply the same ALLOWED_SUBNET rule as
// the HTTP ipRestrict middleware, using the same client address resolution
// (X-Forwarded-For only when Express trusts the proxy).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Fixed environment before any module loads: a loopback bind (behind Caddy)
// and a known subnet.
process.env.HOST = '127.0.0.1';
process.env.ALLOWED_SUBNET = '10.10.0.0/24';
process.env.NODE_ENV = 'development';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  checkClientAddress,
  clientAddressFromRequest,
  trustProxySetting,
} = await import(pathToFileURL(path.join(ROOT, 'middleware', 'ipRestrict.js')).href);
const { setupSocketIO } = require(path.join(ROOT, 'config', 'socket.js'));
const { io: ioClient } = require('socket.io-client');

// ---- unit: the shared subnet decision --------------------------------

test('checkClientAddress allows addresses inside ALLOWED_SUBNET', () => {
  assert.equal(checkClientAddress('10.10.0.5'), null);
  assert.equal(checkClientAddress('::ffff:10.10.0.5'), null);
});

test('checkClientAddress denies addresses outside ALLOWED_SUBNET', () => {
  assert.equal(checkClientAddress('8.8.8.8'), 'Access denied');
  assert.equal(checkClientAddress('10.10.1.5'), 'Access denied');
});

test('checkClientAddress keeps the existing error messages', () => {
  assert.equal(checkClientAddress('2001:db8::1'), 'IP family mismatch');
  assert.equal(checkClientAddress(''), 'Access denied');
  assert.equal(checkClientAddress(undefined), 'Access denied');
  assert.equal(checkClientAddress('not-an-ip'), 'Access denied');
});

// ---- unit: client address for a raw socket request --------------------

function rawReq(peer, xff) {
  return {
    socket: { remoteAddress: peer },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  };
}

test('bound to loopback: forwarded address is used when the peer is the local proxy', () => {
  assert.equal(trustProxySetting(), 'loopback');
  assert.equal(clientAddressFromRequest(rawReq('127.0.0.1', '10.10.0.5')), '10.10.0.5');
  assert.equal(clientAddressFromRequest(rawReq('127.0.0.1', '10.10.0.5, 8.8.8.8')), '8.8.8.8');
  assert.equal(clientAddressFromRequest(rawReq('::1', '10.10.0.5')), '10.10.0.5');
});

test('bound to loopback: no forwarded header falls back to the proxy address', () => {
  assert.equal(clientAddressFromRequest(rawReq('127.0.0.1', undefined)), '127.0.0.1');
});

test('a non-loopback peer never has its X-Forwarded-For trusted', () => {
  assert.equal(clientAddressFromRequest(rawReq('203.0.113.9', '10.10.0.5')), '203.0.113.9');
});

test('when Express does not trust the proxy, the header is ignored entirely', () => {
  assert.equal(clientAddressFromRequest(rawReq('127.0.0.1', '10.10.0.5'), false), '127.0.0.1');
});

// ---- wiring: the real Socket.IO server applies the check --------------
// These connections carry no token, so they never reach the auth middleware
// and need no database. Allowed addresses get past allowRequest and hit the
// token check ('Authentication required'). Denied ones are refused earlier.

let httpServer;
let io;
let url;

before(async () => {
  httpServer = http.createServer();
  io = setupSocketIO(httpServer);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

function connectError(forwardedFor) {
  return new Promise((resolve) => {
    const s = ioClient(url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { 'X-Forwarded-For': forwardedFor },
    });
    s.on('connect', () => { s.close(); resolve({ connected: true }); });
    s.on('connect_error', (err) => { s.close(); resolve({ connected: false, message: err.message }); });
  });
}

test('handshake from an allowed forwarded address reaches the token check', async () => {
  const r = await connectError('10.10.0.5');
  assert.equal(r.connected, false);
  assert.equal(r.message, 'Authentication required');
});

test('handshake from a forwarded public address is refused before the token check', async () => {
  const r = await connectError('8.8.8.8');
  assert.equal(r.connected, false);
  assert.notEqual(r.message, 'Authentication required');
});
