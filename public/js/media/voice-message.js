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

      <div class="voice-message-error" aria-live="polite">${ICONS.alert} <span class="voice-message-error-text">Failed to load voice message</span></div>

      <audio
        id="vaudio-${messageId}"
        preload="metadata"
        src="${escapeAttr(attachmentUrl)}"
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
  const errorTextEl = playerEl.querySelector('.voice-message-error-text');

  // ====================================================
  // HELPERS
  // ====================================================

  const setLoading = (isLoading) => {
    playerEl.classList.toggle('loading', isLoading);
  };

  // ====================================================
  // EXPLICIT PLAYBACK STATE
  //
  // "the audio element exists" is not the same thing as "audio is
  // playable" — track a real state machine (idle/loading/playing/
  // paused/ended/error) as a data attribute, both for CSS hooks and
  // so nothing downstream has to infer state from a mix of
  // audio.paused/audio.error/loading-class checks.
  // ====================================================

  function setPlayerState(state) {
    playerEl.dataset.state = state;
    setLoading(state === 'loading');
    // A later successful load (e.g. after a manual retry / reconnect)
    // should clear a previously-shown error rather than leave it
    // stuck on screen forever.
    if (state !== 'error') errorEl.style.display = 'none';
  }

  setPlayerState('idle');

  // ====================================================
  // SMOOTH PROGRESS (requestAnimationFrame)
  //
  // `timeupdate` only fires a handful of times per second (and can be
  // throttled further by the browser), which — combined with any CSS
  // transition on the fill bar — is what produced the old "jumps
  // once a second" look. While actually playing, drive the fill/time
  // label from a rAF loop instead, reading audio.currentTime directly
  // every frame; `timeupdate` is kept only as the source of truth for
  // state-saving and as a fallback for the (rare) ticks where a frame
  // is skipped, not as the primary progress driver.
  // ====================================================

  let rafId = null;

  function startProgressLoop() {
    if (rafId !== null) return;
    const tick = () => {
      updateProgress();
      updateTimeLabel();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopProgressLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

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

  // `play` fires the instant .play() is called — before any audio
  // data has necessarily arrived. `playing` only fires once playback
  // is actually, audibly advancing (initial buffering done, or
  // recovered from a stall) — that's the real "progress can now move"
  // signal, not `play`. Driving the rAF loop off `play` alone is what
  // made a slow/buffering connection look frozen: icon flips to pause
  // immediately, nothing visibly moves for a few seconds, no
  // indication why.
  audio.addEventListener('playing', () => {
    setPlayerState('playing');
    startProgressLoop();
  });

  // Fires whenever playback stalls for lack of buffered data — both
  // the initial press-play buffering gap AND any mid-playback rebuffer
  // on a slow connection. Shown as the same loading state as initial
  // load, so there's a visible reason for the pause instead of a
  // silently frozen progress bar.
  audio.addEventListener('waiting', () => {
    if (intendedPlaying) setPlayerState('loading');
    stopProgressLoop();
  });

  audio.addEventListener('pause', () => {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    playBtn.setAttribute('aria-label', 'Play voice message');
    stopProgressLoop();
    // 'pause' also fires on 'ended', which sets its own state right
    // after — don't stomp that with 'paused' here.
    if (!audio.ended) setPlayerState('paused');
    // Final sync so the fill/time land exactly on the paused position
    // rather than wherever the last rAF frame happened to be.
    updateProgress();
    updateTimeLabel();
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

  setPlayerState('loading');

  const savedState = voicePlaybackState.get(messageId);

  audio.addEventListener('loadedmetadata', () => {
    // Metadata resolved and the file is confirmed playable — back to
    // idle (not yet played) unless the resume-from-saved-state logic
    // below immediately starts it again.
    setPlayerState('idle');

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

  // Fallback only: on a fresh load with no saved state, if `canplay`
  // somehow fires before `loadedmetadata` finished handling loading
  // state (rare, but not spec-guaranteed ordering across browsers),
  // make sure we're not stuck showing the loading spinner forever.
  audio.addEventListener('canplay', () => {
    if (playerEl.dataset.state === 'loading') setPlayerState('idle');
  });

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
    stopProgressLoop();
    setPlayerState('ended');
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

  // MediaError.code is the ONE signal the <audio> element itself
  // gives us, and it's ambiguous by design: MEDIA_ERR_SRC_NOT_SUPPORTED
  // (4) fires both for "this browser can't decode this codec" AND for
  // "the network request never returned a valid media body at all"
  // (e.g. the server sent back a 401/403/404/500 JSON error instead
  // of audio — HTMLMediaElement has no separate error code for that).
  // Those are different bugs with different fixes, so on error we do
  // one extra plain fetch() of the same URL purely to read its real
  // HTTP status/Content-Type and tell the two apart — never to
  // re-render or replace the audio element itself.
  function stripToken(url) {
    return url.split('?')[0];
  }

  async function diagnoseAndShowError(mediaError) {
    const code = mediaError?.code;
    const diagnostics = {
      messageId,
      mediaErrorCode: code,
      mediaErrorName:
        {
          1: 'MEDIA_ERR_ABORTED',
          2: 'MEDIA_ERR_NETWORK',
          3: 'MEDIA_ERR_DECODE',
          4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
        }[code] || 'unknown',
      url: stripToken(attachmentUrl),
      hadAuthToken: !!getMediaToken(),
    };

    let userMessage = 'Failed to load voice message';

    try {
      // A tiny ranged request — just enough to see real status/headers
      // without re-downloading the file.
      const resp = await fetch(attachmentUrl, {
        headers: { Range: 'bytes=0-1' },
      });

      diagnostics.httpStatus = resp.status;
      diagnostics.contentType = resp.headers.get('content-type');

      if (resp.status === 401) {
        userMessage = 'Your session has expired — refresh the page and sign in again';
      } else if (resp.status === 403) {
        userMessage = "You don't have permission to view this voice message";
      } else if (resp.status === 404) {
        userMessage = 'This voice message is no longer available';
      } else if (resp.status >= 500) {
        userMessage = 'The server had a problem loading this voice message';
      } else if (
        resp.ok &&
        diagnostics.contentType &&
        !diagnostics.contentType.startsWith('audio/')
      ) {
        // Got a real 2xx, but not actually audio — a strong sign the
        // stored attachment_mime/path is wrong server-side, not a
        // browser codec problem.
        userMessage = 'This voice message could not be loaded (unexpected file type)';
      } else if (code === 4) {
        // Got a normal audio response back, so this really is a
        // codec/container the current browser can't decode — the
        // sender's browser recorded it in a format this one doesn't
        // support playing back.
        userMessage = "This voice message's audio format isn't supported in this browser";
      } else if (code === 2) {
        userMessage = 'Network error while loading this voice message';
      }
    } catch (fetchErr) {
      diagnostics.diagnosticFetchError = fetchErr?.message;
      if (code === 4) {
        userMessage = "This voice message's audio format isn't supported in this browser";
      } else if (code === 2) {
        userMessage = 'Network error while loading this voice message';
      }
    }

    // Never log the token itself — stripToken() above already removed
    // it from the URL, and nothing else here touches localStorage's
    // raw value.
    console.error('Voice message playback failed:', diagnostics);

    errorTextEl.textContent = userMessage;
    errorEl.style.display = 'flex';
  }

  audio.addEventListener('error', () => {
    stopProgressLoop();
    setPlayerState('error');
    diagnoseAndShowError(audio.error);
  });
}
