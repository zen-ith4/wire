// ============================================================
// Voice message player
// ------------------------------------------------------------
// Separate compact player for voice messages.
//
// Lifecycle (nothing here waits for a first playback):
//   1. render     the pill appears at once; a waveform and duration
//                 already analysed for this message (voice-waveform.js
//                 cache) are drawn immediately, otherwise a flat
//                 placeholder and "--:--".
//   2. source     the audio is resolved (E2EE: download + decrypt into a
//                 blob: URL this player owns). Until then play/seek are
//                 inert; download never is.
//   3. ready      src is set and the player is playable right away. The
//                 element's own metadata loads in the background, but
//                 the UI does not depend on it: browsers that defer media
//                 loading until play() would otherwise show 0:00 and stay
//                 "loading" forever.
//   4. analysis   the same decrypted bytes are decoded ONCE (cached per
//                 message) into the real duration and a 32-bar loudness
//                 envelope, which replace the placeholder.
// Playback progress, seeking and the visualizer all use one duration:
// the element's when it knows it, the analysed one otherwise.
//
// Waveform:
// - Real per-message loudness bars (voice-waveform.js); the old
//   deterministic pseudo-random bars remain only as the fallback for
//   audio this browser cannot decode.
// - Rendered to a canvas instead of dozens of DOM elements.
// ============================================================

import { ICONS } from '../icons.js';
import { escapeHtmlAttr } from '../core/utils.js';
import { getMediaSrcUrl, refreshMediaSrcUrl, resolveMediaSrc } from './mediaToken.js';
import { fetchDecryptedAttachment } from './attachment-e2ee.js';
import { resolveServerUrl } from '../core/server.js';
import {
  VOICE_WAVEFORM_BARS,
  getCachedVoiceWaveform,
  loadVoiceWaveform,
  voiceWaveformKey,
} from './voice-waveform.js';

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

const BAR_COUNT = VOICE_WAVEFORM_BARS;

// Drawn until the real envelope is known: a flat, low row of bars, so
// nothing on screen pretends to describe audio that was not read yet.
const PLACEHOLDER_BAR = 12;

function placeholderBars(count) {
  return new Array(count).fill(PLACEHOLDER_BAR);
}

// Shown in the time label while the duration is not known yet.
const UNKNOWN_TIME = '--:--';

// Decorative bars for audio this browser cannot decode: the previous
// (seeded, deterministic) look, kept only as that fallback.
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

// Played vs unplayed bars must be told apart at a glance. Their colours
// come from two independent tokens - the viewer's accent and --muted2 -
// and with the default "Neutral" accent both are nearly the same grey
// (|dR|+|dG|+|dB| = 37), so the playback position was practically
// invisible. When the two are that close, the UNPLAYED bars are drawn
// translucent; themes whose colours already differ draw exactly as before.
const MIN_PLAYED_CONTRAST = 96;
const UNPLAYED_ALPHA_WHEN_CLOSE = 0.42;

function parseRgb(color) {
  const match =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(
      String(color || '').trim()
    );

  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}

function unplayedAlphaFor(activeColor, inactiveColor) {
  const a = parseRgb(activeColor);
  const b = parseRgb(inactiveColor);

  if (!a || !b) {
    return 1;
  }

  const distance =
    Math.abs(a[0] - b[0]) +
    Math.abs(a[1] - b[1]) +
    Math.abs(a[2] - b[2]);

  return distance < MIN_PLAYED_CONTRAST
    ? UNPLAYED_ALPHA_WHEN_CLOSE
    : 1;
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

  const inactiveAlpha =
    Number.isFinite(colors?.inactiveAlpha)
      ? colors.inactiveAlpha
      : 1;

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

    ctx.globalAlpha = active
      ? 1
      : inactiveAlpha;

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

  ctx.globalAlpha = 1;
}

function setupWaveformCanvas(
  canvas,
  initialBars
) {
  if (!canvas) {
    return {
      setProgress: () => {},
      setBars: () => {},
      redraw: () => {},
      destroy: () => {},
    };
  }

  // Replaced once the real envelope is known (setBars below).
  let bars = initialBars;

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

      inactiveAlpha:
        unplayedAlphaFor(
          activeColor,
          inactiveColor
        ),
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

  const setBars = (nextBars) => {
    if (!Array.isArray(nextBars) || nextBars.length === 0) {
      return;
    }

    bars = nextBars;
    redraw();
  };

  return {
    setProgress,

    setBars,

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
  containerEl,
  // Group voice: the caller already resolved the media (the DECRYPTED blob of
  // a group attachment - whole file, no streaming - passed as { src, isBlob }).
  // When absent the DM/E2EE default (resolveMediaSrc) applies, exactly as before.
  preResolved = null
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

  // A message whose audio was already analysed (an earlier render of
  // this thread, before a tab switch) draws its real waveform and
  // duration immediately, without decoding anything again.
  const analysisKey =
    voiceWaveformKey(
      scope,
      msg.id
    );

  const cachedAnalysis =
    getCachedVoiceWaveform(
      analysisKey
    );

  const bars =
    cachedAnalysis
      ? cachedAnalysis.peaks
      : placeholderBars(BAR_COUNT);

  const filename =
    msg.attachment_name ||
    'voice-message';

  const template = `
    <div
      class="voice-message loading"
      id="${playerId}"
      data-waveform="${cachedAnalysis ? 'ready' : 'pending'}"
    >
      <button
        type="button"
        class="voice-message-play"
        aria-label="Play voice message"
      >
        <span class="icon-play">${ICONS.play}</span>

        <span
          class="icon-pause js-hidden"
         
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

      <span class="voice-message-time">${
        cachedAnalysis
          ? formatTime(cachedAnalysis.duration)
          : UNKNOWN_TIME
      }</span>

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
            class="icon-volume-mute js-hidden"
           
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

      <button
        type="button"
        class="voice-message-download"
        title="Download ${escapeHtmlAttr(filename)}"
        aria-label="Download voice message"
        data-action="audio-player-download"
        data-msg-id="${Number(msg.id)}"
        data-filename="${escapeHtmlAttr(filename)}"
        data-scope="${escapeHtmlAttr(scope)}"
        data-mime="${escapeHtmlAttr(msg.attachment_mime || '')}"
      >${ICONS.download}</button>

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
  // WAVEFORM + DURATION (independent of playback)
  // ====================================================

  const waveform =
    setupWaveformCanvas(
      waveCanvas,
      bars
    );

  // Duration read from the decoded audio (voice-waveform.js). Used
  // whenever the <audio> element does not know its own duration yet -
  // before metadata loaded, in browsers that only load media on play(),
  // or for a MediaRecorder file whose header carries no duration.
  let analysisDuration =
    cachedAnalysis &&
    Number.isFinite(cachedAnalysis.duration)
      ? cachedAnalysis.duration
      : NaN;

  function effectiveDuration() {
    const elementDuration =
      audio.duration;

    if (
      Number.isFinite(elementDuration) &&
      elementDuration > 0
    ) {
      return elementDuration;
    }

    return analysisDuration > 0
      ? analysisDuration
      : NaN;
  }

  function playbackPosition() {
    return Number.isFinite(audio.currentTime)
      ? Math.max(0, audio.currentTime)
      : 0;
  }

  // ====================================================
  // HELPERS
  // ====================================================

  const setLoading =
    (isLoading) => {
      playerEl.classList.toggle(
        'loading',
        !!isLoading
      );

      playerEl.setAttribute(
        'aria-busy',
        isLoading ? 'true' : 'false'
      );
    };

  // 'loading'   the source is being resolved (nothing to play yet)
  // 'idle'      ready - playable even before the element has metadata
  // 'buffering' playing but waiting for data: purely visual, every
  //             control stays usable (pause must work while buffering)
  // 'playing' | 'paused' | 'ended' | 'error'
  function setPlayerState(state) {
    playerEl.dataset.state =
      state;

    setLoading(
      state === 'loading'
    );

    // Nothing can play after a failed load; the error text says why and
    // the download button stays available.
    const failed =
      state === 'error';

    playBtn.disabled =
      failed;

    playBtn.setAttribute(
      'aria-disabled',
      failed ? 'true' : 'false'
    );

    if (!failed) {
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
        effectiveDuration();

      const currentTime =
        playbackPosition();

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

  // Position while started/paused mid-way, the duration while at the
  // start (before playback, after it ended), "--:--" while the duration
  // is genuinely not known yet - never a made-up "0:00".
  const updateTimeLabel =
    () => {
      const duration =
        effectiveDuration();

      const currentTime =
        playbackPosition();

      if (currentTime > 0) {
        timeEl.textContent =
          formatTime(
            currentTime
          );
      } else if (
        Number.isFinite(duration) &&
        duration > 0
      ) {
        timeEl.textContent =
          formatTime(
            duration
          );
      } else {
        timeEl.textContent =
          UNKNOWN_TIME;
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
        effectiveDuration();

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

    // The background duration fix (resolveRealDuration) has the element
    // parked at its far end; playing now would end at once. It resumes
    // this request as soon as it has rewound.
    if (fixingDuration) {
      playAfterDurationFix =
        true;

      return;
    }

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

    playAfterDurationFix =
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

  // Mid-playback buffering is shown, but never blocks the controls the
  // way 'loading' does: the user must still be able to pause.
  audio.addEventListener(
    'waiting',
    () => {
      if (intendedPlaying) {
        setPlayerState(
          'buffering'
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
        effectiveDuration();

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

  // play() pressed while the fix below was running (see play()).
  let playAfterDurationFix =
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

        if (playAfterDurationFix) {
          playAfterDurationFix =
            false;

          play();
        }
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

          // The player is usually already 'idle' (playable since its src
          // was set) or further along - e.g. playing, in a browser that
          // only loads media on play(). Only a stale 'loading' moves.
          if (
            playerEl.dataset.state ===
            'loading'
          ) {
            setPlayerState(
              'idle'
            );
          }

          if (savedState) {
            const duration =
              effectiveDuration();

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

      errorEl.title =
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

    // The pill is narrow: the text may be cut with an ellipsis, the
    // full message stays available as the tooltip.
    errorEl.title =
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
  // WAVEFORM + DURATION ANALYSIS
  //
  // Decodes the message's audio once (cached per message by
  // voice-waveform.js; a cached result was already drawn above) and
  // replaces the placeholder bars and "--:--" with the real envelope and
  // duration. Never tied to playback, and never repeated per render.
  // ====================================================

  function applyAnalysis(analysis) {
    if (!analysis || !playerEl.isConnected) {
      return;
    }

    if (
      Number.isFinite(analysis.duration) &&
      analysis.duration > 0
    ) {
      analysisDuration =
        analysis.duration;
    }

    waveform.setBars(
      analysis.peaks
    );

    playerEl.dataset.waveform =
      'ready';

    updateProgress();
    updateTimeLabel();
  }

  function startAnalysis(loadBytes) {
    if (cachedAnalysis) {
      return;
    }

    loadVoiceWaveform(
      analysisKey,
      loadBytes
    ).then(
      applyAnalysis,
      (error) => {
        if (!playerEl.isConnected) {
          return;
        }

        // This browser cannot decode the file (or the bytes could not be
        // read). Playback may still work through the media element, so
        // fall back to the decorative bars and the element's own
        // duration rather than leaving the placeholder up.
        console.warn(
          'Voice message waveform unavailable:',
          {
            messageId,
            reason: error?.message || String(error)
          }
        );

        waveform.setBars(
          seededBars(
            msg.id,
            BAR_COUNT
          )
        );

        playerEl.dataset.waveform =
          'fallback';
      }
    );
  }

  // ====================================================
  // RESOLVE MEDIA URL
  // ====================================================

  /*
   * The visual player already exists at this point.
   *
   * getMediaSrcUrl() can therefore run without blocking the
   * initial waveform render.
   */
  let resolvedIsBlob = false;
  let resolvedBlobUrl = null;

  try {
    // E2EE voice notes resolve to a decrypted blob: URL this player
    // owns and must revoke; legacy ones keep the token-URL path.
    const resolved = preResolved
      ? { src: preResolved.src, isBlob: !!preResolved.isBlob }
      : await resolveMediaSrc(
          msg,
          scope
        );

    resolvedIsBlob =
      !!(resolved && resolved.isBlob);

    if (resolvedIsBlob) {
      resolvedBlobUrl =
        resolved.src;
    }

    const resolvedUrl =
      resolvedIsBlob
        ? resolved.src
        : resolveServerUrl(
            resolved && resolved.src
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
      // A decrypted blob that never got an element would leak.
      if (resolvedBlobUrl) {
        URL.revokeObjectURL(
          resolvedBlobUrl
        );
      }

      waveform.destroy();
      return;
    }

    attachmentUrl =
      resolvedUrl;

    if (resolvedIsBlob) {
      audio.dataset.blobUrl =
        resolvedUrl;
    }

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

    // Playable from here on. Not waiting for 'loadedmetadata': browsers
    // that only load media once play() is called would otherwise keep
    // the player "loading" (and its play button inert) forever.
    setPlayerState(
      'idle'
    );

    // A player rebuilt for a message the user had already started (tab
    // switch, reopened conversation) resumes where they left off: before
    // metadata this sets the element's default playback start position,
    // and loadedmetadata applies the same saved state again.
    if (
      savedState &&
      Number.isFinite(savedState.currentTime) &&
      savedState.currentTime > 0
    ) {
      try {
        audio.currentTime =
          savedState.currentTime;
      } catch {
        // Applied on loadedmetadata instead.
      }
    }

    updateProgress();
    updateTimeLabel();

    // The bytes behind this source, for the one-time analysis. An
    // encrypted note is already decrypted and cached by
    // attachment-e2ee.js (resolveMediaSrc() just used it), so this costs
    // no second download; a legacy one is fetched with its media token.
    startAnalysis(
      resolvedIsBlob
        ? async () =>
            (await fetchDecryptedAttachment(scope, msg.id)).arrayBuffer()
        : async () => {
            const response =
              await fetch(resolvedUrl);

            if (!response.ok) {
              throw new Error(
                `Voice message download failed (${response.status})`
              );
            }

            return response.arrayBuffer();
          }
    );

  } catch (error) {
    console.error(
      'Failed to resolve voice attachment URL:',
      error
    );

    // Fallback UI: the decorative bars are not drawn for audio that
    // could not be read; the pill says it failed, play is disabled, and
    // the download button stays available.
    waveform.destroy();

    setPlayerState(
      'error'
    );

    errorTextEl.textContent =
      'Failed to load voice message';

    errorEl.title =
      'Failed to load voice message';

    errorEl.style.display =
      'flex';
  }
}
