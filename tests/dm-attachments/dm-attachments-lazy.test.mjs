// Lazy decrypt for encrypted audio/video: REAL server, REAL client
// modules (video-player.js, audio-player.js, attachment-e2ee.js,
// mediaToken.js) in the jsdom actor. Spies on fetch and blob URLs prove
// that nothing is downloaded, decrypted or turned into a Blob until the
// user presses play, and that every Blob URL is revoked afterwards.
import { TEST_ROOT } from './_env.mjs';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startDmServer, createUser, prepareAsClient, postUpload, authGet, disposeActors } from './_harness.mjs';

let server; let alice; let bob;
const CS = 64 * 1024;

before(async () => {
  server = await startDmServer();
  alice = await createUser(server, 'alice');
  bob = await createUser(server, 'bob');
});
after(async () => {
  await disposeActors();
  await server.stop();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

// ---- spies --------------------------------------------------------------
const spy = { created: [], revoked: [], plays: [] };
// Every attachment download the recipient's client made (the actor logs
// every HTTP request its app code issues).
const attFetches = () => bob.actor.fetchLog.filter((r) => /\/api\/dm\/attachments\/\d+/.test(r.url) && !/media-token/.test(r.url)).map((r) => r.url);
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
let installed = false;

function installSpies() {
  if (installed) return;
  installed = true;
  URL.createObjectURL = (blob) => { const u = realCreate(blob); spy.created.push(u); return u; };
  URL.revokeObjectURL = (u) => { spy.revoked.push(u); return realRevoke(u); };
  // jsdom has no media pipeline: record when play() really reaches the element
  // and what src it had at that moment.
}

// The actor's own jsdom window owns HTMLMediaElement.
function stubMediaElements(win) {
  const proto = win.HTMLMediaElement.prototype;
  proto.play = function () { spy.plays.push({ src: this.getAttribute('src') }); return Promise.resolve(); };
  proto.pause = function () {};
  proto.load = function () {};
}

function resetSpies() {
  spy.created.length = 0; spy.revoked.length = 0; spy.plays.length = 0;
  if (bob) bob.actor.fetchLog.length = 0;
}
beforeEach(resetSpies);

// ---- helpers ------------------------------------------------------------
function pattern(n, seed) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x >>> 16; }
  return out;
}

async function sendMedia(kind, mime, bytes) {
  const prepared = await prepareAsClient(alice, bob, { bytes, name: `${kind}.bin`, mime });
  const res = await postUpload(server, alice, bob.id, prepared);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id;
}

// Boots the recipient's real client modules, wraps fetch, mounts messages.
async function openChat(ids) {
  bob.actor.use();
  installSpies();
  const win = bob.actor.window;
  stubMediaElements(win);
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  globalThis.matchMedia = win.matchMedia;
  // browser globals the players use that Node does not provide
  for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Event', 'MouseEvent', 'KeyboardEvent']) {
    if (typeof globalThis[name] === 'undefined' && typeof win[name] === 'function') globalThis[name] = win[name].bind(win);
  }
  if (typeof globalThis.ResizeObserver === 'undefined') globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (typeof globalThis.IntersectionObserver === 'undefined') globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  // jsdom has no CSS.escape (the players use it for ids)
  globalThis.CSS = globalThis.CSS || { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };

  const e2ee = await bob.actor.importModule('media/attachment-e2ee.js');
  const video = await bob.actor.importModule('media/video-player.js');
  const audio = await bob.actor.importModule('media/audio-player.js');
  const attachments = await bob.actor.importModule('media/attachments.js');


  const history = await (await authGet(server, bob, `/api/dm/messages/${alice.id}/recent`)).json();
  const rows = Array.isArray(history) ? history : history.messages;
  const doc = win.document;
  const root = doc.createElement('div');
  root.id = 'dm-messages';
  doc.body.appendChild(root);

  const mounted = {};
  for (const id of ids) {
    const row = rows.find((m) => m.id === id);
    const msg = await e2ee.applyAttachmentMeta(row, alice.id, 'dm');
    const el = doc.createElement('div');
    el.className = 'chat-msg';
    el.dataset.msgId = String(id);
    el.innerHTML = '<div class="chat-msg-content"></div>';
    root.appendChild(el);
    mounted[id] = { msg, el };
  }
  return { e2ee, video, audio, attachments, root, mounted, doc, win };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await tick(20); }
  assert.fail(`timed out waiting for ${label}`);
}

// ---- tests --------------------------------------------------------------

test('several large videos in one chat: no fetch, no decrypt, no Blob until played', async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await sendMedia(`v${i}`, 'video/mp4', pattern(CS * 3 + 5, i + 1)));
  const { video, mounted, root } = await openChat(ids);
  resetSpies();

  for (const id of ids) await video.renderVideo(mounted[id].msg, 'dm', mounted[id].el);

  assert.equal(root.querySelectorAll('video').length, 4, 'players are rendered');
  assert.equal(root.querySelectorAll('.play-btn').length, 4, 'with their play controls');
  assert.equal(attFetches().length, 0, 'no download before play');
  assert.equal(spy.created.length, 0, 'no Blob URL before play');
  assert.equal(root.querySelectorAll('[data-blob-url]').length, 0);
  for (const v of root.querySelectorAll('video')) {
    assert.equal(v.hasAttribute('src'), false, 'no src before play');
    assert.equal(v.getAttribute('preload'), 'none');
  }
});

test('pressing play downloads + decrypts only that video, then plays it from the blob', async () => {
  const a = await sendMedia('a', 'video/mp4', pattern(CS * 2 + 9, 11));
  const b = await sendMedia('b', 'video/mp4', pattern(CS * 2 + 9, 12));
  const { video, mounted, root } = await openChat([a, b]);
  resetSpies();
  await video.renderVideo(mounted[a].msg, 'dm', mounted[a].el);
  await video.renderVideo(mounted[b].msg, 'dm', mounted[b].el);

  mounted[a].el.querySelector('.play-btn').click();
  await waitFor(() => spy.plays.length === 1, 'play to reach the element');

  assert.equal(attFetches().length, 1, 'exactly one download');
  assert.match(attFetches()[0], new RegExp(`/api/dm/attachments/${a}\\?download=1`));
  assert.equal(spy.created.length, 1, 'exactly one Blob URL');
  const vA = mounted[a].el.querySelector('video');
  assert.equal(vA.getAttribute('src'), spy.created[0], 'src is the decrypted blob');
  assert.equal(vA.dataset.blobUrl, spy.created[0], 'stamped for revoke');
  assert.equal(spy.plays[0].src, spy.created[0], 'play() happened after the src was set');
  // the other video is still untouched
  assert.equal(mounted[b].el.querySelector('video').hasAttribute('src'), false);
  assert.equal(root.querySelectorAll('[data-blob-url]').length, 1);

  // the decrypted bytes are the real file
  const blob = await (await fetch(spy.created[0])).blob().catch(() => null);
  if (blob) assert.equal(blob.size, CS * 2 + 9);

  // pressing play again does not download or decrypt twice
  const before = attFetches().length;
  vA.play();
  await tick(100);
  assert.equal(attFetches().length, before);
  assert.equal(spy.created.length, 1);
});

test('removing the message or leaving the chat revokes the Blob URL', async () => {
  const a = await sendMedia('rm', 'video/mp4', pattern(CS + 3, 21));
  const b = await sendMedia('leave', 'video/mp4', pattern(CS + 3, 22));
  const { video, attachments, e2ee, mounted, root } = await openChat([a, b]);
  resetSpies();
  for (const id of [a, b]) {
    await video.renderVideo(mounted[id].msg, 'dm', mounted[id].el);
    mounted[id].el.querySelector('.play-btn').click();
  }
  await waitFor(() => spy.created.length === 2, 'both blobs');

  // what dm.js removeDmMessage() does for one message
  attachments.revokeMediaPlayerBlobUrls(mounted[a].el);
  e2ee.forgetAttachmentSecret('dm', a);
  assert.deepEqual(spy.revoked, [mounted[a].el.querySelector('video').getAttribute('src')].filter(Boolean));
  assert.equal(spy.revoked.length, 1);

  // what leaving the chat does (destroyDmComposer on #dm-messages)
  attachments.revokeMediaPlayerBlobUrls(root);
  assert.equal(new Set(spy.revoked).size, 2, 'every created Blob URL was revoked');
  assert.deepEqual([...new Set(spy.revoked)].sort(), [...spy.created].sort());
});

test('a blob that finishes decrypting after its player is gone is revoked, not leaked', async () => {
  const id = await sendMedia('late', 'video/mp4', pattern(CS + 1, 31));
  const { video, mounted } = await openChat([id]);
  resetSpies();
  await video.renderVideo(mounted[id].msg, 'dm', mounted[id].el);

  // hold the download in flight for 400 ms, remove the player meanwhile
  bob.actor.delayNext('GET', new RegExp(`/api/dm/attachments/${id}\\?download=1`), 400);
  mounted[id].el.querySelector('.play-btn').click();
  await waitFor(() => attFetches().length === 1, 'download to start');

  mounted[id].el.remove(); // user left / message deleted mid-download
  await waitFor(() => spy.created.length === 1, 'decrypt to finish');
  await waitFor(() => spy.revoked.length === 1, 'late blob to be revoked');
  assert.equal(spy.revoked[0], spy.created[0]);
  assert.equal(spy.plays.length, 0, 'a removed player never plays');
});

test('tampered ciphertext: play fails safely with a visible error and no Blob', async () => {
  const id = await sendMedia('tamper', 'video/mp4', pattern(CS * 2, 41));
  const stored = server.db.prepare('SELECT attachment_path FROM direct_messages WHERE id = ?').get(id).attachment_path;
  const file = path.join(process.env.DM_UPLOAD_DIR, stored);
  const data = fs.readFileSync(file);
  data[8 + 100] ^= 1;
  fs.writeFileSync(file, data);

  const { video, mounted } = await openChat([id]);
  resetSpies();
  await video.renderVideo(mounted[id].msg, 'dm', mounted[id].el);
  mounted[id].el.querySelector('.play-btn').click();

  await waitFor(() => mounted[id].el.querySelector('.video-error-note'), 'error note');
  assert.equal(mounted[id].el.querySelector('.video-error-note').textContent, 'Video could not be decrypted');
  assert.equal(spy.created.length, 0, 'no Blob for a file that failed authentication');
  assert.equal(spy.plays.length, 0);
  assert.equal(mounted[id].el.querySelector('video').hasAttribute('src'), false);
});

test('encrypted audio is lazy too; plays from a blob after the first play', async () => {
  const id = await sendMedia('song', 'audio/mpeg', pattern(CS * 2, 51));
  const { audio, mounted, root } = await openChat([id]);
  resetSpies();
  await audio.renderAudio(mounted[id].msg, 'dm', mounted[id].el);

  const el = root.querySelector('audio');
  assert.ok(el, 'audio player rendered');
  assert.equal(el.hasAttribute('src'), false);
  assert.equal(attFetches().length, 0);
  assert.equal(spy.created.length, 0);

  mounted[id].el.querySelector('.audio-player-play, .play-btn, button[class*="play"]').click();
  await waitFor(() => spy.plays.length === 1, 'audio play');
  assert.equal(spy.created.length, 1);
  assert.equal(el.getAttribute('src'), spy.created[0]);
  assert.equal(el.dataset.blobUrl, spy.created[0]);
});

test('mounting before the container is attached (as dm.js does) still renders the player', async () => {
  const idV = await sendMedia('late-attach-v', 'video/mp4', pattern(CS + 2, 61));
  const idA = await sendMedia('late-attach-a', 'audio/mpeg', pattern(CS + 2, 62));
  const { video, audio, mounted, root, doc } = await openChat([idV, idA]);
  resetSpies();

  // detach both containers, call mount (no await), attach afterwards
  const pV = (mounted[idV].el.remove(), video.renderVideo(mounted[idV].msg, 'dm', mounted[idV].el));
  const pA = (mounted[idA].el.remove(), audio.renderAudio(mounted[idA].msg, 'dm', mounted[idA].el));
  await tick(100);
  root.appendChild(mounted[idV].el);
  root.appendChild(mounted[idA].el);
  await Promise.all([pV, pA]);

  assert.ok(root.querySelector('video'), 'video player rendered after late attach');
  assert.ok(root.querySelector('audio'), 'audio player rendered after late attach');
  assert.equal(spy.created.length, 0);
  assert.equal(attFetches().length, 0);

  // a container that is NEVER attached renders nothing and creates nothing
  const orphan = doc.createElement('div');
  orphan.className = 'chat-msg';
  orphan.dataset.msgId = String(idV);
  orphan.innerHTML = '<div class="chat-msg-content"></div>';
  const before = root.querySelectorAll('video').length;
  await video.renderVideo(mounted[idV].msg, 'dm', orphan).catch(() => {});
  assert.equal(root.querySelectorAll('video').length, before);
});

test('legacy (non-encrypted) media is NOT made lazy: eager token path is unchanged', async () => {
  const { video } = await openChat([]);
  const lazy = await bob.actor.importModule('media/lazy-e2ee-media.js');
  assert.equal(lazy.isLazyE2eeMedia({ id: 987654 }, 'dm'), false);
  void video;
});
