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

const AUDIO_VOLUME_KEY = 'audio-player-volume';
let lastUnmutedVolume = 1; // State to restore volume when unmuting

// ============================================================
// Volume Control & Cookie Persistence
// ============================================================

function setGlobalVolume(volume) {
  volume = Math.max(0, Math.min(1, volume));

  // 1. Persist volume using cookies (1 year expiration)
  document.cookie = `${AUDIO_VOLUME_KEY}=${volume}; path=/; max-age=31536000`;

  if (volume > 0) {
    lastUnmutedVolume = volume;
  }

  // 2. Broadcast the volume update to all existing audio players on the page
  document.querySelectorAll('.audio-player').forEach((el) => {
    const player = el._audioPlayer;

    if (player?.audio) {
      player.audio.volume = volume;
    }

    const slider = el.querySelector('.audio-player-volume-slider');
    if (slider && slider.value !== String(volume)) {
      slider.value = volume;
    }
    
    // Update mute button appearance
    const volBtn = el.querySelector('.audio-player-volume');
    if (volBtn) {
      volBtn.style.opacity = volume === 0 ? '0.4' : '1';
    }
  });
}

function getGlobalVolume() {
  // Read volume from cookie
  const match = document.cookie.match(new RegExp('(^| )' + AUDIO_VOLUME_KEY + '=([^;]+)'));
  if (match) {
    const volume = Number(match[2]);
    if (Number.isFinite(volume)) {
      return Math.max(0, Math.min(1, volume));
    }
  }
  // Sensible default if missing or invalid
  return 1;
}

// ============================================================
// Check whether a MIME type or file extension indicates an audio format.
// Handles both 'audio/mpeg' and 'mp3' / 'song.mp3'.
// ============================================================
export function isAudio(mimeTypeOrName) {
  if (!mimeTypeOrName) return false;

  const s = String(mimeTypeOrName).toLowerCase().trim();

  // Direct MIME-type match (e.g. 'audio/mpeg', 'audio/ogg')
  if (/^audio\//i.test(s)) return true;

  // Extension from a path / filename
  const dot = s.lastIndexOf('.');
  if (dot > 0) {
    const ext = s.slice(dot + 1);
    return AUDIO_EXTS.has(ext);
  }

  // Bare extension (e.g. 'mp3' without dots)
  return AUDIO_EXTS.has(s);
}

const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'ogg', 'opus',
  'm4a', 'aac', 'flac', 'webm',
  'wma', 'aiff',
]);

// ============================================================
// MP3 ID3v2 extraction (lightweight)
// Returns { title, artist, album } or null on failure.
// ============================================================
function extractId3(blob) {
  try {
    const view = new DataView(blob.buffer, blob.byteOffset, Math.min(blob.size, 1024 * 1024));
    // Must start with "ID3"
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x38) {
      return null;
    }
    const major = view.getUint8(3);
    if (major < 0x02 || major > 0x04) return null;

    // Read size (synchsafe integer, 4 bytes)
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

      // Skip if not a valid frame ID (all printable)
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
      if (id === 'TPE1' && !text.startsWith('\uFFFD') && !text.startsWith('')) {
        const r = { title: undefined, artist: text.trim(), album: undefined };
        return r;
      }
      if (id === 'TALB' && !text.startsWith('\uFFFD') && !text.startsWith('')) {
        const r = { title: undefined, artist: undefined, album: text.trim() };
        return r;
      }

      offset = frameEnd;
    }
  } catch {
    // Silently ignore extraction errors
  }
  return null;
}

// ============================================================
// Internal: play a message's audio
// ============================================================
function playAudio(msg, scope) {
  const attachmentUrl = scope === 'dm'
    ? `/api/dm/attachments/${msg.id}`
    : `/api/chat/attachments/${msg.id}`;

  // Show loading state while fetching
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

      <!-- Compact & Expandable Volume Control -->
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

  // Each player owns its own state.
  const player = {
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

  playerEl._audioPlayer = player;

  const playBtn = playerEl.querySelector('.audio-player-play');
  const volumeSlider = playerEl.querySelector('.audio-player-volume-slider');
  const volBtn = playerEl.querySelector('.audio-player-volume');

  // Wire up volume slider
  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      setGlobalVolume(Number(volumeSlider.value));
    });
  }

  // Wire up mute/unmute button
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

  // Wire up play button
  playBtn.addEventListener('click', () => {
    if (player.destroyed) return;

    if (!player.audio) {
      // Audio element not ready yet — remember the request and wait for fetchBlob
      player.playRequested = true;
      playerEl.classList.add('loading');
      playBtn.title = 'Loading…';
      return;
    }

    const isPlaying = !player.audio.paused;
    if (isPlaying) {
      // Pause this player
      player.audio.pause();
      playBtn.innerHTML = ICONS.play;
      playBtn.title = 'Play';
      playerEl.classList.remove('playing');
      playerEl.classList.add('paused');
      cancelAnimationFrame(player.animId);
      player.animId = null;

      // Update global state
      if (currentPlaying === player) currentPlaying = null;
    } else {
      // Pause the previously playing player (if different)
      if (currentPlaying && currentPlaying !== player) {
        currentPlaying.audio.pause();
        const prevBtn = currentPlaying.el.querySelector('.audio-player-play');
        if (prevBtn) {
          prevBtn.innerHTML = ICONS.play;
          prevBtn.title = 'Play';
        }
        currentPlaying.el.classList.remove('playing');
        currentPlaying.el.classList.add('paused');
        cancelAnimationFrame(currentPlaying.animId);
        currentPlaying.animId = null;
      }

      // Audio is ready — start playback immediately
      const c = ensureCtx(player);
      if (c.state === 'suspended') c.resume();
      player.audio.play().catch(() => showToast('Playback failed', 'error'));
      playBtn.innerHTML = ICONS.pause;
      playBtn.title = 'Pause';
      playerEl.classList.remove('paused');
      playerEl.classList.add('playing');
      drawWaveform(player);

      // Update global state
      currentPlaying = player;
    }
  });

  // Wire up seek bar click
  const progressBar = playerEl.querySelector('.audio-player-waveform');
  progressBar.addEventListener('click', (e) => {
    if (!player.audio || !player.audio.duration) return;
    const rect = progressBar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    player.audio.currentTime = pct * player.audio.duration;
  });

  // Fetch the audio via fetchBlob, then create the Audio element.
  fetchBlob(attachmentUrl)
    .then((blob) => {
      if (player.destroyed) return;

      const objectURL = URL.createObjectURL(blob);
      player.blobUrl = objectURL;

      const audio = new Audio(objectURL);
      
      // Initialize with the globally managed cookie volume
      audio.volume = getGlobalVolume();
      player.audio = audio;

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

      audio.addEventListener('play', () => {
        const c = ensureCtx(player);
        if (c.state === 'suspended') c.resume();
        if (!player.sourceNode) {
          player.sourceNode = c.createMediaElementSource(audio);
          player.analyser = c.createAnalyser();
          player.analyser.fftSize = 256;
          player.sourceNode.connect(player.analyser);
          player.analyser.connect(c.destination);
        }
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

      // Attach to the message element
      const msgEl = document.querySelector(`.chat-msg[data-msg-id="${msg.id}"]`);
      if (msgEl) {
        const attWrap = msgEl.querySelector(':scope > div > .chat-attachment, :scope > div > .chat-attachment-image-wrap');
        if (attWrap) {
          attWrap.replaceWith(playerEl);
        } else {
          const contentDiv = msgEl.querySelector(':scope > div > .chat-bubble, :scope > div > .chat-meta');
          if (contentDiv) {
            contentDiv.after(playerEl);
          }
        }
      }

      // If user clicked play while waiting, start playback now.
      if (player.playRequested) {
        player.playRequested = false;
        playerEl.classList.remove('loading');
        playBtn.title = 'Pause';
        const c = ensureCtx(player);
        if (c.state === 'suspended') c.resume();
        player.audio.play().catch(() => showToast('Playback failed', 'error'));
        drawWaveform(player);

        if (currentPlaying && currentPlaying !== player) {
          currentPlaying.audio.pause();
          const prevBtn = currentPlaying.el.querySelector('.audio-player-play');
          if (prevBtn) {
            prevBtn.innerHTML = ICONS.play;
            prevBtn.title = 'Play';
          }
          currentPlaying.el.classList.remove('playing');
          currentPlaying.el.classList.add('paused');
          cancelAnimationFrame(currentPlaying.animId);
          currentPlaying.animId = null;
        }
        currentPlaying = player;
      }

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
  if (player.audio.paused) return;

  const canvas = player.el.querySelector('.audio-player-canvas');
  const analyser = player.analyser;
  if (!canvas || !analyser) return;

  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    if (!player.el || player.audio.paused) {
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

function pauseCurrentPlayer() {
  if (!currentPlaying) return;

  const p = currentPlaying;
  try {
    p.audio.pause();
  } catch { /* ignore */ }

  const btn = p.el.querySelector('.audio-player-play');
  if (btn) {
    btn.innerHTML = ICONS.play;
    btn.title = 'Play';
  }
  p.el.classList.remove('playing');
  p.el.classList.add('paused');
  cancelAnimationFrame(p.animId);
  p.animId = null;

  currentPlaying = null;
}

function stopAllPlayers() {
  if (currentPlaying) {
    pauseCurrentPlayer();
  }
}

function destroyPlayer(player) {
  if (!player || player.destroyed) return;
  player.destroyed = true;

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

export function renderAudio(msg, scope) {
  playAudio(msg, scope);
}

export function stopAll() {
  stopAllPlayers();
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