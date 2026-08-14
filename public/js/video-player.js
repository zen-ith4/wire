import { ICONS } from './icons.js';

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
// TOKEN
// ======================================================

function getMediaToken() {
  return localStorage.getItem('token') || '';
}

// ======================================================
// MEDIA URL
// ======================================================

function getVideoUrl(msg, scope) {
  const baseUrl =
    scope === 'dm'
      ? `/api/dm/attachments/${encodeURIComponent(msg.id)}`
      : `/api/chat/attachments/${encodeURIComponent(msg.id)}`;

  const token = getMediaToken();

  if (!token) {
    return baseUrl;
  }

  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}

// ======================================================
// VIDEO PLAYER
// ======================================================

export function renderVideo(msg, scope, containerEl) {
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

  const attachmentUrl = getVideoUrl(msg, scope);

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

        <div class="video-time">
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

  const contentWrapper = container.querySelector('.chat-msg-content') || container;
  contentWrapper.insertAdjacentHTML('beforeend', template);

  const playerEl = contentWrapper.lastElementChild;
  const video = playerEl ? playerEl.querySelector('video') : null;

  if (!playerEl || !video) {
    console.error('Video player element not found after insertion for message:', msg.id);
    return;
  }

  const playBtn = playerEl.querySelector('.play-btn');
  const iconPlay = playerEl.querySelector('.icon-play');
  const iconPause = playerEl.querySelector('.icon-pause');
  const currentTimeEl = playerEl.querySelector('.current-time');
  const durationEl = playerEl.querySelector('.duration');
  const seekbar = playerEl.querySelector('.seekbar');
  const volumeSlider = playerEl.querySelector('.volume-slider');
  const muteBtn = playerEl.querySelector('.mute-btn');
  const fullscreenBtn = playerEl.querySelector('.fullscreen-btn');

  // ====================================================
  // HELPERS
  // ====================================================

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  };

  const updateSeekFill = () => {
    const max = Number(seekbar.max);
    const value = Number(seekbar.value);
    const percent = max > 0 ? (value / max) * 100 : 0;
    seekbar.style.backgroundSize = `${percent}% 100%`;
  };

  const updateVolumeFill = () => {
    const max = Number(volumeSlider.max) || 1;
    const value = Number(volumeSlider.value);
    const percent = max > 0 ? (value / max) * 100 : 0;
    volumeSlider.style.backgroundSize = `${percent}% 100%`;
  };

  // ====================================================
  // PLAY / PAUSE
  // ====================================================

  playBtn.addEventListener('click', () => {
    if (video.paused) {
      video.play().catch((error) => console.error('Video playback failed:', error));
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
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    seekbar.max = duration;
    seekbar.value = 0;
    durationEl.textContent = formatTime(duration);
    updateSeekFill();
  });

  video.addEventListener('timeupdate', () => {
    if (!seekbar.matches(':active')) {
      seekbar.value = video.currentTime;
      updateSeekFill();
    }
    currentTimeEl.textContent = formatTime(video.currentTime);
  });

  // ====================================================
  // SEEK & VOLUME
  // ====================================================

  seekbar.addEventListener('input', () => {
    video.currentTime = Number(seekbar.value);
    updateSeekFill();
  });

  volumeSlider.addEventListener('input', () => {
    const volume = Number(volumeSlider.value);
    video.volume = volume;
    video.muted = volume === 0;
    updateVolumeFill();
  });

  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) {
      video.volume = 1;
    }
    volumeSlider.value = video.muted ? 0 : video.volume;
    updateVolumeFill();
  });

  // ====================================================
  // FULLSCREEN BUTTON
  // ====================================================

  fullscreenBtn.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) {
        await playerEl.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.warn('Fullscreen failed:', error);
    }
  });

  // ====================================================
  // VIDEO CLICK
  // ====================================================
  let lastVideoClick = 0;

  video.addEventListener('dblclick', (e) => {
    const now = Date.now();
    // Ignore the first click of a rapid double-click
    if (now - lastVideoClick < 300) return;
    lastVideoClick = now;

    video.focus();
    if (video.paused) {
      video.play().catch(error => console.error('Play failed:', error));
    } else {
      video.pause();
    }
  });

  // ====================================================
  // KEYBOARD (SPACEBAR: PLAY/PAUSE | F: FULLSCREEN)
  // ====================================================
  playerEl.addEventListener('keydown', async (e) => {
    const tag = e.target.tagName.toLowerCase();

    // Ignore native inputs/buttons so they function normally
    if (tag === 'button' || tag === 'input' || tag === 'textarea') {
      return; 
    }

    // Spacebar -> Play / Pause
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (video.paused) {
        video.play().catch(err => console.error('Play failed:', err));
      } else {
        video.pause();
      }
    } 
    // F key -> Toggle Fullscreen
    else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      try {
        if (!document.fullscreenElement) {
          await playerEl.requestFullscreen();
        } else {
          await document.exitFullscreen();
        }
      } catch (error) {
        console.warn('Fullscreen failed:', error);
      }
    }
  });

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
    console.warn('Video network stalled:', video.currentSrc);
  });
  video.addEventListener('waiting', () => {});
  video.addEventListener('canplay', () => {
    console.log('Video can play:', video.currentSrc);
  });
}