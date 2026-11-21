// tests/dm-voice-message-browser.test.mjs
//
// Regression (Bug 5): the voice-message player's duration and visualizer
// depended on playback instead of on the audio.
//
//   - The "waveform" was 32 pseudo-random bars seeded by the message id: it
//     said nothing about the recording.
//   - The duration only existed once the <audio> element had loaded metadata,
//     and the player stayed in its pointer-blocking "loading" state until
//     then. Browsers that defer media loading until play() (iOS Safari ignores
//     preload; Android data saver / background tabs treat "metadata" as
//     "none") therefore showed 0:00 and an inert player until a first play.
//   - With the default accent, played and unplayed bars were the same grey, so
//     the visualizer did not visibly reflect the playback position.
//
// Voice notes are recorded through the REAL composer and recorder (the
// microphone is replaced by an oscillator with a known loudness envelope:
// silence then tone, and tone then silence), so the waveform can be checked
// against what is actually in the file.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startRealServer,
  registerUser,
  newUserPage,
  closeUserBrowsers,
  loginUi,
  sessionFromPage,
  socketConnected,
  openDmUi,
} from './_acceptance-harness.mjs';
import { Database } from './credentials/_fixture.mjs';
import {
  pollUntil,
  sleep,
  cspViolations,
  openThreadByRow,
  leaveAndReturn,
  sendTextViaComposer,
  stubMicrophone,
  recordVoiceViaComposer,
  corruptStoredAttachment,
} from './_dm-ui-helpers.mjs';

let server = null;

after(async () => {
  await closeUserBrowsers();
  if (server) await server.stop().catch(() => {});
});

// Runs before any app code on every load: CSP violations, and counters for
// audio decodes and media play() calls.
function voiceProbes() {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI || ''}`);
  });
  window.__decodes = 0;
  const base = (window.BaseAudioContext || window.AudioContext).prototype;
  const decode = base.decodeAudioData;
  base.decodeAudioData = function (...args) {
    window.__decodes += 1;
    return decode.apply(this, args);
  };
  window.__plays = 0;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    window.__plays += 1;
    return play.apply(this, args);
  };
}

// The same probes, plus a model of a browser that fetches NOTHING for an
// <audio> element until play() is called (iOS Safari, Android data saver).
function voiceProbesDeferredMedia() {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI || ''}`);
  });
  window.__decodes = 0;
  const base = (window.BaseAudioContext || window.AudioContext).prototype;
  const decode = base.decodeAudioData;
  base.decodeAudioData = function (...args) {
    window.__decodes += 1;
    return decode.apply(this, args);
  };
  window.__plays = 0;
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    enumerable: src.enumerable,
    get() {
      return this.__deferredSrc !== undefined ? this.__deferredSrc : src.get.call(this);
    },
    set(value) {
      if (this instanceof HTMLAudioElement && !this.__released) {
        this.__deferredSrc = value;
        return;
      }
      src.set.call(this, value);
    },
  });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    window.__plays += 1;
    if (this.__deferredSrc !== undefined && !this.__released) {
      this.__released = true;
      src.set.call(this, this.__deferredSrc);
      this.__deferredSrc = undefined;
    }
    return play.apply(this, args);
  };
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const voice = (id) => `#dm-messages > .chat-msg[data-msg-id="${id}"] .voice-message`;

/**
 * What the user sees of one voice player, including the canvas itself: per
 * pixel column, how much is painted and how much is drawn in the "played"
 * style (the accent colour at full opacity).
 */
async function voiceState(page, id) {
  return page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    const a = p.querySelector('audio');
    const play = p.querySelector('.voice-message-play');
    const wave = p.querySelector('.voice-message-wave');
    const canvas = p.querySelector('canvas');
    const r = play.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);

    const parse = (c) => (/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c) || []).slice(1).map(Number);
    const accent = parse(getComputedStyle(play).backgroundColor);
    const cols = [];
    try {
      const { width, height } = canvas;
      const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      // Per pixel column: how many pixels are painted, and the most opaque
      // pixel (its alpha and colour). A column is "played" when that pixel is
      // the accent colour. Colour, not opacity, decides: bars are ~2px wide
      // and short for quiet audio, so many columns are anti-aliased edges -
      // getImageData returns un-premultiplied colour, which survives that.
      for (let x = 0; x < width; x++) {
        let painted = 0;
        let maxAlpha = 0;
        let maxAt = -1;
        for (let y = 0; y < height; y++) {
          const i = (y * width + x) * 4;
          if (data[i + 3] > 24) painted++;
          if (data[i + 3] > maxAlpha) {
            maxAlpha = data[i + 3];
            maxAt = i;
          }
        }
        const rgb = maxAt >= 0 ? [data[maxAt], data[maxAt + 1], data[maxAt + 2]] : [0, 0, 0];
        const played = maxAlpha >= 20 && accent.length === 3 &&
          Math.abs(rgb[0] - accent[0]) + Math.abs(rgb[1] - accent[1]) + Math.abs(rgb[2] - accent[2]) < 12;
        cols.push([painted, played ? 1 : 0, maxAlpha, ...rgb]);
      }
    } catch {
      /* canvas not drawable yet */
    }

    return {
      state: p.dataset.state || null,
      waveform: p.dataset.waveform || null,
      loading: p.classList.contains('loading'),
      time: p.querySelector('.voice-message-time').textContent.trim(),
      aria: Number(wave.getAttribute('aria-valuenow')),
      playHittable: !!hit && play.contains(hit),
      playDisabled: play.disabled,
      paused: a.paused,
      currentTime: a.currentTime,
      duration: a.duration,
      readyState: a.readyState,
      hasSrcAttr: a.hasAttribute('src'),
      errorShown: getComputedStyle(p.querySelector('.voice-message-error')).display !== 'none',
      errorText: p.querySelector('.voice-message-error-text').textContent.trim(),
      downloadVisible: (() => {
        const d = p.querySelector('.voice-message-download');
        if (!d) return false;
        const b = d.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && getComputedStyle(d).display !== 'none';
      })(),
      cols,
    };
  }, voice(id));
}

/** Mean painted height of the columns in [from, to) of the canvas width. */
function meanHeight(cols, from, to) {
  const a = Math.floor(cols.length * from);
  const b = Math.floor(cols.length * to);
  const painted = cols.slice(a, b).map(([p]) => p).filter((p) => p > 0);
  return painted.length ? painted.reduce((s, v) => s + v, 0) / painted.length : 0;
}

/** Share of painted columns drawn in the "played" style: the visual progress. */
function playedRatio(cols) {
  const painted = cols.filter(([p]) => p > 0);
  if (!painted.length) return 0;
  return painted.filter(([, played]) => played > 0).length / painted.length;
}

/**
 * How different played and unplayed bars look: the summed |dR|+|dG|+|dB| of
 * their colours as composited (premultiplied by opacity - the pill behind
 * them is near-black), each side taken at its most opaque bar centres.
 * Returns null unless both sides are on screen.
 */
function visibleContrast(cols) {
  const premul = ([, , a, r, g, b]) => [r * a / 255, g * a / 255, b * a / 255];
  const mean = (list) => [0, 1, 2].map((k) => list.reduce((s, c) => s + premul(c)[k], 0) / list.length);
  const played = cols.filter((c) => c[1] && c[0] > 0);
  const unplayed = cols.filter((c) => !c[1] && c[0] > 0);
  if (!played.length || !unplayed.length) return null;
  const topPlayed = Math.max(...played.map((c) => c[2]));
  const topUnplayed = Math.max(...unplayed.map((c) => c[2]));
  const p = mean(played.filter((c) => c[2] >= 0.9 * topPlayed));
  const u = mean(unplayed.filter((c) => c[2] >= 0.9 * topUnplayed));
  return Math.abs(p[0] - u[0]) + Math.abs(p[1] - u[1]) + Math.abs(p[2] - u[2]);
}

async function clickIn(page, selector) {
  const handle = await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await handle.click();
}

async function clickWaveAt(page, id, ratio) {
  const wave = await page.$(`${voice(id)} .voice-message-wave`);
  const box = await wave.boundingBox();
  await page.mouse.click(box.x + box.width * ratio, box.y + box.height / 2);
}

function attachmentPathOf(dbPath, id) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT attachment_path FROM direct_messages WHERE id = ?').get(id)?.attachment_path ?? null;
  } finally {
    db.close();
  }
}

test('voice messages: duration and real waveform before playback, accurate progress, pause/resume, seek, independent players, tab switches, cached analysis, failure fallback', async () => {
  server = await startRealServer({ csp: 'true' });
  await registerUser(server.origin, 'vm-alice');
  await registerUser(server.origin, 'vm-bob');

  const A = await newUserPage({ onNewDocument: voiceProbes });
  await loginUi(A.page, server.origin, 'vm-alice');
  const alice = await sessionFromPage(A.page, server.origin, 'vm-alice');

  const Bpre = await newUserPage();
  await loginUi(Bpre.page, server.origin, 'vm-bob');
  const bob = await sessionFromPage(Bpre.page, server.origin, 'vm-bob');
  await Bpre.page.close();
  assert.ok(await socketConnected(A.page));

  // ---- Alice records three voice notes through the real composer.
  await openDmUi(A.page, bob.id, 'vm-bob');
  await sendTextViaComposer(A.page, alice.api, bob.id, 'voice notes incoming');

  // A: ~1 s of silence, then a loud tone.
  await stubMicrophone(A.page, [[0, 0], [1.0, 0], [1.05, 0.9], [9, 0.9]]);
  const noteA = await recordVoiceViaComposer(A.page, alice.api, bob.id, 2400);
  // B: a loud tone, then silence.
  await stubMicrophone(A.page, [[0, 0.9], [1.0, 0.9], [1.05, 0], [9, 0]]);
  const noteB = await recordVoiceViaComposer(A.page, alice.api, bob.id, 2000);
  // C: will be corrupted on the server to exercise the failure fallback.
  await stubMicrophone(A.page, [[0, 0.5], [9, 0.5]]);
  const noteC = await recordVoiceViaComposer(A.page, alice.api, bob.id, 1000);
  corruptStoredAttachment(server.dirs, attachmentPathOf(server.dbPath, noteC));

  // ---- Bob, on a fresh page: history load, nothing played yet.
  const B = await newUserPage({ onNewDocument: voiceProbes });
  await loginUi(B.page, server.origin, 'vm-bob');
  await openThreadByRow(B.page, alice.id);

  // The postcondition, before any playback: a real duration on the label and a
  // waveform shaped like the recording - quiet where the audio is silent, tall
  // where the tone is (note A rises, note B falls).
  const shapeOf = (cols) => ({ start: meanHeight(cols, 0, 0.3), end: meanHeight(cols, 0.7, 1) });
  const ready = {};
  for (const [id, recorded, rising] of [[noteA, 2.4, true], [noteB, 2.0, false]]) {
    const s = await pollUntil(async () => {
      const v = await voiceState(B.page, id);
      if (!v || !/^\d+:\d{2}$/.test(v.time) || v.time === '0:00' || !v.cols.length) return null;
      const { start, end } = shapeOf(v.cols);
      return (rising ? end > 2 * start : start > 2 * end) ? v : null;
    }, {
      timeout: 20000,
      what: `voice ${id}: a real duration and a waveform that follows the recording, before playback`,
      describe: async () => {
        const v = await voiceState(B.page, id);
        return JSON.stringify({ ...v, cols: undefined, shape: v && v.cols.length ? shapeOf(v.cols) : null });
      },
    });
    assert.equal(s.waveform, 'ready', `voice ${id}: the player reports its analysed waveform`);

    // 1. Duration shown before playback, and it is the recording's length.
    const seconds = Number(s.time.split(':')[0]) * 60 + Number(s.time.split(':')[1]);
    assert.ok(Math.abs(seconds - Math.floor(recorded)) <= 1, `voice ${id}: shows ${s.time} for a ~${recorded}s recording`);
    assert.notEqual(s.time, '0:00', 'a real duration, not a placeholder');
    // ...ready to play, nothing played to get there.
    assert.equal(s.loading, false, `voice ${id}: not stuck loading`);
    assert.equal(s.playHittable, true, `voice ${id}: the play button takes real clicks`);
    assert.equal(s.paused, true);
    assert.equal(s.currentTime, 0);
    assert.equal(s.aria, 0);
    ready[id] = s;
  }
  assert.equal(await B.page.evaluate(() => window.__plays), 0, 'no playback was needed to initialise anything');

  // 2. The waveform describes the audio: silence draws low bars, the tone tall ones.
  const a = ready[noteA].cols;
  const b = ready[noteB].cols;
  assert.ok(meanHeight(a, 0.7, 1) > 2 * meanHeight(a, 0, 0.3),
    `note A (silence, then tone): end bars must be much taller than start bars (${meanHeight(a, 0, 0.3).toFixed(1)} vs ${meanHeight(a, 0.7, 1).toFixed(1)})`);
  assert.ok(meanHeight(b, 0, 0.3) > 2 * meanHeight(b, 0.7, 1),
    `note B (tone, then silence): start bars must be much taller than end bars (${meanHeight(b, 0, 0.3).toFixed(1)} vs ${meanHeight(b, 0.7, 1).toFixed(1)})`);
  assert.equal(playedRatio(a), 0, 'nothing is drawn as played before playback');

  // Failure fallback for the corrupted note: a clear error, nothing stuck, download kept.
  const c = await pollUntil(async () => {
    const v = await voiceState(B.page, noteC);
    return v && v.state === 'error' ? v : null;
  }, { timeout: 20000, what: 'the corrupted voice note to show its failure', describe: async () => JSON.stringify({ ...(await voiceState(B.page, noteC)), cols: undefined }) });
  assert.equal(c.errorShown, true, 'the error message is shown');
  assert.match(c.errorText, /Failed to load voice message/);
  assert.equal(c.playDisabled, true, 'nothing to play');
  assert.equal(c.loading, false, 'a failed note must not stay "loading"');
  assert.equal(c.downloadVisible, true, 'the download control stays available');

  // 3 + 4. Play note A (real click): progress and visualizer advance together.
  await clickIn(B.page, `${voice(noteA)} .voice-message-play`);
  const p1 = await pollUntil(async () => {
    const v = await voiceState(B.page, noteA);
    return v && !v.paused && v.currentTime > 0.3 ? v : null;
  }, { what: 'note A to play' });
  const p2 = await pollUntil(async () => {
    const v = await voiceState(B.page, noteA);
    return v && v.currentTime > p1.currentTime + 0.4 ? v : null;
  }, { what: 'note A to keep playing' });
  assert.ok(p2.aria > p1.aria, `progress must advance (${p1.aria} -> ${p2.aria})`);
  assert.ok(playedRatio(p2.cols) > playedRatio(p1.cols), 'the visualizer must advance with playback');
  for (const v of [p1, p2]) {
    const expected = v.currentTime / v.duration;
    assert.ok(Math.abs(v.aria / 100 - expected) < 0.15, `aria-valuenow ${v.aria} vs position ${expected.toFixed(2)}`);
  }

  // 5. Pause (real click): position holds, labels and visualizer agree with it.
  await clickIn(B.page, `${voice(noteA)} .voice-message-play`);
  const paused = await pollUntil(async () => {
    const v = await voiceState(B.page, noteA);
    return v && v.paused ? v : null;
  }, { what: 'note A to pause' });
  await sleep(500);
  const held = await voiceState(B.page, noteA);
  assert.ok(Math.abs(held.currentTime - paused.currentTime) < 0.01, 'a paused note must not advance');
  assert.equal(held.state, 'paused');
  assert.equal(held.time, formatTime(held.currentTime), 'paused: the label shows the position');
  assert.ok(Math.abs(playedRatio(held.cols) - held.currentTime / held.duration) < 0.12,
    `paused: the visualizer shows the position (${playedRatio(held.cols).toFixed(2)} vs ${(held.currentTime / held.duration).toFixed(2)})`);
  // ...and the played part can actually be told apart from the rest. With the
  // default accent both used to be the same grey (a difference of ~37).
  const contrast = visibleContrast(held.cols);
  assert.ok(contrast !== null && contrast >= 60,
    `played and unplayed bars must look different (contrast ${contrast === null ? 'n/a' : contrast.toFixed(0)}, need >= 60)`);

  // ...and resume (real click) continues from there, not from 0.
  await clickIn(B.page, `${voice(noteA)} .voice-message-play`);
  const resumed = await pollUntil(async () => {
    const v = await voiceState(B.page, noteA);
    return v && !v.paused && v.currentTime > held.currentTime + 0.05 ? v : null;
  }, { what: 'note A to resume' });
  assert.ok(resumed.currentTime > held.currentTime, 'resumed from the paused position');
  await clickIn(B.page, `${voice(noteA)} .voice-message-play`);
  await pollUntil(async () => (await voiceState(B.page, noteA))?.paused, { what: 'note A to pause again' });

  // 6. Seek (real click at 75% of the waveform).
  await clickWaveAt(B.page, noteA, 0.75);
  const seekA = await pollUntil(async () => {
    const v = await voiceState(B.page, noteA);
    return v && Math.abs(v.currentTime - 0.75 * v.duration) < 0.2 ? v : null;
  }, { what: 'note A to seek to 75%', describe: async () => JSON.stringify({ ...(await voiceState(B.page, noteA)), cols: undefined }) });
  assert.ok(Math.abs(seekA.aria - 75) <= 8, `aria-valuenow after seek: ${seekA.aria}`);
  assert.ok(Math.abs(playedRatio(seekA.cols) - 0.75) < 0.1, `visualizer after seek: ${playedRatio(seekA.cols).toFixed(2)}`);
  assert.equal(seekA.time, formatTime(seekA.currentTime));

  // 7. Independent players: note B was never touched...
  let vb = await voiceState(B.page, noteB);
  assert.equal(vb.currentTime, 0, 'note B position is its own');
  assert.equal(vb.aria, 0);
  assert.equal(playedRatio(vb.cols), 0, "note B's visualizer is its own");
  assert.equal(vb.time, ready[noteB].time, 'note B still shows its duration');
  // ...seeking it leaves note A where it was.
  await clickWaveAt(B.page, noteB, 0.5);
  vb = await pollUntil(async () => {
    const v = await voiceState(B.page, noteB);
    return v && Math.abs(v.currentTime - 0.5 * v.duration) < 0.2 ? v : null;
  }, { what: 'note B to seek to 50%' });
  const stillA = await voiceState(B.page, noteA);
  assert.ok(Math.abs(stillA.currentTime - seekA.currentTime) < 0.05, 'note A keeps its own position');

  // 8. Another tab and back: positions and the waveform come back as they were,
  //    and the waveform is NOT decoded again.
  const decodesBefore = await B.page.evaluate(() => window.__decodes);
  assert.ok(decodesBefore >= 2, `each note was analysed (decodes: ${decodesBefore})`);
  await leaveAndReturn(B.page, alice.id);
  const backA = await pollUntil(async () => {
    const v = await voiceState(B.page, noteA);
    return v && v.cols.length && v.waveform === 'ready' && Math.abs(v.currentTime - seekA.currentTime) < 0.15 ? v : null;
  }, { what: 'note A restored after the tab switch', describe: async () => JSON.stringify({ ...(await voiceState(B.page, noteA)), cols: undefined }) });
  assert.equal(backA.paused, true, 'a paused note stays paused');
  assert.equal(backA.time, formatTime(backA.currentTime));
  assert.ok(Math.abs(playedRatio(backA.cols) - 0.75) < 0.1, 'the visualizer shows the restored position');
  assert.ok(meanHeight(backA.cols, 0.7, 1) > 2 * meanHeight(backA.cols, 0, 0.3), 'the same real waveform');
  const backB = await pollUntil(async () => {
    const v = await voiceState(B.page, noteB);
    return v && Math.abs(v.currentTime - vb.currentTime) < 0.15 ? v : null;
  }, { what: 'note B restored after the tab switch' });
  assert.equal(backB.waveform, 'ready');
  assert.equal(await B.page.evaluate(() => window.__decodes), decodesBefore, 'the cached analysis is reused, not decoded again');

  // ...and playback resumes from the restored position.
  await clickIn(B.page, `${voice(noteA)} .voice-message-play`);
  const afterSwitch = await pollUntil(async () => {
    const v = await voiceState(B.page, noteA);
    return v && !v.paused && v.currentTime > backA.currentTime ? v : null;
  }, { what: 'note A to resume after the tab switch' });
  assert.ok(afterSwitch.currentTime >= backA.currentTime);

  assert.deepEqual(await cspViolations(B.page), [], 'no CSP violation');
});

test('voice messages in a browser that loads media only on play(): duration and waveform still show first, and play works', async () => {
  if (!server) server = await startRealServer({ csp: 'true' });
  await registerUser(server.origin, 'vd-alice');
  await registerUser(server.origin, 'vd-bob');

  const A = await newUserPage();
  await loginUi(A.page, server.origin, 'vd-alice');
  const alice = await sessionFromPage(A.page, server.origin, 'vd-alice');
  const Bpre = await newUserPage();
  await loginUi(Bpre.page, server.origin, 'vd-bob');
  const bob = await sessionFromPage(Bpre.page, server.origin, 'vd-bob');
  await Bpre.page.close();
  assert.ok(await socketConnected(A.page));

  await openDmUi(A.page, bob.id, 'vd-bob');
  await sendTextViaComposer(A.page, alice.api, bob.id, 'one voice note');
  await stubMicrophone(A.page, [[0, 0], [0.9, 0], [0.95, 0.9], [9, 0.9]]);
  const note = await recordVoiceViaComposer(A.page, alice.api, bob.id, 2000);

  const B = await newUserPage({ onNewDocument: voiceProbesDeferredMedia });
  await loginUi(B.page, server.origin, 'vd-bob');
  await openThreadByRow(B.page, alice.id);

  const s = await pollUntil(async () => {
    const v = await voiceState(B.page, note);
    return v && /^\d+:\d{2}$/.test(v.time) && v.time !== '0:00' && v.cols.length &&
      meanHeight(v.cols, 0.7, 1) > 2 * meanHeight(v.cols, 0, 0.3) ? v : null;
  }, { timeout: 20000, what: 'duration and waveform while the media element has loaded nothing', describe: async () => JSON.stringify({ ...(await voiceState(B.page, note)), cols: undefined }) });
  assert.equal(s.waveform, 'ready');

  // The model holds: the element itself knows nothing yet.
  assert.equal(s.readyState, 0, 'the media element has not loaded anything');
  assert.equal(s.hasSrcAttr, false);
  // The player still shows the truth, and can be played.
  const shown = Number(s.time.split(':')[0]) * 60 + Number(s.time.split(':')[1]);
  assert.ok(shown >= 1 && shown <= 2, `the recording's duration (~2 s), read from the audio itself: ${s.time}`);
  assert.ok(meanHeight(s.cols, 0.7, 1) > 2 * meanHeight(s.cols, 0, 0.3), 'the real waveform');
  assert.equal(s.loading, false, 'the player must not wait for media metadata');
  assert.equal(s.playHittable, true, 'the play button takes real clicks');
  assert.equal(await B.page.evaluate(() => window.__plays), 0);

  await clickIn(B.page, `${voice(note)} .voice-message-play`);
  const playing = await pollUntil(async () => {
    const v = await voiceState(B.page, note);
    return v && !v.paused && v.currentTime > 0.2 ? v : null;
  }, { timeout: 15000, what: 'playback after the first play()', describe: async () => JSON.stringify({ ...(await voiceState(B.page, note)), cols: undefined }) });
  assert.ok(playing.aria > 0, 'progress advances');
  assert.ok(playedRatio(playing.cols) > 0, 'the visualizer advances');

  assert.deepEqual(await cspViolations(B.page), [], 'no CSP violation');
});
