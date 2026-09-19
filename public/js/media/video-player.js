import { ICONS } from '../icons.js';
import { downloadAttachment } from './attachments.js';
import { getMediaSrcUrl } from './mediaToken.js';
import { resolveServerUrl } from '../core/server.js';

// ======================================================
// VIDEO DETECTION
// ======================================================

export function isVideo(mime) {
  return (
    typeof mime === 'string' &&
    mime.toLowerCase().startsWith('video/')
  );
}

// ======================================================
// VIDEO PLAYER
// ======================================================

export async function renderVideo(
  msg,
  scope,
  containerEl
) {
  const messageId = String(msg.id);
  const escapedMessageId = CSS.escape(messageId);

  const container =
    containerEl ||
    document.querySelector(
      `.chat-msg[data-msg-id="${escapedMessageId}"]`
    );

  if (!container) {
    console.error(
      'Video container not found for message:',
      msg.id
    );
    return;
  }

  // Prevent duplicate players.
  if (
    container.querySelector(
      `#vplayer-${escapedMessageId}`
    )
  ) {
    return;
  }

  // ====================================================
  // MEDIA URL
  // ====================================================

  let relativeAttachmentUrl;

  try {
    relativeAttachmentUrl = await getMediaSrcUrl(
      scope,
      msg.id
    );
  } catch (error) {
    console.error(
      '[Video] Failed to get media URL:',
      error
    );
    return;
  }

  const attachmentUrl =
    resolveServerUrl(relativeAttachmentUrl);

  console.log(
    '[Video] Media URL:',
    relativeAttachmentUrl,
    '→',
    attachmentUrl
  );

  // The message may have disappeared while
  // getMediaSrcUrl() was running.
  if (
    !document.body.contains(container) ||
    container.querySelector(
      `#vplayer-${escapedMessageId}`
    )
  ) {
    return;
  }

  // ====================================================
  // TEMPLATE
  // ====================================================

  const template = `
    <div
      class="video-player"
      id="vplayer-${escapedMessageId}"
    >
      <video
        id="video-${escapedMessageId}"
        src="${attachmentUrl}"
        preload="auto"
        playsinline
        webkit-playsinline
        tabindex="0"
      ></video>

      <div class="video-player-controls">
        <button
          class="video-ctrl-btn play-btn"
          title="Play"
          type="button"
        >
          <span class="icon-play">
            ${ICONS.play}
          </span>

          <span
            class="icon-pause"
            style="display:none"
          >
            ${ICONS.pause}
          </span>
        </button>

        <div
          class="video-time"
          style="display:none"
        >
          <span class="current-time">
            0:00
          </span>

          <span class="sep">
            /
          </span>

          <span class="duration">
            0:00
          </span>
        </div>

        <div class="video-seek-wrap">
          <input
            type="range"
            class="video-seekbar seekbar"
            min="0"
            max="0"
            step="0.1"
            value="0"
          />
        </div>

        <div class="video-volume-wrap">
          <button
            class="video-ctrl-btn mute-btn"
            title="Mute"
            type="button"
          >
            ${ICONS.volume}
          </button>

          <input
            type="range"
            class="video-volume-slider volume-slider"
            min="0"
            max="1"
            step="0.01"
            value="1"
          />
        </div>

        <button
          class="video-ctrl-btn download-btn"
          title="Download"
          type="button"
        >
          ${ICONS.download}
        </button>

        <button
          class="video-ctrl-btn fullscreen-btn"
          title="Fullscreen"
          type="button"
        >
          ${ICONS.fullscreen}
        </button>
      </div>
    </div>
  `;

  // ====================================================
  // INSERT PLAYER
  // ====================================================

  const contentWrapper =
    container.querySelector('.chat-msg-content') ||
    container;

  contentWrapper.insertAdjacentHTML(
    'beforeend',
    template
  );

  const playerEl =
    contentWrapper.lastElementChild;

  const video =
    playerEl?.querySelector('video');

  if (!playerEl || !video) {
    console.error(
      'Video player element not found after insertion for message:',
      msg.id
    );
    return;
  }

  // ====================================================
  // ELEMENTS
  // ====================================================

  const playBtn =
    playerEl.querySelector('.play-btn');

  const iconPlay =
    playerEl.querySelector('.icon-play');

  const iconPause =
    playerEl.querySelector('.icon-pause');

  const currentTimeEl =
    playerEl.querySelector('.current-time');

  const durationEl =
    playerEl.querySelector('.duration');

  const videoTime =
    playerEl.querySelector('.video-time');

  const seekbar =
    playerEl.querySelector('.seekbar');

  const volumeSlider =
    playerEl.querySelector('.volume-slider');

  const muteBtn =
    playerEl.querySelector('.mute-btn');

  const fullscreenBtn =
    playerEl.querySelector('.fullscreen-btn');

  const downloadBtn =
    playerEl.querySelector('.download-btn');

  const volumeWrap =
    playerEl.querySelector('.video-volume-wrap');

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
      return (
        `${hours}:` +
        `${String(minutes).padStart(2, '0')}:` +
        `${String(secs).padStart(2, '0')}`
      );
    }

    return (
      `${minutes}:` +
      `${String(secs).padStart(2, '0')}`
    );
  };

  const isTouch =
    window.matchMedia(
      '(hover:none)'
    ).matches;

  const updateSeekFill = () => {
    const max =
      Number(seekbar.max);

    const value =
      Number(seekbar.value);

    const percent =
      max > 0
        ? (value / max) * 100
        : 0;

    seekbar.style.backgroundSize =
      `${percent}% 100%`;
  };

  const updateVolumeFill = () => {
    const max =
      Number(volumeSlider.max) || 1;

    const value =
      Number(volumeSlider.value);

    const percent =
      max > 0
        ? (value / max) * 100
        : 0;

    volumeSlider.style.backgroundSize =
      `${percent}% 100%`;
  };

  // ====================================================
  // RENDERING DEBUG
  // ====================================================

  const getRect = (element) => {
    if (!element) {
      return 'null';
    }

    const rect =
      element.getBoundingClientRect();

    return (
      `${Math.round(rect.x)},` +
      `${Math.round(rect.y)} ` +
      `${Math.round(rect.width)}x` +
      `${Math.round(rect.height)}`
    );
  };

  const getComputed = (element) => {
    if (!element) {
      return null;
    }

    const style =
      getComputedStyle(element);

    return {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      position: style.position,
      zIndex: style.zIndex,
      transform: style.transform,
      filter: style.filter,
      overflow: style.overflow,
      objectFit: style.objectFit,
      width: style.width,
      height: style.height,
      maxWidth: style.maxWidth,
      maxHeight: style.maxHeight,
      aspectRatio: style.aspectRatio,
      backgroundColor: style.backgroundColor
    };
  };

  const logRenderState = (label) => {
    const rect =
      video.getBoundingClientRect();

    const playerRect =
      playerEl.getBoundingClientRect();

    const videoStyle =
      getComputed(video);

    const playerStyle =
      getComputed(playerEl);

    console.log(
      `[Video] ${label}:`,
      'id=', msg.id,
      'readyState=', video.readyState,
      'networkState=', video.networkState,
      'paused=', video.paused,
      'ended=', video.ended,
      'currentTime=', video.currentTime,
      'video=', `${video.videoWidth}x${video.videoHeight}`,
      'client=', `${video.clientWidth}x${video.clientHeight}`,
      'offset=', `${video.offsetWidth}x${video.offsetHeight}`,
      'rect=', getRect(video),
      'player=', `${playerEl.clientWidth}x${playerEl.clientHeight}`,
      'playerRect=', getRect(playerEl),
      'display=', videoStyle?.display,
      'visibility=', videoStyle?.visibility,
      'opacity=', videoStyle?.opacity,
      'objectFit=', videoStyle?.objectFit,
      'transform=', videoStyle?.transform,
      'filter=', videoStyle?.filter,
      'playerTransform=', playerStyle?.transform,
      'playerFilter=', playerStyle?.filter
    );

    console.log(
      `[Video] ${label} geometry:`,
      `videoRect=${Math.round(rect.width)}x${Math.round(rect.height)}`,
      `playerRect=${Math.round(playerRect.width)}x${Math.round(playerRect.height)}`,
      `videoClient=${video.clientWidth}x${video.clientHeight}`,
      `videoOffset=${video.offsetWidth}x${video.offsetHeight}`,
      `scroll=${window.scrollX},${window.scrollY}`
    );
  };

  // ====================================================
  // PARENT / ANCESTOR DEBUG
  // ====================================================

  const logAncestors = () => {
    let element = video.parentElement;
    let level = 1;

    while (
      element &&
      level <= 6
    ) {
      const style =
        getComputedStyle(element);

      const rect =
        element.getBoundingClientRect();

      console.log(
        `[Video] Ancestor ${level}:`,
        element.tagName,
        element.className || '(no-class)',
        `rect=${Math.round(rect.width)}x${Math.round(rect.height)}`,
        `display=${style.display}`,
        `visibility=${style.visibility}`,
        `opacity=${style.opacity}`,
        `position=${style.position}`,
        `overflow=${style.overflow}`,
        `transform=${style.transform}`,
        `filter=${style.filter}`,
        `contain=${style.contain}`,
        `zIndex=${style.zIndex}`
      );

      element =
        element.parentElement;

      level++;
    }
  };

  // ====================================================
  // FULLSCREEN STATE
  // ====================================================

  const isPlayerFullscreen = () => {
    return (
      document.fullscreenElement === playerEl ||
      document.webkitFullscreenElement === playerEl
    );
  };

  const updateVideoTimeVisibility = () => {
    if (!videoTime) {
      return;
    }

    videoTime.style.display =
      isPlayerFullscreen()
        ? ''
        : 'none';
  };

  playerEl.addEventListener(
    'fullscreenchange',
    updateVideoTimeVisibility
  );

  playerEl.addEventListener(
    'webkitfullscreenchange',
    updateVideoTimeVisibility
  );

  // ====================================================
  // ANDROID / WEBVIEW FIRST-FRAME PRIME STATE
  // ====================================================

  let firstFramePrimed = false;
  let primingFirstFrame = false;

  // ====================================================
  // PLAY / PAUSE
  // ====================================================

  playBtn.addEventListener(
    'click',
    () => {
      if (video.paused) {
        video.play().catch((error) => {
          console.error(
            '[Video] Playback failed:',
            error
          );
        });
      } else {
        video.pause();
      }
    }
  );

  video.addEventListener(
    'play',
    () => {
      /*
       * Internal first-frame priming should not make
       * the controls visibly switch to the pause icon.
       */
      if (!primingFirstFrame) {
        iconPlay.style.display = 'none';
        iconPause.style.display = 'block';
      }

      console.log(
        '[Video] play event:',
        msg.id,
        'currentTime=',
        video.currentTime
      );
    }
  );

  video.addEventListener(
    'pause',
    () => {
      if (!primingFirstFrame) {
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
      }

      console.log(
        '[Video] pause event:',
        msg.id,
        'currentTime=',
        video.currentTime
      );
    }
  );

  // ====================================================
  // ANDROID / WEBVIEW FIRST-FRAME PRIME
  // ====================================================
  //
  // Some Android WebView video pipelines can decode the first
  // frame while paused but not submit that frame to the
  // compositor until playback actually starts.
  //
  // We briefly start muted playback, wait for a real frame
  // submission, then pause again.
  //
  // This is intentionally done only once.
  //

  const primeFirstFrame = async () => {
    if (
      firstFramePrimed ||
      primingFirstFrame
    ) {
      return;
    }

    if (!video.paused) {
      console.log(
        '[Video] First-frame prime skipped: video already playing'
      );
      return;
    }

    firstFramePrimed = true;
    primingFirstFrame = true;

    const wasMuted = video.muted;
    const wasVolume = video.volume;
    const wasCurrentTime =
      video.currentTime;

    console.log(
      '[Video] Priming first frame:',
      msg.id,
      'currentTime=',
      wasCurrentTime,
      'readyState=',
      video.readyState
    );

    // Muted playback avoids audible autoplay restrictions.
    video.muted = true;

    let frameCallbackId = null;
    let timeoutId = null;

    try {
      /*
       * requestVideoFrameCallback fires when a new frame
       * has been submitted toward the compositor.
       */
      const framePresented =
        typeof video.requestVideoFrameCallback ===
        'function'
          ? new Promise((resolve) => {
              frameCallbackId =
                video.requestVideoFrameCallback(
                  (now, metadata) => {
                    console.log(
                      '[Video] First-frame prime callback:',
                      msg.id,
                      'mediaTime=',
                      metadata.mediaTime,
                      'presentedFrames=',
                      metadata.presentedFrames,
                      'expectedDisplayTime=',
                      metadata.expectedDisplayTime,
                      'width=',
                      metadata.width,
                      'height=',
                      metadata.height
                    );

                    resolve(true);
                  }
                );
            })
          : Promise.resolve(false);

      /*
       * Start playback immediately.
       *
       * If the decoder is not ready yet, play() waits internally.
       * This lets decoder / Surface initialization begin as early
       * as possible instead of waiting for loadeddata first.
       */
      const playPromise =
        video.play();

      if (playPromise) {
        await playPromise;
      }

      /*
       * Safety timeout.
       *
       * Normally the frame callback wins long before this.
       */
      const timeout =
        new Promise((resolve) => {
          timeoutId = setTimeout(
            () => resolve(false),
            1000
          );
        });

      const frameWasPresented =
        await Promise.race([
          framePresented,
          timeout
        ]);

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      console.log(
        '[Video] First-frame prime result:',
        msg.id,
        'framePresented=',
        frameWasPresented,
        'currentTime=',
        video.currentTime
      );

      /*
       * Stop immediately after the compositor has received
       * a frame.
       */
      video.pause();

      /*
       * Do not seek back to 0 for tiny movements.
       *
       * On some Android hardware a seek can make the decoder
       * reset/reinitialize the Surface, defeating the purpose
       * of the prime.
       *
       * Only restore the original position if the video moved
       * by a meaningful amount.
       */
      if (
        Number.isFinite(wasCurrentTime) &&
        Math.abs(
          video.currentTime -
            wasCurrentTime
        ) > 0.05
      ) {
        try {
          video.currentTime =
            wasCurrentTime;
        } catch (seekError) {
          console.warn(
            '[Video] Failed to restore currentTime after prime:',
            seekError
          );
        }
      }

      if (
        Number.isFinite(wasCurrentTime) &&
        wasCurrentTime === 0
      ) {
        seekbar.value = 0;
        updateSeekFill();
      }
    } catch (error) {
      console.warn(
        '[Video] First-frame prime failed:',
        msg.id,
        error
      );

      try {
        video.pause();
      } catch {
        // Ignore pause failures.
      }

      if (
        frameCallbackId !== null &&
        typeof video.cancelVideoFrameCallback ===
          'function'
      ) {
        try {
          video.cancelVideoFrameCallback(
            frameCallbackId
          );
        } catch {
          // Ignore cancellation failures.
        }
      }
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      video.muted = wasMuted;
      video.volume = wasVolume;

      primingFirstFrame = false;

      console.log(
        '[Video] First-frame prime finished:',
        msg.id,
        'paused=',
        video.paused,
        'currentTime=',
        video.currentTime,
        'muted=',
        video.muted,
        'volume=',
        video.volume
      );

      logRenderState(
        'After first-frame prime'
      );
    }
  };

  // ====================================================
  // METADATA
  // ====================================================

  video.addEventListener(
    'loadedmetadata',
    () => {
      const duration =
        Number.isFinite(video.duration)
          ? video.duration
          : 0;

      seekbar.max = duration;
      seekbar.value = 0;

      durationEl.textContent =
        formatTime(duration);

      updateSeekFill();

      if (
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        playerEl.style.aspectRatio =
          `${video.videoWidth} / ${video.videoHeight}`;
      }

      console.log(
        '[Video] Metadata:',
        msg.id,
        'size=',
        `${video.videoWidth}x${video.videoHeight}`,
        'duration=',
        duration,
        'aspect=',
        playerEl.style.aspectRatio
      );

      logRenderState(
        'After metadata'
      );

      /*
       * Start the Android/WebView prime as early as possible.
       *
       * play() can wait internally until enough media data
       * is available, so we don't need to wait for loadeddata.
       */
      if (
        video.paused &&
        !firstFramePrimed
      ) {
        primeFirstFrame();
      }
    }
  );

  // ====================================================
  // FIRST FRAME
  // ====================================================

  video.addEventListener(
    'loadeddata',
    () => {
      console.log(
        '[Video] First frame ready:',
        msg.id,
        'readyState=',
        video.readyState,
        'currentTime=',
        video.currentTime,
        'size=',
        `${video.videoWidth}x${video.videoHeight}`,
        'duration=',
        video.duration
      );

      logRenderState(
        'First frame'
      );

      logAncestors();

      console.log(
        '[Video] Visibility test:',
        'hidden=',
        video.hidden,
        'ariaHidden=',
        video.getAttribute(
          'aria-hidden'
        ),
        'class=',
        video.className || '(none)'
      );

      /*
       * Debug callback.
       *
       * This callback is separate from the actual prime.
       * It tells us whether a real frame reached the compositor.
       */
      if (
        typeof video.requestVideoFrameCallback ===
        'function'
      ) {
        video.requestVideoFrameCallback(
          (now, metadata) => {
            console.log(
              '[Video] Video frame callback:',
              msg.id,
              'mediaTime=',
              metadata.mediaTime,
              'presentedFrames=',
              metadata.presentedFrames,
              'expectedDisplayTime=',
              metadata.expectedDisplayTime,
              'width=',
              metadata.width,
              'height=',
              metadata.height
            );

            logRenderState(
              'After video frame callback'
            );
          }
        );
      } else {
        console.log(
          '[Video] requestVideoFrameCallback: NOT SUPPORTED'
        );
      }

      /*
       * Run once more after the browser gets a chance
       * to perform layout/compositing.
       */
      requestAnimationFrame(() => {
        logRenderState(
          'requestAnimationFrame #1'
        );

        requestAnimationFrame(() => {
          logRenderState(
            'requestAnimationFrame #2'
          );
        });
      });

      /*
       * IMPORTANT:
       *
       * primeFirstFrame() is NOT called here anymore.
       * It already starts from loadedmetadata, earlier in
       * the media pipeline.
       */
    }
  );

  // ====================================================
  // PROGRESS
  // ====================================================

  video.addEventListener(
    'timeupdate',
    () => {
      if (
        !seekbar.matches(':active')
      ) {
        seekbar.value =
          video.currentTime;

        updateSeekFill();
      }

      currentTimeEl.textContent =
        formatTime(
          video.currentTime
        );
    }
  );

  // ====================================================
  // SEEK
  // ====================================================

  seekbar.addEventListener(
    'input',
    () => {
      video.currentTime =
        Number(seekbar.value);

      updateSeekFill();
    }
  );

  // ====================================================
  // VOLUME
  // ====================================================

  volumeSlider.addEventListener(
    'input',
    () => {
      const volume =
        Number(volumeSlider.value);

      video.volume = volume;
      video.muted = volume === 0;

      updateVolumeFill();
    }
  );

  muteBtn.addEventListener(
    'click',
    () => {
      video.muted = !video.muted;

      if (
        !video.muted &&
        video.volume === 0
      ) {
        video.volume = 1;
      }

      volumeSlider.value =
        video.muted
          ? 0
          : video.volume;

      updateVolumeFill();

      if (isTouch) {
        volumeWrap.classList.toggle(
          'open'
        );
      }
    }
  );

  // ====================================================
  // DOWNLOAD
  // ====================================================

  downloadBtn.addEventListener(
    'click',
    (e) => {
      e.stopPropagation();

      downloadAttachment(
        msg.id,
        msg.attachment_name,
        scope
      );
    }
  );

  // ====================================================
  // FULLSCREEN
  // ====================================================

  fullscreenBtn.addEventListener(
    'click',
    async () => {
      await toggleFullscreen();
    }
  );

  async function toggleFullscreen() {
    try {
      const isFullscreen =
        document.fullscreenElement ||
        document.webkitFullscreenElement;

      if (!isFullscreen) {
        if (playerEl.requestFullscreen) {
          await playerEl.requestFullscreen();
        } else if (
          playerEl.webkitRequestFullscreen
        ) {
          playerEl.webkitRequestFullscreen();
        } else if (
          video.webkitEnterFullscreen
        ) {
          video.webkitEnterFullscreen();
        }
      } else if (
        document.exitFullscreen
      ) {
        await document.exitFullscreen();
      } else if (
        document.webkitExitFullscreen
      ) {
        document.webkitExitFullscreen();
      }
    } catch (error) {
      console.warn(
        '[Video] Fullscreen failed:',
        error
      );
    }
  }

  // ====================================================
  // DOUBLE CLICK
  // ====================================================

  video.addEventListener(
    'dblclick',
    () => {
      video.focus();

      if (video.paused) {
        video.play().catch((error) => {
          console.error(
            '[Video] Play failed:',
            error
          );
        });
      } else {
        video.pause();
      }
    }
  );

  // ====================================================
  // KEYBOARD
  // ====================================================

  playerEl.addEventListener(
    'keydown',
    async (e) => {
      const tag =
        e.target.tagName.toLowerCase();

      if (
        tag === 'button' ||
        tag === 'input' ||
        tag === 'textarea'
      ) {
        return;
      }

      if (
        e.key === ' ' ||
        e.code === 'Space'
      ) {
        e.preventDefault();

        if (video.paused) {
          video.play().catch((err) => {
            console.error(
              '[Video] Play failed:',
              err
            );
          });
        } else {
          video.pause();
        }
      } else if (
        e.key === 'f' ||
        e.key === 'F'
      ) {
        e.preventDefault();

        await toggleFullscreen();
      }
    }
  );

  // ====================================================
  // TAP-TO-TOGGLE CONTROLS
  // ====================================================

  if (isTouch) {
    let hideTimer = null;

    const scheduleAutoHide = () => {
      clearTimeout(hideTimer);

      hideTimer = setTimeout(() => {
        if (!video.paused) {
          playerEl.classList.add(
            'controls-hidden'
          );
        }
      }, 2500);
    };

    video.addEventListener(
      'click',
      (e) => {
        if (
          e.target.closest(
            '.video-player-controls'
          )
        ) {
          return;
        }

        playerEl.classList.toggle(
          'controls-hidden'
        );

        if (
          !playerEl.classList.contains(
            'controls-hidden'
          )
        ) {
          scheduleAutoHide();
        }
      }
    );

    video.addEventListener(
      'play',
      scheduleAutoHide
    );

    video.addEventListener(
      'pause',
      () => {
        clearTimeout(hideTimer);

        playerEl.classList.remove(
          'controls-hidden'
        );
      }
    );
  }

  // ====================================================
  // INITIAL STATE
  // ====================================================

  updateVolumeFill();

  // ====================================================
  // DEBUG EVENTS
  // ====================================================

  video.addEventListener(
    'loadstart',
    () => {
      console.log(
        '[Video] Load started:',
        video.currentSrc
      );
    }
  );

  video.addEventListener(
    'error',
    () => {
      const error =
        video.error;

      console.error(
        '[Video] Video error:',
        msg.id,
        'code=',
        error?.code,
        'message=',
        error?.message || '(none)',
        'networkState=',
        video.networkState,
        'readyState=',
        video.readyState,
        'src=',
        video.currentSrc
      );
    }
  );

  video.addEventListener(
    'stalled',
    () => {
      console.warn(
        '[Video] Network stalled:',
        msg.id,
        'readyState=',
        video.readyState,
        'networkState=',
        video.networkState
      );
    }
  );

  video.addEventListener(
    'waiting',
    () => {
      console.log(
        '[Video] Waiting:',
        msg.id,
        'readyState=',
        video.readyState,
        'networkState=',
        video.networkState,
        'currentTime=',
        video.currentTime
      );
    }
  );

  video.addEventListener(
    'canplay',
    () => {
      console.log(
        '[Video] Can play:',
        msg.id,
        'readyState=',
        video.readyState,
        'networkState=',
        video.networkState,
        'paused=',
        video.paused
      );
    }
  );

  video.addEventListener(
    'canplaythrough',
    () => {
      console.log(
        '[Video] Can play through:',
        msg.id,
        'readyState=',
        video.readyState
      );
    }
  );

  video.addEventListener(
    'playing',
    () => {
      console.log(
        '[Video] Playing:',
        msg.id,
        'currentTime=',
        video.currentTime
      );

      logRenderState(
        'Playing'
      );
    }
  );

  video.addEventListener(
    'resize',
    () => {
      console.log(
        '[Video] Video resize:',
        msg.id,
        'size=',
        `${video.videoWidth}x${video.videoHeight}`
      );

      logRenderState(
        'After video resize'
      );
    }
  );

  // ====================================================
  // INITIAL DEBUG
  // ====================================================

  console.log(
    '[Video] Player inserted:',
    msg.id,
    'videoSrc=',
    video.src,
    'currentSrc=',
    video.currentSrc,
    'readyState=',
    video.readyState,
    'networkState=',
    video.networkState,
    'paused=',
    video.paused,
    'autoplay=',
    video.autoplay,
    'muted=',
    video.muted,
    'playsInline=',
    video.playsInline,
    'controls=',
    video.controls
  );

  logRenderState(
    'Immediately after insertion'
  );
}
