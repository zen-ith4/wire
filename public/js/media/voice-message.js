// ============================================================
// Voice message player
// ------------------------------------------------------------
// Deliberately a SEPARATE component from audio-player.js (the
// generic uploaded-audio-file player). Voice messages share the
// message/attachment/upload/streaming infrastructure with normal
// audio attachments (see attachments.js) but get their own compact,
// native-chat-app-style UI here — a single row with a play button,
// a lightweight generated waveform doubling as the seek bar,
// current/total time, and a playback-speed toggle. The two players
// are never meant to converge; see the header comment in
// audio-player.js for the reasoning on why that one stays untouched.
// ============================================================

import { ICONS } from '../icons.js';
import { escapeAttr } from '../core/utils.js';
import { fetchBlob } from '../core/api.js';

// ======================================================
// DETECTION
// ======================================================

// A voice message is any attachment the server tagged
// is_voice_message=true. (The server only ever sets that flag when
// the attachment's mime is actually audio/* — see
// chat.controller.js/dm.controller.js's isVoiceMessageFlag() — but
// the mime check is repeated here too, defensively, so a malformed
// row can never end up rendered through an <audio> element as if it
// were playable audio.)
export function isVoiceMessage(msg) {
  return !!(
    msg &&
    msg.is_voice_message &&
    typeof msg.attachment_mime === 'string' &&
    msg.attachment_mime.startsWith('audio/')
  );
}

// ======================================================
// PLAYBACK STATE PERSISTENCE (across tab/view switches)
//
// Same reasoning as audioPlaybackState in audio-player.js: the whole
// message list is torn down and rebuilt via innerHTML on every
// Chat/DM navigation (including navigating back to a tab you were
// already on), which would otherwise silently reset every voice
// message back to 0:00 on each visit. Kept as a module-level map so
// it survives that DOM wipe.
// ======================================================

const voicePlaybackState = new Map();

function saveVoiceState(messageId, audio, playing, rate) {
  voicePlaybackState.set(messageId, {
    currentTime: audio.currentTime,
    playing,
    rate,
    muted: audio.muted,
    volume: audio.volume,
  });
}

// ======================================================
// SINGLE ACTIVE PLAYER
//
// Only one voice message plays at a time. When a new one starts,
// whatever was previously playing gets paused via its own <audio>
// element's pause() — which fires that player's own 'pause' listener
// (registered below, once, when that player was built) to flip its
// icon/state back. No separate "who owns the UI" bookkeeping needed;
// pausing the actual media element is enough for it to fix its own
// display, and calling pause() on an element whose player has since
// been torn down (e.g. after navigating away) is harmless.
// ======================================================

let activeAudioEl = null;

function setActivePlayer(audio) {
  if (activeAudioEl && activeAudioEl !== audio && !activeAudioEl.paused) {
    try {
      activeAudioEl.pause();
    } catch (e) {
      // element may already be detached — nothing to do
    }
  }
  activeAudioEl = audio;
}

// ======================================================
// SINGLE OPEN VOLUME PANEL
//
// Same "at most one at a time" idea as the active player above, for
// a different reason: opening the volume panel attaches a document-
// level click listener (to close it when you click elsewhere), and
// there's no per-render "this player was torn down" hook to guarantee
// that listener always gets removed (e.g. the person opens the panel
// then navigates away without closing it first). Tracking only ONE
// open panel's close function at a time — and force-closing it
// whenever a different panel opens — bounds the worst case to at
// most one stray listener/closure system-wide, rather than one per
// voice message ever opened.
// ======================================================

let closeOpenVolumePanel = null;

// ======================================================
// TOKEN / URL — identical scheme to audio-player.js's getAudioUrl()
// ======================================================

function getMediaToken() {
  return localStorage.getItem('token') || '';
}

function getVoiceUrl(msg, scope) {
  const baseUrl =
    scope === 'dm'
      ? `/api/dm/attachments/${encodeURIComponent(msg.id)}`
      : `/api/chat/attachments/${encodeURIComponent(msg.id)}`;

  const token = getMediaToken();

  if (!token) return baseUrl;

  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}

// ======================================================
// WAVEFORM (decorative, generated — no audio decoding required)
//
// A real per-sample waveform would mean fetching and decoding the
// whole file via the Web Audio API just to draw a picture, which is
// unnecessary work for a compact chat bubble and would fight the
// range-request/streaming behavior the player relies on for large
// files. Instead this generates a fixed, deterministic set of bar
// heights seeded from the message id, so the same voice message
// always renders the same-looking (but not audio-accurate) waveform
// on every render — visually in the spirit of a waveform without
// requiring extra dependencies or fully downloading the file first.
// ======================================================

const BAR_COUNT = 32;

function seededBars(seed, count) {
  // Small deterministic PRNG (mulberry32) — good enough for a purely
  // decorative bar pattern, no need for a real RNG/crypto here.
  let state = (seed >>> 0) || 1;
  function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const bars = [];
  for (let i = 0; i < count; i++) {
    // Bias toward mid-range heights (25%-95%) so the waveform reads
    // as audio-ish rather than random noise.
    bars.push(Math.round(25 + next() * 70));
  }
  return bars;
}

function barsHtml(bars) {
  return bars
    .map((h) => `<span class="voice-wave-bar" style="height:${h}%"></span>`)
    .join('');
}

// ======================================================
// PLAYBACK SPEED
// ======================================================

const SPEED_STEPS = [1, 1.25, 1.5, 2];

function nextSpeed(current) {
  const idx = SPEED_STEPS.indexOf(current);
  return SPEED_STEPS[(idx + 1) % SPEED_STEPS.length];
}

function formatSpeed(rate) {
  return `${rate % 1 === 0 ? rate.toFixed(0) : rate}x`;
}

// ======================================================
// TIME FORMAT — same shape as audio-player.js's formatTime()
// ======================================================

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

// ======================================================
// PLAYER
// ======================================================

// `containerEl` is the message's own element, passed in directly by
// mountAttachmentMedia() in attachments.js — see the identical note
// in audio-player.js's renderAudio() for why this is looked up
// inside `containerEl` rather than via a global document query.
export function renderVoiceMessage(msg, scope, containerEl) {
  const messageId = String(msg.id);

  const container =
    containerEl ||
    document.querySelector(`.chat-msg[data-msg-id="${CSS.escape(messageId)}"]`);

  if (!container) {
    console.error('Voice message container not found for message:', msg.id);
    return;
  }

  const playerId = `vplayer-${messageId}`;

  // Prevent duplicate players (same reasoning as renderAudio()).
  if (container.querySelector(`#${CSS.escape(playerId)}`)) {
    return;
  }

  const attachmentUrl = getVoiceUrl(msg, scope);
  const bars = seededBars(msg.id, BAR_COUNT);
  const barsMarkup = barsHtml(bars);

  const template = `
    <div class="voice-message loading" id="${playerId}">
      <button
        type="button"
        class="voice-message-play"
        aria-label="Play voice message"
      >
        <span class="icon-play">${ICONS.play}</span>
        <span class="icon-pause" style="display:none">${ICONS.pause}</span>
      </button>

      <div
        class="voice-message-wave"
        role="slider"
        tabindex="0"
        aria-label="Seek voice message"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="0"
      >
        <div class="voice-wave-track">${barsMarkup}</div>
        <div class="voice-wave-fill" style="width:0%">${barsMarkup}</div>
      </div>

      <span class="voice-message-time">0:00</span>

      <button
        type="button"
        class="voice-message-speed"
        aria-label="Change playback speed"
      >1x</button>

      <div class="voice-message-volume-control">
        <button
          type="button"
          class="voice-message-volume"
          aria-label="Show volume control"
          aria-expanded="false"
        >
          <span class="icon-volume">${ICONS.volume}</span>
          <span class="icon-volume-mute" style="display:none">${ICONS.volumeMute}</span>
        </button>

        <div class="voice-message-volume-slider-wrap">
          <input
            type="range"
            class="voice-message-volume-slider"
            min="0"
            max="1"
            step="0.01"
            value="1"
            aria-label="Volume"
          >
        </div>
      </div>

      <div class="voice-message-error" aria-live="polite">${ICONS.alert} Failed to load voice message</div>

      <audio
        id="vaudio-${messageId}"
        preload="metadata"
      ></audio>
    </div>
  `;

  // Same insertion point as renderAudio(): inside the message's
  // content column, after the bubble/reply-quote, never as a sibling
  // of the avatar.
  const contentWrapper = container.querySelector('.chat-msg-content') || container;
  contentWrapper.insertAdjacentHTML('beforeend', template);

  const playerEl = contentWrapper.lastElementChild;
  const audio = playerEl ? playerEl.querySelector('audio') : null;

  if (!playerEl || !audio) {
    console.error('Voice message element not found after insertion for message:', msg.id);
    return;
  }

  const playBtn = playerEl.querySelector('.voice-message-play');
  const iconPlay = playerEl.querySelector('.icon-play');
  const iconPause = playerEl.querySelector('.icon-pause');
  const waveEl = playerEl.querySelector('.voice-message-wave');
  const fillEl = playerEl.querySelector('.voice-wave-fill');
  const timeEl = playerEl.querySelector('.voice-message-time');
  const speedBtn = playerEl.querySelector('.voice-message-speed');
  const volumeControlEl = playerEl.querySelector('.voice-message-volume-control');
  const volumeBtn = playerEl.querySelector('.voice-message-volume');
  const iconVolume = playerEl.querySelector('.icon-volume');
  const iconVolumeMute = playerEl.querySelector('.icon-volume-mute');
  const volumeSlider = playerEl.querySelector('.voice-message-volume-slider');
  const errorEl = playerEl.querySelector('.voice-message-error');

  // ====================================================
  // MEDIA LOADING / AUTH FALLBACK
  //
  // <audio src> can send the token in the query string, but some
  // browser/network paths are stricter about authenticated media
  // requests than normal fetch/XHR.  If the direct media request fails,
  // retry through fetchBlob(), which sends the exact same JWT in the
  // Authorization header used by the rest of the app, then hand the
  // authenticated Blob to <audio> via an object URL.
  //
  // This keeps normal playback range-streamed and lightweight when the
  // direct request works, while giving sender + receiver the same
  // authenticated fallback path when it does not.
  // ====================================================

  let fallbackAttempted = false;
  let blobObjectUrl = null;

  async function loadAuthenticatedFallback() {
    if (fallbackAttempted) return false;
    fallbackAttempted = true;

    try {
      const baseUrl =
        scope === 'dm'
          ? `/api/dm/attachments/${encodeURIComponent(msg.id)}`
          : `/api/chat/attachments/${encodeURIComponent(msg.id)}`;

      const blob = await fetchBlob(baseUrl);

      if (!document.body.contains(playerEl)) return false;

      if (blobObjectUrl) {
        URL.revokeObjectURL(blobObjectUrl);
      }

      blobObjectUrl = URL.createObjectURL(blob);
      audio.src = blobObjectUrl;
      audio.load();
      return true;
    } catch (error) {
      console.error('Authenticated voice fallback failed:', error);
      return false;
    }
  }

  // ====================================================
  // HELPERS
  // ====================================================

  const setLoading = (isLoading) => {
    playerEl.classList.toggle('loading', isLoading);
  };

  const updateProgress = () => {
    const duration = audio.duration;
    const pct =
      Number.isFinite(duration) && duration > 0
        ? Math.min(100, (audio.currentTime / duration) * 100)
        : 0;
    fillEl.style.width = `${pct}%`;
    waveEl.setAttribute('aria-valuenow', String(Math.round(pct)));
  };

  // Shows elapsed time while idle/playing, and total duration only
  // once metadata is known and playback hasn't started — mirrors how
  // most native chat voice-message bubbles greet you with the total
  // length before you've pressed play.
  const updateTimeLabel = () => {
    const duration = audio.duration;
    if (audio.currentTime > 0 || !(Number.isFinite(duration) && duration > 0)) {
      timeEl.textContent = formatTime(audio.currentTime);
    } else {
      timeEl.textContent = formatTime(duration);
    }
  };

  const updateVolumeIcon = () => {
    const isMuted = audio.muted || audio.volume === 0;
    iconVolume.style.display = isMuted ? 'none' : 'block';
    iconVolumeMute.style.display = isMuted ? 'block' : 'none';
  };

  const updateVolumeSliderFill = () => {
    const pct = Math.round(Number(volumeSlider.value) * 100);
    volumeSlider.style.background =
      `linear-gradient(to right, var(--message-accent, rgb(var(--indigo))) 0%, var(--message-accent, rgb(var(--indigo))) ${pct}%, var(--border-soft) ${pct}%, var(--border-soft) 100%)`;
  };

  const seekToRatio = (ratio) => {
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    audio.currentTime = Math.min(1, Math.max(0, ratio)) * duration;
    updateProgress();
    updateTimeLabel();
    saveVoiceState(messageId, audio, intendedPlaying, audio.playbackRate);
  };

  const seekToClientX = (clientX) => {
    const rect = waveEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekToRatio((clientX - rect.left) / rect.width);
  };

  // Initial slider fill (100%, matching the default value="1" in the
  // template) — before any saved state or user interaction happens.
  updateVolumeSliderFill();

  // ====================================================
  // PLAY / PAUSE
  //
  // Same `intendedPlaying` reasoning as audio-player.js: driven only
  // by explicit user action (or a successful auto-resume), never by
  // the element's own play/pause events — those also fire from
  // implicit browser behavior (e.g. teardown-via-innerHTML on
  // navigation), which is not the same thing as "the user paused it".
  // ====================================================

  let intendedPlaying = false;

  function play() {
    setActivePlayer(audio);
    intendedPlaying = true;
    audio.play().catch((error) => {
      intendedPlaying = false;
      console.error('Voice message playback failed:', error);
    });
  }

  function pause() {
    intendedPlaying = false;
    audio.pause();
  }

  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      play();
    } else {
      pause();
    }
  });

  audio.addEventListener('play', () => {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    playBtn.setAttribute('aria-label', 'Pause voice message');
    saveVoiceState(messageId, audio, intendedPlaying, audio.playbackRate);
  });

  audio.addEventListener('pause', () => {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    playBtn.setAttribute('aria-label', 'Play voice message');
    saveVoiceState(messageId, audio, intendedPlaying, audio.playbackRate);
  });

  // ====================================================
  // KEYBOARD (the waveform doubles as a slider — arrow keys nudge it)
  // ====================================================

  waveEl.addEventListener('keydown', (e) => {
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const step = 5 / duration; // ~5 seconds per key press, as a ratio
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      seekToRatio(audio.currentTime / duration + step);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      seekToRatio(audio.currentTime / duration - step);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      audio.paused ? play() : pause();
    }
  });

  // ====================================================
  // LOADING / METADATA
  // ====================================================

  setLoading(true);

  // Start with the normal streaming URL. If the browser cannot load it,
  // the error handler below retries through an authenticated fetch.
  audio.src = attachmentUrl;
  audio.load();

  const savedState = voicePlaybackState.get(messageId);

  audio.addEventListener('loadedmetadata', () => {
    setLoading(false);

    if (savedState) {
      const duration = audio.duration;
      audio.currentTime = Math.min(savedState.currentTime, duration || savedState.currentTime);
      audio.playbackRate = savedState.rate || 1;
      speedBtn.textContent = formatSpeed(audio.playbackRate);
      audio.muted = !!savedState.muted;
      audio.volume = typeof savedState.volume === 'number' ? savedState.volume : 1;
      volumeSlider.value = audio.muted ? 0 : audio.volume;
      updateVolumeSliderFill();
      updateVolumeIcon();

      if (savedState.playing) {
        setActivePlayer(audio);
        intendedPlaying = true;
        audio.play().catch((error) => {
          // Autoplay can be blocked without a recent user gesture —
          // fall back to paused-but-seeked-to-position.
          intendedPlaying = false;
          console.error('Voice message resume failed:', error);
        });
      }
    }

    updateProgress();
    updateTimeLabel();
  });

  audio.addEventListener('canplay', () => setLoading(false));

  // ====================================================
  // PROGRESS
  // ====================================================

  audio.addEventListener('timeupdate', () => {
    updateProgress();
    updateTimeLabel();
    saveVoiceState(messageId, audio, intendedPlaying, audio.playbackRate);
  });

  audio.addEventListener('ended', () => {
    intendedPlaying = false;
    // A message that finished naturally shouldn't "resume" mid-way
    // through the next time this player is rebuilt.
    voicePlaybackState.delete(messageId);
    audio.currentTime = 0;
    updateProgress();
    updateTimeLabel();
  });

  // ====================================================
  // SEEK (click / drag on the waveform)
  //
  // Same window-listener lifetime reasoning as audio-player.js's
  // waveform scrubbing: mousemove/mouseup are only ever attached for
  // the duration of an active drag (added on mousedown, removed on
  // the matching mouseup), so at most one pair is alive at a time
  // across every voice message ever rendered, rather than one
  // permanent pair per message.
  // ====================================================

  let scrubbing = false;

  function onWindowMouseMove(e) {
    if (!scrubbing) return;
    seekToClientX(e.clientX);
  }

  function onWindowMouseUp() {
    scrubbing = false;
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
  }

  waveEl.addEventListener('mousedown', (e) => {
    scrubbing = true;
    seekToClientX(e.clientX);
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
  });

  waveEl.addEventListener('click', (e) => {
    seekToClientX(e.clientX);
  });

  // Touch support (mobile) — separate from the mouse handlers above
  // since touch events don't fire mouse events on most browsers.
  waveEl.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches[0]) seekToClientX(e.touches[0].clientX);
    },
    { passive: true }
  );

  // ====================================================
  // SPEED
  // ====================================================

  speedBtn.addEventListener('click', () => {
    audio.playbackRate = nextSpeed(audio.playbackRate);
    speedBtn.textContent = formatSpeed(audio.playbackRate);
    saveVoiceState(messageId, audio, intendedPlaying, audio.playbackRate);
  });

  // ====================================================
  // VOLUME
  //
  // Clicking the icon no longer mutes instantly — it opens a compact
  // slider (matching the generic audio-player.css's expanding volume
  // control), which is what actually controls volume/mute. The time
  // label collapses out of the way while the slider is open (via the
  // .volume-open class below) to give it room without the player
  // overflowing or wrapping onto a second line — see voice-message.css.
  // ====================================================

  function openVolumePanel() {
    if (closeOpenVolumePanel && closeOpenVolumePanel !== closeThisPanel) {
      closeOpenVolumePanel();
    }

    playerEl.classList.add('volume-open');
    volumeControlEl.classList.add('open');
    volumeBtn.setAttribute('aria-expanded', 'true');

    // Only attached while open, and only one instance system-wide —
    // see the closeOpenVolumePanel module comment above.
    document.addEventListener('mousedown', onOutsideClick, true);
    document.addEventListener('touchstart', onOutsideClick, true);

    closeOpenVolumePanel = closeThisPanel;
  }

  function closeThisPanel() {
    playerEl.classList.remove('volume-open');
    volumeControlEl.classList.remove('open');
    volumeBtn.setAttribute('aria-expanded', 'false');

    document.removeEventListener('mousedown', onOutsideClick, true);
    document.removeEventListener('touchstart', onOutsideClick, true);

    if (closeOpenVolumePanel === closeThisPanel) {
      closeOpenVolumePanel = null;
    }
  }

  function onOutsideClick(e) {
    if (!volumeControlEl.contains(e.target)) {
      closeThisPanel();
    }
  }

  volumeBtn.addEventListener('click', () => {
    if (volumeControlEl.classList.contains('open')) {
      closeThisPanel();
    } else {
      openVolumePanel();
    }
  });

  volumeBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && volumeControlEl.classList.contains('open')) {
      closeThisPanel();
    }
  });

  volumeSlider.addEventListener('input', () => {
    const volume = Number(volumeSlider.value);
    audio.volume = volume;
    audio.muted = volume === 0;
    updateVolumeSliderFill();
    updateVolumeIcon();
    saveVoiceState(messageId, audio, intendedPlaying, audio.playbackRate);
  });

  volumeSlider.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeThisPanel();
  });

  // ====================================================
  // ERRORS
  // ====================================================

  audio.addEventListener('error', async () => {
    setLoading(false);

    const error = audio.error;
    console.error('Voice message error:', {
      code: error?.code,
      message: error?.message,
      src: audio.currentSrc,
    });

    // First failure may simply be the browser refusing the media
    // element's token-authenticated request. Retry with fetch(), which
    // can send Authorization: Bearer <token> explicitly.
    if (!blobObjectUrl) {
      setLoading(true);
      const recovered = await loadAuthenticatedFallback();
      if (recovered) {
        errorEl.style.display = 'none';
        return;
      }
      setLoading(false);
    }

    errorEl.style.display = 'flex';
  });
}
