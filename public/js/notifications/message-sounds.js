// ============================================================
// DM message sounds
// ------------------------------------------------------------
// The one place that plays Wire's in-app DM sounds:
//
//   playSent()      - after a DM was actually sent
//   playReceived()  - when a genuinely new DM from someone else
//                     arrived
//
// plus the Settings-facing API (presets, volume, custom sounds,
// previews). These are in-app UI sounds only. They are unrelated
// to system notifications: nothing here touches
// notification-manager.js, web notifications, Electron
// notifications or FCM.
//
// Mechanism (same on every platform):
//   The Web Audio API. Every sound is decoded into an AudioBuffer
//   and played through its own GainNode, so the volume setting
//   only ever scales Wire's message sounds - never the system
//   volume or any other audio. Web Audio is available in the
//   browser, in Electron's renderer and in Capacitor's Android
//   WebView, so there is no per-platform implementation.
//
// Sound sources, per kind ("sent" / "received"):
//   - one of the built-in presets in /audio/ (see SOUND_PRESETS)
//   - or a custom file the user picked. Custom files never leave
//     the device: the raw bytes live in IndexedDB, and only tiny
//     metadata (name, size, duration) goes in localStorage.
//   If a custom sound is unavailable for any reason, the selected
//   built-in preset plays instead.
//
// Persistence
//   localStorage 'wire-message-sounds'        enabled ('on'|'off')
//   localStorage 'wire-message-sounds:prefs'  volume, selected
//                                             presets, custom-sound
//                                             metadata (JSON)
//   IndexedDB 'wire-message-sounds' /
//     store 'custom-sounds', keys 'sent' | 'received'
//                                             custom sound bytes
//   AudioBuffers are only ever an in-memory cache.
//
// Callers:
//   chat/dm.js                    playSent() / playReceived()
//   settings/settings-message-sounds.js   everything else
//
// Nothing in here throws into the chat UI and nothing awaits audio
// on the caller's behalf: playSent()/playReceived() return
// immediately.
// ============================================================

import { isNativeApp } from '../core/server.js';

const ENABLED_KEY = 'wire-message-sounds';
const PREFS_KEY = 'wire-message-sounds:prefs';
const DB_NAME = 'wire-message-sounds';
const DB_STORE = 'custom-sounds';

const KINDS = ['sent', 'received'];

export const DEFAULT_VOLUME = 100;

// Root-relative, like the existing '/img/logo.jpg' references.
// "default" is the original pair of sounds.
const PRESET_URLS = {
  default: {
    sent: '/audio/message-sent.wav',
    received: '/audio/message-received.wav',
  },
  soft: {
    sent: '/audio/soft-sent.wav',
    received: '/audio/soft-received.wav',
  },
  subtle: {
    sent: '/audio/subtle-sent.wav',
    received: '/audio/subtle-received.wav',
  },
  classic: {
    sent: '/audio/classic-sent.wav',
    received: '/audio/classic-received.wav',
  },
  digital: {
    sent: '/audio/digital-sent.wav',
    received: '/audio/digital-received.wav',
  },
  minimal: {
    sent: '/audio/minimal-sent.wav',
    received: '/audio/minimal-received.wav',
  },
};

export const SOUND_PRESETS = [
  { id: 'default', name: 'Default' },
  { id: 'soft', name: 'Soft' },
  { id: 'subtle', name: 'Subtle' },
  { id: 'classic', name: 'Classic' },
  { id: 'digital', name: 'Digital' },
  { id: 'minimal', name: 'Minimal' },
];

// Custom sounds are short UI sounds, not music.
export const CUSTOM_SOUND_LIMITS = {
  maxBytes: 1024 * 1024, // 1 MB
  maxSeconds: 3,
};

// A hint for the file picker only. Whether a file is accepted is
// decided by actually decoding it, never by its name or type.
export const CUSTOM_SOUND_ACCEPT =
  'audio/*,.wav,.mp3,.ogg,.oga,.opus,.m4a,.aac,.flac,.webm';

// A burst (several files sent/received at once) should not stack
// into a smear of overlapping chirps.
const MIN_GAP_MS = 150;

// Bounded, like notification-manager.js's notified-id set.
const MAX_TRACKED_IDS = 200;

// How long to wait for a suspended AudioContext to resume before
// treating playback as blocked (a blocked resume() may never settle).
const RESUME_TIMEOUT_MS = 300;

let context = null;
let activePreview = null;
const bufferCache = new Map();
const playedKeys = new Set();
const lastPlayedAt = { sent: 0, received: 0 };
const listeners = new Set();

function isKind(kind) {
  return KINDS.includes(kind);
}

function isPresetId(id) {
  return Object.prototype.hasOwnProperty.call(PRESET_URLS, id);
}

// ------------------------------------------------------------
// Settings persistence
// ------------------------------------------------------------
// Everything is read from localStorage on every use instead of being
// cached, so a change takes effect immediately and also across
// tabs/windows.

function isEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'off';
  } catch {
    return true;
  }
}

function setEnabled(enabled) {
  const value = enabled === true;

  try {
    localStorage.setItem(ENABLED_KEY, value ? 'on' : 'off');
  } catch {
    // Non-fatal. The setting simply won't survive a reload.
  }

  notify();

  return value;
}

function blankKind() {
  return { preset: 'default', useCustom: false, custom: null };
}

function cleanName(name) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();

  return (base || 'Custom sound').slice(0, 80);
}

function sanitizeCustom(custom) {
  if (!custom || typeof custom !== 'object') return null;
  if (typeof custom.rev !== 'string' || !custom.rev) return null;

  const size = Number(custom.size);
  const duration = Number(custom.duration);

  return {
    name: cleanName(custom.name),
    size: Number.isFinite(size) && size > 0 ? size : 0,
    duration:
      Number.isFinite(duration) && duration > 0 ? duration : 0,
    rev: custom.rev,
  };
}

function sanitizeKind(raw) {
  const kind = blankKind();
  if (!raw || typeof raw !== 'object') return kind;

  if (isPresetId(raw.preset)) kind.preset = raw.preset;

  kind.custom = sanitizeCustom(raw.custom);
  kind.useCustom = raw.useCustom === true && kind.custom !== null;

  return kind;
}

function clampVolume(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.min(100, Math.max(0, n));
}

function readPrefs() {
  let raw = null;

  try {
    raw = JSON.parse(localStorage.getItem(PREFS_KEY));
  } catch {
    raw = null;
  }

  if (!raw || typeof raw !== 'object') raw = {};

  return {
    volume:
      raw.volume === undefined
        ? DEFAULT_VOLUME
        : clampVolume(raw.volume),
    sent: sanitizeKind(raw.sent),
    received: sanitizeKind(raw.received),
  };
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

function updatePrefs(mutate) {
  const prefs = readPrefs();
  mutate(prefs);
  const ok = writePrefs(prefs);
  notify();
  return ok;
}

function getSettings() {
  return {
    enabled: isEnabled(),
    ...JSON.parse(JSON.stringify(readPrefs())),
  };
}

// Lets the Settings page repaint when something changes underneath
// it (e.g. a stored custom sound turned out to be missing).
function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A broken listener must not affect playback or settings.
    }
  });
}

function setVolume(volume) {
  const value = clampVolume(volume);
  updatePrefs((prefs) => {
    prefs.volume = value;
  });
  return value;
}

// `choice` is a preset id, or 'custom' to use the stored custom file.
function selectSound(kind, choice) {
  if (!isKind(kind)) return false;

  if (choice === 'custom') {
    if (!readPrefs()[kind].custom) return false;

    updatePrefs((prefs) => {
      prefs[kind].useCustom = true;
    });
  } else if (isPresetId(choice)) {
    updatePrefs((prefs) => {
      prefs[kind].preset = choice;
      prefs[kind].useCustom = false;
    });
  } else {
    return false;
  }

  warm(kind);
  return true;
}

// ------------------------------------------------------------
// Custom sound storage (IndexedDB)
// ------------------------------------------------------------

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        if (!globalThis.indexedDB) {
          throw new Error('IndexedDB is unavailable');
        }

        const request = globalThis.indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE);
          }
        };

        request.onsuccess = () => {
          const db = request.result;
          // If another tab upgrades the schema, let go and reopen later.
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };

        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('blocked'));
      } catch (error) {
        reject(error);
      }
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }

  return dbPromise;
}

function withStore(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const request = run(tx.objectStore(DB_STORE));
        let result;

        request.onsuccess = () => {
          result = request.result;
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

const dbGet = (kind) => withStore('readonly', (s) => s.get(kind));
const dbPut = (kind, record) =>
  withStore('readwrite', (s) => s.put(record, kind));
const dbDelete = (kind) =>
  withStore('readwrite', (s) => s.delete(kind));

// ------------------------------------------------------------
// Audio plumbing
// ------------------------------------------------------------

function isElectronApp() {
  return Boolean(window.electronAPI && window.electronAPI.isElectron);
}

// Creates the AudioContext (once) and asks it to run. Safe to call
// repeatedly; never throws. Must be called synchronously inside a
// user gesture for the resume to be honored in a plain browser.
function armAudio() {
  try {
    if (!context) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      context = new Ctor();
    }

    if (context.state !== 'running') {
      // Rejects (harmlessly) if the platform still wants a gesture.
      context.resume().catch(() => {});
    }

    // Decode the selected sounds now so the first real play is instant.
    KINDS.forEach(warm);
  } catch {
    // Audio is a nicety; never surface a failure.
  }
}

function warm(kind) {
  if (!context) return;

  try {
    resolveBuffer(kind, readPrefs()[kind]).catch(() => {});
  } catch {
    // Ignore.
  }
}

// Caches the in-flight/finished decode. A failed load is forgotten so
// a later play can retry (e.g. the first attempt was offline).
function cached(key, load) {
  let pending = bufferCache.get(key);

  if (!pending) {
    pending = load().then(
      (buffer) => {
        if (!buffer) bufferCache.delete(key);
        return buffer || null;
      },
      () => {
        bufferCache.delete(key);
        return null;
      }
    );

    bufferCache.set(key, pending);
  }

  return pending;
}

function dropCached(prefix) {
  Array.from(bufferCache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) bufferCache.delete(key);
  });
}

function loadPresetBuffer(kind, presetId) {
  if (!context || !isPresetId(presetId)) {
    return Promise.resolve(null);
  }

  const ctx = context;

  return cached(`preset:${presetId}:${kind}`, () =>
    fetch(PRESET_URLS[presetId][kind])
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes))
  );
}

// The stored bytes are gone or unusable: forget the custom sound so
// Settings shows the truth and playback stays on the built-in one.
function forgetCustom(kind, rev, alsoDeleteBytes) {
  const current = readPrefs()[kind].custom;

  if (current && current.rev === rev) {
    updatePrefs((prefs) => {
      prefs[kind].custom = null;
      prefs[kind].useCustom = false;
    });
  }

  dropCached(`custom:${kind}:`);

  if (alsoDeleteBytes) dbDelete(kind).catch(() => {});
}

function loadCustomBuffer(kind, custom) {
  if (!context) return Promise.resolve(null);

  const ctx = context;

  return cached(`custom:${kind}:${custom.rev}`, async () => {
    let record;

    try {
      record = await dbGet(kind);
    } catch {
      // Storage failure: don't forget the sound, just fall back for now.
      return null;
    }

    if (!record || !record.data || !record.data.byteLength) {
      forgetCustom(kind, custom.rev, false); // deleted/unavailable
      return null;
    }

    try {
      // decodeAudioData may detach its input, so hand it a copy.
      return await ctx.decodeAudioData(record.data.slice(0));
    } catch {
      forgetCustom(kind, custom.rev, true); // corrupted/unsupported
      return null;
    }
  });
}

// `selection` = { preset, useCustom, custom }. Custom first, then the
// selected preset, then (defensively) the Default preset.
async function resolveBuffer(kind, selection) {
  let fallback = false;

  if (selection.useCustom) {
    if (selection.custom) {
      const buffer = await loadCustomBuffer(kind, selection.custom);
      if (buffer) return { buffer, fallback: false };
    }
    fallback = true;
  }

  let buffer = await loadPresetBuffer(kind, selection.preset);

  if (!buffer && selection.preset !== 'default') {
    buffer = await loadPresetBuffer(kind, 'default');
  }

  return { buffer, fallback };
}

// Browsers only allow audio to start after a user gesture, so in a
// plain browser the context is created on the first tap/click/key.
// Electron and Capacitor's WebView are app shells, so they arm
// immediately (and still fall back to the first gesture below if the
// platform turns out to require one).
function initAudioUnlock() {
  if (typeof window === 'undefined') return;

  const events = ['pointerdown', 'keydown', 'touchend'];

  const onGesture = () => {
    events.forEach((name) =>
      window.removeEventListener(name, onGesture, true)
    );
    armAudio();
  };

  events.forEach((name) =>
    window.addEventListener(name, onGesture, true)
  );

  if (isNativeApp() || isElectronApp()) {
    armAudio();
  }
}

// ------------------------------------------------------------
// Playing
// ------------------------------------------------------------

// Decides whether a real message sound should happen at all, and
// records it so the same message can never sound twice. Previews do
// NOT go through here, so they neither consume nor obey the
// duplicate/throttle state.
function shouldPlay(kind, messageId) {
  if (!isEnabled()) return false;

  if (messageId != null) {
    const key = `${kind}:${messageId}`;

    if (playedKeys.has(key)) return false;

    if (playedKeys.size >= MAX_TRACKED_IDS) {
      Array.from(playedKeys)
        .slice(0, MAX_TRACKED_IDS / 2)
        .forEach((old) => playedKeys.delete(old));
    }

    playedKeys.add(key);
  }

  const now = Date.now();

  if (now - lastPlayedAt[kind] < MIN_GAP_MS) return false;

  lastPlayedAt[kind] = now;

  return true;
}

// Resolves to true once the context is running. A blocked resume()
// can stay pending forever, so don't wait on it indefinitely (that
// would otherwise replay a stale sound after the first gesture).
async function ensureRunning() {
  if (context.state === 'running') return true;

  await Promise.race([
    context.resume().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS)),
  ]);

  return context.state === 'running';
}

async function playSelection(kind, selection, volume, isPreview) {
  // No context yet = no user gesture so far in a plain browser (or no
  // Web Audio at all). Stay silent rather than fight autoplay policy.
  if (!context) return { ok: false, reason: 'unsupported' };

  if (!(await ensureRunning())) {
    return { ok: false, reason: 'blocked' };
  }

  const { buffer, fallback } = await resolveBuffer(kind, selection);

  if (!buffer) return { ok: false, reason: 'unavailable' };

  const source = context.createBufferSource();
  source.buffer = buffer;

  // The gain node is what makes the volume setting apply to Wire's
  // message sounds only.
  const gain = context.createGain();
  gain.gain.value = volume / 100;

  source.connect(gain);
  gain.connect(context.destination);

  if (isPreview) {
    stopPreview();
    activePreview = source;
    source.onended = () => {
      if (activePreview === source) activePreview = null;
    };
  }

  source.start();

  return { ok: true, fallback };
}

function stopPreview() {
  try {
    if (activePreview) activePreview.stop();
  } catch {
    // Already stopped.
  }
  activePreview = null;
}

function play(kind, messageId) {
  try {
    // On Android the system/FCM notification owns anything that
    // happens while the app isn't in front; don't add a second cue.
    if (
      kind === 'received' &&
      isNativeApp() &&
      document.visibilityState !== 'visible'
    ) {
      return;
    }

    const prefs = readPrefs();

    if (prefs.volume <= 0) return;

    if (!shouldPlay(kind, messageId)) return;

    // Fire and forget: never block, never throw.
    playSelection(kind, prefs[kind], prefs.volume, false).catch(
      () => {}
    );
  } catch {
    // Never let a sound break sending/receiving.
  }
}

// Settings preview. `choice` is a preset id, 'custom', or omitted for
// the currently selected sound. Always plays (even while message
// sounds are switched off), bypasses duplicate/throttle protection,
// and is itself a user gesture, so it may start the AudioContext.
// Resolves to { ok, reason?, fallback? } and never rejects.
function preview(kind, choice) {
  try {
    armAudio(); // synchronously, while still inside the gesture

    const prefs = readPrefs();

    if (prefs.volume <= 0) {
      return Promise.resolve({ ok: false, reason: 'muted' });
    }

    let selection = prefs[kind];

    if (choice === 'custom') {
      selection = {
        preset: prefs[kind].preset,
        useCustom: true,
        custom: prefs[kind].custom,
      };
    } else if (isPresetId(choice)) {
      selection = { preset: choice, useCustom: false, custom: null };
    }

    return playSelection(kind, selection, prefs.volume, true).catch(
      () => ({ ok: false, reason: 'unavailable' })
    );
  } catch {
    return Promise.resolve({ ok: false, reason: 'unavailable' });
  }
}

// ------------------------------------------------------------
// Custom sounds
// ------------------------------------------------------------

function fail(code, message) {
  return { ok: false, code, message };
}

const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

// Validates a user-picked File by actually decoding it as audio, then
// stores it locally and selects it. Never throws; resolves to
// { ok: true, info } or { ok: false, code, message } with a message
// that is safe to show in Settings. The file is only ever treated as
// bytes: it is never executed, interpreted as markup, or uploaded.
async function setCustomSound(kind, file) {
  try {
    if (!isKind(kind)) return fail('invalid', 'Unknown sound.');

    if (!file || typeof file.size !== 'number') {
      return fail('no-file', 'No file was selected.');
    }

    if (file.size === 0) {
      return fail('empty', 'That file is empty.');
    }

    const { maxBytes, maxSeconds } = CUSTOM_SOUND_LIMITS;

    if (file.size > maxBytes) {
      return fail(
        'too-large',
        `That file is too large (${kb(file.size)}). Sounds can be up to ${kb(maxBytes)}.`
      );
    }

    armAudio();

    if (!context) {
      return fail(
        'unsupported',
        "This device can't play custom sounds."
      );
    }

    let bytes;
    let decoded;

    try {
      bytes = await file.arrayBuffer();
      // decodeAudioData may detach its input; keep `bytes` intact.
      decoded = await context.decodeAudioData(bytes.slice(0));
    } catch {
      return fail(
        'unsupported',
        "That file couldn't be read as audio. Try a WAV, MP3, OGG or M4A file."
      );
    }

    if (!(decoded.duration > 0)) {
      return fail('unsupported', 'That file has no audio in it.');
    }

    if (decoded.duration > maxSeconds) {
      return fail(
        'too-long',
        `That sound is ${decoded.duration.toFixed(1)} seconds long. Sounds can be up to ${maxSeconds} seconds.`
      );
    }

    const info = {
      name: cleanName(file.name),
      size: file.size,
      duration: decoded.duration,
      rev: `${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 6)}`,
    };

    const storageError = fail(
      'storage',
      "Couldn't save that sound on this device. Storage may be full or unavailable."
    );

    try {
      await dbPut(kind, { ...info, type: file.type || '', data: bytes });
    } catch {
      return storageError;
    }

    const saved = updatePrefs((prefs) => {
      prefs[kind].custom = info;
      prefs[kind].useCustom = true;
    });

    if (!saved) {
      dbDelete(kind).catch(() => {});
      return storageError;
    }

    dropCached(`custom:${kind}:`);
    bufferCache.set(`custom:${kind}:${info.rev}`, Promise.resolve(decoded));

    return { ok: true, info: { ...info } };
  } catch {
    return fail('unknown', 'Something went wrong with that file.');
  }
}

async function removeCustomSound(kind) {
  if (!isKind(kind)) return { ok: false };

  updatePrefs((prefs) => {
    prefs[kind].custom = null;
    prefs[kind].useCustom = false;
  });

  dropCached(`custom:${kind}:`);

  try {
    await dbDelete(kind);
  } catch {
    // The metadata is already gone, so the orphaned bytes are
    // unreachable; nothing more to do.
  }

  warm(kind);

  return { ok: true };
}

// Volume, selected presets and custom sounds back to factory state.
// The on/off switch is left as the user set it.
async function resetToDefaults() {
  updatePrefs((prefs) => {
    prefs.volume = DEFAULT_VOLUME;
    KINDS.forEach((kind) => {
      prefs[kind] = blankKind();
    });
  });

  dropCached('custom:');

  await Promise.all(
    KINDS.map((kind) => dbDelete(kind).catch(() => {}))
  );

  KINDS.forEach(warm);

  return { ok: true };
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export const messageSoundManager = {
  // Master switch
  isEnabled,
  setEnabled,

  // Volume, 0-100
  getVolume: () => readPrefs().volume,
  setVolume,

  // Snapshot for the Settings UI
  getSettings,
  onChange,

  // Sound selection: a preset id, or 'custom'
  setSentSound: (choice) => selectSound('sent', choice),
  setReceivedSound: (choice) => selectSound('received', choice),

  // Custom files
  setCustomSound,
  removeCustomSound,
  resetToDefaults,

  // Message playback (used by chat/dm.js)
  //
  // playSent: call only once a DM has actually been sent
  // successfully. playReceived: call only for a new DM authored by
  // someone else. `messageId` (optional) makes repeated calls for the
  // same message a no-op.
  playSent(messageId) {
    play('sent', messageId);
  },

  playReceived(messageId) {
    play('received', messageId);
  },

  // Settings previews (see preview())
  previewSent: (choice) => preview('sent', choice),
  previewReceived: (choice) => preview('received', choice),
};

initAudioUnlock();
