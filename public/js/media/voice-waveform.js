// public/js/media/voice-waveform.js
//
// The duration and the waveform of a voice message, read ONCE from the audio
// itself, before anything is played, and kept in memory.
//
// Before this, the voice player knew nothing about the file it showed: the
// "waveform" was 32 pseudo-random bars seeded by the message id, and the
// duration only existed once the <audio> element had loaded metadata - which
// many browsers defer until the user presses play (iOS Safari ignores
// preload, Android data saver and background tabs treat "metadata" as
// "none"). So the time showed 0:00, and nothing about the visualizer said
// anything true, until a first playback.
//
// Cost: one decode per message for the lifetime of the page. Work for the
// same message is shared while it runs and the result is cached afterwards,
// so re-rendering a thread (tab switches, reopening the conversation, a
// second player for the same row) never decodes again. Decoding runs at a
// low sample rate: a 32-bar envelope needs loudness, not fidelity, so a
// 5-minute note is ~2.4M samples for the moment it is analysed.
//
// Privacy: the envelope is derived from DECRYPTED audio, so it is treated
// like the decrypted blobs in attachment-e2ee.js - memory only, never
// persisted, dropped on logout and when its message is deleted.

export const VOICE_WAVEFORM_BARS = 32;

// Lowest bar, in percent of the bar area: silence still draws a baseline.
const MIN_BAR = 8;

// Tried in order; not every engine accepts every rate for an offline context.
const ANALYSIS_SAMPLE_RATES = [8000, 22050, 44100];

const MAX_CACHED = 300;

const cache = new Map(); // key -> { duration, peaks }
const inflight = new Map(); // key -> Promise<{ duration, peaks }>
const undecodable = new Set(); // keys whose audio this engine cannot decode

export function voiceWaveformKey(scope, id) {
  return `${scope}:${id}`;
}

/** The cached analysis for `key`, or null. Never starts any work. */
export function getCachedVoiceWaveform(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key); // keep recently used entries at the end (LRU)
  cache.set(key, hit);
  return hit;
}

function remember(key, analysis) {
  cache.delete(key);
  cache.set(key, analysis);
  while (cache.size > MAX_CACHED) {
    cache.delete(cache.keys().next().value);
  }
}

export function forgetVoiceWaveform(key) {
  cache.delete(key);
  inflight.delete(key);
  undecodable.delete(key);
}

export function clearVoiceWaveformCache() {
  cache.clear();
  inflight.clear();
  undecodable.clear();
}

/**
 * Bar heights (MIN_BAR..100) from decoded samples: the RMS loudness of each of
 * `bars` equal slices of the timeline, all channels together, normalised to
 * the loudest slice. Pure and deterministic.
 *
 * @param {ArrayLike<number>[]} channels one sample array per channel
 * @param {number} [bars]
 * @returns {number[]}
 */
export function computeWaveformPeaks(channels, bars = VOICE_WAVEFORM_BARS) {
  const count = Math.max(1, Math.floor(Number(bars)) || VOICE_WAVEFORM_BARS);
  const list = Array.isArray(channels) ? channels.filter(Boolean) : [];
  const length = list.reduce((max, ch) => Math.max(max, ch.length || 0), 0);

  const levels = new Array(count).fill(0);

  if (length > 0) {
    for (let bar = 0; bar < count; bar++) {
      const start = Math.floor((bar * length) / count);
      const end = Math.max(start + 1, Math.floor(((bar + 1) * length) / count));
      let sumSquares = 0;
      let samples = 0;

      for (const ch of list) {
        const stop = Math.min(end, ch.length);
        for (let i = start; i < stop; i++) {
          const v = Number(ch[i]) || 0;
          sumSquares += v * v;
          samples++;
        }
      }

      levels[bar] = samples ? Math.sqrt(sumSquares / samples) : 0;
    }
  }

  const loudest = Math.max(...levels);

  return levels.map((level) =>
    loudest > 0
      ? Math.round(MIN_BAR + (100 - MIN_BAR) * Math.min(1, level / loudest))
      : MIN_BAR
  );
}

function createDecodeContext() {
  const Ctor =
    globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctor) return null;

  for (const rate of ANALYSIS_SAMPLE_RATES) {
    try {
      return new Ctor(1, 1, rate);
    } catch {
      // this rate is not supported for an offline context here; try the next
    }
  }

  return null;
}

// Modern engines return a promise (and call the callbacks too); older Safari
// only has the callback form.
function decodeAudio(ctx, bytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (buffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error || new Error('Audio could not be decoded'));
    };

    try {
      const pending = ctx.decodeAudioData(bytes, ok, fail);
      if (pending && typeof pending.then === 'function') pending.then(ok, fail);
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Decodes `bytes` and measures it.
 *
 * @param {ArrayBuffer} bytes the complete audio file (detached by decoding)
 * @returns {Promise<{ duration: number, peaks: number[] }>}
 */
export async function analyzeVoiceAudio(bytes, { bars = VOICE_WAVEFORM_BARS } = {}) {
  const ctx = createDecodeContext();
  if (!ctx) throw new Error('Audio decoding is not available in this browser');

  const buffer = await decodeAudio(ctx, bytes);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  return {
    duration: buffer.duration,
    peaks: computeWaveformPeaks(channels, bars),
  };
}

/**
 * The analysis for `key`: from the cache, from work already running for the
 * same key, or by loading the bytes with `loadBytes()` and decoding them once.
 *
 * Rejects when the bytes cannot be loaded (a later call may retry) or decoded
 * (remembered for this page: the same engine will not decode them next time
 * either, so it is not attempted again).
 *
 * @param {string} key voiceWaveformKey(scope, id)
 * @param {() => Promise<ArrayBuffer>} loadBytes
 * @returns {Promise<{ duration: number, peaks: number[] }>}
 */
export function loadVoiceWaveform(key, loadBytes, { bars = VOICE_WAVEFORM_BARS } = {}) {
  const cached = getCachedVoiceWaveform(key);
  if (cached) return Promise.resolve(cached);

  if (undecodable.has(key)) {
    return Promise.reject(new Error('Audio could not be decoded'));
  }

  const running = inflight.get(key);
  if (running) return running;

  const work = (async () => {
    const bytes = await loadBytes();

    let analysis;
    try {
      analysis = await analyzeVoiceAudio(bytes, { bars });
    } catch (error) {
      undecodable.add(key);
      throw error;
    }

    if (inflight.get(key) === work) remember(key, analysis);
    return analysis;
  })().finally(() => {
    if (inflight.get(key) === work) inflight.delete(key);
  });

  inflight.set(key, work);
  return work;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('wire:logout', clearVoiceWaveformCache);
}
