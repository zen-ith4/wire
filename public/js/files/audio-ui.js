// ============================================================
// Wire-styled audio player for the Files viewer.
//
// A plain <audio> element (never displayed) driven by our own controls:
// play/pause, ±10 s, a seek slider, current time / duration, mute and
// volume. Everything is a real <button> or <input type="range"> so it
// works with keyboard, touch and screen readers.
//
// The owner (viewer.js) supplies the src and handles token recovery;
// this module only builds the UI and tears it down via `signal`.
// ============================================================

import { ICONS } from '../icons.js';
import { formatDuration } from './kinds.js';

const SEEK_STEPS = 1000;

export function buildAudioPlayer({ signal }) {
  const root = document.createElement('div');
  root.className = 'fa';

  root.innerHTML = `
    <div class="fa-art" aria-hidden="true">${ICONS.audio}</div>

    <div class="fa-seek">
      <input
        type="range"
        class="fa-range fa-seek-range"
        min="0"
        max="${SEEK_STEPS}"
        step="1"
        value="0"
        aria-label="Seek"
        disabled
      >
      <div class="fa-times">
        <span class="fa-cur">0:00</span>
        <span class="fa-dur">--:--</span>
      </div>
    </div>

    <div class="fa-controls">
      <button type="button" class="fa-skip" data-act="back" aria-label="Back 10 seconds">
        <span aria-hidden="true">−10</span>
      </button>
      <button type="button" class="fa-play" aria-label="Play" disabled>
        <span class="fa-play-icon">${ICONS.play}</span>
        <span class="fa-play-icon fa-pause-icon">${ICONS.pause}</span>
        <span class="fa-spinner spin" aria-hidden="true"></span>
      </button>
      <button type="button" class="fa-skip" data-act="fwd" aria-label="Forward 10 seconds">
        <span aria-hidden="true">+10</span>
      </button>
    </div>

    <div class="fa-vol">
      <button type="button" class="fa-mute" aria-label="Mute">
        <span class="fa-vol-on">${ICONS.volume}</span>
        <span class="fa-vol-off">${ICONS.volumeMute || ICONS.volume}</span>
      </button>
      <input
        type="range"
        class="fa-range fa-vol-range"
        min="0"
        max="100"
        step="1"
        value="100"
        aria-label="Volume"
      >
    </div>
  `;

  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  root.appendChild(audio);

  const q = (sel) => root.querySelector(sel);

  const seek = q('.fa-seek-range');
  const cur = q('.fa-cur');
  const dur = q('.fa-dur');
  const play = q('.fa-play');
  const mute = q('.fa-mute');
  const vol = q('.fa-vol-range');

  let scrubbing = false;
  let wantsPlay = false;

  const setFill = (el, pct) => el.style.setProperty('--fa-pct', `${pct}%`);

  function syncProgress() {
    const d = audio.duration;
    const known = Number.isFinite(d) && d > 0;

    cur.textContent = formatDuration(audio.currentTime);
    dur.textContent = known ? formatDuration(d) : '--:--';
    seek.disabled = !known;

    if (!scrubbing && known) {
      const pct = (audio.currentTime / d) * 100;
      seek.value = String(Math.round((pct / 100) * SEEK_STEPS));
      setFill(seek, pct);
    }
  }

  function syncPlayState() {
    const playing = !audio.paused && !audio.ended;

    root.classList.toggle('is-playing', playing);
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function syncVolume() {
    const level = audio.muted ? 0 : audio.volume;

    vol.value = String(Math.round(level * 100));
    setFill(vol, level * 100);
    root.classList.toggle('is-muted', audio.muted || audio.volume === 0);
    mute.setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute');
  }

  const on = (target, type, handler) =>
    target.addEventListener(type, handler, { signal });

  // ---- media events ----
  on(audio, 'loadedmetadata', () => {
    play.disabled = false;
    syncProgress();
  });
  on(audio, 'durationchange', syncProgress);
  on(audio, 'timeupdate', syncProgress);
  on(audio, 'play', syncPlayState);
  on(audio, 'pause', syncPlayState);
  on(audio, 'ended', () => {
    syncPlayState();
    syncProgress();
  });
  on(audio, 'volumechange', syncVolume);
  on(audio, 'waiting', () => root.classList.add('is-buffering'));
  on(audio, 'seeking', () => root.classList.add('is-buffering'));
  for (const type of ['playing', 'canplay', 'seeked']) {
    on(audio, type, () => root.classList.remove('is-buffering'));
  }

  // ---- controls ----
  function togglePlay() {
    if (audio.paused || audio.ended) {
      wantsPlay = true;
      audio.play().catch(() => {
        /* blocked or interrupted: the button state stays truthful via 'pause' */
      });
    } else {
      wantsPlay = false;
      audio.pause();
    }
  }

  on(play, 'click', togglePlay);

  const skip = (delta) => {
    const d = audio.duration;
    const max = Number.isFinite(d) ? d : Infinity;

    audio.currentTime = Math.min(max, Math.max(0, audio.currentTime + delta));
  };

  on(root, 'click', (event) => {
    const btn = event.target.closest('.fa-skip');
    if (btn) skip(btn.dataset.act === 'back' ? -10 : 10);
  });

  // Seek slider. While dragging we only move the thumb + time label;
  // the (expensive) seek happens once, on release.
  const previewSeek = () => {
    const d = audio.duration;
    if (!Number.isFinite(d)) return;

    const pct = (Number(seek.value) / SEEK_STEPS) * 100;
    setFill(seek, pct);
    cur.textContent = formatDuration((pct / 100) * d);
  };

  const commitSeek = () => {
    const d = audio.duration;

    if (Number.isFinite(d)) {
      audio.currentTime = (Number(seek.value) / SEEK_STEPS) * d;
    }

    scrubbing = false;
  };

  on(seek, 'pointerdown', () => { scrubbing = true; });
  on(seek, 'input', () => {
    scrubbing = true;
    previewSeek();
  });
  on(seek, 'change', commitSeek);
  on(seek, 'pointerup', commitSeek);
  on(seek, 'pointercancel', () => { scrubbing = false; syncProgress(); });

  // 1/1000ths of a track are useless keyboard steps: arrows seek 5 s.
  on(seek, 'keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      skip(-5);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      skip(5);
    }
  });

  on(mute, 'click', () => {
    audio.muted = !audio.muted;
  });

  on(vol, 'input', () => {
    const level = Number(vol.value) / 100;

    audio.muted = false;
    audio.volume = level;
  });

  syncVolume();
  syncPlayState();

  return {
    el: root,
    audio,
    togglePlay,
    focusPrimary: () => play.focus({ preventScroll: true }),
    setLoading(loading) {
      root.classList.toggle('is-loading', loading);
      play.disabled = loading || !Number.isFinite(audio.duration);
    },
    /** True if the user had pressed play (used to resume after token recovery). */
    get wantsPlay() { return wantsPlay; },
  };
}
