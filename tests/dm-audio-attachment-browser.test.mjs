// tests/dm-audio-attachment-browser.test.mjs
//
// Regression (Bugs 1 and 2): audio attachments in DMs.
//
// Bug 1 - audio could not be played. DM attachments are end-to-end encrypted,
// so audio-player.js renders them LAZY: no src until the first play() starts
// the download + decrypt (lazy-e2ee-media.js). But the player was also put in
// its `loading` state at render, and `.audio-player.loading` blocks pointer
// events; with no source, no media event ever cleared it. The play button
// could never be clicked, so nothing ever loaded. (The existing jsdom test
// called el.click() directly, which ignores pointer-events, so it could not
// see this.) Here: real input clicks, four real formats, the full
// play / pause / resume / seek cycle, and a decryption failure.
//
// Bug 2 - no (working) download button. The audio player's download control
// sat inside that same pointer-blocked player, and its markup carried a stray
// ">" from the CSP refactor; voice messages had no download control at all.
// Here: every audio attachment and a voice message expose a visible control
// that takes a real click and saves the ORIGINAL bytes under the original
// name and extension, through the existing authenticated download path - and
// the server still refuses anyone outside the conversation.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  startRealServer,
  registerUser,
  newUserPage,
  closeUserBrowsers,
  loginUi,
  sessionFromPage,
  socketConnected,
  restLogin,
  openDmUi,
  jsonClient,
} from './_acceptance-harness.mjs';
import { Database } from './credentials/_fixture.mjs';
import {
  pollUntil,
  sleep,
  cspProbe,
  watchPage,
  cspViolations,
  openThreadByRow,
  sendFileViaComposer,
  sendTextViaComposer,
  wavBytes,
  mp3Bytes,
  recordInPage,
  writeTempFile,
  tempDir,
  stubMicrophone,
  recordVoiceViaComposer,
  captureDownloads,
  corruptStoredAttachment,
  skipUnlessChromium,
} from './_dm-ui-helpers.mjs';

let server = null;
const cleanup = [];

after(async () => {
  await closeUserBrowsers();
  if (server) await server.stop().catch(() => {});
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function attachmentPathOf(dbPath, id) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT attachment_path FROM direct_messages WHERE id = ?').get(id)?.attachment_path ?? null;
  } finally {
    db.close();
  }
}

const player = (id) => `#dm-messages > .chat-msg[data-msg-id="${id}"] .audio-player`;

async function audioState(page, id) {
  return page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    const a = p.querySelector('audio');
    const play = p.querySelector('.audio-player-play');
    const r = play.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const fill = p.querySelector('.audio-player-progress-fill').getBoundingClientRect();
    const wave = p.querySelector('.audio-player-waveform').getBoundingClientRect();
    return {
      loading: p.classList.contains('loading'),
      busy: p.getAttribute('aria-busy'),
      state: p.dataset.state || null,
      playHittable: !!hit && play.contains(hit),
      src: a.getAttribute('src') || '',
      paused: a.paused,
      currentTime: a.currentTime,
      duration: a.duration,
      durationText: p.querySelector('.audio-player-duration').textContent.trim(),
      currentText: p.querySelector('.audio-player-current-time').textContent.trim(),
      errorShown: getComputedStyle(p.querySelector('.audio-player-error')).display !== 'none',
      pauseIconShown: getComputedStyle(p.querySelector('.icon-pause')).display !== 'none',
      fillRatio: wave.width > 0 ? fill.width / wave.width : 0,
    };
  }, player(id));
}

async function clickIn(page, selector) {
  // A real input click at the element's centre (scrolled into view first).
  const handle = await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await handle.click();
}

test('audio attachments play in the app across formats: ready state, play, pause, resume, seek, and a decryption failure', async () => {
  server = await startRealServer({ csp: 'true' });
  await registerUser(server.origin, 'au-alice');
  await registerUser(server.origin, 'au-bob');

  const A = await newUserPage({ onNewDocument: cspProbe });
  const B = await newUserPage({ onNewDocument: cspProbe });
  const errors = watchPage(B.page);
  await loginUi(A.page, server.origin, 'au-alice');
  await loginUi(B.page, server.origin, 'au-bob');
  const alice = await sessionFromPage(A.page, server.origin, 'au-alice');
  const bob = await sessionFromPage(B.page, server.origin, 'au-bob');
  assert.ok(await socketConnected(A.page));

  const dir = tempDir('wire-audio-');
  cleanup.push(dir);
  const fixtures = [
    { name: 'tone.wav', bytes: wavBytes({ seconds: 1.5 }), seconds: 1.5 },
    { name: 'silence.mp3', bytes: mp3Bytes({ frames: 50 }), seconds: 1.306 },
    { name: 'clip.weba', bytes: await recordInPage(A.page, 'audio/webm;codecs=opus', 1600), seconds: 1.6 },
    { name: 'clip.m4a', bytes: await recordInPage(A.page, 'audio/mp4;codecs=mp4a.40.2', 1600), seconds: 1.6 },
  ];

  await openDmUi(A.page, bob.id, 'au-bob');
  for (const f of fixtures) {
    f.id = await sendFileViaComposer(A.page, alice.api, bob.id, writeTempFile(dir, f.name, f.bytes));
  }
  const broken = { name: 'broken.wav', bytes: wavBytes({ seconds: 1 }) };
  broken.id = await sendFileViaComposer(A.page, alice.api, bob.id, writeTempFile(dir, broken.name, broken.bytes));
  corruptStoredAttachment(server.dirs, attachmentPathOf(server.dbPath, broken.id));

  // The RECIPIENT opens the conversation: nothing is decrypted or cached yet.
  await openThreadByRow(B.page, alice.id);

  for (const f of fixtures) {
    await pollUntil(() => B.page.$(player(f.id)), { what: `${f.name}: the audio player to render` });
    const before = await audioState(B.page, f.id);

    // Ready, not "loading": the play button is reachable by a real pointer.
    assert.equal(before.loading, false, `${f.name}: an unplayed encrypted player must not sit in "loading"`);
    assert.equal(before.busy, 'false', `${f.name}: aria-busy`);
    assert.equal(before.playHittable, true, `${f.name}: the play button must receive real clicks`);
    assert.equal(before.src, '', `${f.name}: nothing is downloaded before play`);
    assert.equal(before.durationText, '--:--', `${f.name}: an unknown duration must not read as 0:00`);

    // Play (real click): download + decrypt, then real playback from a blob.
    await clickIn(B.page, `${player(f.id)} .audio-player-play`);
    const playing = await pollUntil(async () => {
      const s = await audioState(B.page, f.id);
      return s && !s.paused && s.currentTime > 0.1 ? s : null;
    }, { timeout: 20000, what: `${f.name}: playback to start and advance`, describe: async () => JSON.stringify(await audioState(B.page, f.id)) });
    assert.match(playing.src, /^blob:/, `${f.name}: plays from the decrypted blob`);
    assert.ok(Math.abs(playing.duration - f.seconds) < 0.35, `${f.name}: duration ${playing.duration}s, expected ~${f.seconds}s`);
    assert.equal(playing.durationText, formatTime(playing.duration), `${f.name}: duration label`);
    assert.equal(playing.pauseIconShown, true, `${f.name}: the button shows "pause" while playing`);
    assert.equal(playing.loading, false);

    // Pause (real click): position holds still.
    await clickIn(B.page, `${player(f.id)} .audio-player-play`);
    const paused = await pollUntil(async () => {
      const s = await audioState(B.page, f.id);
      return s && s.paused ? s : null;
    }, { what: `${f.name}: pause` });
    await sleep(400);
    const stillPaused = await audioState(B.page, f.id);
    assert.ok(Math.abs(stillPaused.currentTime - paused.currentTime) < 0.01, `${f.name}: a paused player must not advance`);
    assert.equal(stillPaused.pauseIconShown, false, `${f.name}: the button shows "play" while paused`);

    // Seek (real click on the bar at 75%), still paused.
    const bar = await B.page.$(`${player(f.id)} .audio-player-waveform`);
    const box = await bar.boundingBox();
    await B.page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
    const seeked = await pollUntil(async () => {
      const s = await audioState(B.page, f.id);
      return s && Math.abs(s.currentTime - 0.75 * s.duration) < 0.2 && s.currentText === formatTime(s.currentTime) ? s : null;
    }, { what: `${f.name}: seek to 75%`, describe: async () => JSON.stringify(await audioState(B.page, f.id)) });
    assert.ok(Math.abs(seeked.fillRatio - 0.75) < 0.06, `${f.name}: progress bar at ${seeked.fillRatio}, expected ~0.75`);
    assert.equal(seeked.currentText, formatTime(seeked.currentTime), `${f.name}: current-time label follows the seek`);

    // Resume (real click): continues from the seek position, not from 0.
    await clickIn(B.page, `${player(f.id)} .audio-player-play`);
    const resumed = await pollUntil(async () => {
      const s = await audioState(B.page, f.id);
      return s && (!s.paused || s.currentTime >= s.duration - 0.05) && s.currentTime >= seeked.currentTime ? s : null;
    }, { what: `${f.name}: resume from the seek position`, describe: async () => JSON.stringify(await audioState(B.page, f.id)) });
    assert.ok(resumed.currentTime >= seeked.currentTime - 0.01, `${f.name}: resumed from ${resumed.currentTime}, sought ${seeked.currentTime}`);
    await B.page.evaluate((sel) => document.querySelector(sel)?.querySelector('audio')?.pause(), player(f.id));
  }

  // A file that fails authentication: a real error state, never a stuck one.
  await clickIn(B.page, `${player(broken.id)} .audio-player-play`);
  const failed = await pollUntil(async () => {
    const s = await audioState(B.page, broken.id);
    return s && s.errorShown ? s : null;
  }, { timeout: 20000, what: 'the decryption failure to be shown', describe: async () => JSON.stringify(await audioState(B.page, broken.id)) });
  assert.equal(failed.state, 'error');
  assert.equal(failed.loading, false, 'a failed player must not stay "loading"');
  assert.equal(failed.src, '', 'no blob was created for a file that failed authentication');
  assert.equal(failed.paused, true);
  assert.equal(failed.pauseIconShown, false, 'the button returns to "play"');
  assert.match(await B.page.$eval(`${player(broken.id)} .audio-player-error`, (e) => e.textContent), /Failed to load audio/);

  // The other players are unaffected by that failure.
  const other = await audioState(B.page, fixtures[0].id);
  assert.equal(other.state, null, 'an unrelated player must not be in an error state');

  assert.deepEqual(await cspViolations(B.page), [], 'no CSP violation');
  assert.deepEqual(errors.filter((e) => /pageerror/.test(e)), [], errors.join(' | '));
});

test('every audio attachment and a voice message have a working download: original bytes, name and extension, existing auth', async (t) => {
  skipUnlessChromium(t, 'captureDownloads uses CDP Browser.setDownloadBehavior (chromium-only)');
  if (!server) server = await startRealServer({ csp: 'true' });
  await registerUser(server.origin, 'dl-alice');
  await registerUser(server.origin, 'dl-bob');
  await registerUser(server.origin, 'dl-mallory'); // never in the conversation, never UI-logged-in

  const A = await newUserPage({ onNewDocument: cspProbe });
  const B = await newUserPage({ onNewDocument: cspProbe });
  await loginUi(A.page, server.origin, 'dl-alice');
  await loginUi(B.page, server.origin, 'dl-bob');
  const alice = await sessionFromPage(A.page, server.origin, 'dl-alice');
  const bob = await sessionFromPage(B.page, server.origin, 'dl-bob');
  const mallory = await restLogin(server.origin, 'dl-mallory');
  assert.ok(await socketConnected(A.page));

  const dir = tempDir('wire-audio-dl-');
  const downloads = tempDir('wire-downloads-');
  cleanup.push(dir, downloads);

  const fixtures = [
    { name: 'tone.wav', bytes: wavBytes({ seconds: 1.2 }) },
    { name: 'silence.mp3', bytes: mp3Bytes({ frames: 40 }) },
    { name: 'clip.weba', bytes: await recordInPage(A.page, 'audio/webm;codecs=opus', 1000) },
    { name: 'clip.m4a', bytes: await recordInPage(A.page, 'audio/mp4;codecs=mp4a.40.2', 1000) },
  ];

  await openDmUi(A.page, bob.id, 'dl-bob');
  await sendTextViaComposer(A.page, alice.api, bob.id, 'files for you');
  for (const f of fixtures) {
    f.id = await sendFileViaComposer(A.page, alice.api, bob.id, writeTempFile(dir, f.name, f.bytes));
  }

  // A voice message through the real recorder (microphone replaced by a tone).
  await stubMicrophone(A.page, [[0, 0.6], [1, 0.6]]);
  const voiceId = await recordVoiceViaComposer(A.page, alice.api, bob.id, 1200);
  // Its original (decrypted) bytes and name, from the sender's own client.
  const voiceOriginal = await A.page.evaluate(async (id) => {
    const { fetchDecryptedAttachment, getAttachmentSecret } = await import('/js/media/attachment-e2ee.js');
    const blob = await fetchDecryptedAttachment('dm', id);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { b64: btoa(s), name: getAttachmentSecret('dm', id).name };
  }, voiceId);
  assert.match(voiceOriginal.name, /\.(webm|m4a|ogg)$/, `voice file name keeps an audio extension: ${voiceOriginal.name}`);

  // Bob downloads from his own fresh view of the conversation.
  const dl = await captureDownloads(B.browser, downloads);
  const attachmentRequests = [];
  B.page.on('request', (req) => {
    if (/\/api\/dm\/attachments\/\d+/.test(req.url())) {
      attachmentRequests.push({ url: req.url(), auth: req.headers().authorization || null });
    }
  });
  await openThreadByRow(B.page, alice.id);

  const controls = [
    ...fixtures.map((f) => ({ ...f, selector: `${player(f.id)} .audio-player-download` })),
    {
      id: voiceId,
      name: voiceOriginal.name,
      bytes: Buffer.from(voiceOriginal.b64, 'base64'),
      selector: `#dm-messages > .chat-msg[data-msg-id="${voiceId}"] .voice-message-download`,
    },
  ];

  let count = 0;
  for (const c of controls) {
    await pollUntil(() => B.page.$(c.selector), { what: `${c.name}: a download control to render` });

    // Visible, unobstructed, an icon button with an accessible name and no stray text.
    const look = await B.page.$eval(c.selector, (btn) => {
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        width: r.width,
        height: r.height,
        visible: getComputedStyle(btn).visibility !== 'hidden' && getComputedStyle(btn).display !== 'none',
        hittable: !!top && btn.contains(top),
        text: btn.textContent.trim(),
        label: btn.getAttribute('aria-label') || btn.getAttribute('title') || '',
        hasIcon: !!btn.querySelector('svg'),
      };
    });
    assert.ok(look.visible && look.width > 0 && look.height > 0, `${c.name}: the download control must be visible ${JSON.stringify(look)}`);
    assert.equal(look.hittable, true, `${c.name}: the download control must receive real clicks`);
    assert.equal(look.text, '', `${c.name}: the control is the icon only (no stray markup text): ${JSON.stringify(look.text)}`);
    assert.ok(look.hasIcon && look.label, `${c.name}: icon + accessible label`);

    // Real click -> the existing download path -> a file on disk.
    await B.page.click(c.selector);
    count += 1;
    const done = await dl.next(count);
    assert.equal(done.name, c.name, `${c.name}: saved under its original name and extension`);
    const saved = path.join(downloads, done.name);
    await pollUntil(() => fs.existsSync(saved) && fs.statSync(saved).size === c.bytes.length, {
      what: `${c.name}: the saved file to be complete`,
    });
    assert.ok(fs.readFileSync(saved).equals(c.bytes), `${c.name}: the download must be the ORIGINAL (decrypted) file`);
  }

  // The downloads went through the existing authenticated path: the session in
  // the Authorization header, never a token in the URL.
  const downloadCalls = attachmentRequests.filter((r) => /download=1/.test(r.url));
  assert.ok(downloadCalls.length >= controls.length, `every download fetched its attachment (${downloadCalls.length})`);
  for (const r of downloadCalls) {
    assert.match(r.auth || '', /^Bearer \S+/, `download request must carry the session: ${r.url}`);
    assert.doesNotMatch(r.url, /[?&]token=/, `download URL must not carry a token: ${r.url}`);
  }

  // Authorization is unchanged: only the two participants get the file.
  const target = fixtures[0].id;
  const asBob = await bob.api(`/api/dm/attachments/${target}?download=1`);
  assert.equal(asBob.status, 200, 'a participant may download');
  const asMallory = await mallory.api(`/api/dm/attachments/${target}?download=1`);
  assert.equal(asMallory.status, 403, 'someone outside the conversation must be refused');
  const anonymous = await jsonClient(server.origin)(`/api/dm/attachments/${target}?download=1`);
  assert.equal(anonymous.status, 401, 'no credentials, no file');
  // A media token is scoped to ONE attachment.
  const minted = await bob.api(`/api/dm/attachments/${fixtures[1].id}/media-token`);
  assert.equal(minted.status, 200);
  const crossUse = await jsonClient(server.origin)(`/api/dm/attachments/${target}?token=${encodeURIComponent(minted.body.token)}`);
  assert.ok(crossUse.status === 401 || crossUse.status === 403, `a token for another attachment must not open this one (got ${crossUse.status})`);
  // And the server only ever hands out ciphertext for an encrypted row.
  const raw = await fetch(`${server.origin}/api/dm/attachments/${target}?download=1`, { headers: { Authorization: `Bearer ${bob.token}` } });
  assert.equal(raw.headers.get('content-type'), 'application/octet-stream');
  assert.ok(!Buffer.from(await raw.arrayBuffer()).equals(fixtures[0].bytes), 'the server must not hold the plaintext');

  assert.deepEqual(await cspViolations(B.page), [], 'no CSP violation');
});
