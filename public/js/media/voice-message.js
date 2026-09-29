// ============================================================
// Voice message player
// ------------------------------------------------------------
// Separate compact player for voice messages.
//
// Waveform:
// - Deterministic per-message bars.
// - Rendered to a canvas instead of dozens of DOM elements.
// - Does not block the player from appearing while the media URL
//   is being resolved.
// ============================================================

import { ICONS } from '../icons.js';
import { getMediaSrcUrl, refreshMediaSrcUrl } from './mediaToken.js';
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
      // Previous element may already be detached.
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

function drawWaveform(
  canvas,
  bars,
  progress = 0,
  colors = null
) {
  if (
    !canvas ||
    !Array.isArray(bars) ||
    bars.length === 0
  ) {
    return;
  }

  const rect = canvas.getBoundingClientRect();

  if (
    !rect ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return;
  }

  const dpr = Math.max(
    1,
    Math.min(
      3,
      window.devicePixelRatio || 1
    )
  );

  const width = Math.max(
    1,
    Math.round(rect.width * dpr)
  );

  const height = Math.max(
    1,
    Math.round(rect.height * dpr)
  );

  if (
    canvas.width !== width ||
    canvas.height !== height
  ) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, width, height);

  const inactiveColor =
    colors?.inactive ||
    'rgba(255,255,255,.35)';

  const activeColor =
    colors?.active ||
    'rgb(99,102,241)';

  const normalizedProgress = Math.min(
    1,
    Math.max(
      0,
      Number(progress) || 0
    )
  );

  /*
   * Do not force a 2px minimum width here.
   *
   * On narrow phones, 32 bars + gaps may simply not fit.
   * Let the bars shrink instead of overflowing/clipping.
   */
  const gapCss = Math.min(
    2,
    Math.max(
      0.75,
      rect.width / bars.length * 0.12
    )
  );

  const totalGapCss =
    gapCss * Math.max(
      0,
      bars.length - 1
    );

  const barWidthCss = Math.max(
    1,
    (
      rect.width -
      totalGapCss
    ) / bars.length
  );

  const radiusCss = Math.min(
    2,
    barWidthCss / 2
  );

  for (let i = 0; i < bars.length; i++) {
    const xCss =
      i * (
        barWidthCss +
        gapCss
      );

    const normalizedHeight =
      Math.min(
        100,
        Math.max(
          0,
          Number(bars[i]) || 0
        )
      ) / 100;

    const barHeightCss = Math.max(
      2,
      rect.height *
        normalizedHeight
    );

    const yCss =
      (rect.height -
        barHeightCss) / 2;

    /*
     * Use the center of the bar for progress.
     * This prevents the last partially active bar from
     * looking randomly clipped.
     */
    const barCenter =
      (
        xCss +
        barWidthCss / 2
      ) / rect.width;

    const active =
      normalizedProgress > 0 &&
      barCenter <= normalizedProgress;

    const x = xCss * dpr;
    const y = yCss * dpr;

    const w = Math.max(
      1,
      barWidthCss * dpr
    );

    const h = Math.max(
      1,
      barHeightCss * dpr
    );

    const r = Math.max(
      0,
      radiusCss * dpr
    );

    ctx.fillStyle = active
      ? activeColor
      : inactiveColor;

    if (
      typeof ctx.roundRect === 'function'
    ) {
      ctx.beginPath();

      ctx.roundRect(
        x,
        y,
        w,
        h,
        r
      );

      ctx.fill();
    } else {
      ctx.fillRect(
        x,
        y,
        w,
        h
      );
    }
  }
}

function setupWaveformCanvas(
  canvas,
  bars
) {
  if (!canvas) {
    return {
      setProgress: () => {},
      redraw: () => {},
      destroy: () => {},
    };
  }

  const waveEl =
    canvas.closest(
      '.voice-message-wave'
    ) || canvas;

  const playerEl =
    canvas.closest(
      '.voice-message'
    );

  let progress = 0;
  let resizeFrame = null;

  const getWaveColors = () => {
    let inactiveColor = '';
    let activeColor = '';

    try {
      /*
       * Inactive/unplayed waveform color comes from:
       *
       * .voice-message-wave {
       *   color: var(--muted2);
       * }
       *
       * getComputedStyle() resolves the actual final CSS color.
       */
      inactiveColor =
        getComputedStyle(
          waveEl
        ).color.trim();
    } catch {
      inactiveColor = '';
    }

    try {
      /*
       * The play button already uses:
       *
       * background:
       *   var(--message-accent, rgb(var(--indigo)));
       *
       * Reading its computed background-color gives us the
       * actual resolved accent color without duplicating the
       * accent value in JavaScript.
       */
      const playButton =
        playerEl?.querySelector(
          '.voice-message-play'
        );

      if (playButton) {
        activeColor =
          getComputedStyle(
            playButton
          ).backgroundColor.trim();
      }
    } catch {
      activeColor = '';
    }

    /*
     * These fallbacks are only defensive. Under the current CSS,
     * both values are resolved from the stylesheet.
     */
    return {
      active:
        activeColor ||
        inactiveColor ||
        'transparent',

      inactive:
        inactiveColor ||
        'transparent',
    };
  };

  const redraw = () => {
    const colors =
      getWaveColors();

    drawWaveform(
      canvas,
      bars,
      progress,
      colors
    );
  };

  const setProgress = (value) => {
    progress = Math.min(
      1,
      Math.max(
        0,
        Number(value) || 0
      )
    );

    redraw();
  };

  const scheduleResizeRedraw = () => {
    if (resizeFrame !== null) {
      return;
    }

    resizeFrame =
      requestAnimationFrame(() => {
        resizeFrame = null;
        redraw();
      });
  };

  let resizeObserver = null;

  if (
    typeof ResizeObserver ===
    'function'
  ) {
    resizeObserver =
      new ResizeObserver(
        scheduleResizeRedraw
      );

    resizeObserver.observe(canvas);
  } else {
    window.addEventListener(
      'resize',
      scheduleResizeRedraw
    );
  }

  requestAnimationFrame(
    redraw
  );

  return {
    setProgress,

    redraw,

    destroy() {
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      } else {
        window.removeEventListener(
          'resize',
          scheduleResizeRedraw
        );
      }

      if (resizeFrame !== null) {
        cancelAnimationFrame(
          resizeFrame
        );

        resizeFrame = null;
      }
    },
  };
}

// ======================================================
// PLAYBACK SPEED
// ======================================================

const SPEED_STEPS = [
  1,
  1.25,
  1.5,
  2,
];

function nextSpeed(current) {
  const normalized =
    Number(current);

  const idx =
    SPEED_STEPS.indexOf(
      normalized
    );

  if (idx === -1) {
    return 1;
  }

  return SPEED_STEPS[
    (idx + 1) %
      SPEED_STEPS.length
  ];
}

function formatSpeed(rate) {
  const value =
    Number(rate);

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return '1x';
  }

  return `${
    value % 1 === 0
      ? value.toFixed(0)
      : value
  }x`;
}

// ======================================================
// TIME FORMAT
// ======================================================

function formatTime(seconds) {
  if (
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    seconds = 0;
  }

  const hours =
    Math.floor(
      seconds / 3600
    );

  const minutes =
    Math.floor(
      (seconds % 3600) / 60
    );

  const secs =
    Math.floor(
      seconds % 60
    );

  if (hours > 0) {
    return `${hours}:${String(
      minutes
    ).padStart(2, '0')}:${String(
      secs
    ).padStart(2, '0')}`;
  }

  return `${minutes}:${String(
    secs
  ).padStart(2, '0')}`;
}

// ======================================================
// PLAYER
// ======================================================

export async function renderVoiceMessage(
  msg,
  scope,
  containerEl
) {
  const messageId =
    String(msg.id);

  const container =
    containerEl ||
    document.querySelector(
      `.chat-msg[data-msg-id="${CSS.escape(
        messageId
      )}"]`
    );

  if (!container) {
    console.error(
      'Voice message container not found for message:',
      msg.id
    );
    return;
  }

  const playerId =
    `vplayer-${messageId}`;

  if (
    container.querySelector(
      `#${CSS.escape(playerId)}`
    )
  ) {
    return;
  }

  const bars =
    seededBars(
      msg.id,
      BAR_COUNT
    );

  const template = `
    <div
      class="voice-message loading"
      id="${playerId}"
    >
      <button
        type="button"
        class="voice-message-play"
        aria-label="Play voice message"
      >
        <span class="icon-play">${ICONS.play}</span>

        <span
          class="icon-pause"
          style="display:none"
        >${ICONS.pause}</span>
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
        <canvas
          class="voice-wave-canvas"
          aria-hidden="true"
        ></canvas>
      </div>

      <span class="voice-message-time">
        0:00
      </span>

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
          <span class="icon-volume">
            ${ICONS.volume}
          </span>

          <span
            class="icon-volume-mute"
            style="display:none"
          >${ICONS.volumeMute}</span>
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

      <div
        class="voice-message-error"
        aria-live="polite"
      >
        ${ICONS.alert}

        <span class="voice-message-error-text">
          Failed to load voice message
        </span>
      </div>

      <audio
        id="vaudio-${messageId}"
        preload="metadata"
      ></audio>
    </div>
  `;

  const contentWrapper =
    container.querySelector(
      '.chat-msg-content'
    ) || container;

  contentWrapper.insertAdjacentHTML(
    'beforeend',
    template
  );

  const playerEl =
    contentWrapper.lastElementChild;

  const audio =
    playerEl?.querySelector(
      'audio'
    );

  if (!playerEl || !audio) {
    console.error(
      'Voice message element not found after insertion for message:',
      msg.id
    );
    return;
  }

  const playBtn =
    playerEl.querySelector(
      '.voice-message-play'
    );

  const iconPlay =
    playerEl.querySelector(
      '.icon-play'
    );

  const iconPause =
    playerEl.querySelector(
      '.icon-pause'
    );

  const waveEl =
    playerEl.querySelector(
      '.voice-message-wave'
    );

  const waveCanvas =
    playerEl.querySelector(
      '.voice-wave-canvas'
    );

  const timeEl =
    playerEl.querySelector(
      '.voice-message-time'
    );

  const speedBtn =
    playerEl.querySelector(
      '.voice-message-speed'
    );

  const volumeControlEl =
    playerEl.querySelector(
      '.voice-message-volume-control'
    );

  const volumeBtn =
    playerEl.querySelector(
      '.voice-message-volume'
    );

  const iconVolume =
    playerEl.querySelector(
      '.icon-volume'
    );

  const iconVolumeMute =
    playerEl.querySelector(
      '.icon-volume-mute'
    );

  const volumeSlider =
    playerEl.querySelector(
      '.voice-message-volume-slider'
    );

  const errorEl =
    playerEl.querySelector(
      '.voice-message-error'
    );

  const errorTextEl =
    playerEl.querySelector(
      '.voice-message-error-text'
    );

  if (
    !playBtn ||
    !iconPlay ||
    !iconPause ||
    !waveEl ||
    !waveCanvas ||
    !timeEl ||
    !speedBtn ||
    !volumeControlEl ||
    !volumeBtn ||
    !iconVolume ||
    !iconVolumeMute ||
    !volumeSlider ||
    !errorEl ||
    !errorTextEl
  ) {
    console.error(
      'Voice message player controls are incomplete:',
      msg.id
    );

    playerEl.remove();
    return;
  }

  // ====================================================
  // MEDIA URL STATE
  // ====================================================

  /*
   * Keep this separate from the DOM.
   *
   * The previous version referenced attachmentUrl before
   * declaring it, which could make the diagnostic/error path
   * throw another exception on top of the actual media error.
   */
  let attachmentUrl = '';

  // ====================================================
  // WAVEFORM
  // ====================================================

  const waveform =
    setupWaveformCanvas(
      waveCanvas,
      bars
    );

  // ====================================================
  // HELPERS
  // ====================================================

  const setLoading =
    (isLoading) => {
      playerEl.classList.toggle(
        'loading',
        !!isLoading
      );
    };

  function setPlayerState(state) {
    playerEl.dataset.state =
      state;

    setLoading(
      state === 'loading'
    );

    if (state !== 'error') {
      errorEl.style.display =
        'none';
    }
  }

  setPlayerState(
    'loading'
  );

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
        !document.body.contains(
          playerEl
        ) ||
        audio.paused ||
        audio.ended
      ) {
        rafId = null;
        return;
      }

      updateProgress();
      updateTimeLabel();

      rafId =
        requestAnimationFrame(
          tick
        );
    };

    rafId =
      requestAnimationFrame(
        tick
      );
  }

  function stopProgressLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(
        rafId
      );

      rafId = null;
    }
  }

  const updateProgress =
    () => {
      const duration =
        audio.duration;

      const currentTime =
        Number.isFinite(
          audio.currentTime
        )
          ? Math.max(
              0,
              audio.currentTime
            )
          : 0;

      const pct =
        Number.isFinite(duration) &&
        duration > 0
          ? Math.min(
              100,
              Math.max(
                0,
                (
                  currentTime /
                  duration
                ) * 100
              )
            )
          : 0;

      waveform.setProgress(
        pct / 100
      );

      waveEl.setAttribute(
        'aria-valuenow',
        String(
          Math.round(pct)
        )
      );
    };

  const updateTimeLabel =
    () => {
      const duration =
        audio.duration;

      const currentTime =
        Number.isFinite(
          audio.currentTime
        )
          ? Math.max(
              0,
              audio.currentTime
            )
          : 0;

      if (
        currentTime > 0 ||
        !Number.isFinite(duration) ||
        duration <= 0
      ) {
        timeEl.textContent =
          formatTime(
            currentTime
          );
      } else {
        timeEl.textContent =
          formatTime(
            duration
          );
      }
    };

  const updateVolumeIcon =
    () => {
      const isMuted =
        audio.muted ||
        audio.volume === 0;

      iconVolume.style.display =
        isMuted
          ? 'none'
          : 'block';

      iconVolumeMute.style.display =
        isMuted
          ? 'block'
          : 'none';
    };

  const updateVolumeSliderFill =
    () => {
      const rawValue =
        Number(
          volumeSlider.value
        );

      const pct =
        Math.round(
          Math.min(
            1,
            Math.max(
              0,
              rawValue
            )
          ) * 100
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

  let intendedPlaying =
    false;

  const seekToRatio =
    (ratio) => {
      const duration =
        audio.duration;

      if (
        !Number.isFinite(duration) ||
        duration <= 0
      ) {
        return;
      }

      const normalizedRatio =
        Math.min(
          1,
          Math.max(
            0,
            Number(ratio) || 0
          )
        );

      const targetTime =
        normalizedRatio *
        duration;

      if (
        !Number.isFinite(
          targetTime
        )
      ) {
        return;
      }

      try {
        audio.currentTime =
          targetTime;
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

  const seekToClientX =
    (clientX) => {
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
        (
          clientX -
          rect.left
        ) / rect.width
      );
    };

  // ====================================================
  // INITIAL AUDIO STATE
  // ====================================================

  audio.playbackRate = 1;
  audio.volume = 1;
  audio.muted = false;

  updateVolumeSliderFill();
  updateVolumeIcon();

  // ====================================================
  // PLAY / PAUSE
  // ====================================================

  function play() {
    setActivePlayer(
      audio
    );

    intendedPlaying =
      true;

    const promise =
      audio.play();

    if (
      promise &&
      typeof promise.catch ===
        'function'
    ) {
      promise.catch(
        (error) => {
          intendedPlaying =
            false;

          console.error(
            'Voice message playback failed:',
            error
          );
        }
      );
    }
  }

  function pause() {
    intendedPlaying =
      false;

    try {
      audio.pause();
    } catch (error) {
      console.warn(
        'Voice message pause failed:',
        error
      );
    }
  }

  playBtn.addEventListener(
    'click',
    () => {
      if (audio.paused) {
        play();
      } else {
        pause();
      }
    }
  );

  // ====================================================
  // PLAYBACK EVENTS
  // ====================================================

  audio.addEventListener(
    'play',
    () => {
      iconPlay.style.display =
        'none';

      iconPause.style.display =
        'block';

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
    }
  );

  audio.addEventListener(
    'playing',
    () => {
      setPlayerState(
        'playing'
      );

      startProgressLoop();

      networkRetryCount = 0;

      tokenRefreshAttempted = false;
    }
  );

  audio.addEventListener(
    'waiting',
    () => {
      if (intendedPlaying) {
        setPlayerState(
          'loading'
        );
      }

      stopProgressLoop();
    }
  );

  audio.addEventListener(
    'pause',
    () => {
      iconPlay.style.display =
        'block';

      iconPause.style.display =
        'none';

      playBtn.setAttribute(
        'aria-label',
        'Play voice message'
      );

      stopProgressLoop();

      if (!audio.ended) {
        setPlayerState(
          'paused'
        );
      }

      updateProgress();
      updateTimeLabel();

      saveVoiceState(
        messageId,
        audio,
        intendedPlaying,
        audio.playbackRate
      );

      if (
        activeAudioEl === audio
      ) {
        activeAudioEl =
          null;
      }
    }
  );

  // ====================================================
  // KEYBOARD SEEK
  // ====================================================

  waveEl.addEventListener(
    'keydown',
    (event) => {
      const duration =
        audio.duration;

      if (
        !Number.isFinite(duration) ||
        duration <= 0
      ) {
        return;
      }

      const step =
        5 / duration;

      if (
        event.key === 'ArrowRight' ||
        event.key === 'ArrowUp'
      ) {
        event.preventDefault();

        seekToRatio(
          audio.currentTime /
            duration +
            step
        );
      } else if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowDown'
      ) {
        event.preventDefault();

        seekToRatio(
          audio.currentTime /
            duration -
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
    }
  );

  // ====================================================
  // LOADING / METADATA
  // ====================================================

  const savedState =
    voicePlaybackState.get(
      messageId
    );

  /*
   * Chrome/Edge MediaRecorder output (webm/opus) has no duration in
   * its header, so audio.duration is Infinity forever: the time label,
   * progress bar and seeking all silently break. The standard
   * workaround is to seek far past the end, which forces the browser
   * to scan the file and report the real duration, then rewind.
   *
   * `fixingDuration` keeps the timeupdate events caused by that
   * temporary seek from being saved/rendered as real playback.
   */
  let fixingDuration =
    false;

  function resolveRealDuration(
    done
  ) {
    if (
      Number.isFinite(
        audio.duration
      )
    ) {
      done(true);
      return;
    }

    let finished =
      false;

    let timeoutId =
      null;

    const finish =
      (resolved) => {
        if (finished) {
          return;
        }

        finished = true;

        audio.removeEventListener(
          'durationchange',
          onDurationChange
        );

        if (timeoutId !== null) {
          clearTimeout(
            timeoutId
          );

          timeoutId = null;
        }

        try {
          audio.currentTime = 0;
        } catch {
          // Element may not accept a seek yet; harmless.
        }

        fixingDuration =
          false;

        done(resolved);
      };

    const onDurationChange =
      () => {
        if (
          Number.isFinite(
            audio.duration
          )
        ) {
          finish(true);
        }
      };

    audio.addEventListener(
      'durationchange',
      onDurationChange
    );

    fixingDuration =
      true;

    try {
      audio.currentTime =
        1e101;
    } catch {
      finish(false);
      return;
    }

    timeoutId =
      setTimeout(
        () => {
          finish(
            Number.isFinite(
              audio.duration
            )
          );
        },
        3000
      );
  }

  audio.addEventListener(
    'loadedmetadata',
    () => {
      resolveRealDuration(
        () => {
          if (
            !document.body.contains(
              playerEl
            )
          ) {
            return;
          }

          setPlayerState(
            'idle'
          );

          if (savedState) {
            const duration =
              audio.duration;

            let restoreTime =
              Number.isFinite(
                savedState.currentTime
              )
                ? Math.max(
                    0,
                    savedState.currentTime
                  )
                : 0;

            if (
              Number.isFinite(
                duration
              ) &&
              duration > 0
            ) {
              restoreTime =
                Math.min(
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
                : String(
                    audio.volume
                  );

            updateVolumeSliderFill();
            updateVolumeIcon();

            if (
              savedState.playing
            ) {
              setActivePlayer(
                audio
              );

              intendedPlaying =
                true;

              const promise =
                audio.play();

              if (
                promise &&
                typeof promise.catch ===
                  'function'
              ) {
                promise.catch(
                  (error) => {
                    intendedPlaying =
                      false;

                    console.error(
                      'Voice message resume failed:',
                      error
                    );
                  }
                );
              }
            }
          }

          updateProgress();
          updateTimeLabel();
        }
      );
    }
  );

  audio.addEventListener(
    'canplay',
    () => {
      if (
        playerEl.dataset.state ===
        'loading'
      ) {
        setPlayerState(
          'idle'
        );
      }

      updateProgress();
      updateTimeLabel();
    }
  );

  // ====================================================
  // PROGRESS EVENTS
  // ====================================================

  audio.addEventListener(
    'timeupdate',
    () => {
      if (fixingDuration) {
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
    }
  );

  audio.addEventListener(
    'durationchange',
    () => {
      updateProgress();
      updateTimeLabel();
    }
  );

  audio.addEventListener(
    'ended',
    () => {
      intendedPlaying =
        false;

      stopProgressLoop();

      setPlayerState(
        'ended'
      );

      voicePlaybackState.delete(
        messageId
      );

      try {
        audio.currentTime = 0;
      } catch {
        // Ignore implementations that reject immediate seeking.
      }

      updateProgress();
      updateTimeLabel();

      iconPlay.style.display =
        'block';

      iconPause.style.display =
        'none';

      playBtn.setAttribute(
        'aria-label',
        'Play voice message'
      );

      if (
        activeAudioEl === audio
      ) {
        activeAudioEl =
          null;
      }
    }
  );

  // ====================================================
  // SEEK
  // ====================================================

  let scrubbing =
    false;

  function onWindowMouseMove(
    event
  ) {
    if (!scrubbing) {
      return;
    }

    seekToClientX(
      event.clientX
    );
  }

  function onWindowMouseUp(
    event
  ) {
    if (!scrubbing) {
      return;
    }

    if (
      event &&
      Number.isFinite(
        event.clientX
      )
    ) {
      seekToClientX(
        event.clientX
      );
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

      scrubbing =
        true;

      seekToClientX(
        event.clientX
      );

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
      seekToClientX(
        event.clientX
      );
    }
  );

  // Touch: a tap fires 'click' (handled above). Seeking on
  // 'touchstart' made every finger-scroll across a voice bubble seek.

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
      closeOpenVolumePanel =
        null;
    }
  }

  function onOutsideClick(
    event
  ) {
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
      const volume =
        Number(
          volumeSlider.value
        );

      if (
        !Number.isFinite(volume)
      ) {
        return;
      }

      audio.volume =
        Math.min(
          1,
          Math.max(
            0,
            volume
          )
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
      if (
        event.key === 'Escape'
      ) {
        closeThisPanel();
      }
    }
  );

  // ====================================================
  // ERRORS
  // ====================================================

  function stripToken(url) {
    try {
      return String(
        url || ''
      ).split('?')[0];
    } catch {
      return '';
    }
  }

  async function diagnoseAndShowError(
    mediaError
  ) {
    const code =
      mediaError?.code;

    const diagnostics = {
      messageId,

      mediaErrorCode:
        code,

      mediaErrorName:
        {
          1: 'MEDIA_ERR_ABORTED',
          2: 'MEDIA_ERR_NETWORK',
          3: 'MEDIA_ERR_DECODE',
          4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
        }[code] || 'unknown',

      url:
        stripToken(
          attachmentUrl
        ),

      hadAuthToken:
        typeof attachmentUrl ===
          'string' &&
        attachmentUrl.includes(
          'token='
        ),
    };

    let userMessage =
      'Failed to load voice message';

    if (!attachmentUrl) {
      diagnostics.reason =
        'No attachment URL was resolved';

      console.error(
        'Voice message playback failed:',
        diagnostics
      );

      errorTextEl.textContent =
        userMessage;

      errorEl.style.display =
        'flex';

      return;
    }

    try {
      const resp =
        await fetch(
          attachmentUrl,
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

      if (
        resp.status === 401 &&
        !tokenRefreshAttempted
      ) {
        tokenRefreshAttempted =
          true;

        try {
          const freshUrl =
            resolveServerUrl(
              await refreshMediaSrcUrl(
                scope,
                msg.id
              )
            );

          diagnostics.tokenRefreshed =
            true;

          attachmentUrl =
            freshUrl;

          audio.src =
            freshUrl;

          errorEl.style.display =
            'none';

          console.log(
            'Voice message media token had expired; refreshed and retrying:',
            diagnostics
          );

          retryLoadAndResume();

          /*
           * Let the reload play out through the normal
           * loadedmetadata/error events (retryLoadAndResume() above,
           * or — if it fails again — this same function, re-entered
           * with tokenRefreshAttempted already true so it falls
           * straight through to an accurate message instead of
           * retrying forever).
           */
          return;

        } catch (refreshError) {
          diagnostics.tokenRefreshError =
            refreshError?.message;

          /*
           * api() (see core/api.js) only throws exactly this message
           * when the server told us the *login* session/token itself
           * is invalid or expired — as opposed to this attachment's
           * short-lived media token, or some other failure (denied
           * access, attachment gone, etc.) on the media-token
           * endpoint. Only that specific case is a real "please sign
           * in again".
           */
          userMessage =
            refreshError?.message ===
            'Session expired'
              ? 'Your session has expired — refresh the page and sign in again'
              : "This voice message's link expired and couldn't be " +
                'refreshed. Try reopening the conversation.';
        }
      } else if (
        resp.status === 401
      ) {
        userMessage =
          "This voice message's link expired and couldn't be " +
          'refreshed. Try reopening the conversation.';
      } else if (
        resp.status === 403
      ) {
        userMessage =
          "You don't have permission to view this voice message";
      } else if (
        resp.status === 404
      ) {
        userMessage =
          'This voice message is no longer available';
      } else if (
        resp.status >= 500
      ) {
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
      } else if (
        code === 4
      ) {
        userMessage =
          "This voice message's audio format isn't supported in this browser";
      } else if (
        code === 3
      ) {
        userMessage =
          "This voice message's audio data could not be decoded";
      } else if (
        code === 2
      ) {
        userMessage =
          'Network error while loading this voice message';
      }
    } catch (
      fetchError
    ) {
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

    errorEl.style.display =
      'flex';
  }

  // ====================================================
  // TRANSIENT NETWORK ERROR RETRY
  // ====================================================

  const MAX_NETWORK_RETRIES =
    2;

  let networkRetryCount =
    0;

  let networkRetryTimer =
    null;

  /*
   * The token embedded in attachmentUrl/audio.src is a short-lived
   * (~90s) media-scoped token minted when this player was created —
   * see mediaToken.js. It is NOT the login session token, so it can
   * (and, for a message opened a while before playback is attempted,
   * routinely will) expire on its own well before the actual login
   * session does. Guards a single automatic "get a fresh one and
   * retry" attempt so a genuinely broken/permission-denied attachment
   * doesn't retry forever.
   */
  let tokenRefreshAttempted =
    false;

  /*
   * Reloads the (possibly just-reassigned) audio.src and restores
   * playback position/state once the new metadata is available.
   *
   * Shared by the network-error retry below and by the token-refresh
   * retry in diagnoseAndShowError(): both cases are "the underlying
   * request should work now, pick back up where we left off",
   * differing only in why the previous attempt failed.
   */
  function retryLoadAndResume() {
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

    setPlayerState(
      'loading'
    );

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

        if (
          wasPlaying
        ) {
          play();
        } else {
          updateProgress();
          updateTimeLabel();
        }
      };

    audio.addEventListener(
      'loadedmetadata',
      onRetryMetadata,
      {
        once: true,
      }
    );

    /*
     * Keep retry behavior unchanged.
     * Here load() is intentional because we are explicitly
     * restarting a failed media request.
     */
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
  }

  audio.addEventListener(
    'error',
    () => {
      stopProgressLoop();

      const mediaError =
        audio.error;

      if (
        mediaError?.code === 2 &&
        networkRetryCount <
          MAX_NETWORK_RETRIES
      ) {
        networkRetryCount += 1;

        setPlayerState(
          'loading'
        );

        if (
          networkRetryTimer !==
          null
        ) {
          clearTimeout(
            networkRetryTimer
          );
        }

        networkRetryTimer =
          setTimeout(
            () => {
              networkRetryTimer =
                null;

              if (
                !document.body.contains(
                  playerEl
                )
              ) {
                return;
              }

              retryLoadAndResume();
            },
            800 *
              networkRetryCount
          );

        return;
      }

      setPlayerState(
        'error'
      );

      diagnoseAndShowError(
        mediaError
      );
    }
  );

  // ====================================================
  // FIRST UI STATE
  // ====================================================

  updateVolumeSliderFill();
  updateVolumeIcon();
  updateProgress();
  updateTimeLabel();

  // ====================================================
  // RESOLVE MEDIA URL
  // ====================================================

  /*
   * The visual player already exists at this point.
   *
   * getMediaSrcUrl() can therefore run without blocking the
   * initial waveform render.
   */
  try {
    const mediaUrl =
      await getMediaSrcUrl(
        scope,
        msg.id
      );

    const resolvedUrl =
      resolveServerUrl(
        mediaUrl
      );

    if (
      !resolvedUrl ||
      typeof resolvedUrl !==
        'string'
    ) {
      throw new Error(
        'Resolved voice attachment URL is empty'
      );
    }

    if (
      !document.body.contains(
        playerEl
      )
    ) {
      waveform.destroy();
      return;
    }

    attachmentUrl =
      resolvedUrl;

    /*
     * IMPORTANT:
     *
     * Do not call audio.load() here.
     *
     * Assigning src is enough to select the media resource.
     * load() is reserved for explicit retry/reload operations.
     *
     * This also avoids resetting the media element immediately
     * after assigning the newly resolved URL.
     */
    audio.src =
      resolvedUrl;

  } catch (error) {
    console.error(
      'Failed to resolve voice attachment URL:',
      error
    );

    waveform.destroy();

    setPlayerState(
      'error'
    );

    errorTextEl.textContent =
      'Failed to load voice message';

    errorEl.style.display =
      'flex';
  }
}
