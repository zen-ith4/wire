// ============================================================
// Voice message player
// ------------------------------------------------------------
// Deliberately a SEPARATE component from audio-player.js (the
// generic uploaded-audio-file player). Voice messages share the
// message/attachment/upload/streaming infrastructure with normal
// audio attachments (see attachments.js) but get their own compact,
// native-chat-app-style UI here — a single row with a play button,
// a lightweight generated waveform doubling as the seek bar,
// current/total time, and a playback-speed toggle.
// ============================================================

import { ICONS } from '../icons.js';
import { escapeAttr } from '../core/utils.js';
import { getMediaSrcUrl } from './mediaToken.js';
import { resolveServerUrl } from '../core/server.js';

// ======================================================
// DETECTION
// ======================================================

export function isVoiceMessage(msg) {
  return !!(
    msg &&
    msg.is_voice_message &&
    typeof msg.attachment_mime === 'string' &&
    msg.attachment_mime.startsWith('audio/')
  );
}

// ======================================================
// PLAYBACK STATE PERSISTENCE
// ======================================================

const voicePlaybackState = new Map();

function saveVoiceState(messageId, audio, playing, rate) {
  const currentTime = Number.isFinite(audio.currentTime)
    ? Math.max(0, audio.currentTime)
    : 0;

  const volume = Number.isFinite(audio.volume)
    ? Math.min(1, Math.max(0, audio.volume))
    : 1;

  voicePlaybackState.set(messageId, {
    currentTime,
    playing: !!playing,
    rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
    muted: !!audio.muted,
    volume,
  });
}

// ======================================================
// SINGLE ACTIVE PLAYER
// ======================================================

let activeAudioEl = null;

function setActivePlayer(audio) {
  if (
    activeAudioEl &&
    activeAudioEl !== audio &&
    !activeAudioEl.paused
  ) {
    try {
      activeAudioEl.pause();
    } catch {
      // The previous element may already have been detached.
    }
  }

  activeAudioEl = audio;
}

// ======================================================
// SINGLE OPEN VOLUME PANEL
// ======================================================

let closeOpenVolumePanel = null;

// ======================================================
// WAVEFORM
// ======================================================

const BAR_COUNT = 32;

function seededBars(seed, count) {
  let state = (Number(seed) >>> 0) || 1;

  function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;

    let t = Math.imul(
      state ^ (state >>> 15),
      1 | state
    );

    t = (
      t +
      Math.imul(
        t ^ (t >>> 7),
        61 | t
      )
    ) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const bars = [];

  for (let i = 0; i < count; i++) {
    bars.push(Math.round(25 + next() * 70));
  }

  return bars;
}

function barsHtml(bars) {
  return bars
    .map(
      (height) =>
        `<span class="voice-wave-bar" style="height:${height}%"></span>`
    )
    .join('');
}

// ======================================================
// PLAYBACK SPEED
// ======================================================

const SPEED_STEPS = [1, 1.25, 1.5, 2];

function nextSpeed(current) {
  const normalized = Number(current);

  const idx = SPEED_STEPS.indexOf(normalized);

  if (idx === -1) {
    return 1;
  }

  return SPEED_STEPS[(idx + 1) % SPEED_STEPS.length];
}

function formatSpeed(rate) {
  const value = Number(rate);

  if (!Number.isFinite(value) || value <= 0) {
    return '1x';
  }

  return `${value % 1 === 0 ? value.toFixed(0) : value}x`;
}

// ======================================================
// TIME FORMAT
// ======================================================

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    seconds = 0;
  }

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

export async function renderVoiceMessage(msg, scope, containerEl) {
  const messageId = String(msg.id);

  const container =
    containerEl ||
    document.querySelector(
      `.chat-msg[data-msg-id="${CSS.escape(messageId)}"]`
    );

  if (!container) {
    console.error(
      'Voice message container not found for message:',
      msg.id
    );
    return;
  }

  const playerId = `vplayer-${messageId}`;

  // Prevent duplicate players.
  if (
    container.querySelector(
      `#${CSS.escape(playerId)}`
    )
  ) {
    return;
  }

  let attachmentUrl;

  try {
    /*
     * IMPORTANT:
     *
     * getMediaSrcUrl() may return a relative API path such as:
     *
     *   /api/dm/attachments/19?token=...
     *
     * In Capacitor's WebView the page origin is:
     *
     *   https://localhost
     *
     * Therefore assigning that relative URL directly to <audio>
     * makes WebView try to load:
     *
     *   https://localhost/api/dm/attachments/19?token=...
     *
     * which is a local Capacitor asset URL and not our backend.
     *
     * Always resolve the final media URL against the configured
     * server endpoint before giving it to the native <audio>
     * element.
     */
    const mediaUrl = await getMediaSrcUrl(
      scope,
      msg.id
    );

    attachmentUrl = resolveServerUrl(
      mediaUrl
    );
  } catch (error) {
    console.error(
      'Failed to resolve voice attachment URL:',
      error
    );
    return;
  }

  // The container may have been removed while awaiting the token.
  if (
    !document.body.contains(container) ||
    container.querySelector(
      `#${CSS.escape(playerId)}`
    )
  ) {
    return;
  }

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

      <div class="voice-message-error" aria-live="polite">
        ${ICONS.alert}
        <span class="voice-message-error-text">
          Failed to load voice message
        </span>
      </div>

      <audio
        id="vaudio-${escapeAttr(messageId)}"
        preload="metadata"
        src="${escapeAttr(attachmentUrl)}"
      ></audio>
    </div>
  `;

  const contentWrapper =
    container.querySelector('.chat-msg-content') ||
    container;

  contentWrapper.insertAdjacentHTML(
    'beforeend',
    template
  );

  const playerEl = contentWrapper.lastElementChild;
  const audio = playerEl
    ? playerEl.querySelector('audio')
    : null;

  if (!playerEl || !audio) {
    console.error(
      'Voice message element not found after insertion for message:',
      msg.id
    );
    return;
  }

  const playBtn = playerEl.querySelector(
    '.voice-message-play'
  );

  const iconPlay = playerEl.querySelector(
    '.icon-play'
  );

  const iconPause = playerEl.querySelector(
    '.icon-pause'
  );

  const waveEl = playerEl.querySelector(
    '.voice-message-wave'
  );

  const fillEl = playerEl.querySelector(
    '.voice-wave-fill'
  );

  const timeEl = playerEl.querySelector(
    '.voice-message-time'
  );

  const speedBtn = playerEl.querySelector(
    '.voice-message-speed'
  );

  const volumeControlEl = playerEl.querySelector(
    '.voice-message-volume-control'
  );

  const volumeBtn = playerEl.querySelector(
    '.voice-message-volume'
  );

  const iconVolume = playerEl.querySelector(
    '.icon-volume'
  );

  const iconVolumeMute = playerEl.querySelector(
    '.icon-volume-mute'
  );

  const volumeSlider = playerEl.querySelector(
    '.voice-message-volume-slider'
  );

  const errorEl = playerEl.querySelector(
    '.voice-message-error'
  );

  const errorTextEl = playerEl.querySelector(
    '.voice-message-error-text'
  );

  // ====================================================
  // HELPERS
  // ====================================================

  const setLoading = (isLoading) => {
    playerEl.classList.toggle(
      'loading',
      !!isLoading
    );
  };

  function setPlayerState(state) {
    playerEl.dataset.state = state;

    setLoading(state === 'loading');

    if (state !== 'error') {
      errorEl.style.display = 'none';
    }
  }

  setPlayerState('idle');

  // ====================================================
  // PROGRESS
  // ====================================================

  let rafId = null;

  function startProgressLoop() {
    if (rafId !== null) {
      return;
    }

    const tick = () => {
      if (
        !document.body.contains(playerEl) ||
        audio.paused ||
        audio.ended
      ) {
        rafId = null;
        return;
      }

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
    const currentTime = Number.isFinite(audio.currentTime)
      ? Math.max(0, audio.currentTime)
      : 0;

    const pct =
      Number.isFinite(duration) &&
      duration > 0
        ? Math.min(
            100,
            Math.max(
              0,
              (currentTime / duration) * 100
            )
          )
        : 0;

    fillEl.style.width = `${pct}%`;

    waveEl.setAttribute(
      'aria-valuenow',
      String(Math.round(pct))
    );
  };

  const updateTimeLabel = () => {
    const duration = audio.duration;
    const currentTime = Number.isFinite(audio.currentTime)
      ? Math.max(0, audio.currentTime)
      : 0;

    if (
      currentTime > 0 ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      timeEl.textContent = formatTime(currentTime);
    } else {
      timeEl.textContent = formatTime(duration);
    }
  };

  const updateVolumeIcon = () => {
    const isMuted =
      audio.muted ||
      audio.volume === 0;

    iconVolume.style.display = isMuted
      ? 'none'
      : 'block';

    iconVolumeMute.style.display = isMuted
      ? 'block'
      : 'none';
  };

  const updateVolumeSliderFill = () => {
    const rawValue = Number(
      volumeSlider.value
    );

    const pct = Math.round(
      Math.min(1, Math.max(0, rawValue)) * 100
    );

    volumeSlider.style.background =
      `linear-gradient(to right, ` +
      `var(--message-accent, rgb(var(--indigo))) 0%, ` +
      `var(--message-accent, rgb(var(--indigo))) ${pct}%, ` +
      `var(--border-soft) ${pct}%, ` +
      `var(--border-soft) 100%)`;
  };

  // ====================================================
  // PLAYBACK STATE
  // ====================================================

  let intendedPlaying = false;

  const seekToRatio = (ratio) => {
    const duration = audio.duration;

    if (
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      return;
    }

    const normalizedRatio = Math.min(
      1,
      Math.max(0, Number(ratio) || 0)
    );

    const targetTime =
      normalizedRatio * duration;

    if (!Number.isFinite(targetTime)) {
      return;
    }

    try {
      audio.currentTime = targetTime;
    } catch (error) {
      console.warn(
        'Voice message seek failed:',
        error
      );
      return;
    }

    updateProgress();
    updateTimeLabel();

    saveVoiceState(
      messageId,
      audio,
      intendedPlaying,
      audio.playbackRate
    );
  };

  const seekToClientX = (clientX) => {
    const rect =
      waveEl.getBoundingClientRect();

    if (
      !rect ||
      rect.width <= 0 ||
      !Number.isFinite(clientX)
    ) {
      return;
    }

    seekToRatio(
      (clientX - rect.left) /
        rect.width
    );
  };

  // Initial volume UI.
  updateVolumeSliderFill();
  updateVolumeIcon();

  function play() {
    setActivePlayer(audio);

    intendedPlaying = true;

    const promise = audio.play();

    if (promise && typeof promise.catch === 'function') {
      promise.catch((error) => {
        intendedPlaying = false;

        console.error(
          'Voice message playback failed:',
          error
        );
      });
    }
  }

  function pause() {
    intendedPlaying = false;

    try {
      audio.pause();
    } catch (error) {
      console.warn(
        'Voice message pause failed:',
        error
      );
    }
  }

  // ====================================================
  // PLAY / PAUSE EVENTS
  // ====================================================

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

    playBtn.setAttribute(
      'aria-label',
      'Pause voice message'
    );

    saveVoiceState(
      messageId,
      audio,
      intendedPlaying,
      audio.playbackRate
    );
  });

  audio.addEventListener('playing', () => {
    setPlayerState('playing');

    startProgressLoop();

    networkRetryCount = 0;
  });

  audio.addEventListener('waiting', () => {
    if (intendedPlaying) {
      setPlayerState('loading');
    }

    stopProgressLoop();
  });

  audio.addEventListener('pause', () => {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';

    playBtn.setAttribute(
      'aria-label',
      'Play voice message'
    );

    stopProgressLoop();

    if (!audio.ended) {
      setPlayerState('paused');
    }

    updateProgress();
    updateTimeLabel();

    saveVoiceState(
      messageId,
      audio,
      intendedPlaying,
      audio.playbackRate
    );

    if (activeAudioEl === audio) {
      activeAudioEl = null;
    }
  });

  // ====================================================
  // KEYBOARD SEEK
  // ====================================================

  waveEl.addEventListener('keydown', (event) => {
    const duration = audio.duration;

    if (
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      return;
    }

    const step = 5 / duration;

    if (
      event.key === 'ArrowRight' ||
      event.key === 'ArrowUp'
    ) {
      event.preventDefault();

      seekToRatio(
        audio.currentTime / duration +
          step
      );
    } else if (
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowDown'
    ) {
      event.preventDefault();

      seekToRatio(
        audio.currentTime / duration -
          step
      );
    } else if (
      event.key === ' ' ||
      event.key === 'Enter'
    ) {
      event.preventDefault();

      if (audio.paused) {
        play();
      } else {
        pause();
      }
    }
  });

  // ====================================================
  // LOADING / METADATA
  // ====================================================

  setPlayerState('loading');

  const savedState =
    voicePlaybackState.get(messageId);

  /*
   * IMPORTANT ANDROID WEBVIEW FIX
   *
   * MediaRecorder voice messages can be WebM/Opus files whose
   * container does not contain a final duration.
   *
   * Chromium may initially expose:
   *
   *     audio.duration === Infinity
   *
   * The old implementation attempted to force duration
   * resolution with:
   *
   *     audio.currentTime = 1e101;
   *
   * That is not safe on Android WebView and can throw a
   * DOMException.
   *
   * We deliberately never assign an absurd/non-finite seek
   * position. Instead we wait for durationchange and give the
   * browser a short amount of time to resolve the metadata.
   *
   * If the browser still cannot determine the duration, we
   * gracefully continue without crashing. Playback itself can
   * still work, and the duration will be updated later if the
   * browser discovers it during playback.
   */

  function resolveRealDuration(done) {
    if (Number.isFinite(audio.duration)) {
      done(true);
      return;
    }

    let finished = false;

    const finish = (resolved) => {
      if (finished) {
        return;
      }

      finished = true;

      audio.removeEventListener(
        'durationchange',
        onDurationChange
      );

      clearTimeout(timeoutId);

      done(resolved);
    };

    const onDurationChange = () => {
      if (Number.isFinite(audio.duration)) {
        finish(true);
      }
    };

    audio.addEventListener(
      'durationchange',
      onDurationChange
    );

    const timeoutId = setTimeout(() => {
      finish(
        Number.isFinite(audio.duration)
      );
    }, 1500);
  }

  audio.addEventListener(
    'loadedmetadata',
    () => {
      resolveRealDuration(() => {
        if (!document.body.contains(playerEl)) {
          return;
        }

        setPlayerState('idle');

        if (savedState) {
          const duration = audio.duration;

          let restoreTime =
            Number.isFinite(
              savedState.currentTime
            )
              ? Math.max(
                  0,
                  savedState.currentTime
                )
              : 0;

          // Only seek when the duration is actually known.
          // Never assign currentTime using Infinity/NaN.
          if (
            Number.isFinite(duration) &&
            duration > 0
          ) {
            restoreTime = Math.min(
              restoreTime,
              duration
            );

            try {
              audio.currentTime =
                restoreTime;
            } catch (error) {
              console.warn(
                'Failed to restore voice message position:',
                error
              );
            }
          }

          const savedRate =
            Number.isFinite(
              savedState.rate
            ) &&
            savedState.rate > 0
              ? savedState.rate
              : 1;

          audio.playbackRate =
            SPEED_STEPS.includes(
              savedRate
            )
              ? savedRate
              : 1;

          speedBtn.textContent =
            formatSpeed(
              audio.playbackRate
            );

          audio.muted =
            !!savedState.muted;

          audio.volume =
            typeof savedState.volume ===
              'number' &&
            Number.isFinite(
              savedState.volume
            )
              ? Math.min(
                  1,
                  Math.max(
                    0,
                    savedState.volume
                  )
                )
              : 1;

          volumeSlider.value =
            audio.muted
              ? '0'
              : String(audio.volume);

          updateVolumeSliderFill();
          updateVolumeIcon();

          if (savedState.playing) {
            setActivePlayer(audio);

            intendedPlaying = true;

            const promise =
              audio.play();

            if (
              promise &&
              typeof promise.catch ===
                'function'
            ) {
              promise.catch((error) => {
                intendedPlaying = false;

                console.error(
                  'Voice message resume failed:',
                  error
                );
              });
            }
          }
        }

        updateProgress();
        updateTimeLabel();
      });
    }
  );

  // If metadata is still unresolved, canplay is a useful fallback
  // for browsers/WebViews that provide enough information to play
  // even while duration remains Infinity.
  audio.addEventListener('canplay', () => {
    if (
      playerEl.dataset.state ===
      'loading'
    ) {
      setPlayerState('idle');
    }

    updateProgress();
    updateTimeLabel();
  });

  // ====================================================
  // PROGRESS
  // ====================================================

  audio.addEventListener(
    'timeupdate',
    () => {
      updateProgress();
      updateTimeLabel();

      saveVoiceState(
        messageId,
        audio,
        intendedPlaying,
        audio.playbackRate
      );
    }
  );

  audio.addEventListener('durationchange', () => {
    updateProgress();
    updateTimeLabel();
  });

  audio.addEventListener('ended', () => {
    intendedPlaying = false;

    stopProgressLoop();

    setPlayerState('ended');

    // A naturally completed message should start from zero next time.
    voicePlaybackState.delete(messageId);

    try {
      audio.currentTime = 0;
    } catch {
      // Some media implementations can reject seeking immediately
      // after ended. The UI is still reset below.
    }

    updateProgress();
    updateTimeLabel();

    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';

    playBtn.setAttribute(
      'aria-label',
      'Play voice message'
    );

    if (activeAudioEl === audio) {
      activeAudioEl = null;
    }
  });

  // ====================================================
  // SEEK
  // ====================================================

  let scrubbing = false;

  function onWindowMouseMove(event) {
    if (!scrubbing) {
      return;
    }

    seekToClientX(event.clientX);
  }

  function onWindowMouseUp(event) {
    if (!scrubbing) {
      return;
    }

    if (event && Number.isFinite(event.clientX)) {
      seekToClientX(event.clientX);
    }

    scrubbing = false;

    window.removeEventListener(
      'mousemove',
      onWindowMouseMove
    );

    window.removeEventListener(
      'mouseup',
      onWindowMouseUp
    );
  }

  waveEl.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0) {
        return;
      }

      scrubbing = true;

      seekToClientX(event.clientX);

      window.addEventListener(
        'mousemove',
        onWindowMouseMove
      );

      window.addEventListener(
        'mouseup',
        onWindowMouseUp
      );
    }
  );

  waveEl.addEventListener(
    'click',
    (event) => {
      // A click following a mouse drag is harmless because
      // seekToClientX simply applies the same final position.
      seekToClientX(event.clientX);
    }
  );

  waveEl.addEventListener(
    'touchstart',
    (event) => {
      if (
        event.touches &&
        event.touches[0]
      ) {
        seekToClientX(
          event.touches[0].clientX
        );
      }
    },
    { passive: true }
  );

  // ====================================================
  // SPEED
  // ====================================================

  speedBtn.addEventListener(
    'click',
    () => {
      audio.playbackRate =
        nextSpeed(
          audio.playbackRate
        );

      speedBtn.textContent =
        formatSpeed(
          audio.playbackRate
        );

      saveVoiceState(
        messageId,
        audio,
        intendedPlaying,
        audio.playbackRate
      );
    }
  );

  // ====================================================
  // VOLUME
  // ====================================================

  function openVolumePanel() {
    if (
      closeOpenVolumePanel &&
      closeOpenVolumePanel !==
        closeThisPanel
    ) {
      closeOpenVolumePanel();
    }

    playerEl.classList.add(
      'volume-open'
    );

    volumeControlEl.classList.add(
      'open'
    );

    volumeBtn.setAttribute(
      'aria-expanded',
      'true'
    );

    document.addEventListener(
      'mousedown',
      onOutsideClick,
      true
    );

    document.addEventListener(
      'touchstart',
      onOutsideClick,
      true
    );

    closeOpenVolumePanel =
      closeThisPanel;
  }

  function closeThisPanel() {
    playerEl.classList.remove(
      'volume-open'
    );

    volumeControlEl.classList.remove(
      'open'
    );

    volumeBtn.setAttribute(
      'aria-expanded',
      'false'
    );

    document.removeEventListener(
      'mousedown',
      onOutsideClick,
      true
    );

    document.removeEventListener(
      'touchstart',
      onOutsideClick,
      true
    );

    if (
      closeOpenVolumePanel ===
      closeThisPanel
    ) {
      closeOpenVolumePanel = null;
    }
  }

  function onOutsideClick(event) {
    if (
      !volumeControlEl.contains(
        event.target
      )
    ) {
      closeThisPanel();
    }
  }

  volumeBtn.addEventListener(
    'click',
    () => {
      if (
        volumeControlEl.classList.contains(
          'open'
        )
      ) {
        closeThisPanel();
      } else {
        openVolumePanel();
      }
    }
  );

  volumeBtn.addEventListener(
    'keydown',
    (event) => {
      if (
        event.key === 'Escape' &&
        volumeControlEl.classList.contains(
          'open'
        )
      ) {
        closeThisPanel();
      }
    }
  );

  volumeSlider.addEventListener(
    'input',
    () => {
      const volume = Number(
        volumeSlider.value
      );

      if (!Number.isFinite(volume)) {
        return;
      }

      audio.volume = Math.min(
        1,
        Math.max(0, volume)
      );

      audio.muted =
        audio.volume === 0;

      updateVolumeSliderFill();
      updateVolumeIcon();

      saveVoiceState(
        messageId,
        audio,
        intendedPlaying,
        audio.playbackRate
      );
    }
  );

  volumeSlider.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        closeThisPanel();
      }
    }
  );

  // ====================================================
  // ERRORS
  // ====================================================

  function stripToken(url) {
    try {
      return String(url).split('?')[0];
    } catch {
      return '';
    }
  }

  async function diagnoseAndShowError(
    mediaError
  ) {
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
      url: stripToken(
        attachmentUrl
      ),
      hadAuthToken:
        attachmentUrl.includes(
          'token='
        ),
    };

    let userMessage =
      'Failed to load voice message';

    try {
      const resp = await fetch(
        resolveServerUrl(
          attachmentUrl
        ),
        {
          headers: {
            Range: 'bytes=0-1',
          },
        }
      );

      diagnostics.httpStatus =
        resp.status;

      diagnostics.contentType =
        resp.headers.get(
          'content-type'
        );

      if (resp.status === 401) {
        userMessage =
          'Your session has expired — refresh the page and sign in again';
      } else if (resp.status === 403) {
        userMessage =
          "You don't have permission to view this voice message";
      } else if (resp.status === 404) {
        userMessage =
          'This voice message is no longer available';
      } else if (resp.status >= 500) {
        userMessage =
          'The server had a problem loading this voice message';
      } else if (
        resp.ok &&
        diagnostics.contentType &&
        !diagnostics.contentType.startsWith(
          'audio/'
        )
      ) {
        userMessage =
          'This voice message could not be loaded (unexpected file type)';
      } else if (code === 4) {
        userMessage =
          "This voice message's audio format isn't supported in this browser";
      } else if (code === 3) {
        userMessage =
          "This voice message's audio data could not be decoded";
      } else if (code === 2) {
        userMessage =
          'Network error while loading this voice message';
      }
    } catch (fetchError) {
      diagnostics.diagnosticFetchError =
        fetchError?.message;

      if (code === 4) {
        userMessage =
          "This voice message's audio format isn't supported in this browser";
      } else if (code === 3) {
        userMessage =
          "This voice message's audio data could not be decoded";
      } else if (code === 2) {
        userMessage =
          'Network error while loading this voice message';
      }
    }

    console.error(
      'Voice message playback failed:',
      diagnostics
    );

    errorTextEl.textContent =
      userMessage;

    errorEl.style.display = 'flex';
  }

  // ====================================================
  // TRANSIENT NETWORK ERROR RETRY
  // ====================================================

  const MAX_NETWORK_RETRIES = 2;

  let networkRetryCount = 0;
  let networkRetryTimer = null;

  audio.addEventListener('error', () => {
    stopProgressLoop();

    const mediaError =
      audio.error;

    if (
      mediaError?.code === 2 &&
      networkRetryCount <
        MAX_NETWORK_RETRIES
    ) {
      networkRetryCount += 1;

      const rawCurrentTime =
        audio.currentTime;

      const resumeAt =
        Number.isFinite(
          rawCurrentTime
        )
          ? Math.max(
              0,
              rawCurrentTime
            )
          : 0;

      const wasPlaying =
        intendedPlaying;

      setPlayerState('loading');

      if (networkRetryTimer !== null) {
        clearTimeout(
          networkRetryTimer
        );
      }

      networkRetryTimer =
        setTimeout(() => {
          networkRetryTimer = null;

          if (
            !document.body.contains(
              playerEl
            )
          ) {
            return;
          }

          /*
           * Register loadedmetadata BEFORE load().
           *
           * This avoids a race where WebView manages to emit
           * loadedmetadata synchronously/very quickly after load()
           * and our listener would otherwise miss it.
           */
          const onRetryMetadata =
            () => {
              const duration =
                audio.duration;

              if (
                Number.isFinite(
                  resumeAt
                ) &&
                Number.isFinite(
                  duration
                ) &&
                duration > 0
              ) {
                const target =
                  Math.min(
                    resumeAt,
                    duration
                  );

                try {
                  audio.currentTime =
                    target;
                } catch (error) {
                  console.warn(
                    'Failed to restore voice message position after retry:',
                    error
                  );
                }
              }

              if (wasPlaying) {
                play();
              } else {
                updateProgress();
                updateTimeLabel();
              }
            };

          audio.addEventListener(
            'loadedmetadata',
            onRetryMetadata,
            { once: true }
          );

          try {
            audio.load();
          } catch (error) {
            console.error(
              'Voice message retry load failed:',
              error
            );

            audio.removeEventListener(
              'loadedmetadata',
              onRetryMetadata
            );

            setPlayerState(
              'error'
            );

            diagnoseAndShowError(
              audio.error
            );
          }
        }, 800 * networkRetryCount);

      return;
    }

    setPlayerState('error');

    diagnoseAndShowError(
      mediaError
    );
  });

  // ====================================================
  // INITIAL AUDIO STATE
  // ====================================================

  audio.playbackRate = 1;
  audio.volume = 1;
  audio.muted = false;

  updateVolumeSliderFill();
  updateVolumeIcon();
  updateProgress();
  updateTimeLabel();
}
