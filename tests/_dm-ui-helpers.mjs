// tests/_dm-ui-helpers.mjs  (helper, not a test)
//
// Shared helpers for the DM browser regression tests that drive the REAL UI:
// real clicks on the app's own controls, the real composer, real navigation
// between tabs. Built on tests/_acceptance-harness.mjs (server, browser,
// login); nothing here replaces it.
//
// Waiting is always a bounded poll on the exact postcondition about to be
// asserted, never a sleep standing in for one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded poll. `probe` returns a truthy value when the condition holds; that
 * value is returned. On timeout the error says what was waited for and, via
 * `describe`, what the page looked like instead.
 */
export async function pollUntil(probe, { timeout = 15000, step = 100, what = 'a condition', describe = null } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
      last = value;
      lastError = null;
    } catch (e) {
      // A page mid-navigation can fail an evaluate; that is "not yet".
      lastError = e;
    }
    await sleep(step);
  }
  let detail;
  if (describe) {
    detail = await Promise.resolve()
      .then(() => describe(last))
      .catch((e) => `describe failed: ${e.message}`);
  } else {
    detail = lastError ? `last probe threw: ${lastError.message}` : `last probe returned ${JSON.stringify(last)}`;
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${what}; ${detail}`);
}

/**
 * Collects what the page reports going wrong: uncaught errors, console errors
 * and Content-Security-Policy violations. Pass `cspProbe` as newUserPage's
 * onNewDocument so violations are recorded from the first byte of every load.
 */
export function cspProbe() {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI || ''} ${e.sourceFile || ''}:${e.lineNumber || ''}`);
  });
}

export function watchPage(page) {
  const sink = [];
  page.on('pageerror', (e) => sink.push(`pageerror: ${e && e.message ? e.message : e}`));
  page.on('console', (m) => { if (m.type() === 'error') sink.push(`console.error: ${m.text()}`); });
  return sink;
}

export async function cspViolations(page) {
  return page.evaluate(() => window.__cspViolations || []);
}

/** A real click on `selector`, retried while the element is being re-rendered under it. */
export async function clickReal(page, selector, { timeout = 15000 } = {}) {
  await pollUntil(async () => {
    try {
      const handle = await page.waitForSelector(selector, { timeout: 2000, visible: true });
      await handle.click();
      return true;
    } catch {
      return false;
    }
  }, { timeout, step: 150, what: `a real click on ${selector}` });
}

/** Rows the thread has rendered, by server id, top to bottom. */
export async function renderedRowIds(page) {
  return page.$$eval('#dm-messages > .chat-msg', (rows) => rows.map((r) => Number(r.dataset.msgId)));
}

/** The server's ids for this conversation, oldest first (the truth a hard refresh shows). */
export async function serverRowIds(api, peerId) {
  const r = await api(`/api/dm/messages/${peerId}/recent?limit=50`);
  if (r.status !== 200 || !Array.isArray(r.body)) {
    throw new Error(`recent rows for ${peerId}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  return r.body.map((m) => Number(m.id));
}

/** Messages tab (real click) -> the peer's conversation row (real click) -> composer mounted. */
export async function openThreadByRow(page, peerId) {
  await clickReal(page, '.nav-link[data-view="messages"]');
  await clickReal(page, `.dm-conv[data-peer="${peerId}"]`);
  await page.waitForSelector('#dm-input', { timeout: 20000 });
  await pollUntil(
    () => page.evaluate(() => !document.querySelector('#dm-messages .loading-state')),
    { what: 'the thread to finish loading' }
  );
}

/** Another tab (Files) and back to the conversation, all through real clicks. */
export async function leaveAndReturn(page, peerId) {
  await clickReal(page, '.nav-link[data-view="files"]');
  await pollUntil(() => page.evaluate(() => !document.getElementById('dm-messages')), {
    what: 'the DM thread to be torn down by the tab switch',
  });
  await openThreadByRow(page, peerId);
}

/**
 * Types `text` into the composer and presses the real Send button ONCE.
 * Resolves with the new server row id once the server has it and the thread
 * has drawn it.
 */
export async function sendTextViaComposer(page, api, peerId, text) {
  const before = await serverRowIds(api, peerId);
  await page.click('#dm-input');
  await page.type('#dm-input', text);
  await page.click('[data-action="dm-send"]');
  await pollUntil(() => page.$eval('#dm-input', (e) => e.value === ''), { what: `the composer to send ${JSON.stringify(text)}` });
  const ids = await pollUntil(async () => {
    const now = await serverRowIds(api, peerId);
    return now.length > before.length ? now : null;
  }, { what: 'the server to store the message' });
  const id = ids[ids.length - 1];
  await pollUntil(() => page.$(`#dm-messages > .chat-msg[data-msg-id="${id}"]`), { what: `row ${id} to render` });
  return id;
}

// ---------------------------------------------------------------- audio fixtures

/** 16-bit PCM WAV: a sine tone. */
export function wavBytes({ seconds = 1.5, rate = 8000, freq = 440 } = {}) {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2);
  return b;
}

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono; zeroed side info decodes as silence. 50 frames = 1.306 s. */
export function mp3Bytes({ frames = 50 } = {}) {
  const FRAME = 417;
  const b = Buffer.alloc(FRAME * frames);
  for (let f = 0; f < frames; f++) {
    const o = f * FRAME;
    b[o] = 0xff; b[o + 1] = 0xfb; b[o + 2] = 0x90; b[o + 3] = 0xc0;
  }
  return b;
}

/** Records `ms` of an oscillator with the page's own MediaRecorder; returns the file bytes. */
export async function recordInPage(page, mimeType, ms = 1600) {
  const b64 = await page.evaluate(async (type, duration) => {
    const ctx = new AudioContext();
    await ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const rec = new MediaRecorder(dest.stream, { mimeType: type });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    await new Promise((r) => setTimeout(r, duration));
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop();
    await ctx.close();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, mimeType, ms);
  return Buffer.from(b64, 'base64');
}

export function writeTempFile(dir, name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Stages `filePath` through the real file input and presses the real Send button. Returns the new row id. */
export async function sendFileViaComposer(page, api, peerId, filePath) {
  const before = await serverRowIds(api, peerId);
  const input = await page.$('#dm-file-input');
  await input.uploadFile(filePath);
  await page.waitForSelector('#dm-attach-staging .attach-chip', { timeout: 15000 });
  await page.click('[data-action="dm-send"]');
  const ids = await pollUntil(async () => {
    const now = await serverRowIds(api, peerId);
    return now.length > before.length ? now : null;
  }, { timeout: 30000, what: `the server to store ${path.basename(filePath)}` });
  const id = ids[ids.length - 1];
  await pollUntil(() => page.$(`#dm-messages > .chat-msg[data-msg-id="${id}"]`), { what: `row ${id} to render` });
  return id;
}

// ---------------------------------------------------------------- voice recording

/**
 * Replaces getUserMedia with an oscillator stream, so the composer's REAL
 * recorder (voice-recorder.js -> MediaRecorder) records something known.
 * `envelope` is a list of [secondsFromStart, gain] points (linear ramps).
 */
export async function stubMicrophone(page, envelope) {
  await page.evaluate((points) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      try { await ctx.resume(); } catch { /* resumed by the click's activation */ }
      const osc = ctx.createOscillator();
      osc.frequency.value = 330;
      const gain = ctx.createGain();
      const t0 = ctx.currentTime;
      gain.gain.setValueAtTime(points[0][1], t0);
      for (const [t, g] of points.slice(1)) gain.gain.linearRampToValueAtTime(g, t0 + t);
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      return dest.stream;
    };
  }, envelope);
}

/** Mic button -> wait `ms` -> stop button, through real clicks. Resolves with the new row id. */
export async function recordVoiceViaComposer(page, api, peerId, ms) {
  const before = await serverRowIds(api, peerId);
  await page.click('#dm-mic-btn');
  await page.waitForSelector('#dm-recording-bar.active', { timeout: 10000 });
  await sleep(ms);
  await page.click('#dm-recording-stop');
  const ids = await pollUntil(async () => {
    const now = await serverRowIds(api, peerId);
    return now.length > before.length ? now : null;
  }, { timeout: 30000, what: 'the server to store the voice message' });
  const id = ids[ids.length - 1];
  await pollUntil(() => page.$(`#dm-messages > .chat-msg[data-msg-id="${id}"] .voice-message`), {
    what: `voice row ${id} to render`,
  });
  return id;
}

// ---------------------------------------------------------------- downloads

/**
 * Lets the browser save downloads into `dir` (a temp dir - never the user's
 * Downloads folder) and reports each finished one.
 */
export async function captureDownloads(browser, dir) {
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  const started = new Map();
  const finished = [];
  cdp.on('Browser.downloadWillBegin', (e) => started.set(e.guid, e.suggestedFilename));
  cdp.on('Browser.downloadProgress', (e) => {
    if (e.state === 'completed') finished.push({ guid: e.guid, name: started.get(e.guid) });
  });
  return {
    finished,
    async next(count, { timeout = 30000 } = {}) {
      return pollUntil(() => (finished.length >= count ? finished[count - 1] : null), {
        timeout, what: `download #${count} to complete`,
      });
    },
  };
}

/** Rewrites the stored ciphertext of an attachment so it fails authentication. */
export function corruptStoredAttachment(dirs, attachmentPath, offset = 8 + 100) {
  const file = path.join(dirs.dm, attachmentPath);
  const data = fs.readFileSync(file);
  data[offset] ^= 0xff;
  fs.writeFileSync(file, data);
  return file;
}

// ---------------------------------------------------------------- engine guards

/**
 * The engine selected for this run, mirroring launchBrowser() in
 * tests/_acceptance-harness.mjs. Defaults to 'chromium'.
 */
export function currentEngine() {
  return process.env.WIRE_TEST_BROWSER || 'chromium';
}

/**
 * Assert that the current engine matches `engine`. Throws if not - use this
 * inside a test body when the test fundamentally requires a specific engine
 * and cannot proceed without it.
 */
export function requireEngine(t, engine) {
  if (currentEngine() !== engine) {
    throw new Error(`this test requires the ${engine} engine (current: ${currentEngine()})`);
  }
}

/**
 * Skip this test unless the current engine is 'chromium', printing an
 * explicit `# SKIP <reason>` line into the TAP output. The skip triggers
 * only when WIRE_TEST_BROWSER is not 'chromium'.
 */
export function skipUnlessChromium(t, reason) {
  if (currentEngine() !== 'chromium') {
    t.skip(`needs Chromium: ${reason}`);
  }
}
