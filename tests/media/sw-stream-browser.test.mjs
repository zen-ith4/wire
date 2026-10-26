// tests/media/sw-stream-browser.test.mjs
//
// C5d: real-Chromium browser tests of progressive encrypted DM media streaming.
//
// The repository's public/sw.js ships MEDIA_STREAM_ENABLED = false. Every test
// that needs the stream route builds its own flag-ON copy of public/ through
// tests/helpers/sw-flag-on-copy.mjs, serves that copy from a local proxy that
// forwards /api/* to a fresh real server, and never writes to the repository.
//
// Each test is self-contained: it starts its own server, seeds its own
// encrypted attachment and opens its own page. No test reads state left by
// another test, and no test depends on declaration order.
//
// Evidence is only valid from WSL2 + @sparticuz/chromium 153 (HeadlessChrome/153.x).
// Set CHROMIUM_DIR to the directory that holds @sparticuz/chromium and
// puppeteer-core (see tests/_acceptance-harness.mjs launchBrowser()).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

import { launchBrowser, startRealServer, registerUser, restLogin } from '../_acceptance-harness.mjs';
import { createFlagOnPublicCopy, assertRepoFlagOff, regenerateCopyManifest } from '../helpers/sw-flag-on-copy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---- wire constants (must match public/js/crypto/messages/attachment-stream.js)

const CHUNK = 64 * 1024;          // STREAM_CHUNK_SIZE
const TAG = 16;                   // STREAM_TAG_BYTES
const HDR = 8;                    // STREAM_HEADER_BYTES
const CT_CHUNK = CHUNK + TAG;
const WAV_HEADER = 44;
const BYTES_PER_SEC = 44100 * 2;  // mono 16-bit 44100 Hz
// Test 4 seeks to 60 s, not 5 s. Test 3 measures that ~2 MiB of ciphertext
// (about the first 22 s of audio) is already fetched before playback starts,
// so a 5 s seek is served from the buffer and must not expect a new Range.
const SEEK_SECONDS = 60;
const TAMPER_CHUNK = 1;           // the ONE ciphertext chunk corrupted in test 5
const TAMPER_AT = HDR + TAMPER_CHUNK * CT_CHUNK + 100; // one byte inside that chunk
const WAV_SIZE = 10 * 1024 * 1024; // > 8 MiB: a streaming candidate

/** Ciphertext offset where plaintext chunk i starts. */
function ctChunkStart(i) { return HDR + i * CT_CHUNK; }
/** Total ciphertext bytes for a plaintext size (mirrors encryptedSizeFor). */
function ctTotal(plainSize) { return HDR + plainSize + Math.max(1, Math.ceil(plainSize / CHUNK)) * TAG; }

// ---- helpers ---------------------------------------------------------------

const tmpDirs = [];
function track(dir) { tmpDirs.push(dir); return dir; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function log(line) { console.log(`# c5d: ${line}`); }

async function poll(fn, ms = 30000, step = 100) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > ms) return value;
    await sleep(step);
  }
}

/** Generates a PCM WAV of `totalBytes`: a 440 Hz tone with an ASCII marker at the start. */
function makeWav(totalBytes, marker) {
  const sampleRate = 44100;
  const dataSize = totalBytes - WAV_HEADER;
  const buf = Buffer.alloc(totalBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(totalBytes - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < dataSize / 2; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000);
    buf.writeInt16LE(v, WAV_HEADER + i * 2);
  }
  // Written AFTER the samples: writing it first let the sample loop overwrite it.
  Buffer.from(marker, 'ascii').copy(buf, WAV_HEADER);
  if (buf.indexOf(marker) !== WAV_HEADER) throw new Error('fixture: marker must sit at the first PCM byte');
  return buf;
}

// ---- proxy: forwards /api/* to the real server, serves the flag-ON copy ----

const servers = [];
const realServers = [];

async function startRealServerWrapped() {
  const rs = await startRealServer({ csp: 'false' });
  realServers.push(rs);
  return rs;
}

function guessMime(file) {
  const map = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav', '.png': 'image/png' };
  return map[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * @param {string} publicDir        the flag-ON copy to serve
 * @param {string} apiOrigin        the real server
 * @param {{tamperAt?: number|null}} [opts]
 *   tamperAt: absolute ciphertext byte offset to flip in every attachment
 *   response whose served range covers it (exactly one byte, one chunk).
 */
async function startProxy(publicDir, apiOrigin, opts = {}) {
  const harnessHtml = '<!doctype html><html><head><meta charset="utf-8"><title>c5</title></head><body><div id="root"></div></body></html>';
  const proxy = { requests: [], bytesServed: 0, tamperedCount: 0, origin: '', server: null };
  proxy.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    proxy.requests.push({ method: req.method, url: req.url, range: req.headers.range || null, pathname, at: Date.now() });

    if (pathname.startsWith('/api/') || pathname.startsWith('/socket.io/')) {
      const target = new URL(req.url, apiOrigin);
      const isAttachment = pathname.startsWith('/api/dm/attachments/') && req.method === 'GET';
      const proxyReq = http.request(target, {
        method: req.method,
        headers: { ...req.headers, host: new URL(apiOrigin).host },
      }, (proxyRes) => {
        if (!isAttachment) {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
          return;
        }
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () => {
          let buf = Buffer.concat(chunks);
          proxy.bytesServed += buf.length;
          if (opts.tamperAt != null) {
            const cr = /^bytes (\d+)-(\d+)\//.exec(proxyRes.headers['content-range'] || '');
            const start = cr ? Number(cr[1]) : 0;
            const end = cr ? Number(cr[2]) : buf.length - 1;
            if (opts.tamperAt >= start && opts.tamperAt <= end) {
              buf = Buffer.from(buf);
              buf[opts.tamperAt - start] ^= 0x01;
              proxy.tamperedCount += 1;
            }
          }
          const headers = { ...proxyRes.headers, 'content-length': String(buf.length) };
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
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', guessMime(file));
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => proxy.server.listen(0, '127.0.0.1', r));
  servers.push(proxy.server);
  proxy.origin = `http://127.0.0.1:${proxy.server.address().port}`;
  return proxy;
}

// ---- page-side library (one helper for register / play / snapshot / scan) --

/**
 * Injected once per page as window.__c5. It is the only place where the page
 * registers a secret, starts a lazy source, reads state, or scans storage.
 */
function pageLib() {
  const STREAM = '/__wire_media_stream/';
  const state = { errored: 0, lazyErrors: 0, srcSets: 0, blobSets: 0, deadMsgs: 0, streamUrl: null, lastSrc: '', el: null, client: null };
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'STREAM_DEAD') state.deadMsgs += 1;
  });

  const mintFor = async (o) => {
    const mt = await import('/js/media/mediaToken.js');
    return mt.getMediaToken(o.scope, o.messageId);
  };

  const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const bytesToHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const hasSeq = (hay, needle) => {
    if (needle.length === 0 || hay.length < needle.length) return false;
    outer: for (let i = 0; i <= hay.length - needle.length; i += 1) {
      if (hay[i] !== needle[0]) continue;
      for (let j = 1; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  };

  async function scanControl(marker) {
    const name = 'c5-scan-control';
    const cache = await caches.open(name);
    await cache.put(new Request('http://127.0.0.1/c5-scan-control'), new Response(marker));
    return name;
  }

  async function collect(value, out, where) {
    if (value == null) return;
    if (typeof value === 'string') { out.strings.push([where, value]); return; }
    if (value instanceof ArrayBuffer) { out.bytes.push([where, new Uint8Array(value)]); return; }
    if (ArrayBuffer.isView(value)) { out.bytes.push([where, new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]); return; }
    if (typeof Blob !== 'undefined' && value instanceof Blob) { out.bytes.push([where, new Uint8Array(await value.arrayBuffer())]); out.blobs += 1; return; }
    if (Array.isArray(value)) { for (const v of value) await collect(v, out, where); return; }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) { out.strings.push([where, k]); await collect(v, out, where); }
    }
  }

  return (window.__c5 = {
    state,

    /** Writes a known marker into a scratch cache so the scanner can be proven to see Cache Storage bodies. */
    async scanControlPut(marker) { return scanControl(marker); },
    async scanControlDelete(name) { return caches.delete(name); },

    async register(messageId, metaPlain) {
      const sm = await import('/js/crypto/messages/attachment-stream.js');
      const att = await import('/js/media/attachment-e2ee.js');
      att.registerAttachmentSecret('dm', messageId, sm.parseAttachmentMeta(metaPlain));
      return true;
    },

    async hasSecret(messageId) {
      const att = await import('/js/media/attachment-e2ee.js');
      return !!att.getAttachmentSecret('dm', messageId);
    },

    /** Starts a lazy source on a fresh element and plays it. Returns the src it got. */
    async play(messageId, kind = 'audio') {
      const lazy = await import('/js/media/lazy-e2ee-media.js');
      const scl = await import('/js/media/sw-stream-client.js');
      const client = scl.createSwStreamClient({ serviceWorker: navigator.serviceWorker, mintMediaToken: mintFor });
      const el = document.createElement(kind);
      el.muted = true;
      el.preload = 'auto';
      document.body.appendChild(el);
      state.el = el;
      state.client = client;
      el.addEventListener('error', () => { state.errored += 1; });
      new MutationObserver(() => {
        const v = el.getAttribute('src') || '';
        if (!v || v === state.lastSrc) return;
        state.lastSrc = v;
        state.srcSets += 1;
        if (v.startsWith('blob:')) state.blobSets += 1;
        if (v.includes(STREAM) && !state.streamUrl) state.streamUrl = new URL(v, location.href).href;
      }).observe(el, { attributes: true, attributeFilter: ['src'] });
      lazy.installLazySource(el, {
        msg: { id: messageId },
        scope: 'dm',
        isAlive: () => true,
        streamClient: client,
        onError: () => { state.lazyErrors += 1; },
      });
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
      for (let i = 0; i < 400; i += 1) {
        if (el.getAttribute('src')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return el.getAttribute('src') || '';
    },

    /**
     * Probes a stream URL the way playback does: through an <audio> element.
     * A script fetch() has destination "empty" and always gets 404 from the
     * worker, so only a media element can show whether bytes would play.
     */
    async probeMedia(url) {
      // Chromium's media cache answers an identical URL from memory, which made
      // a dead stream look alive. The worker matches the stream on the pathname,
      // so a unique query reaches the worker and changes nothing else.
      const probeUrl = url + (url.includes('?') ? '&' : '?') + 'c5probe=' + crypto.randomUUID();
      const el = document.createElement('audio');
      el.muted = true;
      document.body.appendChild(el);
      const result = await new Promise((resolve) => {
        const done = (why) => resolve({ why, error: el.error ? el.error.code : null, currentTime: el.currentTime, readyState: el.readyState });
        el.addEventListener('error', () => done('error'), { once: true });
        el.addEventListener('loadeddata', () => done('loadeddata'), { once: true });
        el.src = probeUrl;
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
        setTimeout(() => done('timeout'), 6000);
      });
      el.remove();
      return result;
    },

    /** Resolves the src the way the chat does for a non-streaming attachment. */
    async resolveBlob(messageId) {
      const mt = await import('/js/media/mediaToken.js');
      const r = await mt.resolveMediaSrc({ id: messageId }, 'dm');
      return r && r.src ? r.src : '';
    },

    snapshot() {
      const el = state.el;
      return {
        currentTime: el ? el.currentTime : null,
        readyState: el ? el.readyState : null,
        src: el ? (el.getAttribute('src') || '') : '',
        mediaError: el && el.error ? el.error.code : null,
        errored: state.errored,
        lazyErrors: state.lazyErrors,
        srcSets: state.srcSets,
        blobSets: state.blobSets,
        deadMsgs: state.deadMsgs,
        streamUrl: state.streamUrl,
      };
    },

    seek(t) { state.el.currentTime = t; return state.el.currentTime; },

    /**
     * Captures the decoded PCM the media element produces (not a byte fetch:
     * the worker only serves audio/video destinations). Web Audio at 44100 Hz
     * means no resampling, so each sample is exactly int16 / 32768.
     */
    async capture(count) {
      const el = state.el;
      const ctx = new AudioContext({ sampleRate: 44100 });
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch {} }
      const source = ctx.createMediaElementSource(el);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const frames = [];
      let got = 0;
      const t0 = el.currentTime;
      proc.onaudioprocess = (e) => {
        if (got >= count) return;
        const ch = e.inputBuffer.getChannelData(0);
        frames.push(Float32Array.from(ch));
        got += ch.length;
      };
      source.connect(proc);
      proc.connect(ctx.destination);
      // A muted element feeds silence into Web Audio, so unmute for the capture
      // and restore it after. Headless Chromium has no output device.
      el.muted = false;
      el.play().catch(() => {});
      await new Promise((resolve) => {
        const timer = setInterval(() => { if (got >= count) { clearInterval(timer); resolve(); } }, 50);
        setTimeout(() => { clearInterval(timer); resolve(); }, 30000);
      });
      el.pause();
      el.muted = true;
      const flat = new Float32Array(Math.min(got, count));
      let off = 0;
      for (const f of frames) { const n = Math.min(f.length, flat.length - off); flat.set(f.subarray(0, n), off); off += n; if (off >= flat.length) break; }
      const int16 = new Int16Array(flat.length);
      for (let i = 0; i < flat.length; i += 1) int16[i] = Math.max(-32768, Math.min(32767, Math.round(flat[i] * 32768)));
      let bin = '';
      const view = new Uint8Array(int16.buffer);
      for (let i = 0; i < view.length; i += 0x8000) bin += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
      await ctx.close();
      return { sampleRate: ctx.sampleRate, t0, samples: int16.length, b64: btoa(bin) };
    },

    /** A Range fetch through the stream URL, as the page sees it. */
    async fetchRange(url, range) {
      try {
        const r = await fetch(url, { headers: { Range: range }, cache: 'no-store' });
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return { status: r.status, ok: r.ok, contentRange: r.headers.get('content-range'), b64: btoa(bin) };
      } catch (e) {
        return { status: 0, ok: false, error: String(e), b64: '' };
      }
    },

    /** Walks every IndexedDB database/store/record, Cache Storage, and web storage. */
    async scan(keyB64, ivB64, marker) {
      const key = b64ToBytes(keyB64);
      const iv = b64ToBytes(ivB64);
      const markerBytes = Uint8Array.from(marker, (c) => c.charCodeAt(0));
      const needles = [
        ['marker', markerBytes], ['key', key], ['iv', iv],
      ];
      const textNeedles = [
        ['marker', marker], ['key-b64', keyB64], ['iv-b64', ivB64], ['key-hex', bytesToHex(key)], ['iv-hex', bytesToHex(iv)],
      ];
      const hits = [];
      const counts = { dbs: 0, stores: 0, records: 0, blobs: 0, caches: 0, cacheEntries: 0, storage: 0, bytesChecked: 0 };

      const check = (where, out) => {
        for (const [where2, text] of out.strings) {
          for (const [name, needle] of textNeedles) if (text.includes(needle)) hits.push(`${where}${where2} text:${name}`);
        }
        for (const [where2, buf] of out.bytes) {
          counts.bytesChecked += buf.length;
          for (const [name, needle] of needles) if (hasSeq(buf, needle)) hits.push(`${where}${where2} bytes:${name}`);
        }
      };

      // IndexedDB: every database, every store, every record.
      const dbInfos = indexedDB.databases ? await indexedDB.databases() : [];
      for (const info of dbInfos) {
        counts.dbs += 1;
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(info.name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const storeNames = Array.from(db.objectStoreNames);
        if (storeNames.length) {
          const tx = db.transaction(storeNames, 'readonly');
          for (const storeName of storeNames) {
            counts.stores += 1;
            const store = tx.objectStore(storeName);
            const records = await new Promise((resolve, reject) => {
              const found = [];
              const req = store.openCursor();
              req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) { resolve(found); return; }
                found.push({ key: cursor.key, value: cursor.value });
                cursor.continue();
              };
              req.onerror = () => reject(req.error);
            });
            for (const rec of records) {
              counts.records += 1;
              const out = { strings: [], bytes: [], blobs: 0 };
              await collect(rec.key, out, '');
              await collect(rec.value, out, '');
              counts.blobs += out.blobs;
              check(`idb:${info.name}/${storeName}`, out);
            }
          }
        }
        db.close();
      }

      // Cache Storage: every cache, every request URL, every response body.
      counts.cacheUrls = [];
      if (window.caches) {
        for (const name of await caches.keys()) {
          counts.caches += 1;
          const cache = await caches.open(name);
          for (const req of await cache.keys()) {
            counts.cacheEntries += 1;
            counts.cacheUrls.push(name + ' ' + req.url.replace(/^https?:\/\/[^/]+/, ''));
            const out = { strings: [[ '', req.url ]], bytes: [], blobs: 0 };
            const resp = await cache.match(req);
            if (resp) {
              const bodyBytes = new Uint8Array(await resp.arrayBuffer());
              out.bytes.push(['', bodyBytes]);
              counts.cacheHeads = counts.cacheHeads || [];
              counts.cacheHeads.push(name + ' ' + req.url.replace(/^https?:\/\/[^/]+/, '').slice(-24) + ' len=' + bodyBytes.length + ' head=' + Array.from(bodyBytes.slice(0, 16), (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''));
            }
            check(`cache:${name} `, out);
          }
        }
      }

      // localStorage and sessionStorage: keys and values.
      for (const [label, store] of [['local', localStorage], ['session', sessionStorage]]) {
        for (let i = 0; i < store.length; i += 1) {
          counts.storage += 1;
          const k = store.key(i);
          check(`${label}Storage`, { strings: [['key', k], ['value', store.getItem(k) || '']], bytes: [], blobs: 0 });
        }
      }

      return { hits, counts, dbNames: dbInfos.map((d) => d.name) };
    },
  }) && true;
}
const PAGE_LIB = `(${pageLib.toString()})()`;

// ---- browser ---------------------------------------------------------------

let browser = null;
let browserReason = null;

before(async () => {
  const launched = await launchBrowser();
  browser = launched.browser;
  browserReason = launched.reason;
  if (!browser) throw new Error('no Chromium: ' + browserReason);
  log(`browser ready`);
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await Promise.all(realServers.map((r) => r.stop()));
  if (browser) await browser.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---- per-test scenario -----------------------------------------------------

async function installWorker(page, origin) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => 'ready'),
      new Promise((r) => setTimeout(() => r('timeout'), 30000)),
    ]);
    if (ready !== 'ready') throw new Error('SW did not activate within 30s');
    for (let i = 0; i < 200; i += 1) { if (navigator.serviceWorker.controller) break; await new Promise((r) => setTimeout(r, 100)); }
    return { activeState: registration.active ? registration.active.state : null, controlled: Boolean(navigator.serviceWorker.controller) };
  }, origin);
}

/**
 * Seeds one encrypted DM attachment on `rs` (its own users, its own upload).
 * Returns everything a test needs to register, play and scan.
 */
async function makeUsers(rs) {
  const aliceName = 'c5alice_' + crypto.randomBytes(4).toString('hex');
  const bobName = 'c5bob_' + crypto.randomBytes(4).toString('hex');
  await registerUser(rs.origin, aliceName);
  await registerUser(rs.origin, bobName);
  return { alice: await restLogin(rs.origin, aliceName), bob: await restLogin(rs.origin, bobName) };
}

async function seedAttachment(rs, { bytes, name = 'big.wav', mime = 'audio/wav', isVoice = false, width = null, height = null, marker, users = null }) {
  const { alice, bob } = users || (await makeUsers(rs));

  const streamMod = await import(pathToFileURL(path.join(ROOT, 'public/js/crypto/messages/attachment-stream.js')).href);
  const { generateAttachmentKeyMaterial, encryptAttachmentStream, buildAttachmentMeta } = streamMod;

  const material = generateAttachmentKeyMaterial();
  const { blob: cipherBlob } = await encryptAttachmentStream(new Blob([bytes], { type: mime }), material);
  const cipherBuf = Buffer.from(await cipherBlob.arrayBuffer());
  const metaPlain = buildAttachmentMeta({
    rawKey: material.rawKey,
    baseIv: material.baseIv,
    name,
    mime,
    size: bytes.length,
    isVoice,
    width,
    height,
  });
  const ivB64 = Buffer.from(material.baseIv).toString('base64');
  const metaEnv = JSON.stringify({ encryption: { version: 1, algorithm: 'AES-GCM', iv: ivB64, ciphertext: Buffer.from(metaPlain).toString('base64') } });

  const form = new FormData();
  form.append('file', new Blob([cipherBuf], { type: 'application/octet-stream' }), name + '.enc');
  form.append('recipient_id', String(bob.id));
  form.append('attachment_meta', metaEnv);
  form.append('attachment_iv', ivB64);
  const upRes = await fetch(`${rs.origin}/api/dm/upload`, { method: 'POST', headers: { Authorization: `Bearer ${alice.token}` }, body: form });
  const upJson = await upRes.json();
  if (upRes.status !== 200) throw new Error('upload failed: ' + upRes.status + ' ' + JSON.stringify(upJson));

  return {
    rs, alice, bob, messageId: upJson.id, material, metaPlain, bytes, cipherBuf, marker,
    keyB64: Buffer.from(material.rawKey).toString('base64'),
    ivB64,
  };
}

/** Flag-ON copy + proxy + page with the worker controlling it and the lib injected. */
async function openCase(seeded, { tamperAt = null, fresh = false } = {}) {
  const copy = createFlagOnPublicCopy({ fresh });
  if (copy.created) track(copy.dir);
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin, { tamperAt });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  const info = await installWorker(page, proxy.origin);
  assert.equal(info.controlled, true, 'SW must control the page');
  await page.evaluate(PAGE_LIB);
  await page.evaluate(async (id, meta) => window.__c5.register(id, meta), seeded.messageId, seeded.metaPlain);
  return { copy, proxy, page };
}

const call = (page, name, ...args) => page.evaluate((n, a) => window.__c5[n](...a), name, args);
const snap = (page) => call(page, 'snapshot');

// ---- tests -----------------------------------------------------------------

test('1. SW active and controlling; probe true', async () => {
  const rs = await startRealServerWrapped();
  const copy = createFlagOnPublicCopy();
  if (copy.created) track(copy.dir);
  const proxy = await startProxy(copy.publicDir, rs.origin);
  const page = await browser.newPage();
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  const info = await installWorker(page, proxy.origin);
  assert.equal(info.controlled, true, 'SW must control the page');
  const probe = await page.evaluate(async () => {
    const m = await import('/js/media/sw-stream-client.js');
    const c = m.createSwStreamClient({ serviceWorker: navigator.serviceWorker });
    return c.probe();
  });
  assert.equal(probe, true, 'probe must be true with flag ON');
  await page.close();
  assertRepoFlagOff();
});

test('2. >8 MiB encrypted WAV uses /__wire_media_stream/, not blob', async () => {
  const seeded = await seedAttachment(await startRealServerWrapped(), {
    bytes: makeWav(WAV_SIZE, 'WIREC5MARKER-2'), marker: 'WIREC5MARKER-2',
  });
  const { page, proxy } = await openCase(seeded);
  const src = await call(page, 'play', seeded.messageId, 'audio');
  assert.ok(src.includes('/__wire_media_stream/'), 'src must be stream URL, got: ' + src);
  assert.ok(!src.startsWith('blob:'), 'must not be blob');
  await page.close();
  assertRepoFlagOff();
});

test('3. playback starts before whole ciphertext downloaded', async () => {
  const seeded = await seedAttachment(await startRealServerWrapped(), {
    bytes: makeWav(WAV_SIZE, 'WIREC5MARKER-3'), marker: 'WIREC5MARKER-3',
  });
  const { page, proxy } = await openCase(seeded);
  await call(page, 'play', seeded.messageId, 'audio');
  const started = await poll(async () => {
    const s = await snap(page);
    return s.currentTime > 0 ? s : null;
  }, 30000);
  assert.ok(started, 'playback must start (currentTime > 0)');
  const total = seeded.cipherBuf.length;
  const served = proxy.bytesServed;
  log(`test3 playback started at currentTime=${started.currentTime.toFixed(3)}s; ciphertext served=${served} of total=${total} bytes`);
  assert.ok(started.src.includes('/__wire_media_stream/'), 'must use stream path');
  assert.ok(served > 0, 'some ciphertext must have been served');
  assert.ok(served < total, `playback began while only ${served} of ${total} ciphertext bytes were served`);
  await page.close();
  assertRepoFlagOff();
});

test('4. seek: Range request at the seek position, correct time, correct decoded bytes', async () => {
  const seeded = await seedAttachment(await startRealServerWrapped(), {
    bytes: makeWav(WAV_SIZE, 'WIREC5MARKER-4'), marker: 'WIREC5MARKER-4',
  });
  const { page, proxy } = await openCase(seeded);
  await call(page, 'play', seeded.messageId, 'audio');
  await poll(async () => (await snap(page)).readyState >= 2);
  const mark = proxy.requests.length;

  // Network events for the media element's own requests: the response headers
  // the worker sent to the media pipeline (a script fetch cannot see them).
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  const mediaResponses = [];
  cdp.on('Network.responseReceived', (e) => {
    if (e.response && e.response.url.includes('/__wire_media_stream/')) {
      mediaResponses.push({ status: e.response.status, contentRange: e.response.headers['content-range'] || e.response.headers['Content-Range'] || null, type: e.type });
    }
  });

  await call(page, 'seek', SEEK_SECONDS);
  // Wait for the playback to really arrive at the target (not just the seek
  // assignment, which sets currentTime synchronously) and for the server to see
  // the Range that brought it there.
  const after = await poll(async () => {
    const s = await snap(page);
    const seen = proxy.requests.slice(mark).some((r) => r.pathname.startsWith('/api/dm/attachments/') && r.range);
    return seen && s.readyState >= 2 && Math.abs(s.currentTime - SEEK_SECONDS) < 1.5 ? s : null;
  }, 40000);
  assert.ok(after, 'currentTime must reach ~60 s after seek and the server must see a Range');

  // (a) a Range request with an offset consistent with the seek position
  const targetPlain = WAV_HEADER + SEEK_SECONDS * BYTES_PER_SEC; // 441044
  const targetChunk = Math.floor(targetPlain / CHUNK);            // 6
  const allowed = [ctChunkStart(targetChunk - 1), ctChunkStart(targetChunk)];
  const postRanges = proxy.requests.slice(mark)
    .filter((r) => r.pathname.startsWith('/api/dm/attachments/') && r.range)
    .map((r) => Number(/^bytes=(\d+)-/.exec(r.range)[1]));
  log(`test4 seek target plaintext offset=${targetPlain} (chunk ${targetChunk}); allowed ciphertext starts=${allowed.join(',')}; server range starts after seek=${postRanges.join(',') || 'none'}`);
  assert.ok(postRanges.some((s) => s > 0 && s >= allowed[0] && s <= allowed[1]),
    `a server Range start in [${allowed[0]}, ${allowed[1]}] must follow the seek; got [${postRanges}]`);

  // (b) currentTime within 1.5 s of the target
  assert.ok(Math.abs(after.currentTime - SEEK_SECONDS) < 1.5, `currentTime ${after.currentTime} not within 1.5 s of 5`);

  // Content-Range the media pipeline received after the seek: the PLAIN total.
  await sleep(500);
  const ranged = mediaResponses.filter((r) => r.status === 206 && r.contentRange);
  log(`test4 media-element 206 responses after seek: ${JSON.stringify(ranged)}`);
  assert.ok(ranged.length > 0, 'the media element must have received a 206 with Content-Range after the seek (CDP Network)');
  for (const r of ranged) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.contentRange);
    assert.ok(m, 'Content-Range must be bytes a-b/total, got ' + r.contentRange);
    assert.equal(Number(m[3]), seeded.bytes.length, 'Content-Range total must be the PLAIN size ' + seeded.bytes.length + ', got ' + m[3]);
  }
  await cdp.detach();

  // (c0) a script fetch of the stream URL must not read the bytes (by design:
  // the worker serves only audio/video destinations; a fetch has destination "empty").
  const scriptRead = await call(page, 'fetchRange', after.streamUrl, `bytes=${targetPlain}-${targetPlain + 55}`);
  assert.equal(scriptRead.status, 404, 'a script fetch of the stream URL must get 404, got ' + scriptRead.status);
  assert.equal(scriptRead.b64, '', 'a script fetch must receive no bytes');

  // (c) decoded content: the PCM the media element produces after the seek is the
  // plaintext, sample for sample. Sample-exact after aligning the capture.
  const WANT = 16384;
  const cap = await call(page, 'capture', WANT);
  assert.equal(cap.sampleRate, 44100, 'AudioContext must run at 44100 Hz (no resampling)');
  const capBuf = Buffer.from(cap.b64, 'base64');
  const capInt16 = new Int16Array(capBuf.buffer, capBuf.byteOffset, capBuf.length / 2);
  const pcm = new Int16Array(seeded.bytes.length / 2 - WAV_HEADER / 2);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = seeded.bytes.readInt16LE(WAV_HEADER + i * 2);
  const expectStart = Math.floor(targetPlain / 2 - WAV_HEADER / 2) - 44100;
  let aligned = -1;
  for (let s0 = Math.max(0, expectStart); s0 < Math.min(pcm.length - WANT, expectStart + 88200); s0 += 1) {
    let ok = true;
    for (let k = 0; k < 256; k += 1) if (capInt16[k] !== pcm[s0 + k]) { ok = false; break; }
    if (ok) { aligned = s0; break; }
  }
  let nonzero = 0; for (let k = 0; k < capInt16.length; k += 1) if (capInt16[k] !== 0) nonzero += 1;
  log(`test4 capture diagnostics: samples=${capInt16.length} nonzero=${nonzero} first8=[${Array.from(capInt16.slice(0, 8)).join(',')}] expectStart=${expectStart} pcmLen=${pcm.length}`);
  assert.ok(aligned >= 0, 'captured PCM must align with the plaintext within +-1 s of the seek');
  assert.ok(Math.abs(aligned / 44100 - SEEK_SECONDS) < 1.5, `decoded position ${(aligned / 44100).toFixed(3)} s must be within 1.5 s of the seek target`);
  const wantPcm = Buffer.from(pcm.buffer, pcm.byteOffset + aligned * 2, WANT * 2);
  const gotPcm = Buffer.from(capInt16.buffer, capInt16.byteOffset, WANT * 2);
  assert.equal(sha256(gotPcm), sha256(wantPcm), 'decoded PCM must equal the plaintext PCM');
  log(`test4 decoded PCM: captured ${cap.samples} samples from currentTime~${cap.t0.toFixed(2)}s, aligned at plaintext sample ${aligned} (t=${(aligned / 44100).toFixed(3)}s); sha256(${WANT} samples)=${sha256(gotPcm)} == plaintext`);

  await page.close();
  assertRepoFlagOff();
});

test('5. tampered chunk: playback errors, no plaintext past it, stream dead', async () => {
  const seeded = await seedAttachment(await startRealServerWrapped(), {
    bytes: makeWav(WAV_SIZE, 'WIREC5MARKER-5'), marker: 'WIREC5MARKER-5',
  });
  const { page, proxy } = await openCase(seeded, { tamperAt: TAMPER_AT });
  await call(page, 'play', seeded.messageId, 'audio');
  const errored = await poll(async () => {
    const s = await snap(page);
    return s.errored > 0 || s.lazyErrors > 0 || s.mediaError != null ? s : null;
  }, 40000);
  const s = await snap(page);
  log(`test5 tampered 1 byte at ciphertext offset ${TAMPER_AT} (chunk ${TAMPER_CHUNK}); tamperedResponses=${proxy.tamperedCount}; element errored=${!!errored}; mediaError=${s.mediaError}; lazyErrors=${s.lazyErrors}; currentTime=${s.currentTime}`);
  assert.ok(errored, 'playback must error on the tampered chunk');
  assert.ok(proxy.tamperedCount >= 1, 'the proxy must have tampered at least one response');
  assert.ok(s.currentTime < (TAMPER_CHUNK + 1) * (CHUNK / BYTES_PER_SEC) + 0.5, 'no audio past the tampered chunk');

  const url = s.streamUrl;
  assert.ok(url, 'the stream URL must have been observed before the error');
  const tampered = await call(page, 'fetchRange', url, `bytes=${TAMPER_CHUNK * CHUNK}-${TAMPER_CHUNK * CHUNK + 63}`);
  assert.ok(!tampered.ok, 'Range of the tampered chunk must fail, got ' + tampered.status);
  assert.notEqual(tampered.b64, Buffer.from(seeded.bytes.subarray(TAMPER_CHUNK * CHUNK, TAMPER_CHUNK * CHUNK + 64)).toString('base64'), 'no plaintext');
  const later = await call(page, 'probeMedia', url);
  log(`test5 same stream URL probed through a media element after the tamper: ${JSON.stringify(later)}`);
  assert.equal(later.why, 'error', 'the same stream URL must stay dead after the tamper, got ' + JSON.stringify(later));
  assert.equal(later.readyState, 0, 'the dead stream must not reach any data');

  await page.close();
  assertRepoFlagOff();
});

test('6. logout: streams purged, old URL dead, other client cannot read, key needed again', async () => {
  const seeded = await seedAttachment(await startRealServerWrapped(), {
    bytes: makeWav(WAV_SIZE, 'WIREC5MARKER-6'), marker: 'WIREC5MARKER-6',
  });
  const { page, proxy } = await openCase(seeded);
  await call(page, 'play', seeded.messageId, 'audio');
  const url = await poll(async () => (await snap(page)).streamUrl);
  assert.ok(url, 'stream must be registered before logout');

  // Cross-client: a second page on the same worker is a different client and must not read it.
  const other = await browser.newPage();
  await other.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  await poll(async () => other.evaluate(() => !!navigator.serviceWorker.controller));
  await other.evaluate(PAGE_LIB);
  const foreign = await call(other, 'probeMedia', url);
  log(`test6 other client media probe of stream URL: ${JSON.stringify(foreign)}`);
  assert.equal(foreign.why, 'error', 'a different client must not play another client\'s stream, got ' + JSON.stringify(foreign));
  await other.close();

  await page.evaluate(async () => {
    const auth = await import('/js/core/auth.js');
    auth.logout();
  });
  await sleep(1000);

  const control = await call(page, 'probeMedia', url.replace(/__wire_media_stream\/[^/?#]+$/, '__wire_media_stream/' + crypto.randomUUID()));
  log(`test6 control: a never-registered stream id probed through a media element: ${JSON.stringify(control)}`);
  assert.equal(control.why, 'error', 'the probe control must fail for an unknown stream');
  const own = await call(page, 'probeMedia', url);
  log(`test6 old stream URL media probe after logout: ${JSON.stringify(own)}`);
  assert.equal(own.why, 'error', 'old stream URL must fail after logout, got ' + JSON.stringify(own));
  assert.equal(own.readyState, 0, 'old stream URL must not deliver any data after logout');
  assert.equal(await call(page, 'hasSecret', seeded.messageId), false, 'no key may remain after logout');

  // Registering again is only possible after the secret is registered again.
  const withoutKey = await call(page, 'play', seeded.messageId, 'audio');
  assert.ok(!withoutKey.includes('/__wire_media_stream/'), 'no stream without a registered secret, got ' + withoutKey);
  await page.evaluate(async (id, meta) => window.__c5.register(id, meta), seeded.messageId, seeded.metaPlain);
  assert.equal(await call(page, 'hasSecret', seeded.messageId), true, 'the secret is available only after re-registering');

  await page.close();
  assertRepoFlagOff();
});

test('7. SW restart (CDP stopAllWorkers): observed page behaviour, no plaintext from the old URL', async () => {
  const seeded = await seedAttachment(await startRealServerWrapped(), {
    bytes: makeWav(WAV_SIZE, 'WIREC5MARKER-7'), marker: 'WIREC5MARKER-7',
  });
  const { page } = await openCase(seeded);
  await call(page, 'play', seeded.messageId, 'audio');
  const before = await poll(async () => {
    const s = await snap(page);
    return s.streamUrl && s.readyState >= 2 ? s : null;
  });
  assert.ok(before && before.streamUrl, 'stream must be registered before the restart');

  const cdp = await page.target().createCDPSession();
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await sleep(2000);
  await page.evaluate(async () => { try { await fetch('/sw-manifest.js', { cache: 'no-store' }); } catch {} });
  await sleep(2500);

  const old = await call(page, 'probeMedia', before.streamUrl);
  const after = await snap(page);
  const outcome = {
    oldUrlProbe: old.why,
    oldUrlReadyState: old.readyState,
    oldUrlHasPlaintext: old.why === 'loadeddata',
    audioMediaError: after.mediaError,
    lazyErrors: after.lazyErrors,
    blobFallbacks: after.blobSets,
    srcAfter: after.src.startsWith('blob:') ? 'blob' : (after.src.includes('/__wire_media_stream/') ? 'stream' : (after.src || 'empty')),
    streamDeadMessages: after.deadMsgs,
  };
  log('test7 observed after SW restart: ' + JSON.stringify(outcome));

  assert.notEqual(old.why, 'loadeddata', 'the old stream URL must not serve bytes after the restart, got ' + JSON.stringify(old));
  assert.ok(after.blobSets <= 1, 'the lazy source must fall back to Blob at most once, got ' + after.blobSets);

  await cdp.detach();
  await page.close();
  assertRepoFlagOff();
});

test('8. storage hygiene: no key, IV or plaintext marker in any storage, after playback and after logout', async () => {
  const seeded = await seedAttachment(await startRealServerWrapped(), {
    bytes: makeWav(WAV_SIZE, 'WIREC5MARKER-8'), marker: 'WIREC5MARKER-8',
  });
  const { page, proxy } = await openCase(seeded);
  await call(page, 'play', seeded.messageId, 'audio');
  await poll(async () => {
    const s = await snap(page);
    return s.currentTime > 2 ? s : null;
  }, 30000);

  // Positive control: a known marker written into a scratch cache MUST be found
  // by the same scanner, otherwise a clean result proves nothing.
  const controlMarker = 'WIREC5CONTROL-' + crypto.randomBytes(4).toString('hex');
  const controlCache = await page.evaluate((m) => window.__c5.scanControlPut(m), controlMarker);
  const control = await page.evaluate((k, iv, m) => window.__c5.scan(k, iv, m), seeded.keyB64, seeded.ivB64, controlMarker);
  log(`test8 positive control: scanner found the planted control marker in ${control.hits.length} place(s): ${JSON.stringify(control.hits)}`);
  assert.ok(control.hits.some((h) => h.includes('cache:') && h.includes('marker')), 'the scanner must find a marker placed in a cache body');
  await page.evaluate((n) => window.__c5.scanControlDelete(n), controlCache);

  const scan1 = await page.evaluate((k, iv, m) => window.__c5.scan(k, iv, m), seeded.keyB64, seeded.ivB64, seeded.marker);
  const attachmentRanges = proxy.requests.filter((r) => r.pathname.startsWith('/api/dm/attachments/')).map((r) => r.range);
  log(`test8 proxy attachment Range headers during playback: ${JSON.stringify(attachmentRanges)}`);
  log(`test8 cache entries read: ${JSON.stringify(scan1.counts.cacheUrls)}`);
  log(`test8 scan after playback: ${JSON.stringify({ ...scan1.counts, cacheUrls: undefined })} dbs=[${scan1.dbNames.join(',')}] hits=${JSON.stringify(scan1.hits)}`);
  assert.deepEqual(scan1.hits, [], 'no key, IV or marker may be stored while playing');
  assert.ok(scan1.counts.caches >= 1 && scan1.counts.cacheEntries >= 1, 'the scan must have read the caches');

  await page.evaluate(async () => { const auth = await import('/js/core/auth.js'); auth.logout(); });
  await sleep(1000);

  const scan2 = await page.evaluate((k, iv, m) => window.__c5.scan(k, iv, m), seeded.keyB64, seeded.ivB64, seeded.marker);
  log(`test8 scan after logout: ${JSON.stringify(scan2.counts)} dbs=[${scan2.dbNames.join(',')}] hits=${JSON.stringify(scan2.hits)}`);
  assert.deepEqual(scan2.hits, [], 'no key, IV or marker may be stored after logout');

  await page.close();
  assertRepoFlagOff();
});

test('9. control: real repo sw.js (flag false) uses Blob, no stream request', async () => {
  const seeded = await seedAttachment(await startRealServerWrapped(), {
    bytes: makeWav(WAV_SIZE, 'WIREC5MARKER-9'), marker: 'WIREC5MARKER-9',
  });
  const origin = seeded.rs.origin;
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  const info = await installWorker(page, origin);
  assert.equal(info.controlled, true);
  await page.evaluate(PAGE_LIB);
  await page.evaluate(async (id, meta) => window.__c5.register(id, meta), seeded.messageId, seeded.metaPlain);
  const src = await call(page, 'play', seeded.messageId, 'audio');
  assert.ok(src.startsWith('blob:'), 'must use Blob path, got: ' + src);
  assert.ok(!src.includes('/__wire_media_stream/'), 'must not use stream path');
  await page.close();
  assertRepoFlagOff();
});

test('10. probe timeout: negative probe cached; one Blob fallback; new probe after controllerchange', async () => {
  const seeded = await seedAttachment(await startRealServerWrapped(), {
    bytes: makeWav(WAV_SIZE, 'WIREC5MARKER-10'), marker: 'WIREC5MARKER-10',
  });
  // A fresh copy: this test overwrites its sw.js with an unresponsive worker.
  const copy = createFlagOnPublicCopy({ fresh: true });
  track(copy.dir);
  const goodSw = fs.readFileSync(path.join(copy.publicDir, 'sw.js'), 'utf8');
  const swPath = path.join(copy.publicDir, 'sw.js');
  fs.writeFileSync(swPath, [
    "self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });",
    "self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });",
    '// no fetch handler and no message handler: MEDIA_STREAM_STATUS never answers',
  ].join('\n'));
  const proxy = await startProxy(copy.publicDir, seeded.rs.origin);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('token', t); }, seeded.alice.token);
  await page.goto(proxy.origin + '/c5-harness.html', { waitUntil: 'domcontentloaded' });
  const info = await installWorker(page, proxy.origin);
  assert.equal(info.controlled, true, 'the unresponsive worker must control the page');
  await page.evaluate(PAGE_LIB);
  await page.evaluate(async (id, meta) => window.__c5.register(id, meta), seeded.messageId, seeded.metaPlain);

  // Same client, twice: the first probe times out, the second is answered from the cache.
  const probes = await page.evaluate(async () => {
    const m = await import('/js/media/sw-stream-client.js');
    const client = m.createSwStreamClient({ serviceWorker: navigator.serviceWorker, statusTimeoutMs: 1000 });
    window.__c5.probeClient = client;
    const t0 = performance.now();
    const first = await client.probe();
    const t1 = performance.now();
    const second = await client.probe();
    const t2 = performance.now();
    return { first, second, firstMs: t1 - t0, secondMs: t2 - t1 };
  });
  log(`test10 probe #1=${probes.first} (${probes.firstMs.toFixed(0)} ms); probe #2 same client=${probes.second} (${probes.secondMs.toFixed(1)} ms)`);
  assert.equal(probes.first, false, 'unresponsive worker: probe must be false');
  assert.equal(probes.second, false, 'second probe must be false');
  assert.ok(probes.secondMs < 100, `second probe must be answered from the cache, took ${probes.secondMs} ms`);

  // Playback: the element must end on a non-empty Blob src with exactly one fallback.
  const src = await call(page, 'play', seeded.messageId, 'audio');
  const s = await poll(async () => {
    const v = await snap(page);
    return v.src ? v : null;
  }, 30000);
  log(`test10 element src after play starts with blob: ${s && s.src.startsWith('blob:')}; srcSets=${s && s.srcSets}; blobSets=${s && s.blobSets}`);
  assert.ok(src.length > 0 && s && s.src.length > 0, 'element src must be non-empty');
  assert.ok(s.src.startsWith('blob:'), 'fallback must be a Blob, got: ' + s.src);
  assert.equal(s.blobSets, 1, 'exactly one fallback must happen, observed ' + s.blobSets);

  // controllerchange: restore the real worker and register it. Then the cached negative must be dropped.
  fs.writeFileSync(swPath, goodSw);
  const change = await page.evaluate(async () => {
    const changed = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('no-controllerchange-in-20s'), 20000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve('controllerchange'); }, { once: true });
    });
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    await reg.update();
    return changed;
  });
  log(`test10 after restoring the real worker: ${change}`);
  assert.equal(change, 'controllerchange', 'a working worker must take control');
  const reprobe = await page.evaluate(async () => window.__c5.probeClient.probe());
  log(`test10 probe on the SAME client after controllerchange: ${reprobe}`);
  assert.equal(reprobe, true, 'the cached negative must be dropped on controllerchange and the new probe must be true');

  await page.close();
  assertRepoFlagOff();
});

test('11. non-candidates: voice note, image and audio <= 8 MiB never stream', async () => {
  const rs = await startRealServerWrapped();
  const users = await makeUsers(rs);
  const cases = [
    { label: 'voice note', kind: 'audio', seeded: await seedAttachment(rs, { users, bytes: makeWav(1024 * 1024, 'WIREC5MARKER-11a'), name: 'voice.wav', isVoice: true, marker: 'WIREC5MARKER-11a' }) },
    { label: 'small audio', kind: 'audio', seeded: await seedAttachment(rs, { users, bytes: makeWav(1024 * 1024, 'WIREC5MARKER-11b'), name: 'small.wav', marker: 'WIREC5MARKER-11b' }) },
    { label: 'image', kind: 'image', seeded: await seedAttachment(rs, { users, bytes: crypto.randomBytes(200 * 1024), name: 'pic.png', mime: 'image/png', width: 64, height: 64, marker: 'WIREC5MARKER-11c' }) },
  ];
  // All three share one page; each uses its own message id and secret.
  const first = cases[0].seeded;
  const { page, proxy } = await openCase(first);
  const results = [];
  for (const c of cases) {
    await page.evaluate(async (id, meta) => window.__c5.register(id, meta), c.seeded.messageId, c.seeded.metaPlain);
    const perfBefore = await page.evaluate(() => performance.getEntriesByType('resource').length);
    let src;
    if (c.kind === 'image') {
      src = await call(page, 'resolveBlob', c.seeded.messageId);
    } else {
      src = await call(page, 'play', c.seeded.messageId, c.kind);
    }
    await poll(async () => {
      const v = await page.evaluate(() => {
        const el = window.__c5.state.el;
        return el ? el.getAttribute('src') || '' : '';
      });
      return v || (c.kind === 'image' ? src : '');
    }, 30000);
    const streamSeen = await page.evaluate(() => performance.getEntriesByType('resource').slice(0).some((e) => e.name.includes('/__wire_media_stream/')));
    const perfAfter = await page.evaluate(() => performance.getEntriesByType('resource').length);
    const streamRequests = proxy.requests.filter((r) => r.pathname.startsWith('/__wire_media_stream/')).length;
    results.push({ label: c.label, src: src || '', streamSeen, streamRequests, perfDelta: perfAfter - perfBefore });
    log(`test11 ${c.label}: src=${(src || '').slice(0, 40)} streamResourceEntry=${streamSeen} proxyStreamRequests=${streamRequests}`);
    assert.ok(src && src.startsWith('blob:'), `${c.label} must end on a non-empty blob src, got "${src}"`);
    assert.ok(!streamSeen, `${c.label} must make no /__wire_media_stream/ request`);
    assert.equal(streamRequests, 0, `${c.label} must make no stream request to the proxy`);
  }
  await page.close();
  assertRepoFlagOff();
});
