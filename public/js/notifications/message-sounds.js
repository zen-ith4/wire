// ============================================================
// DM message sounds
// ------------------------------------------------------------
// The one place that plays Wire's two tiny in-app DM sounds:
//
//   playSent()      - after a DM was actually sent
//   playReceived()  - when a genuinely new DM from someone else
//                     arrived
//
// These are in-app UI sounds only. They are unrelated to system
// notifications: nothing here touches notification-manager.js,
// web notifications, Electron notifications or FCM.
//
// Mechanism (same on every platform):
//   The Web Audio API, playing two ~5-15 KB WAV files from
//   /audio/. It needs no dependency and no native plugin, and it
//   is available in the browser, in Electron's renderer and in
//   Capacitor's Android WebView, so there is no per-platform
//   implementation to keep in sync.
//
// Callers:
//   chat/dm.js  - playSent() from the DM composer's success
//                 callback, playReceived() from addDmMessage()
//                 for other users' messages.
//
// Nothing in here can throw into the chat UI and nothing awaits
// audio on the caller's behalf: both play functions return
// immediately.
// ============================================================

import { isNativeApp } from '../core/server.js';

// Same persistence mechanism as the DM Notifications setting
// (notification-manager.js): a plain localStorage flag, default ON.
const SETTING_STORAGE_KEY = 'wire-message-sounds';

// Root-relative, like the existing '/img/logo.jpg' references.
const SOUND_URLS = {
  sent: '/audio/message-sent.wav',
  received: '/audio/message-received.wav',
};

// A burst (several files sent/received at once) should not stack
// into a smear of overlapping chirps.
const MIN_GAP_MS = 150;

// Bounded, like notification-manager.js's notified-id set.
const MAX_TRACKED_IDS = 200;

let context = null;
const bufferPromises = new Map();
const playedKeys = new Set();
const lastPlayedAt = { sent: 0, received: 0 };

// ------------------------------------------------------------
// Setting
// ------------------------------------------------------------
// Read on every call instead of cached, so toggling the setting
// takes effect immediately and also across tabs/windows.

function isEnabled() {
  try {
    return localStorage.getItem(SETTING_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function setEnabled(enabled) {
  const value = enabled === true;

  try {
    localStorage.setItem(SETTING_STORAGE_KEY, value ? 'on' : 'off');
  } catch {
    // Non-fatal. The setting simply won't survive a reload.
  }

  return value;
}

// ------------------------------------------------------------
// Audio plumbing
// ------------------------------------------------------------

function isElectronApp() {
  return Boolean(window.electronAPI && window.electronAPI.isElectron);
}

// Creates the AudioContext (once) and asks it to run. Safe to call
// repeatedly; never throws.
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

    // Fetch + decode both sounds now so the first real play is instant.
    loadBuffer('sent');
    loadBuffer('received');
  } catch {
    // Audio is a nicety; never surface a failure.
  }
}

function loadBuffer(kind) {
  if (!context) return Promise.resolve(null);

  let pending = bufferPromises.get(kind);

  if (!pending) {
    const ctx = context;

    pending = fetch(SOUND_URLS[kind])
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes))
      .catch(() => {
        // Allow a later attempt (e.g. the first one was offline).
        bufferPromises.delete(kind);
        return null;
      });

    bufferPromises.set(kind, pending);
  }

  return pending;
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

// Decides whether this play request should happen at all, and
// records it so the same message can never sound twice.
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

async function playBuffer(kind) {
  // No context yet = no user gesture so far in a plain browser.
  // Stay silent rather than fight the autoplay policy.
  if (!context) return;

  if (context.state !== 'running') {
    await context.resume();
    if (context.state !== 'running') return;
  }

  const buffer = await loadBuffer(kind);
  if (!buffer) return;

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
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

    if (!shouldPlay(kind, messageId)) return;

    // Fire and forget: never block, never throw.
    playBuffer(kind).catch(() => {});
  } catch {
    // Never let a sound break sending/receiving.
  }
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export const messageSoundManager = {
  isEnabled,
  setEnabled,

  // Call only once a DM has actually been sent successfully.
  // `messageId` (optional) makes repeated calls for the same
  // message a no-op.
  playSent(messageId) {
    play('sent', messageId);
  },

  // Call only for a new DM authored by someone else. `messageId`
  // (optional) makes repeated calls for the same message a no-op.
  playReceived(messageId) {
    play('received', messageId);
  },
};

initAudioUnlock();
