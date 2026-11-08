// P0-1: when Express binds to 127.0.0.1 (behind Caddy), the client address
// must come from X-Forwarded-For so ipRestrict can apply ALLOWED_SUBNET to the
// real client. When Express binds anywhere else, the forwarded header must be
// ignored entirely.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';

// Fix the subnet for this test regardless of the caller's environment.
process.env.ALLOWED_SUBNET = '10.10.0.0/24';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ipRestrict, trustProxySetting } = await import(
  pathToFileURL(path.join(ROOT, 'middleware', 'ipRestrict.js')).href
);

test('trust proxy is "loopback" only when bound to 127.0.0.1', () => {
  assert.equal(trustProxySetting('127.0.0.1'), 'loopback');
  assert.equal(trustProxySetting('10.10.0.7'), false);
  assert.equal(trustProxySetting('0.0.0.0'), false);
});

// Real Express app, real loopback socket. Express itself resolves req.ip.
let server;
let port;

before(async () => {
  const app = express();
  app.set('trust proxy', trustProxySetting('127.0.0.1'));
  app.use(ipRestrict);
  app.get('/', (req, res) => res.json({ ok: true }));

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function status(xff) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    headers: xff === undefined ? {} : { 'X-Forwarded-For': xff },
  });
  return res.status;
}

test('bound to 127.0.0.1: forwarded WireGuard client is allowed', async () => {
  assert.equal(await status('10.10.0.5'), 200);
});

test('bound to 127.0.0.1: forwarded public client is denied', async () => {
  assert.equal(await status('8.8.8.8'), 403);
});

test('bound to 127.0.0.1: appended public address still wins (rightmost)', async () => {
  // Caddy appends the real client address; a spoofed allowed IP on the left
  // must not be able to win.
  assert.equal(await status('10.10.0.5, 8.8.8.8'), 403);
});

test('bound to 127.0.0.1: no forwarded header means the proxy itself, which is denied', async () => {
  assert.equal(await status(undefined), 403);
});

// Mocked request for the direct, non-loopback case: the socket peer is a
// public address, so Express would never trust X-Forwarded-For. req.ip is
// the peer and the spoofed header is irrelevant.
function runWithMockReq(req) {
  let nextCalled = false;
  let sent = null;
  const res = {
    status(code) { this.code = code; return this; },
    json(body) { sent = { code: this.code, body }; return this; },
  };
  ipRestrict(req, res, () => { nextCalled = true; });
  return { nextCalled, sent };
}

test('direct non-loopback peer with spoofed X-Forwarded-For is denied', () => {
  const out = runWithMockReq({
    ip: '203.0.113.9',
    socket: { remoteAddress: '203.0.113.9' },
    headers: { 'x-forwarded-for': '10.10.0.5' },
  });
  assert.equal(out.nextCalled, false);
  assert.equal(out.sent.code, 403);
});

test('direct WireGuard peer is allowed without any forwarded header', () => {
  const out = runWithMockReq({
    ip: '10.10.0.9',
    socket: { remoteAddress: '10.10.0.9' },
    headers: {},
  });
  assert.equal(out.nextCalled, true);
});
