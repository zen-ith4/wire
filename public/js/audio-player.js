import { ICONS } from './icons.js';
import { escapeAttr, escapeHtml } from './utils.js';

// ======================================================
// AUDIO DETECTION
// ======================================================

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'aac', 'wma', 'm4a', 'opus', 'weba'];

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
// TOKEN
// ======================================================

function getMediaToken() {
  return localStorage.getItem('token') || '';
}

// ======================================================
// MEDIA URL
// ======================================================

function getAudioUrl(msg, scope) {
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
// AUDIO PLAYER
// ======================================================

// `containerEl` is the message's own element (built by
// buildChatMessageEl/buildDmMessageEl), passed in directly by
// mountAttachmentMedia() in attachments.js. It does not need to be
// attached to the document yet - everything here is scoped to
// `containerEl`, never to the global document, so there is no
// dependency on DOM insertion order/timing.
export function renderAudio(msg, scope, containerEl) {
  const messageId = String(msg.id);

  const container =
    containerEl ||
    document.querySelector(
      `.chat-msg[data-msg-id="${CSS.escape(messageId)}"]`
    );

  if (!container) {
    console.error('Audio container not found for message:', msg.id);
    return;
  }

  const playerId = `aplayer-${messageId}`;

  // Prevent duplicate players
  if (container.querySelector(`#${CSS.escape(playerId)}`)) {
    return;
  }

  const attachmentUrl = getAudioUrl(msg, scope);
  const filename = msg.attachment_name || 'Audio';

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
        <div class="audio-player-title" title="${escapeAttr(filename)}">${escapeHtml(filename)}</div>
        <span class="audio-player-current-time">0:00</span>
        <span class="audio-player-duration">0:00</span>
      </div>

      <div class="audio-player-controls">
        <button class="audio-player-play" type="button" title="Play">
          <span class="icon-play">${ICONS.play}</span>
          <span class="icon-pause" style="display:none">${ICONS.pause}</span>
        </button>

        <div class="audio-player-waveform">
          <canvas class="audio-player-canvas"></canvas>
          <div class="audio-player-progress-fill"></div>
        </div>

        <div class="audio-player-volume-control">
          <button class="audio-player-volume" type="button" title="Mute">${ICONS.volume}</button>
          <div class="audio-player-volume-slider-wrap">
            <input type="range" class="audio-player-volume-slider" min="0" max="1" step="0.01" value="1">
          </div>
        </div>

        <button
          type="button"
          class="audio-player-download"
          title="Download ${escapeAttr(filename)}"
          onclick="window.downloadAttachment(${msg.id}, '${escapeAttr(filename)}', '${scope}')"
        >${ICONS.download}</button>
      </div>

      <div class="audio-player-error">${ICONS.alert} Failed to load audio</div>

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
    container.querySelector('.chat-msg-content') || container;

  contentWrapper.insertAdjacentHTML('beforeend', template);

  // ====================================================
  // ELEMENTS
  //
  // IMPORTANT: not document.getElementById() - see the identical
  // note in video-player.js. `containerEl` may not be attached to
  // the document yet when this runs, so a document-wide lookup would
  // silently miss the just-inserted node and skip listener wiring
  // entirely, leaving a visible-but-inert player.
  // ====================================================

  const playerEl = contentWrapper.lastElementChild;
  const audio = playerEl ? playerEl.querySelector('audio') : null;

  if (!playerEl || !audio) {
    console.error('Audio player element not found after insertion for message:', msg.id);
    return;
  }

  const playBtn = playerEl.querySelector('.audio-player-play');
  const iconPlay = playerEl.querySelector('.icon-play');
  const iconPause = playerEl.querySelector('.icon-pause');
  const currentTimeEl = playerEl.querySelector('.audio-player-current-time');
  const durationEl = playerEl.querySelector('.audio-player-duration');
  const waveform = playerEl.querySelector('.audio-player-waveform');
  const progressFill = playerEl.querySelector('.audio-player-progress-fill');
  const volumeBtn = playerEl.querySelector('.audio-player-volume');
  const volumeSlider = playerEl.querySelector('.audio-player-volume-slider');
  const errorEl = playerEl.querySelector('.audio-player-error');

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

  const updateProgressFill = () => {
    const duration = audio.duration;
    const pct =
      Number.isFinite(duration) && duration > 0
        ? (audio.currentTime / duration) * 100
        : 0;
    progressFill.style.width = `${pct}%`;
  };

  const updateVolumeSliderFill = () => {
    const pct = Math.round(Number(volumeSlider.value) * 100);
    volumeSlider.style.background = `linear-gradient(to right, rgb(var(--indigo)) 0%, rgb(var(--indigo)) ${pct}%, var(--border-soft) ${pct}%, var(--border-soft) 100%)`;
  };

  const setLoading = (isLoading) => {
    playerEl.classList.toggle('loading', isLoading);
  };

  const seekToClientX = (clientX) => {
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const rect = waveform.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    updateProgressFill();
  };

  // ====================================================
  // PLAY / PAUSE
  // ====================================================

  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      audio.play().catch((error) => {
        console.error('Audio playback failed:', error);
      });
    } else {
      audio.pause();
    }
  });

  audio.addEventListener('play', () => {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
  });

  audio.addEventListener('pause', () => {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
  });

  // ====================================================
  // LOADING / METADATA
  // ====================================================

  setLoading(true);

  audio.addEventListener('loadedmetadata', () => {
    setLoading(false);
    const duration = audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      durationEl.textContent = formatTime(duration);
    }
    updateProgressFill();
  });

  // Note: deliberately NOT re-enabling the 'loading' class (which
  // sets pointer-events:none via CSS) on 'waiting'. That event fires
  // for ordinary mid-playback buffering stalls with a streamed file,
  // and blocking the whole player - including Pause/Mute - every
  // time the network pauses briefly would look exactly like "the
  // controls don't respond" to a user who just wants to pause during
  // a stall. The loading state here only covers the initial
  // pre-metadata window, before there's anything meaningful to
  // interact with yet.
  audio.addEventListener('canplay', () => setLoading(false));

  // ====================================================
  // PROGRESS
  // ====================================================

  audio.addEventListener('timeupdate', () => {
    currentTimeEl.textContent = formatTime(audio.currentTime);
    updateProgressFill();
  });

  audio.addEventListener('ended', () => {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
  });

  // ====================================================
  // SEEK (click / drag on the waveform bar)
  // ====================================================

  let scrubbing = false;

  waveform.addEventListener('mousedown', (e) => {
    scrubbing = true;
    seekToClientX(e.clientX);
  });

  window.addEventListener('mousemove', (e) => {
    if (!scrubbing) return;
    seekToClientX(e.clientX);
  });

  window.addEventListener('mouseup', () => {
    scrubbing = false;
  });

  waveform.addEventListener('click', (e) => {
    seekToClientX(e.clientX);
  });

  // ====================================================
  // VOLUME
  // ====================================================

  updateVolumeSliderFill();

  volumeSlider.addEventListener('input', () => {
    const volume = Number(volumeSlider.value);
    audio.volume = volume;
    audio.muted = volume === 0;
    updateVolumeSliderFill();
  });

  volumeBtn.addEventListener('click', () => {
    audio.muted = !audio.muted;
    if (!audio.muted && audio.volume === 0) {
      audio.volume = 1;
    }
    volumeSlider.value = audio.muted ? 0 : audio.volume;
    updateVolumeSliderFill();
  });

  // ====================================================
  // ERRORS
  // ====================================================

  audio.addEventListener('error', () => {
    setLoading(false);
    const error = audio.error;
    console.error('Audio error:', {
      code: error?.code,
      message: error?.message,
      src: audio.currentSrc
    });
    errorEl.style.display = 'flex';
  });
}
