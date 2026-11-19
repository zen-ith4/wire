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
const {
  ipRestrict,
  checkClientAddress,
  trustProxySetting,
} = await import(
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

// ---------------------------------------------------------------------------
// IPv4-mapped IPv6 loopback peers (::ffff:127.0.0.1).
//
// On a dual-stack / IPv6-first deployment the TCP peer of a loopback connection
// presents as an IPv4-mapped IPv6 address rather than plain 127.0.0.1.
// proxy-addr 2.0.8 (GHSA-jqcg-44mw-7w3h, "IP spoofing via IPv4-mapped IPv6
// trust subnet") fixed the trust-subnet comparison for exactly these addresses,
// and ipRestrict must still resolve req.ip correctly over them: the ::ffff:
// prefix is stripped before the ALLOWED_SUBNET test, and Express trusts
// X-Forwarded-For only when the TCP peer itself is loopback.
// ---------------------------------------------------------------------------

test('checkClientAddress strips the ::ffff: IPv4-mapped prefix before the subnet test', () => {
  // Normalized to 127.0.0.1 (loopback) -> not in ALLOWED_SUBNET -> denied.
  assert.equal(checkClientAddress('::ffff:127.0.0.1'), 'Access denied');

  // Normalized to 10.10.0.5 -> in ALLOWED_SUBNET -> allowed.
  assert.equal(checkClientAddress('::ffff:10.10.0.5'), null);

  // A public IPv4-mapped address is denied, not silently treated as loopback.
  assert.equal(checkClientAddress('::ffff:8.8.8.8'), 'Access denied');
});

test('trust proxy loopback trusts XFF over an IPv4-mapped IPv6 loopback peer', async () => {
  const app = express();
  app.set('trust proxy', 'loopback');

  // Force the socket peer to be an IPv4-mapped IPv6 loopback, as a dual-stack
  // kernel reports it. req.ip is a lazy getter, so overriding remoteAddress here
  // is what ipRestrict observes when it reads req.ip below.
  app.use((req, res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', {
      value: '::ffff:127.0.0.1',
      configurable: true,
    });
    next();
  });

  app.use(ipRestrict);
  app.get('/', (req, res) => res.json({ ok: true }));

  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();

  try {
    // A forwarded WireGuard client wins over the loopback peer -> allowed.
    const ok = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'X-Forwarded-For': '10.10.0.5' },
    });
    assert.equal(ok.status, 200);

    // A public forwarded address is honored by req.ip and then denied.
    const deny = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'X-Forwarded-For': '8.8.8.8' },
    });
    assert.equal(deny.status, 403);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
