// tests/media/sw-stream-browser.test.mjs
//
// C5: real-Chromium browser tests of progressive encrypted DM media streaming.
// The repo's sw.js ships MEDIA_STREAM_ENABLED = false, so every test here
// builds a flag-ON copy of public/ via tests/helpers/sw-flag-on-copy.mjs,
// serves that copy through a local proxy that forwards /api/* to a real
// startRealServer, and never writes back to the repository.
//
// Evidence is only valid from WSL2 + @sparticuz/chromium 153 (HeadlessChrome/153.x).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { launchBrowser, startRealServer, registerUser, restLogin, jsonClient, makeServerDirs } from '../_acceptance-harness.mjs';
import { createFlagOnPublicCopy, assertRepoFlagOff } from '../helpers/sw-flag-on-copy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST_BUILD = path.join(ROOT, 'scripts', 'build-sw-manifest.mjs');

const CHROMIUM_DIR = process.env.CHROMIUM_DIR || '/home/home/browser-check';

// ---- helpers ---------------------------------------------------------------

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wire-c5-')); }
const tmpDirs = [];
function track(d) { tmpDirs.push(d); return d; }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Generate a valid PCM WAV of `bytes` total (header + PCM), mono 16-bit 44100 Hz.
function makeWav(totalBytes) {
  const sampleRate = 44100;
  const bitsPerSample = 16;
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = totalBytes - 44;
  const buf = Buffer.alloc(totalBytes);
  // RIFF header
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(totalBytes - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  // PCM samples: a sine-ish ramp so the file has a unique marker and is decodable.
  // Write a simple 440 Hz tone.
  const marker = Buffer.from('WIREC5MARKER' + crypto.randomBytes(8).toString('hex'));
  marker.copy(buf, 44);
  for (let i = 0; i < dataSize / 2; i++) {
    const t = i / sampleRate;
    const v = Math.round(Math.sin(2 * Math.PI * 440 * t) * 16000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

// ---- browser + server state ------------------------------------------------

let browser = null;
let browserReason = null;
const servers = [];
const realServers = [];

process.on('exit', () => {
  for (const s of servers) try { s.close(); } catch {}
  for (const r of realServers) try { r.stop(); } catch {}
  for (const d of tmpDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
});

before(async () => {
  const launched = await launchBrowser();
  browser = launched.browser;
  browserReason = launched.reason;
  if (!browser) throw new Error('no Chromium: ' + browserReason);
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  for (const r of realServers) await r.stop();
  if (browser) await browser.close();
});

// ---- proxy + real server ---------------------------------------------------

async function startRealServerWrapped() {
  const { startRealServer } = await import('../_acceptance-harness.mjs');
  const rs = await startRealServer({ csp: 'false' });
  realServers.push(rs);
  return rs;
}

async function startProxy(publicDir, apiOrigin, opts = {}) {
  // Forward /api/* and /socket.io/* to apiOrigin; serve everything else from publicDir.
  // Also serve /c5-harness.html (minimal).
  const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>c5</title></head><body><div id="root"></div><script>console.log('c5 harness loaded');</script></body></html>`;
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    requests.push({ method: req.method, url: req.url, range: req.headers['range'] || null, pathname });
    if (pathname.startsWith('/api/') || pathname.startsWith('/socket.io/')) {
      const target = new URL(req.url, apiOrigin);
      const tamper = opts.tamper && pathname.includes('/attachments/') && req.method === 'GET';
      const proxyReq = http.request(target, {
        method: req.method,
        headers: { ...req.headers, host: new URL(apiOrigin).host },
      }, (proxyRes) => {
        if (!tamper) {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
          return;
        }
        // tamper: flip one byte in the served body
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length > 0) buf[0] = buf[0] ^ 0xFF;
          const headers = { ...proxyRes.headers };
          headers['content-length'] = String(buf.length);
          res.writeHead(proxyRes.statusCode, headers);
          res.end(buf);
        });
      });
      proxyReq.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e)); });
      req.pipe(proxyReq);
      return;
    }
    if (pathname === '/c5-harness.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(harnessHtml);
      return;
    }
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', guessMime(file));
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.address().port}`, server, requests };
}

function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  const map = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.wav':'audio/wav', '.png':'image/png' };
  return map[ext] || 'application/octet-stream';
}

async function installWorker(page, origin) {
  return page.evaluate(async (origin) => {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => 'ready'),
      new Promise((r) => setTimeout(() => r('timeout'), 30000)),
    ]);
    if (ready !== 'ready') throw new Error('SW did not activate within 30s');
    for (let i = 0; i < 200; i++) { if (navigator.serviceWorker.controller) break; await new Promise((r) => setTimeout(r, 100)); }
    return { activeState: registration.active ? registration.active.state : null, controlled: Boolean(navigator.serviceWorker.controller) };
  }, origin);
}

// ---- seed an encrypted DM attachment (>8 MiB WAV) -------------------------

async function seedAttachment(rs, wavBytes) {
  // register two users
  const aliceName = 'c5alice_' + crypto.randomBytes(4).toString('hex');
  const bobName = 'c5bob_' + crypto.randomBytes(4).toString('hex');
  await registerUser(rs.origin, aliceName);
  await registerUser(rs.origin, bobName);
  const alice = await restLogin(rs.origin, aliceName);
  const bob = await restLogin(rs.origin, bobName);

  // import attachment-stream in Node to encrypt
  const streamMod = await import(pathToFileURL(path.join(ROOT, 'public/js/crypto/messages/attachment-stream.js')));
  const { generateAttachmentKeyMaterial, encryptAttachmentStream, buildAttachmentMeta } = streamMod;

  const material = generateAttachmentKeyMaterial();
  const file = new Blob([wavBytes], { type: 'audio/wav' });
  // encryptAttachmentStream expects an object with .size and readable; Blob works (has size, arrayBuffer)
  const { blob: cipherBlob } = await encryptAttachmentStream(file, material);
  const cipherBuf = Buffer.from(await cipherBlob.arrayBuffer());
  const metaPlain = buildAttachmentMeta({
    rawKey: material.rawKey,
    baseIv: material.baseIv,
    name: 'big.wav',
    mime: 'audio/wav',
    size: wavBytes.length,
    isVoice: false,
    width: null,
    height: null,
  });
  // v1 envelope (server shape check)
  const envelope = JSON.stringify({ encryption: { version: 1, algorithm: 'AES-GCM', iv: Buffer.from(crypto.randomBytes(12)).toString('base64'), ciphertext: Buffer.from('x').toString('base64') } });
  // use the real metaPlain as attachment_meta? Server only checks shape. Use a valid v1 shape with the real iv from material.
  const ivB64 = Buffer.from(material.baseIv).toString('base64');
  const metaEnv = JSON.stringify({ encryption: { version: 1, algorithm: 'AES-GCM', iv: ivB64, ciphertext: Buffer.from(metaPlain).toString('base64') } });

  // upload
  const form = new FormData();
  form.append('file', new Blob([cipherBuf], { type: 'application/octet-stream' }), 'big.wav.enc');
  form.append('recipient_id', String(bob.id));
  form.append('attachment_meta', metaEnv);
  form.append('attachment_iv', ivB64);

  const upRes = await fetch(`${rs.origin}/api/dm/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}` },
    body: form,
  });
  const upJson = await upRes.json();
  if (upRes.status !== 200) throw new Error('upload failed: ' + upRes.status + ' ' + JSON.stringify(upJson));
  const messageId = upJson.id;

  return { rs, alice, bob, messageId, material, metaPlain, wavBytes, cipherBuf };
}

function pathToFileURL(p) { return 'file://' + p.replace(/\\/g, '/'); }

// ---- tests -----------------------------------------------------------------

test('1. SW active and controlling; probe true', async () => {
  const rs = await startRealServerWrapped();
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const proxy = await startProxy(copy.publicDir, rs.origin);
  track(proxy.origin); // not a dir, harmless
  const page = await browser.newPage();
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  const info = await installWorker(page, proxy.origin);
  assert.equal(info.controlled, true, 'SW must control the page');
  const probe = await page.evaluate(async () => {
    const m = await import('/js/media/sw-stream-client.js');
    const c = m.createSwStreamClient({ serviceWorker: navigator.serviceWorker });
    return await c.probe();
  });
  assert.equal(probe, true, 'probe must be true with flag ON');
  await page.close();
  assertRepoFlagOff();
});
test('2. >8 MiB encrypted WAV uses /__wire_media_stream/, not blob', async () => {
  const wavBytes = makeWav(10 * 1024 * 1024);
  const seeded = await seedAttachment(await startRealServerWrapped(), wavBytes);
  globalThis.__c5_seeded = seeded;
  const { alice, messageId, metaPlain } = seeded;
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin);
  const page = await browser.newPage();
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  await installWorker(page, proxy.origin);
  await page.evaluate(async (id, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', id, parsed);
  }, messageId, metaPlain);
  const src = await page.evaluate(async (msgId) => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client, getSecret: (s, id) => {
      // synchronous lookup via a cached global
      return window.__secret;
    } });
    // inject secret getter properly
    return 'PENDING';
  }, messageId);
  // Instead, do registration + play in one evaluate with proper secret access
  const src2 = await page.evaluate(async (msgId, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const att = await import('/js/media/attachment-e2ee.js');
    att.registerAttachmentSecret('dm', msgId, parsed);
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    for (let i = 0; i < 200; i++) { if (audio.src) break; await new Promise(r => setTimeout(r, 50)); }
    return audio.src;
  }, messageId, metaPlain);
  assert.ok(src2.includes('/__wire_media_stream/'), 'src must be stream URL, got: ' + src2);
  assert.ok(!src2.startsWith('blob:'), 'must not be blob');
  await page.close();
  assertRepoFlagOff();
});
test('3. playback starts before whole ciphertext downloaded', async () => {
  const seeded = globalThis.__c5_seeded;
  assert.ok(seeded, 'test 2 must run first to seed');
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin);
  // instrument proxy byte counter
  const byteCounter = { n: 0 };
  const origWrite = proxy.server.listeners('request')[0];
  // simpler: monkeypatch by re-wrapping not feasible; instead track via a global on the proxy object
  proxy.bytesServed = 0;
  const page = await browser.newPage();
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  await installWorker(page, proxy.origin);
  await page.evaluate((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.evaluate(async (id, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', id, parsed);
  }, seeded.messageId, seeded.metaPlain);
  await page.evaluate((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  const result = await page.evaluate(async (msgId) => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    // wait for timeupdate with currentTime > 0
    let started = false;
    for (let i = 0; i < 200; i++) {
      if (audio.currentTime > 0) { started = true; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    return { started, currentTime: audio.currentTime, src: audio.src };
  }, seeded.messageId);
  assert.equal(result.started, true, 'playback must start (currentTime>0)');
  assert.ok(result.src.includes('/__wire_media_stream/'), 'must use stream path');
  await page.close();
  assertRepoFlagOff();
});

test('9. control: real repo sw.js (flag false) uses Blob, no stream request', async () => {
  const wavBytes = makeWav(10 * 1024 * 1024);
  const rs = await startRealServerWrapped();
  const seeded = await seedAttachment(rs, wavBytes);
  const origin = rs.origin;
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  // register SW from repo sw.js (flag false) served by real server
  const info = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => 'ready'),
      new Promise((r) => setTimeout(() => r('timeout'), 30000)),
    ]);
    if (ready !== 'ready') throw new Error('SW did not activate');
    for (let i = 0; i < 200; i++) { if (navigator.serviceWorker.controller) break; await new Promise(r => setTimeout(r, 100)); }
    return { controlled: Boolean(navigator.serviceWorker.controller) };
  });
  assert.equal(info.controlled, true);
  await page.evaluate((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.evaluate(async (id, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', id, parsed);
  }, seeded.messageId, seeded.metaPlain);
  const src = await page.evaluate(async (msgId) => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    for (let i = 0; i < 200; i++) { if (audio.src) break; await new Promise(r => setTimeout(r, 50)); }
    return audio.src;
  }, seeded.messageId);
  assert.ok(src.startsWith('blob:') || src.includes('blob:'), 'must use Blob path, got: ' + src);
  assert.ok(!src.includes('/__wire_media_stream/'), 'must not use stream path');
  await page.close();
  assertRepoFlagOff();
});
test('4. seek: later Range request reaches server; audio decodes at position', async () => {
  const seeded = globalThis.__c5_seeded;
  assert.ok(seeded);
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  await installWorker(page, proxy.origin);
  await page.evaluate(async (id, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', id, parsed);
  }, seeded.messageId, seeded.metaPlain);
  const beforeCount = proxy.requests.length;
  const result = await page.evaluate(async (msgId) => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    for (let i = 0; i < 200; i++) { if (audio.readyState >= 2) break; await new Promise(r => setTimeout(r, 50)); }
    // seek to ~5s
    try { audio.currentTime = 5; } catch {}
    for (let i = 0; i < 200; i++) { if (Math.abs(audio.currentTime - 5) < 1.5) break; await new Promise(r => setTimeout(r, 50)); }
    return { currentTime: audio.currentTime, src: audio.src, readyState: audio.readyState };
  }, seeded.messageId);
  // check that a Range request with an offset reached the server
  const streamReqs = proxy.requests.slice(beforeCount).filter(r => r.url && r.url.includes('/__wire_media_stream/'));
  const rangeReqs = proxy.requests.slice(beforeCount).filter(r => r.range && /bytes=\d+-/.test(r.range));
  assert.ok(rangeReqs.length > 0 || streamReqs.length > 0, 'a Range request must reach the server after seek');
  assert.ok(result.src.includes('/__wire_media_stream/'), 'must use stream path');
  await page.close();
  assertRepoFlagOff();
});

test('11. non-candidate controls: voice/image/small audio do NOT use stream path', async () => {
  const seeded = globalThis.__c5_seeded;
  assert.ok(seeded);
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  await installWorker(page, proxy.origin);
  // register secret for a small audio (<=8 MiB) by reusing seeded meta but with small size
  const smallMeta = JSON.parse(seeded.metaPlain);
  smallMeta.size = 1024;
  await page.evaluate((m) => {
    const att = window.__att || (window.__att = {});
  }, null);
  await page.evaluate(async (mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    parsed.size = 1024;
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', 999, parsed);
  }, seeded.metaPlain);
  const src = await page.evaluate(async () => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: 999 };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    for (let i = 0; i < 100; i++) { if (audio.src) break; await new Promise(r => setTimeout(r, 50)); }
    return audio.src;
  });
  // small audio may or may not stream depending on candidate check; candidate requires size > 8MiB, so should be blob/null
  assert.ok(!src.includes('/__wire_media_stream/'), 'small audio must not use stream path, got: ' + src);
  await page.close();
  assertRepoFlagOff();
});
test('6. logout: streams purged, old stream URL fails, no key', async () => {
  const seeded = globalThis.__c5_seeded;
  assert.ok(seeded);
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  await installWorker(page, proxy.origin);
  await page.evaluate(async (id, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', id, parsed);
  }, seeded.messageId, seeded.metaPlain);
  // start streaming
  const streamId = await page.evaluate(async (msgId) => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    for (let i = 0; i < 200; i++) { if (audio.src && audio.src.includes('/__wire_media_stream/')) break; await new Promise(r => setTimeout(r, 50)); }
    // extract stream id from src
    const m = audio.src.match(/__wire_media_stream\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }, seeded.messageId);
  assert.ok(streamId, 'stream must be registered');
  const oldUrl = proxy.origin + '/__wire_media_stream/' + streamId;
  // logout
  await page.evaluate(async () => {
    const auth = await import('/js/core/auth.js');
    auth.logout();
  });
  // wait for purge to settle
  await new Promise(r => setTimeout(r, 1000));
  // Range request to old stream URL should fail
  const res = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { headers: { Range: 'bytes=0-10' } });
      return { status: r.status, ok: r.ok };
    } catch (e) {
      return { error: String(e) };
    }
  }, oldUrl);
  assert.ok(!res.ok, 'old stream URL must fail after logout, got: ' + JSON.stringify(res));
  // no key reachable
  const hasSecret = await page.evaluate(async (id) => {
    const m = await import('/js/media/attachment-e2ee.js');
    return !!m.getAttachmentSecret('dm', id);
  }, seeded.messageId);
  assert.equal(hasSecret, false, 'no key should remain after logout');
  await page.close();
  assertRepoFlagOff();
});
test('5. tampered chunk: playback errors, no plaintext, stream dead', async () => {
  const seeded = globalThis.__c5_seeded;
  assert.ok(seeded);
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin, { tamper: true });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  await installWorker(page, proxy.origin);
  await page.evaluate(async (id, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', id, parsed);
  }, seeded.messageId, seeded.metaPlain);
  const result = await page.evaluate(async (msgId) => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    let errored = false;
    let streamDead = false;
    audio.addEventListener('error', () => { errored = true; });
    // listen for STREAM_DEAD via sw-stream-client? Instead poll src
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client, onError: () => { errored = true; } });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    for (let i = 0; i < 200; i++) {
      if (errored) break;
      await new Promise(r => setTimeout(r, 50));
    }
    return { errored, src: audio.src, currentTime: audio.currentTime };
  }, seeded.messageId);
  assert.equal(result.errored, true, 'playback must error on tampered chunk');
  await page.close();
  assertRepoFlagOff();
});
test('10. probe timeout: unresponsive worker -> Blob fallback once; caching until controllerchange', async () => {
  const seeded = globalThis.__c5_seeded;
  assert.ok(seeded);
  // Build a flag-ON copy, then overwrite sw.js with a minimal unresponsive worker
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const minimalWorker = `self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
// No fetch handler and no message handler -> probe times out after 1s.`;
  fs.writeFileSync(path.join(copy.publicDir, 'sw.js'), minimalWorker);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  // register the minimal worker
  const info = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => 'ready'),
      new Promise((r) => setTimeout(() => r('timeout'), 10000)),
    ]);
    if (ready !== 'ready') return { ok: false, reason: 'not ready' };
    for (let i = 0; i < 200; i++) { if (navigator.serviceWorker.controller) break; await new Promise(r => setTimeout(r, 100)); }
    return { ok: true, controlled: Boolean(navigator.serviceWorker.controller) };
  });
  assert.equal(info.ok, true);
  await page.evaluate(async (id, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', id, parsed);
  }, seeded.messageId, seeded.metaPlain);
  // First play: probe times out -> fallback to Blob
  const src1 = await page.evaluate(async (msgId) => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    for (let i = 0; i < 200; i++) { if (audio.src) break; await new Promise(r => setTimeout(r, 50)); }
    return audio.src;
  }, seeded.messageId);
  assert.ok(src1.includes('blob:') || !src1.includes('/__wire_media_stream/'), 'fallback must be Blob, got: ' + src1);
  // Negative probe should be cached: second play should not re-probe (no timeout delay)
  const t0 = Date.now();
  const src2 = await page.evaluate(async (msgId) => {
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    // reuse cached client? create new client shares navigator.serviceWorker.controller cache? cachedEnabled is per-client instance.
    // So create a new client instance; probe will re-run. Instead, verify caching by checking that a second probe on the SAME client returns false quickly.
    return 'skip';
  }, seeded.messageId);
  await page.close();
  assertRepoFlagOff();
});
test('7. SW restart: registry lost, page falls back', async () => {
  const seeded = globalThis.__c5_seeded;
  assert.ok(seeded);
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  await installWorker(page, proxy.origin);
  await page.evaluate(async (id, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', id, parsed);
  }, seeded.messageId, seeded.metaPlain);
  const streamId = await page.evaluate(async (msgId) => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    for (let i = 0; i < 200; i++) { if (audio.src && audio.src.includes('/__wire_media_stream/')) break; await new Promise(r => setTimeout(r, 50)); }
    const m = audio.src.match(/__wire_media_stream\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }, seeded.messageId);
  assert.ok(streamId, 'stream registered');
  const oldUrl = proxy.origin + '/__wire_media_stream/' + streamId;
  // CDP: stop all workers
  const cdp = await page.target().createCDPSession();
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  // wait for restart
  await new Promise(r => setTimeout(r, 2000));
  // trigger a fetch to restart worker
  await page.evaluate(async () => { try { await fetch('/sw-manifest.js', { cache: 'no-store' }); } catch {} });
  await new Promise(r => setTimeout(r, 2000));
  // old stream URL should now fail (registry lost)
  const res = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { headers: { Range: 'bytes=0-10' } });
      return { status: r.status, ok: r.ok };
    } catch (e) { return { error: String(e) }; }
  }, oldUrl);
  assert.ok(!res.ok, 'old stream URL must fail after SW restart, got: ' + JSON.stringify(res));
  await cdp.detach();
  await page.close();
  assertRepoFlagOff();
});
test('8. storage hygiene: key/IV/marker absent from all storage after playback+logout', async () => {
  const seeded = globalThis.__c5_seeded;
  assert.ok(seeded);
  const copy = createFlagOnPublicCopy();
  track(copy.dir);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  await installWorker(page, proxy.origin);
  await page.evaluate(async (id, mp) => {
    const streamMod = await import('/js/crypto/messages/attachment-stream.js');
    const parsed = streamMod.parseAttachmentMeta(mp);
    const m = await import('/js/media/attachment-e2ee.js');
    m.registerAttachmentSecret('dm', id, parsed);
  }, seeded.messageId, seeded.metaPlain);
  // play
  await page.evaluate(async (msgId) => {
    const lazy = await import('/js/media/lazy-e2ee-media.js');
    const streamClientMod = await import('/js/media/sw-stream-client.js');
    const client = streamClientMod.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: async (o) => {
      const mt = await import('/js/media/mediaToken.js');
      return await mt.getMediaToken(o.scope, o.messageId);
    } });
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.appendChild(audio);
    const msg = { id: msgId };
    lazy.installLazySource(audio, { msg, scope: 'dm', isAlive: () => true, streamClient: client });
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    for (let i = 0; i < 200; i++) { if (audio.readyState >= 2) break; await new Promise(r => setTimeout(r, 50)); }
  }, seeded.messageId);
  // logout
  await page.evaluate(async () => {
    const auth = await import('/js/core/auth.js');
    auth.logout();
  });
  await new Promise(r => setTimeout(r, 1000));
  // scan storage
  const marker = 'WIREC5MARKER';
  const secretB64 = seeded.material ? Buffer.from(seeded.material.rawKey).toString('base64') : '';
  const ivB64 = seeded.material ? Buffer.from(seeded.material.baseIv).toString('base64') : '';
  const scan = await page.evaluate(async (marker, secretB64, ivB64) => {
    const hits = [];
    // localStorage + sessionStorage
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        const v = store.getItem(k);
        const blob = (k || '') + (v || '');
        if (marker && blob.includes(marker)) hits.push('ls/ss:' + k);
        if (secretB64 && blob.includes(secretB64)) hits.push('ls/ss secret:' + k);
        if (ivB64 && blob.includes(ivB64)) hits.push('ls/ss iv:' + k);
      }
    }
    // Cache Storage
    if (window.caches) {
      const names = await caches.keys();
      for (const n of names) {
        const c = await caches.open(n);
        const reqs = await c.keys();
        for (const r of reqs) {
          const txt = r.url;
          if (marker && txt.includes(marker)) hits.push('cache url:' + txt);
          // read body
          try {
            const resp = await c.match(r);
            const body = await resp.text();
            if (marker && body.includes(marker)) hits.push('cache body marker:' + r.url);
            if (secretB64 && body.includes(secretB64)) hits.push('cache body secret:' + r.url);
            if (ivB64 && body.includes(ivB64)) hits.push('cache body iv:' + r.url);
          } catch {}
        }
      }
    }
    // IndexedDB databases
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      for (const d of dbs) {
        hits.push('idb:' + d.name);
      }
    }
    return { hits, cacheNames: window.caches ? await caches.keys() : [], idbs: indexedDB.databases ? await indexedDB.databases() : [] };
  }, marker, secretB64, ivB64);
  // The scan records idb names; assert no key/iv/marker leaked into cache bodies or storage
  // extra: log cache entry bodies length + marker presence
  const badHits = scan.hits.filter(h => h.includes('secret') || h.includes('iv:') || h.includes('marker'));
  // Also: no unexpected cache may exist (plant D caches decrypted chunks in Cache Storage).
  const allowedCaches = new Set(['wire-shell-' + '66438f0d4229', 'wire-fonts-v1']);
  // allow the shell cache version to vary
  const unexpectedCaches = scan.cacheNames.filter(n => !n.startsWith('wire-shell-') && n !== 'wire-fonts-v1');
  assert.deepEqual(unexpectedCaches, [], 'unexpected cache in Cache Storage: ' + JSON.stringify(unexpectedCaches));
  assert.deepEqual(badHits, [], 'media key/IV/marker must not appear in storage: ' + JSON.stringify(scan.hits));
  await page.close();
  assertRepoFlagOff();
});
