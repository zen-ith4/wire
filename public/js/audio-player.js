import { fetchBlob } from './api.js';
import { showToast } from './utils.js';
import { ICONS } from './icons.js';

// ============================================================
// Audio Player — inline audio player for chat / DM attachments.
//
// Public API:  play(msg, scope)  – starts playing a message's audio.
//              stopAll()         – stops all currently playing audio.
//
// Multiple players can coexist in the DOM.  Only one audio plays
// at a time: starting a new player pauses whatever is currently
// playing without destroying it.
// ============================================================

let currentPlaying = null; // the single player currently playing (may be null)

// Each player is reused when the same message is rendered again.
// Key = `${scope}:${msg.id}`.
const playerRegistry = new Map();

const AUDIO_VOLUME_KEY = 'audio-player-volume';
let lastUnmutedVolume = 1; // State to restore volume when unmuting

// ============================================================
// Volume Control & Cookie Persistence
// ============================================================

// Chrome/WebKit has no native pseudo-element for a range input's
// "filled" portion (Firefox has ::-moz-range-progress, WebKit doesn't),
// so we paint the fill ourselves with a two-stop gradient on the input's
// own background and keep it in sync on every value change.
function updateSliderFill(slider) {
  if (!slider) return;
  const pct = Math.max(0, Math.min(1, Number(slider.value))) * 100;
  slider.style.background =
    `linear-gradient(to right, rgb(var(--indigo)) 0%, rgb(var(--indigo)) ${pct}%, var(--border-soft) ${pct}%, var(--border-soft) 100%)`;
}

function setGlobalVolume(volume) {
  volume = Math.max(0, Math.min(1, volume));

  // 1. Persist volume using cookies (1 year expiration)
  document.cookie = `${AUDIO_VOLUME_KEY}=${volume}; path=/; max-age=31536000`;

  if (volume > 0) {
    lastUnmutedVolume = volume;
  }

  // 2. Broadcast the volume update to all registered players,
  //    even if their DOM element is currently detached from the page.
  playerRegistry.forEach((player) => {
    if (player.destroyed) return;

    if (player.audio) {
      player.audio.volume = volume;
    }

    const slider = player.el?.querySelector('.audio-player-volume-slider');
    if (slider) {
      if (slider.value !== String(volume)) {
        slider.value = volume;
      }
      updateSliderFill(slider);
    }

    const volBtn = player.el?.querySelector('.audio-player-volume');
    if (volBtn) {
      volBtn.style.opacity = volume === 0 ? '0.4' : '1';
    }
  });
}

function getGlobalVolume() {
  const match = document.cookie.match(new RegExp('(^| )' + AUDIO_VOLUME_KEY + '=([^;]+)'));
  if (match) {
    const volume = Number(match[2]);
    if (Number.isFinite(volume)) {
      return Math.max(0, Math.min(1, volume));
    }
  }
  return 1;
}

// ============================================================
// Check whether a MIME type or file extension indicates an audio format.
// ============================================================
export function isAudio(mimeTypeOrName) {
  if (!mimeTypeOrName) return false;

  const s = String(mimeTypeOrName).toLowerCase().trim();

  if (/^audio\//i.test(s)) return true;

  const dot = s.lastIndexOf('.');
  if (dot > 0) {
    const ext = s.slice(dot + 1);
    return AUDIO_EXTS.has(ext);
  }

  return AUDIO_EXTS.has(s);
}

const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'ogg', 'opus',
  'm4a', 'aac', 'flac', 'webm',
  'wma', 'aiff',
]);

// ============================================================
// MP3 ID3v2 extraction (lightweight)
// ============================================================
function extractId3(blob) {
  try {
    const view = new DataView(blob.buffer, blob.byteOffset, Math.min(blob.size, 1024 * 1024));
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
      return null;
    }
    const major = view.getUint8(3);
    if (major < 0x02 || major > 0x04) return null;

    const s1 = view.getUint8(4);
    const s2 = view.getUint8(5);
    const s3 = view.getUint8(6);
    const s4 = view.getUint8(7);
    const headerSize = ((s1 & 0x7f) << 21) | ((s2 & 0x7f) << 14) | ((s3 & 0x7f) << 7) | (s4 & 0x7f);

    let offset = 10;
    const end = Math.min(headerSize + 10, blob.size);

    while (offset < end - 9) {
      const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1),
        view.getUint8(offset + 2), view.getUint8(offset + 3));
      if (id[0] === '\0' || id[1] === '\0' || id[2] === '\0' || id[3] === '\0') break;

      if (!/[a-zA-Z0-9]{4}/.test(id)) {
        offset++;
        continue;
      }

      const fsize = view.getUint8(offset + 4) << 24 | view.getUint8(offset + 5) << 16 |
        view.getUint8(offset + 6) << 8 | view.getUint8(offset + 7);
      if (fsize <= 0 || fsize > 100000) break;

      const frameEnd = offset + 10 + fsize;
      if (frameEnd > end) break;

      let text = '';
      for (let i = 0; i < Math.min(fsize, 5000); i++) {
        const ch = view.getUint8(offset + 10 + i);
        if (ch === 0 || ch === 32) break;
        text += String.fromCharCode(ch);
      }

      if (id === 'TIT2' && !text.startsWith('\uFFFD')) {
        return { title: text.trim(), artist: undefined, album: undefined };
      }
      if (id === 'TPE1' && !text.startsWith('\uFFFD')) {
        return { title: undefined, artist: text.trim(), album: undefined };
      }
      if (id === 'TALB' && !text.startsWith('\uFFFD')) {
        return { title: undefined, artist: undefined, album: text.trim() };
      }

      offset = frameEnd;
    }
  } catch {
    // Silently ignore extraction errors
  }
  return null;
}

// ============================================================
// Helpers
// ============================================================

function getPlayerKey(msg, scope) {
  return `${scope}:${msg.id}`;
}

function updatePlaybackUI(player, isPlaying) {
  if (!player.el) return;

  const btn = player.el.querySelector('.audio-player-play');
  if (btn) {
    btn.innerHTML = isPlaying ? ICONS.pause : ICONS.play;
    btn.title = isPlaying ? 'Pause' : 'Play';
  }

  player.el.classList.toggle('playing', !!isPlaying);
  player.el.classList.toggle('paused', !isPlaying);
}

// Sync UI and global currentPlaying from the actual audio element state.
// Used when an existing player is re-attached to a newly rendered message.
function syncPlayerUI(player) {
  if (!player.el || !player.audio) return;

  const isPlaying = !player.audio.paused && !player.audio.ended;
  updatePlaybackUI(player, isPlaying);

  if (isPlaying) {
    if (currentPlaying !== player) {
      currentPlaying = player;
    }
    drawWaveform(player);
  }
}

function syncPlayerVolume(player) {
  const volume = getGlobalVolume();

  if (player.audio) {
    player.audio.volume = volume;
  }

  const slider = player.el?.querySelector('.audio-player-volume-slider');
  if (slider) {
    slider.value = String(volume);
    updateSliderFill(slider);
  }

  const volBtn = player.el?.querySelector('.audio-player-volume');
  if (volBtn) {
    volBtn.style.opacity = volume === 0 ? '0.4' : '1';
  }
}

// Attach the player element to the correct location under the message DOM.
function mountPlayer(player, msg) {
  if (!player.el) return;

  const msgEl = document.querySelector(`.chat-msg[data-msg-id="${msg.id}"]`);
  if (!msgEl) return;

  // Remove any other audio-player under this message (avoid duplicates).
  msgEl.querySelectorAll('.audio-player').forEach((el) => {
    if (el !== player.el) el.remove();
  });

  const attWrap = msgEl.querySelector(':scope > div > .chat-attachment, :scope > div > .chat-attachment-image-wrap');
  if (attWrap) {
    attWrap.replaceWith(player.el);
  } else {
    const contentDiv = msgEl.querySelector(':scope > div > .chat-bubble, :scope > div > .chat-meta');
    if (contentDiv) {
      contentDiv.after(player.el);
    } else {
      msgEl.appendChild(player.el);
    }
  }
}

// ============================================================
// Internal: play a message's audio
// ============================================================
function playAudio(msg, scope) {
  const attachmentUrl = scope === 'dm'
    ? `/api/dm/attachments/${msg.id}`
    : `/api/chat/attachments/${msg.id}`;

  const key = getPlayerKey(msg, scope);

  // Reuse the same player/audio for this message if it already exists.
  const existing = playerRegistry.get(key);
  if (existing && !existing.destroyed) {
    mountPlayer(existing, msg);
    syncPlayerVolume(existing);
    syncPlayerUI(existing);
    return;
  }

  if (existing && existing.destroyed) {
    playerRegistry.delete(key);
  }

  const title = msg.attachment_title || msg.attachment_name || 'Audio';
  const artist = msg.artist || '';
  const currentVolume = getGlobalVolume();

  const template = `
  <div class="audio-player" data-msg-id="${msg.id}">
    <div class="audio-player-header">
      <div class="audio-player-title">${escapeHtml(title)}</div>
      <span class="audio-player-current-time">0:00</span>
    </div>

    ${artist ? `<div class="audio-player-artist">${escapeHtml(artist)}</div>` : ''}

    <div class="audio-player-controls">

      <button type="button" class="audio-player-play" title="Play">
        ${ICONS.play}
      </button>

      <div class="audio-player-waveform" title="Click to seek">
        <canvas class="audio-player-canvas"></canvas>
        <div class="audio-player-progress-fill" style="width:0%"></div>
      </div>

      <span class="audio-player-duration">--:--</span>

      <a href="${attachmentUrl}" download="${escapeHtml(msg.attachment_name || 'audio')}" class="audio-player-download" title="Download">
        ${ICONS.download}
      </a>

      <div class="audio-player-volume-control" 
           style="display: flex; align-items: center; overflow: hidden; width: 24px; transition: width 0.2s ease-out;" 
           onmouseenter="this.style.width='90px'" 
           onmouseleave="this.style.width='24px'">
        
        <button type="button" class="audio-player-volume" title="Mute / Unmute" 
                style="flex-shrink: 0; background: none; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; width: 24px;">
          ${ICONS.volume}
        </button>

        <input
          type="range"
          class="audio-player-volume-slider"
          min="0"
          max="1"
          step="0.01"
          value="${currentVolume}"
          title="Volume"
          style="flex-shrink: 0; width: 60px; margin-left: 6px; cursor: pointer;"
        >
      </div>

    </div>

    <div class="audio-player-error" style="display:none">
      <span>${ICONS.alert}</span>
      <span>Failed to load audio</span>
    </div>

  </div>
`;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = template.trim();
  const playerEl = wrapper.firstElementChild;

  const player = {
    key,
    audio: null,
    ctx: null,
    analyser: null,
    sourceNode: null,
    animId: null,
    el: playerEl,
    msgId: msg.id,
    scope,
    blobUrl: null,
    playRequested: false,
    destroyed: false,
  };

  playerRegistry.set(key, player);
  playerEl._audioPlayer = player;

  const playBtn = playerEl.querySelector('.audio-player-play');
  const volumeSlider = playerEl.querySelector('.audio-player-volume-slider');
  const volBtn = playerEl.querySelector('.audio-player-volume');

  updateSliderFill(volumeSlider);

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      updateSliderFill(volumeSlider);
      setGlobalVolume(Number(volumeSlider.value));
    });
  }

  if (volBtn) {
    volBtn.style.opacity = currentVolume === 0 ? '0.4' : '1';
    volBtn.addEventListener('click', () => {
      const vol = getGlobalVolume();
      if (vol > 0) {
        setGlobalVolume(0);
      } else {
        setGlobalVolume(lastUnmutedVolume);
      }
    });
  }

  playBtn.addEventListener('click', () => {
    if (player.destroyed) return;

    if (!player.audio) {
      player.playRequested = true;
      playerEl.classList.add('loading');
      playBtn.title = 'Loading…';
      return;
    }

    // Let the native play/pause events update the UI and global state.
    if (!player.audio.paused) {
      player.audio.pause();
    } else {
      const c = ensureCtx(player);
      if (c.state === 'suspended') c.resume();
      player.audio.play().catch(() => showToast('Playback failed', 'error'));
    }
  });

  const progressBar = playerEl.querySelector('.audio-player-waveform');
  progressBar.addEventListener('click', (e) => {
    if (!player.audio || !player.audio.duration) return;
    const rect = progressBar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    player.audio.currentTime = pct * player.audio.duration;
  });

  fetchBlob(attachmentUrl)
    .then((blob) => {
      if (player.destroyed) return;

      const objectURL = URL.createObjectURL(blob);
      player.blobUrl = objectURL;

      const audio = new Audio(objectURL);
      player.audio = audio;

      audio.volume = getGlobalVolume();

      // === Native media events — these fire for media keys as well as UI clicks ===
      audio.addEventListener('play', () => {
        if (player.destroyed) return;

        const c = ensureCtx(player);
        if (c.state === 'suspended') c.resume();

        if (!player.sourceNode) {
          player.sourceNode = c.createMediaElementSource(audio);
          player.analyser = c.createAnalyser();
          player.analyser.fftSize = 256;
          player.sourceNode.connect(player.analyser);
          player.analyser.connect(c.destination);
        }

        // Pause any other currently-playing player.
        if (currentPlaying && currentPlaying !== player && currentPlaying.audio && !currentPlaying.audio.paused) {
          currentPlaying.audio.pause();
        }

        currentPlaying = player;
        updatePlaybackUI(player, true);
        drawWaveform(player);
      });

      audio.addEventListener('pause', () => {
        if (player.destroyed) return;

        cancelAnimationFrame(player.animId);
        player.animId = null;

        updatePlaybackUI(player, false);

        if (currentPlaying === player) {
          currentPlaying = null;
        }
      });

      audio.addEventListener('loadedmetadata', () => {
        if (player.el) {
          const durEl = player.el.querySelector('.audio-player-duration');
          if (durEl) durEl.textContent = formatTime(audio.duration);
        }
      });

      audio.addEventListener('timeupdate', () => {
        if (!player.el || !audio.duration) return;
        const bar = player.el.querySelector('.audio-player-progress-fill');
        const timeEl = player.el.querySelector('.audio-player-current-time');
        if (bar) {
          const pct = (audio.currentTime / audio.duration) * 100;
          bar.style.width = `${pct}%`;
        }
        if (timeEl) timeEl.textContent = formatTime(audio.currentTime);
      });

      audio.addEventListener('ended', () => {
        if (player.el) {
          const pBtn = player.el.querySelector('.audio-player-play');
          if (pBtn) {
            pBtn.innerHTML = ICONS.play;
            pBtn.title = 'Play';
          }
          const fill = player.el.querySelector('.audio-player-progress-fill');
          if (fill) fill.style.width = '0%';
          const ct = player.el.querySelector('.audio-player-current-time');
          if (ct) ct.textContent = '0:00';
        }
      });

      audio.addEventListener('waiting', () => {
        if (player.el) {
          player.el.classList.add('loading');
        }
      });

      audio.addEventListener('canplay', () => {
        if (player.el) {
          player.el.classList.remove('loading');
        }
      });

      audio.addEventListener('error', () => {
        if (player.el) {
          const errEl = player.el.querySelector('.audio-player-error');
          if (errEl) errEl.style.display = 'flex';
          const pBtn = player.el.querySelector('.audio-player-play');
          if (pBtn) pBtn.innerHTML = ICONS.alert;
        }
      });

      // Attach the fully-created player to the message DOM.
      mountPlayer(player, msg);

      // If the user clicked play while we were still fetching the blob.
      if (player.playRequested) {
        player.playRequested = false;
        playerEl.classList.remove('loading');
        const c = ensureCtx(player);
        if (c.state === 'suspended') c.resume();
        player.audio.play().catch(() => showToast('Playback failed', 'error'));
      }

      syncPlayerVolume(player);
      preloadMetadata(blob, msg, player);
    })
    .catch(() => {
      if (player.destroyed) return;
      if (player.el) {
        const errEl = player.el.querySelector('.audio-player-error');
        if (errEl) errEl.style.display = 'flex';
        const pBtn = player.el.querySelector('.audio-player-play');
        if (pBtn) pBtn.innerHTML = ICONS.alert;
      }
    });
}

// ============================================================
// Helper: create/resume AudioContext lazily.
// ============================================================
function ensureCtx(player) {
  if (!player.ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    player.ctx = new C();
    player.analyser = player.ctx.createAnalyser();
    player.analyser.fftSize = 256;
  }
  return player.ctx;
}

function preloadMetadata(blob, msg, player) {
  const isMp3 = msg.attachment_mime === 'audio/mpeg' ||
    (msg.attachment_name && msg.attachment_name.toLowerCase().endsWith('.mp3'));

  if (!isMp3) return;

  const id3 = extractId3(blob);
  if (id3 && (id3.title || id3.artist)) {
    if (id3.title && player.el) {
      const titleEl = player.el.querySelector('.audio-player-title');
      if (titleEl) titleEl.textContent = id3.title;
    }
    if (id3.artist && player.el) {
      const artistEl = player.el.querySelector('.audio-player-artist');
      if (artistEl) {
        artistEl.textContent = id3.artist;
        artistEl.style.display = 'block';
      }
    }
    msg.artist = id3.artist;
    msg.attachment_title = id3.title;
  }
}

// ============================================================
// Waveform visualization
// ============================================================
function drawWaveform(player) {
  if (!player || !player.el || player.animId !== null) return;
  if (!player.audio || player.audio.paused) return;

  const canvas = player.el.querySelector('.audio-player-canvas');
  const analyser = player.analyser;
  if (!canvas || !analyser) return;

  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    if (!player.el || !player.audio || player.audio.paused) {
      player.animId = null;
      return;
    }

    player.animId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    ctx2d.clearRect(0, 0, w, h);

    const barCount = Math.min(bufferLength, w / 1.5);
    const barWidth = w / barCount;

    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor(i * bufferLength / barCount);
      const val = dataArray[idx] / 255;
      const barH = Math.max(1, val * h * 0.85);

      const gradient = ctx2d.createLinearGradient(0, h - barH, 0, h);
      gradient.addColorStop(0, 'rgba(166,227,161,0.9)');
      gradient.addColorStop(1, 'rgba(137,180,135,0.4)');

      ctx2d.fillStyle = gradient;
      ctx2d.fillRect(i * barWidth + 0.5, h - barH, barWidth - 1, barH);
    }
  }

  draw();
}

// ============================================================
// Public API
// ============================================================

export function renderAudio(msg, scope) {
  playAudio(msg, scope);
}

export function stopAll() {
  playerRegistry.forEach((player) => {
    if (player.destroyed || !player.audio) return;
    try {
      if (!player.audio.paused) {
        player.audio.pause();
      }
    } catch {
      // ignore
    }
  });
}

// ============================================================
// Cleanup / utility
// ============================================================

function destroyPlayer(player) {
  if (!player || player.destroyed) return;
  player.destroyed = true;

  if (player.key) {
    playerRegistry.delete(player.key);
  }

  if (player.blobUrl) {
    try { URL.revokeObjectURL(player.blobUrl); } catch { /* ignore */ }
  }

  try {
    player.audio.pause();
  } catch { /* ignore */ }

  if (player.animId !== null) {
    cancelAnimationFrame(player.animId);
    player.animId = null;
  }

  if (player.ctx) {
    try {
      player.ctx.close().catch(() => {});
    } catch { /* ignore */ }
  }

  if (player.el && player.el.parentNode) {
    player.el.remove();
  }

  if (currentPlaying === player) currentPlaying = null;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}