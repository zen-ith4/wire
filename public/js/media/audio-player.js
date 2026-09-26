import { ICONS } from '../icons.js';
import { escapeAttr, escapeHtml } from '../core/utils.js';
import { getMediaSrcUrl, refreshMediaSrcUrl } from './mediaToken.js';
import { resolveServerUrl } from '../core/server.js';

// ======================================================
// PLAYBACK STATE PERSISTENCE (across tab/view switches)
//
// renderChat()/renderDm() do a full teardown+rebuild of the message
// list on every navigation - including navigating back to a view you
// were already on - which destroys and recreates every <audio>
// element from scratch. A freshly created <audio> element always
// starts silent at 0:00, so without this, playback position (and
// whether it was even playing) is lost any time the user switches
// tabs and comes back.
//
// This module-level map is NOT part of the DOM, so it survives that
// teardown untouched. It's kept up to date continuously via the
// player's own existing playback event listeners (no separate
// "about to be destroyed" hook is needed, since nothing calls back
// into this module before the DOM wipe happens) and consulted once,
// right after a player for the same message is (re)created, to
// silently resume exactly where the user left off.
// ======================================================

const audioPlaybackState = new Map();

function saveAudioState(messageId, audio, playing) {
  audioPlaybackState.set(messageId, {
    currentTime: audio.currentTime,
    playing,
    volume: audio.volume,
    muted: audio.muted,
  });
}

// ======================================================
// AUDIO DETECTION
// ======================================================

const AUDIO_EXTENSIONS = [
  'mp3',
  'wav',
  'flac',
  'ogg',
  'oga',
  'aac',
  'wma',
  'm4a',
  'opus',
  'weba'
];

// Accepts either a MIME type ("audio/mpeg") or a filename
// ("song.mp3") - attachments.js calls this with both.
export function isAudio(value) {
  if (!value || typeof value !== 'string') return false;

  const v = value.toLowerCase();

  if (v.startsWith('audio/')) return true;

  const ext = v.split('.').pop();

  return AUDIO_EXTENSIONS.includes(ext);
}

// ======================================================
// MEDIA URL
// ======================================================
//
// getMediaSrcUrl() returns the attachment-scoped media path.
//
// On the web this may be:
//
//   /api/dm/attachments/91?token=...
//
// But inside Capacitor, the app itself is served from:
//
//   https://localhost
//
// Therefore the relative path MUST be resolved against the configured
// server URL before being assigned to <audio src>.
//
// This prevents Capacitor's local asset handler from attempting to
// interpret /api/... as:
//
//   https://localhost/api/...
//
// The final URL used by the media element must be:
//
//   https://wireapp.ir/api/dm/attachments/91?token=...
// ======================================================

async function resolveAudioUrl(scope, messageId) {
  const mediaPath = await getMediaSrcUrl(scope, messageId);

  if (!mediaPath) {
    throw new Error(
      `Failed to resolve media path for audio attachment ${messageId}`
    );
  }

  const resolvedUrl = resolveServerUrl(mediaPath);

  console.log(
    '[Audio] Media URL:',
    mediaPath,
    '→',
    resolvedUrl
  );

  return resolvedUrl;
}

// ======================================================
// AUDIO PLAYER
// ======================================================

// `containerEl` is the message's own element (built by
// buildChatMessageEl/buildDmMessageEl), passed in directly by
// mountAttachmentMedia() in attachments.js. It does not need to be
// attached to the document yet - everything here is scoped to
// `containerEl`, never to the global document, so there is no
// dependency on DOM insertion order/timing.
export async function renderAudio(msg, scope, containerEl) {
  const messageId = String(msg.id);

  const container =
    containerEl ||
    document.querySelector(
      `.chat-msg[data-msg-id="${CSS.escape(messageId)}"]`
    );

  if (!container) {
    console.error(
      'Audio container not found for message:',
      msg.id
    );
    return;
  }

  const playerId = `aplayer-${messageId}`;

  // Prevent duplicate players
  if (
    container.querySelector(
      `#${CSS.escape(playerId)}`
    )
  ) {
    return;
  }

  let attachmentUrl;

  try {
    attachmentUrl = await resolveAudioUrl(
      scope,
      msg.id
    );
  } catch (error) {
    console.error(
      '[Audio] Failed to resolve media URL:',
      error
    );

    return;
  }

  // The container may have been torn down (or a duplicate player
  // already inserted by a concurrent render) while we awaited the
  // token request above.
  if (
    !document.body.contains(container) ||
    container.querySelector(
      `#${CSS.escape(playerId)}`
    )
  ) {
    return;
  }

  const filename =
    msg.attachment_name || 'Audio';

  // ====================================================
  // TEMPLATE
  //
  // preload="metadata" (not "auto"/"none"): the browser fetches just
  // enough to know duration/seekability up front, and only requests
  // the rest - progressively, via HTTP range requests - once the
  // user actually presses play or seeks. Nothing here fetch()es or
  // Blob()s the file, so a large attachment is never pulled fully
  // into memory just because the message rendered.
  // ====================================================

  const template = `
    <div class="audio-player loading" id="${playerId}">
      <div class="audio-player-header">
        <div
          class="audio-player-title"
          title="${escapeAttr(filename)}"
        >${escapeHtml(filename)}</div>

        <span class="audio-player-current-time">0:00</span>
        <span class="audio-player-duration">0:00</span>
      </div>

      <div class="audio-player-controls">
        <button
          class="audio-player-play"
          type="button"
          title="Play"
        >
          <span class="icon-play">${ICONS.play}</span>
          <span
            class="icon-pause"
            style="display:none"
          >${ICONS.pause}</span>
        </button>

        <div class="audio-player-waveform">
          <canvas class="audio-player-canvas"></canvas>
          <div class="audio-player-progress-fill"></div>
        </div>

        <div class="audio-player-volume-control">
          <button
            class="audio-player-volume"
            type="button"
            title="Mute"
          >${ICONS.volume}</button>

          <div class="audio-player-volume-slider-wrap">
            <input
              type="range"
              class="audio-player-volume-slider"
              min="0"
              max="1"
              step="0.01"
              value="1"
            >
          </div>
        </div>

        <button
          type="button"
          class="audio-player-download"
          title="Download ${escapeAttr(filename)}"
          onclick="window.downloadAttachment(${msg.id}, '${escapeAttr(filename)}', '${scope}', '${escapeAttr(msg.attachment_mime || '')}')"
        >${ICONS.download}</button>
      </div>

      <div class="audio-player-error">
        ${ICONS.alert} Failed to load audio
      </div>

      <audio
        id="audio-${messageId}"
        preload="metadata"
        src="${escapeAttr(attachmentUrl)}"
      ></audio>
    </div>
  `;

  // ====================================================
  // INSERT PLAYER
  //
  // Same rule as the video player: this goes inside the message's
  // content column (.chat-msg-content), underneath the sender/time
  // meta row and the text bubble - never as a sibling of the avatar.
  // ====================================================

  const contentWrapper =
    container.querySelector('.chat-msg-content') ||
    container;

  contentWrapper.insertAdjacentHTML(
    'beforeend',
    template
  );

  // ====================================================
  // ELEMENTS
  //
  // IMPORTANT: not document.getElementById() - see the identical
  // note in video-player.js. `containerEl` may not be attached to
  // the document yet when this runs, so a document-wide lookup would
  // silently miss the just-inserted node and skip listener wiring
  // entirely, leaving a visible-but-inert player.
  // ====================================================

  const playerEl =
    contentWrapper.lastElementChild;

  const audio =
    playerEl
      ? playerEl.querySelector('audio')
      : null;

  if (!playerEl || !audio) {
    console.error(
      'Audio player element not found after insertion for message:',
      msg.id
    );

    return;
  }

  const playBtn =
    playerEl.querySelector(
      '.audio-player-play'
    );

  const iconPlay =
    playerEl.querySelector(
      '.icon-play'
    );

  const iconPause =
    playerEl.querySelector(
      '.icon-pause'
    );

  const currentTimeEl =
    playerEl.querySelector(
      '.audio-player-current-time'
    );

  const durationEl =
    playerEl.querySelector(
      '.audio-player-duration'
    );

  const waveform =
    playerEl.querySelector(
      '.audio-player-waveform'
    );

  const progressFill =
    playerEl.querySelector(
      '.audio-player-progress-fill'
    );

  const volumeBtn =
    playerEl.querySelector(
      '.audio-player-volume'
    );

  const volumeSlider =
    playerEl.querySelector(
      '.audio-player-volume-slider'
    );

  const errorEl =
    playerEl.querySelector(
      '.audio-player-error'
    );

  // ====================================================
  // HELPERS
  // ====================================================

  const formatTime = (seconds) => {
    if (
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      seconds = 0;
    }

    const hours =
      Math.floor(seconds / 3600);

    const minutes =
      Math.floor(
        (seconds % 3600) / 60
      );

    const secs =
      Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(
        2,
        '0'
      )}:${String(secs).padStart(
        2,
        '0'
      )}`;
    }

    return `${minutes}:${String(secs).padStart(
      2,
      '0'
    )}`;
  };

  const updateProgressFill = () => {
    const duration =
      audio.duration;

    const pct =
      Number.isFinite(duration) &&
      duration > 0
        ? (audio.currentTime / duration) * 100
        : 0;

    progressFill.style.width =
      `${pct}%`;
  };

  const updateVolumeSliderFill = () => {
    const pct =
      Math.round(
        Number(volumeSlider.value) * 100
      );

    volumeSlider.style.background =
      `linear-gradient(
        to right,
        rgb(var(--indigo)) 0%,
        rgb(var(--indigo)) ${pct}%,
        var(--border-soft) ${pct}%,
        var(--border-soft) 100%
      )`;
  };

  const setLoading = (isLoading) => {
    playerEl.classList.toggle(
      'loading',
      isLoading
    );
  };

  // ====================================================
  // SMOOTH PROGRESS (requestAnimationFrame)
  //
  // `timeupdate` only fires a handful of times per second, which made
  // the fill bar visibly jump instead of glide. While actually
  // playing, drive the fill/time label from a rAF loop instead,
  // reading audio.currentTime directly every frame — same approach
  // as voice-message.js. `timeupdate` is kept as a fallback/state-save
  // tick, not as the primary progress driver.
  // ====================================================

  let rafId = null;

  function startProgressLoop() {
    if (rafId !== null) {
      return;
    }

    const tick = () => {
      updateProgressFill();

      currentTimeEl.textContent =
        formatTime(
          audio.currentTime
        );

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

  const seekToClientX = (
    clientX
  ) => {
    const duration =
      audio.duration;

    if (
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      return;
    }

    const rect =
      waveform.getBoundingClientRect();

    const ratio =
      Math.min(
        1,
        Math.max(
          0,
          (clientX - rect.left) /
            rect.width
        )
      );

    audio.currentTime =
      ratio * duration;

    updateProgressFill();

    saveAudioState(
      messageId,
      audio,
      intendedPlaying
    );
  };

  // ====================================================
  // PLAY / PAUSE
  //
  // `intendedPlaying` tracks what the user actually asked for, and is
  // ONLY ever set from that explicit action (the button here, or a
  // successful auto-resume below) - never from the audio element's
  // own `play`/`pause` events. Those events are not a reliable proxy
  // for user intent: tearing down this player's parent via
  // innerHTML (which renderChat()/renderDm() do on every navigation,
  // including navigating back to a tab you were already on) makes
  // the browser implicitly fire a `pause` event on the element as
  // part of removing it. An earlier version of this fix saved that
  // teardown-triggered pause as if it was user intent, which
  // silently overwrote "was playing" with false a split second before
  // it was needed - position restored correctly, but it never
  // resumed. Driving the saved "playing" flag off `intendedPlaying`
  // instead keeps it immune to that.
  // ====================================================

  let intendedPlaying = false;

  playBtn.addEventListener(
    'click',
    () => {
      if (audio.paused) {
        intendedPlaying = true;

        audio.play().catch(
          (error) => {
            intendedPlaying = false;

            console.error(
              'Audio playback failed:',
              error
            );
          }
        );
      } else {
        intendedPlaying = false;

        audio.pause();
      }
    }
  );

  audio.addEventListener(
    'play',
    () => {
      iconPlay.style.display =
        'none';

      iconPause.style.display =
        'block';

      saveAudioState(
        messageId,
        audio,
        intendedPlaying
      );
    }
  );

  // `play` fires before any data has necessarily arrived; `playing`
  // fires once playback is actually advancing — that's the real
  // "progress can now move" signal.
  audio.addEventListener(
    'playing',
    () => {
      setLoading(false);
      startProgressLoop();
    }
  );

  audio.addEventListener(
    'waiting',
    () => {
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

      stopProgressLoop();

      updateProgressFill();

      currentTimeEl.textContent =
        formatTime(
          audio.currentTime
        );

      saveAudioState(
        messageId,
        audio,
        intendedPlaying
      );
    }
  );

  // ====================================================
  // LOADING / METADATA
  // ====================================================

  setLoading(true);

  // Restore playback position/volume left over from before this
  // player was torn down and rebuilt.
  const savedState =
    audioPlaybackState.get(
      messageId
    );

  audio.addEventListener(
    'loadedmetadata',
    () => {
      setLoading(false);

      const duration =
        audio.duration;

      if (
        Number.isFinite(duration) &&
        duration > 0
      ) {
        durationEl.textContent =
          formatTime(duration);
      }

      if (savedState) {
        audio.currentTime =
          Math.min(
            savedState.currentTime,
            duration ||
              savedState.currentTime
          );

        audio.volume =
          savedState.volume;

        audio.muted =
          savedState.muted;

        volumeSlider.value =
          savedState.muted
            ? 0
            : savedState.volume;

        updateVolumeSliderFill();

        currentTimeEl.textContent =
          formatTime(
            audio.currentTime
          );

        if (savedState.playing) {
          intendedPlaying = true;

          audio.play().catch(
            (error) => {
              intendedPlaying = false;

              console.error(
                'Audio resume failed:',
                error
              );
            }
          );
        }
      }

      updateProgressFill();
    }
  );

  // Note: deliberately NOT re-enabling the 'loading' class on
  // 'waiting'. That event fires for ordinary mid-playback buffering
  // stalls with a streamed file, and blocking the whole player would
  // make the controls appear unresponsive.
  audio.addEventListener(
    'canplay',
    () => setLoading(false)
  );

  // ====================================================
  // PROGRESS
  // ====================================================

  audio.addEventListener(
    'timeupdate',
    () => {
      currentTimeEl.textContent =
        formatTime(
          audio.currentTime
        );

      updateProgressFill();

      saveAudioState(
        messageId,
        audio,
        intendedPlaying
      );
    }
  );

  audio.addEventListener(
    'ended',
    () => {
      iconPlay.style.display =
        'block';

      iconPause.style.display =
        'none';

      intendedPlaying = false;

      stopProgressLoop();

      // A track that finished naturally shouldn't "resume" mid-playback
      // from near its end the next time this player is rebuilt.
      audioPlaybackState.delete(
        messageId
      );
    }
  );

  // ====================================================
  // SEEK (click / drag on the waveform bar)
  // ====================================================

  let scrubbing = false;

  function onWindowMouseMove(e) {
    if (!scrubbing) {
      return;
    }

    seekToClientX(e.clientX);
  }

  function onWindowMouseUp() {
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

  waveform.addEventListener(
    'mousedown',
    (e) => {
      scrubbing = true;

      seekToClientX(
        e.clientX
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

  waveform.addEventListener(
    'click',
    (e) => {
      seekToClientX(
        e.clientX
      );
    }
  );

  // ====================================================
  // VOLUME
  // ====================================================

  updateVolumeSliderFill();

  volumeSlider.addEventListener(
    'input',
    () => {
      const volume =
        Number(
          volumeSlider.value
        );

      audio.volume =
        volume;

      audio.muted =
        volume === 0;

      updateVolumeSliderFill();

      saveAudioState(
        messageId,
        audio,
        intendedPlaying
      );
    }
  );

  volumeBtn.addEventListener(
    'click',
    () => {
      audio.muted =
        !audio.muted;

      if (
        !audio.muted &&
        audio.volume === 0
      ) {
        audio.volume = 1;
      }

      volumeSlider.value =
        audio.muted
          ? 0
          : audio.volume;

      updateVolumeSliderFill();

      saveAudioState(
        messageId,
        audio,
        intendedPlaying
      );
    }
  );

  // ====================================================
  // ERRORS
  //
  // The token embedded in attachmentUrl/audio.src is a short-lived
  // (~90s) media-scoped token minted when this player was created —
  // see mediaToken.js. It is NOT the login session token, so a
  // message opened a while before the user gets around to pressing
  // play will routinely, harmlessly, have it expire before playback
  // even starts. That surfaces here only as a generic MediaError (no
  // HTTP status is exposed to the 'error' event), so a quick
  // Range-request re-fetch is needed to find out whether that's what
  // actually happened before giving up and showing "Failed to load
  // audio".
  // ====================================================

  let tokenRefreshAttempted =
    false;

  async function attemptTokenRefreshAndRetry() {
    let resp;

    try {
      resp = await fetch(
        attachmentUrl,
        {
          headers: {
            Range: 'bytes=0-1',
          },
        }
      );
    } catch (fetchError) {
      console.error(
        '[Audio] Diagnostic re-fetch failed:',
        fetchError
      );

      return false;
    }

    if (resp.status !== 401) {
      return false;
    }

    try {
      const freshUrl =
        resolveServerUrl(
          await refreshMediaSrcUrl(
            scope,
            msg.id
          )
        );

      console.log(
        '[Audio] Media token had expired; refreshed and retrying:',
        { messageId }
      );

      attachmentUrl =
        freshUrl;

      const resumeAt =
        Number.isFinite(
          audio.currentTime
        )
          ? Math.max(
              0,
              audio.currentTime
            )
          : 0;

      const wasPlaying =
        intendedPlaying;

      setLoading(true);

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
            try {
              audio.currentTime =
                Math.min(
                  resumeAt,
                  duration
                );
            } catch (error) {
              console.warn(
                'Failed to restore audio position after token refresh:',
                error
              );
            }
          }

          if (
            wasPlaying
          ) {
            intendedPlaying = true;

            audio.play().catch(
              (error) => {
                intendedPlaying = false;

                console.error(
                  'Audio resume after token refresh failed:',
                  error
                );
              }
            );
          }
        };

      audio.addEventListener(
        'loadedmetadata',
        onRetryMetadata,
        {
          once: true,
        }
      );

      audio.src =
        freshUrl;

      audio.load();

      return true;

    } catch (refreshError) {
      /*
       * api() (see core/api.js) only throws exactly 'Session expired'
       * when the *login* session/token itself is invalid or expired —
       * as opposed to this attachment's short-lived media token, or
       * some other failure (denied access, attachment gone, etc.) on
       * the media-token endpoint. Either way, the retry didn't work,
       * so fall through to the generic error box below.
       */
      console.error(
        '[Audio] Media token refresh failed:',
        refreshError
      );

      return false;
    }
  }

  audio.addEventListener(
    'error',
    () => {
      setLoading(false);

      const error =
        audio.error;

      console.error(
        'Audio error:',
        {
          code: error?.code,
          message: error?.message,
          src: audio.currentSrc
        }
      );

      if (!tokenRefreshAttempted) {
        tokenRefreshAttempted =
          true;

        attemptTokenRefreshAndRetry().then(
          (recovered) => {
            if (!recovered) {
              errorEl.style.display =
                'flex';
            }
          }
        );

        return;
      }

      errorEl.style.display =
        'flex';
    }
  );
}
