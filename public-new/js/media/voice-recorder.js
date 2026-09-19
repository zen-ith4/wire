// ============================================================
// Voice message recorder
// ------------------------------------------------------------
// A small, self-contained wrapper around getUserMedia + MediaRecorder.
// This module owns ONLY the recording mechanics (permission, mic
// stream, MediaRecorder, the recording timer) — it knows nothing
// about upload, composer UI, or how the resulting Blob gets sent.
// That's wired up separately in composer.js, the same way the file
// upload logic there is decoupled from the staging-chip UI.
//
// RESOURCE SAFETY (see the module's callers for the full checklist):
// every mic track, the MediaRecorder instance, and the tick timer
// are released by teardown() — which runs at the end of stop(),
// cancel(), and any start() failure. There is no code path that
// opens a mic stream without a matching release.
// ============================================================

// Preference order: a compressed, widely-supported voice codec
// first, then progressively less specific fallbacks. Not every
// browser supports the same set (notably Safari's opus/webm support
// has historically been inconsistent), so this is picked dynamically
// via MediaRecorder.isTypeSupported() rather than assumed.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

const EXT_BY_BASE_MIME = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

export const MAX_RECORDING_MS = 5 * 60 * 1000; // 5 minutes

export function isVoiceRecordingSupported() {
  return !!(
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return '';
  }
  return MIME_CANDIDATES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch (e) {
      return false;
    }
  }) || '';
}

function extensionForMime(mimeType) {
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_BASE_MIME[base] || 'webm';
}

/**
 * Creates a fresh recorder controller. One instance is meant to be
 * used for exactly one record → (stop | cancel) cycle; create a new
 * one for the next recording (composer.js does this).
 *
 * @param {object} [handlers]
 * @param {(elapsedMs:number) => void} [handlers.onTick] - fired ~4x/sec while recording
 * @param {() => void} [handlers.onMaxDuration] - fired once MAX_RECORDING_MS is hit; caller is expected to call stop()
 */
export function createVoiceRecorder({ onTick, onMaxDuration } = {}) {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let tickInterval = null;
  let maxDurationFired = false;

  function clearTimer() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function releaseStream() {
    if (stream) {
      // Stopping every track is what actually turns off the OS's
      // "microphone in use" indicator — pausing/discarding the
      // recorder alone does not release the hardware.
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {
          // already stopped — nothing to do
        }
      });
      stream = null;
    }
  }

  // Called at the end of every exit path (stop/cancel/start-failure).
  // Idempotent — safe to call more than once.
  function teardown() {
    clearTimer();
    releaseStream();
    if (recorder) {
      // Detach listeners explicitly so a MediaRecorder that fires its
      // 'stop'/'dataavailable' event asynchronously (after we've
      // already moved on, e.g. during cancel()) can't run stale
      // callback logic against a promise nobody is waiting on anymore.
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      recorder = null;
    }
    chunks = [];
  }

  /**
   * Requests mic permission and starts recording.
   * Throws (permission denied / no mic / unsupported) — caller shows
   * the error; no partial state is left behind on failure.
   */
  async function start() {
    if (!isVoiceRecordingSupported()) {
      throw new Error('Voice recording is not supported in this browser');
    }

    const requestedStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    try {
      const mimeType = pickSupportedMimeType();
      recorder = mimeType
        ? new MediaRecorder(requestedStream, { mimeType })
        : new MediaRecorder(requestedStream); // browser default as a last resort

      stream = requestedStream;
      chunks = [];
      startedAt = Date.now();
      maxDurationFired = false;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      recorder.start();

      tickInterval = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        if (onTick) onTick(elapsedMs);
        if (!maxDurationFired && elapsedMs >= MAX_RECORDING_MS) {
          maxDurationFired = true;
          if (onMaxDuration) onMaxDuration();
        }
      }, 250);

      return { mimeType: recorder.mimeType || mimeType || '' };
    } catch (e) {
      // MediaRecorder construction failed after permission was
      // already granted — release the stream we just opened instead
      // of leaving the mic indicator on for a recorder that never
      // started.
      requestedStream.getTracks().forEach((track) => track.stop());
      stream = null;
      throw e;
    }
  }

  /**
   * Stops and finalizes the recording.
   * Resolves with `null` if there is nothing to finalize (never
   * started, or zero audio data captured) — callers treat that the
   * same as a cancellation.
   */
  function stop() {
    return new Promise((resolve, reject) => {
      if (!recorder || recorder.state === 'inactive') {
        teardown();
        resolve(null);
        return;
      }

      const activeRecorder = recorder;
      const mimeType = activeRecorder.mimeType || pickSupportedMimeType() || 'audio/webm';
      const durationMs = Date.now() - startedAt;

      activeRecorder.onstop = () => {
        const blob = chunks.length
          ? new Blob(chunks, { type: mimeType.split(';')[0] })
          : null;
        teardown();
        if (!blob || blob.size === 0) {
          resolve(null);
        } else {
          resolve({ blob, durationMs, ext: extensionForMime(mimeType) });
        }
      };

      activeRecorder.onerror = (e) => {
        teardown();
        reject(e?.error || new Error('Recording failed'));
      };

      clearTimer();

      try {
        activeRecorder.stop();
      } catch (e) {
        teardown();
        reject(e);
      }
    });
  }

  /**
   * Discards the recording in progress (if any) and releases every
   * resource immediately. Safe to call at any point, including
   * before start() resolves, after stop() already ran, or more than
   * once in a row — every one of those is a no-op past the first.
   */
  function cancel() {
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch (e) {
        // ignore — we're tearing down unconditionally below anyway
      }
    }
    teardown();
  }

  return { start, stop, cancel };
}
