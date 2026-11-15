// tests/voice-waveform.test.mjs
//
// Unit tests for public/js/media/voice-waveform.js (Bug 5): the duration and
// waveform of a voice message come from the audio itself, are computed ONCE
// per message (shared while in flight, cached afterwards), and are dropped on
// logout. The browser behaviour is covered by
// tests/dm-voice-message-browser.test.mjs; this pins the module's contract.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The module registers its logout listener on `window` when there is one.
globalThis.window = new EventTarget();

// A stand-in decoder: the "file" is raw Float32 samples at the context rate.
let decodes = 0;
let failDecode = false;
class FakeOfflineAudioContext {
  constructor(channels, length, sampleRate) {
    this.sampleRate = sampleRate;
  }

  decodeAudioData(bytes) {
    decodes += 1;
    if (failDecode) return Promise.reject(new Error('EncodingError: unsupported'));
    const samples = new Float32Array(bytes);
    return Promise.resolve({
      duration: samples.length / this.sampleRate,
      numberOfChannels: 1,
      getChannelData: () => samples,
    });
  }
}
globalThis.OfflineAudioContext = FakeOfflineAudioContext;

const waveform = await import(new URL('../public/js/media/voice-waveform.js', import.meta.url).href);
const {
  VOICE_WAVEFORM_BARS,
  computeWaveformPeaks,
  loadVoiceWaveform,
  getCachedVoiceWaveform,
  forgetVoiceWaveform,
  clearVoiceWaveformCache,
  voiceWaveformKey,
} = waveform;

/** `seconds` of audio at 8 kHz: silent, then a full-scale tone for the second half. */
function silenceThenTone(seconds = 2) {
  const n = seconds * 8000;
  const s = new Float32Array(n);
  for (let i = n / 2; i < n; i++) s[i] = Math.sin(i / 3);
  return s;
}

beforeEach(() => {
  clearVoiceWaveformCache();
  decodes = 0;
  failDecode = false;
});

test('peaks follow the loudness over time, normalised to the loudest slice', () => {
  const peaks = computeWaveformPeaks([silenceThenTone()], 8);
  assert.deepEqual(peaks, [8, 8, 8, 8, 100, 100, 100, 100]);

  const ramp = new Float32Array(8000);
  for (let i = 0; i < ramp.length; i++) ramp[i] = (i / ramp.length) * Math.sin(i);
  const rising = computeWaveformPeaks([ramp], 4);
  for (let i = 1; i < rising.length; i++) assert.ok(rising[i] > rising[i - 1], `a rising envelope rises: ${rising}`);
  assert.equal(rising[3], 100);
});

test('silence and empty input draw the baseline; channels are combined; the bar count is honoured', () => {
  assert.deepEqual(computeWaveformPeaks([new Float32Array(4000)], 5), [8, 8, 8, 8, 8]);
  assert.deepEqual(computeWaveformPeaks([new Float32Array(0)], 3), [8, 8, 8]);
  assert.deepEqual(computeWaveformPeaks([], 2), [8, 8]);
  assert.equal(computeWaveformPeaks([silenceThenTone()]).length, VOICE_WAVEFORM_BARS);

  // Left loud in the first half, right loud in the second: both halves loud.
  const left = new Float32Array(8000);
  const right = new Float32Array(8000);
  for (let i = 0; i < 4000; i++) left[i] = Math.sin(i);
  for (let i = 4000; i < 8000; i++) right[i] = Math.sin(i);
  const both = computeWaveformPeaks([left, right], 2);
  assert.ok(Math.abs(both[0] - both[1]) <= 1, `both halves: ${both}`);
});

test('the first analysis decodes once; concurrent callers share it; later renders hit the cache', async () => {
  const key = voiceWaveformKey('dm', 1);
  let loads = 0;
  const loadBytes = async () => {
    loads += 1;
    return silenceThenTone(2).buffer.slice(0);
  };

  const [first, second] = await Promise.all([loadVoiceWaveform(key, loadBytes), loadVoiceWaveform(key, loadBytes)]);
  assert.equal(loads, 1, 'the bytes are loaded once');
  assert.equal(decodes, 1, 'the audio is decoded once');
  assert.equal(first, second, 'both callers get the same analysis');
  assert.equal(first.duration, 2, 'duration comes from the decoded audio');
  assert.equal(first.peaks.length, VOICE_WAVEFORM_BARS);
  assert.ok(first.peaks[VOICE_WAVEFORM_BARS - 1] > first.peaks[0]);

  // A re-render (tab switch) reads the cache synchronously and decodes nothing.
  assert.equal(getCachedVoiceWaveform(key), first);
  await loadVoiceWaveform(key, loadBytes);
  assert.equal(decodes, 1, 'no second decode for the same message');
  assert.equal(loads, 1);
});

test('a failed load is not cached (a later render retries); an undecodable file is not decoded again', async () => {
  const key = voiceWaveformKey('dm', 2);
  let loads = 0;
  await assert.rejects(loadVoiceWaveform(key, async () => { loads += 1; throw new Error('offline'); }), /offline/);
  assert.equal(getCachedVoiceWaveform(key), null);
  const ok = await loadVoiceWaveform(key, async () => { loads += 1; return silenceThenTone(1).buffer.slice(0); });
  assert.equal(loads, 2, 'the bytes were loaded again after a load failure');
  assert.equal(ok.duration, 1);

  const bad = voiceWaveformKey('dm', 3);
  failDecode = true;
  const decodesBefore = decodes;
  let badLoads = 0;
  const loadBad = async () => { badLoads += 1; return new Float32Array(10).buffer; };
  await assert.rejects(loadVoiceWaveform(bad, loadBad), /EncodingError/);
  await assert.rejects(loadVoiceWaveform(bad, loadBad));
  assert.equal(badLoads, 1, 'an undecodable file is not downloaded and decoded on every render');
  assert.equal(decodes, decodesBefore + 1, 'one decode attempt in total');
});

test('forgetting a message, or logging out, drops its envelope', async () => {
  const key = voiceWaveformKey('dm', 4);
  const loadBytes = async () => silenceThenTone(1).buffer.slice(0);
  await loadVoiceWaveform(key, loadBytes);
  assert.ok(getCachedVoiceWaveform(key));

  forgetVoiceWaveform(key);
  assert.equal(getCachedVoiceWaveform(key), null, 'a deleted message takes its envelope with it');

  await loadVoiceWaveform(key, loadBytes);
  assert.ok(getCachedVoiceWaveform(key));
  window.dispatchEvent(new Event('wire:logout'));
  assert.equal(getCachedVoiceWaveform(key), null, 'logout clears every envelope');
});

test('work forgotten while in flight is not cached afterwards', async () => {
  const key = voiceWaveformKey('dm', 5);
  let release;
  const gate = new Promise((r) => { release = r; });
  const pending = loadVoiceWaveform(key, async () => {
    await gate;
    return silenceThenTone(1).buffer.slice(0);
  });
  forgetVoiceWaveform(key);
  release();
  await pending;
  assert.equal(getCachedVoiceWaveform(key), null);
});
