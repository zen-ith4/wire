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
// MEDIA URL
// ======================================================
//
// Attachment playback URLs carry a short-lived, attachment-scoped
// token (see media/mediaToken.js) rather than the long-lived session
// JWT that used to be read straight out of localStorage.
//
// getMediaSrcUrl() intentionally returns a relative URL so it works
// in a normal browser. Capacitor's WebView, however, treats a
// relative URL as https://localhost/... and therefore tries to open
// the API path as a local asset.
//
// Resolve it against the actual Wire server before assigning it to
// <video>.src.


// ======================================================
// VIDEO PLAYER
// ======================================================

export async function renderVideo(msg, scope, containerEl) {
  const messageId = String(msg.id);

  const container =
    containerEl ||
    document.querySelector(
      `.chat-msg[data-msg-id="${CSS.escape(messageId)}"]`
    );

  if (!container) {
    console.error('Video container not found for message:', msg.id);
    return;
  }

  // Prevent duplicate players
  if (container.querySelector(`#vplayer-${CSS.escape(messageId)}`)) {
    return;
  }

  // Get the short-lived attachment-scoped media URL.
  const relativeAttachmentUrl = await getMediaSrcUrl(
    scope,
    msg.id
  );

  // Resolve the relative API URL against the real server.
  // This is especially important inside Capacitor, where the WebView
  // origin is https://localhost.
  const attachmentUrl = resolveServerUrl(
    relativeAttachmentUrl
  );

  console.log(
    '[Video] Media URL:',
    relativeAttachmentUrl,
    '→',
    attachmentUrl
  );

  // The container may have been removed (or a duplicate player
  // already inserted by a concurrent render) while we were waiting
  // on the token request above.
  if (
    !document.body.contains(container) ||
    container.querySelector(`#vplayer-${CSS.escape(messageId)}`)
  ) {
    return;
  }

  // ====================================================
  // TEMPLATE
  // ====================================================

  const template = `
    <div
      class="video-player"
      id="vplayer-${CSS.escape(messageId)}"
    >
      <video
        id="video-${CSS.escape(messageId)}"
        src="${attachmentUrl}"
        preload="metadata"
        playsinline
        tabindex="0"
      ></video>

      <div class="video-player-controls">
        <button
          class="video-ctrl-btn play-btn"
          title="Play"
          type="button"
        >
          <span class="icon-play">${ICONS.play}</span>
          <span class="icon-pause" style="display:none">${ICONS.pause}</span>
        </button>

        <!-- Hidden outside fullscreen; shown only while this player is fullscreen -->
        <div class="video-time" style="display:none">
          <span class="current-time">0:00</span>
          <span class="sep">/</span>
          <span class="duration">0:00</span>
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
    container.querySelector('.chat-msg-content') || container;

  contentWrapper.insertAdjacentHTML('beforeend', template);

  const playerEl = contentWrapper.lastElementChild;
  const video = playerEl
    ? playerEl.querySelector('video')
    : null;

  if (!playerEl || !video) {
    console.error(
      'Video player element not found after insertion for message:',
      msg.id
    );
    return;
  }

  const playBtn = playerEl.querySelector('.play-btn');
  const iconPlay = playerEl.querySelector('.icon-play');
  const iconPause = playerEl.querySelector('.icon-pause');
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

  // ====================================================
  // HELPERS
  // ====================================================

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) {
      seconds = 0;
    }

    const hours = Math.floor(seconds / 3600);
    const minutes =
      Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    return `${minutes}:${String(secs).padStart(2, '0')}`;
  };

  // No real hover on touch — matches the CSS `(hover:none)`
  // feature query so JS and CSS agree on what "touch" means here.
  const isTouch =
    window.matchMedia('(hover:none)').matches;

  const updateSeekFill = () => {
    const max = Number(seekbar.max);
    const value = Number(seekbar.value);
    const percent =
      max > 0 ? (value / max) * 100 : 0;

    seekbar.style.backgroundSize =
      `${percent}% 100%`;
  };

  const updateVolumeFill = () => {
    const max =
      Number(volumeSlider.max) || 1;
    const value =
      Number(volumeSlider.value);
    const percent =
      max > 0 ? (value / max) * 100 : 0;

    volumeSlider.style.backgroundSize =
      `${percent}% 100%`;
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
    if (!videoTime) return;

    videoTime.style.display =
      isPlayerFullscreen() ? '' : 'none';
  };

  document.addEventListener(
    'fullscreenchange',
    updateVideoTimeVisibility
  );

  document.addEventListener(
    'webkitfullscreenchange',
    updateVideoTimeVisibility
  );

  // ====================================================
  // PLAY / PAUSE
  // ====================================================

  playBtn.addEventListener('click', () => {
    if (video.paused) {
      video
        .play()
        .catch((error) =>
          console.error(
            'Video playback failed:',
            error
          )
        );
    } else {
      video.pause();
    }
  });

  video.addEventListener('play', () => {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
  });

  video.addEventListener('pause', () => {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
  });

  // ====================================================
  // METADATA & PROGRESS
  // ====================================================

  video.addEventListener('loadedmetadata', () => {
    const duration =
      Number.isFinite(video.duration)
        ? video.duration
        : 0;

    seekbar.max = duration;
    seekbar.value = 0;

    durationEl.textContent =
      formatTime(duration);

    updateSeekFill();

    // Portrait vs. landscape: the CSS default (16/9) is
    // a reasonable placeholder before metadata loads.
    if (
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      playerEl.style.aspectRatio =
        `${video.videoWidth} / ${video.videoHeight}`;
    }
  });

  video.addEventListener('timeupdate', () => {
    if (!seekbar.matches(':active')) {
      seekbar.value = video.currentTime;
      updateSeekFill();
    }

    currentTimeEl.textContent =
      formatTime(video.currentTime);
  });

  // ====================================================
  // SEEK & VOLUME
  // ====================================================

  seekbar.addEventListener('input', () => {
    video.currentTime =
      Number(seekbar.value);

    updateSeekFill();
  });

  volumeSlider.addEventListener('input', () => {
    const volume =
      Number(volumeSlider.value);

    video.volume = volume;
    video.muted = volume === 0;

    updateVolumeFill();
  });

  const volumeWrap =
    playerEl.querySelector(
      '.video-volume-wrap'
    );

  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;

    if (
      !video.muted &&
      video.volume === 0
    ) {
      video.volume = 1;
    }

    volumeSlider.value =
      video.muted ? 0 : video.volume;

    updateVolumeFill();

    if (isTouch) {
      volumeWrap.classList.toggle('open');
    }
  });

  // ====================================================
  // DOWNLOAD
  // ====================================================

  downloadBtn.addEventListener('click', (e) => {
    e.stopPropagation();

    downloadAttachment(
      msg.id,
      msg.attachment_name,
      scope
    );
  });

  // ====================================================
  // FULLSCREEN BUTTON
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
      } else if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (
        document.webkitExitFullscreen
      ) {
        document.webkitExitFullscreen();
      }
    } catch (error) {
      console.warn(
        'Fullscreen failed:',
        error
      );
    }
  }

  // ====================================================
  // VIDEO CLICK
  // ====================================================

  let lastVideoClick = 0;

  video.addEventListener('dblclick', (e) => {
    const now = Date.now();

    if (now - lastVideoClick < 300) return;

    lastVideoClick = now;

    video.focus();

    if (video.paused) {
      video
        .play()
        .catch((error) =>
          console.error(
            'Play failed:',
            error
          )
        );
    } else {
      video.pause();
    }
  });

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
          video
            .play()
            .catch((err) =>
              console.error(
                'Play failed:',
                err
              )
            );
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

    video.addEventListener('click', (e) => {
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
    });

    video.addEventListener(
      'play',
      scheduleAutoHide
    );

    video.addEventListener('pause', () => {
      clearTimeout(hideTimer);
      playerEl.classList.remove(
        'controls-hidden'
      );
    });
  }

  // Initialize volume fill on render
  updateVolumeFill();

  // ====================================================
  // DEBUG EVENTS
  // ====================================================

  video.addEventListener('error', () => {
    const error = video.error;

    console.error('Video error:', {
      code: error?.code,
      message: error?.message,
      src: video.currentSrc
    });
  });

  video.addEventListener('stalled', () => {
    console.warn(
      'Video network stalled:',
      video.currentSrc
    );
  });

  video.addEventListener('waiting', () => {});

  video.addEventListener('canplay', () => {
    console.log(
      'Video can play:',
      video.currentSrc
    );
  });
}
