// ============================================================
// Custom background (image, GIF or video)
//
// A purely local UI preference. The media never leaves the
// device: no upload, no API call, nothing in the service-worker
// cache.
//
// Where things live
//   - Settings (enabled, kind, opacity, dim, blur, fit, position,
//     animate, and a "has a background" flag): one
//     JSON object in localStorage under `wire-custom-bg`, the same
//     store every other appearance preference uses (see theme.js).
//   - The media itself: IndexedDB (`wire-appearance` / `assets`).
//     localStorage is a string store with a ~5 MB quota, which is
//     no place for a photo or a clip; IndexedDB stores the Blob
//     as-is and works the same in a browser tab, Electron and the
//     Capacitor Android WebView, with no plugin or new dependency.
//     (Wire already does this for custom message sounds.)
//
// One architecture, three kinds
//   `kind` is "image" | "gif" | "video". Images, GIFs and videos
//   share the same prefs, the same IndexedDB record, the same CSS
//   custom properties and the same layer. A video is stored as the
//   picked file's own bytes (never read into a JS buffer) next to a
//   still poster frame, exactly like an animated GIF.
//
// Rendering
//   One fixed <div id="custom-bg">, right above #ambient-underlay,
//   holding ONE media element: an <img> for images/GIFs, a <video>
//   for video. It is created only while the feature is on and has a
//   background — when off there is no element, no blob URL and no
//   decode. Every control is a CSS custom property, so a slider drag
//   is a property write, not a re-render.
//
// Video playback rules (see syncPlayback)
//   - muted, looping, inline, no controls, pointer-events:none;
//   - never more than one video actually playing. On phones an open
//     conversation is an opaque layer covering the fixed layer, so
//     the video is handed to a twin element inside that layer and
//     the fixed one lets go of its decoder (and the other way round
//     when the conversation is closed);
//   - paused while the page/app is hidden, and while the Settings
//     preview is playing the same media;
//   - not decoded at all (poster frame instead) when the user turns
//     "Play animation" off or the OS asks for reduced motion;
//   - if the browser refuses autoplay, the poster stays and playback
//     starts on the first tap.
//
// Large images are downscaled once, at import, with the browser's
// own decoder (createImageBitmap resize hint, so the full-size
// bitmap is never materialised where supported). Animated GIFs /
// WebP / APNG are stored byte-for-byte so they stay animated; a
// still poster frame is stored next to them and used whenever the
// user pauses the animation or prefers reduced motion. Videos are
// validated (format, size, duration, resolution) from their
// metadata only, via an object URL — the browser streams them.
// ============================================================

import {
  safeGetStorage,
  safeSetStorage
} from './theme.js';

import {
  applySurfaces,
  isLiteDevice
} from './appearance-surfaces.js';

const PREFS_KEY = 'wire-custom-bg';

const DB_NAME = 'wire-appearance';
const DB_STORE = 'assets';
const ASSET_KEY = 'custom-background';

const CHANGE_EVENT = 'wire:custom-bg-change';

// ------------------------------------------------------------
// Options / limits
// ------------------------------------------------------------

export const LIMITS = {
  opacity: { min: 20, max: 100 },
  dim: { min: 15, max: 90 },
  blur: { min: 0, max: 24 }
};

export const FIT_OPTIONS = [
  { id: 'cover', label: 'Fill screen' },
  { id: 'contain', label: 'Fit inside' },
  { id: 'fill', label: 'Stretch' },
  { id: 'none', label: 'Original size' }
];

export const POSITION_OPTIONS = [
  { id: 'center', label: 'Center', css: '50% 50%' },
  { id: 'top', label: 'Top', css: '50% 0%' },
  { id: 'bottom', label: 'Bottom', css: '50% 100%' },
  { id: 'left', label: 'Left', css: '0% 50%' },
  { id: 'right', label: 'Right', css: '100% 50%' }
];

// "image" = still, "gif" = any animated image (GIF / WebP / APNG),
// "video" = a clip. `animated` is derived from it (see sanitize).
export const KINDS = ['image', 'gif', 'video'];

export const DEFAULTS = Object.freeze({
  enabled: false,
  hasImage: false,
  kind: 'image',
  animated: false,

  opacity: 100,
  dim: 40,
  blur: 0,
  fit: 'cover',
  position: 'center',
  animate: true
});

const CONTROL_KEYS = [
  'opacity',
  'dim',
  'blur',
  'fit',
  'position',
  'animate'
];

const MAX_SIDE = 2048;        // stored static images
const POSTER_SIDE = 1280;     // still frame of an animation / video
const KEEP_ORIGINAL_BYTES = 2.5 * 1024 * 1024;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;   // any file, video included
const MAX_ANIMATED_BYTES = 12 * 1024 * 1024;
const MAX_ANIMATED_SIDE = 2560;             // animated images and video
const MAX_PIXELS = 120e6;

// Video only. A background clip loops forever, so it should be a
// short one; the size and resolution limits above still apply.
const MAX_VIDEO_SECONDS = 60;
const VIDEO_PROBE_TIMEOUT_MS = 12000;

// ------------------------------------------------------------
// Preferences
// ------------------------------------------------------------

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function sanitize(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const num = (v, key) =>
    Number.isFinite(v)
      ? clamp(
          Math.round(v),
          LIMITS[key].min,
          LIMITS[key].max
        )
      : DEFAULTS[key];

  const hasImage = p.hasImage === true;

  // Older saves have no `kind`: they were an image, or a GIF when
  // `animated` was set.
  const kind = !hasImage
    ? DEFAULTS.kind
    : KINDS.includes(p.kind)
      ? p.kind
      : p.animated === true
        ? 'gif'
        : 'image';

  return {
    enabled: p.enabled === true,
    hasImage,
    kind,
    animated: kind !== 'image',

    opacity: num(p.opacity, 'opacity'),
    dim: num(p.dim, 'dim'),
    blur: num(p.blur, 'blur'),

    fit: FIT_OPTIONS.some(o => o.id === p.fit)
      ? p.fit
      : DEFAULTS.fit,

    position: POSITION_OPTIONS.some(o => o.id === p.position)
      ? p.position
      : DEFAULTS.position,

    animate: p.animate !== false
  };
}

export function getCustomBackgroundPrefs() {
  try {
    const raw = safeGetStorage(PREFS_KEY);
    return sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitize(null);
  }
}

function writePrefs(patch) {
  const next = sanitize({
    ...getCustomBackgroundPrefs(),
    ...patch
  });

  safeSetStorage(PREFS_KEY, JSON.stringify(next));
  return next;
}

function notify() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export { CHANGE_EVENT as CUSTOM_BG_CHANGE_EVENT };

// ------------------------------------------------------------
// IndexedDB (asset store)
// ------------------------------------------------------------

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        if (!globalThis.indexedDB) {
          throw new Error('IndexedDB is unavailable');
        }

        const request = globalThis.indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE);
          }
        };

        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };

        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('blocked'));
      } catch (error) {
        reject(error);
      }
    }).catch(error => {
      dbPromise = null;
      throw error;
    });
  }

  return dbPromise;
}

function withStore(mode, run) {
  return openDb().then(
    db =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const request = run(tx.objectStore(DB_STORE));
        let result;

        request.onsuccess = () => {
          result = request.result;
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

const dbGet = () =>
  withStore('readonly', s => s.get(ASSET_KEY));

const dbPut = record =>
  withStore('readwrite', s => s.put(record, ASSET_KEY));

const dbDelete = () =>
  withStore('readwrite', s => s.delete(ASSET_KEY));

// ------------------------------------------------------------
// File inspection (header bytes only — no decode)
// ------------------------------------------------------------

function ascii(bytes, start, len) {
  let out = '';
  for (let i = start; i < start + len && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function jpegSize(b) {
  let i = 2;

  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }

    const marker = b[i + 1];

    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }

    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        h: (b[i + 5] << 8) | b[i + 6],
        w: (b[i + 7] << 8) | b[i + 8]
      };
    }

    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }

  return null;
}

// Sniffed from magic bytes, not from file.type / the extension:
// Android's picker frequently reports an empty or wrong MIME type.
async function inspect(file) {
  const bytes = new Uint8Array(
    await file.slice(0, 256 * 1024).arrayBuffer()
  );

  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return {
      kind: 'jpeg',
      mime: 'image/jpeg',
      animated: false,
      w: size?.w || 0,
      h: size?.h || 0
    };
  }

  // PNG (+ APNG)
  if (ascii(bytes, 1, 3) === 'PNG' && bytes[0] === 0x89) {
    const view = new DataView(bytes.buffer);
    const animated = ascii(bytes, 33, 4096).includes('acTL');
    return {
      kind: 'png',
      mime: 'image/png',
      animated,
      w: view.getUint32(16),
      h: view.getUint32(20)
    };
  }

  // GIF
  if (ascii(bytes, 0, 4) === 'GIF8') {
    return {
      kind: 'gif',
      mime: 'image/gif',
      animated: true,
      w: bytes[6] | (bytes[7] << 8),
      h: bytes[8] | (bytes[9] << 8)
    };
  }

  // WebP (+ animated WebP)
  if (
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 4) === 'WEBP'
  ) {
    let animated = false;
    let w = 0;
    let h = 0;

    if (ascii(bytes, 12, 4) === 'VP8X') {
      animated = (bytes[20] & 0x02) !== 0;
      w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    }

    return {
      kind: 'webp',
      mime: 'image/webp',
      animated,
      w,
      h
    };
  }

  // MP4 / M4V / MOV: an ISO base-media file starts with an `ftyp`
  // box. HEIC/AVIF stills share that container, so the brand has
  // to be checked or an iPhone photo would be taken for a video.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const boxSize = new DataView(bytes.buffer).getUint32(0);
    const end = Math.min(
      bytes.length,
      boxSize >= 16 ? boxSize : 32
    );

    const major = ascii(bytes, 8, 4);
    const compatible = [];

    for (let i = 16; i + 4 <= end; i += 4) {
      compatible.push(ascii(bytes, i, 4));
    }

    const brands = [major, ...compatible];

    const isStill = /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/;
    const isVideoBrand =
      /^(isom|iso[2-9]|mp41|mp42|mp71|avc1|m4v |m4vh|m4vp|msnv|dash|qt  |3gp[4-9]|3g2[4-9]|f4v )$/;

    if (
      !isStill.test(major) &&
      brands.some(brand => isVideoBrand.test(brand))
    ) {
      return {
        kind: 'video',
        // QuickTime files are labelled MP4: browsers sniff the
        // container from its bytes, and Chrome does not list
        // video/quicktime.
        mime: 'video/mp4',
        animated: true,
        w: 0,
        h: 0
      };
    }
  }

  // WebM (a Matroska file whose DocType is "webm"). Plain Matroska
  // (.mkv) is not reliably playable in browsers, so it is refused.
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3 &&
    ascii(bytes, 0, 64).includes('webm')
  ) {
    return {
      kind: 'video',
      mime: 'video/webm',
      animated: true,
      w: 0,
      h: 0
    };
  }

  return null;
}

// ------------------------------------------------------------
// Local preprocessing
// ------------------------------------------------------------

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve =>
    canvas.toBlob(blob => resolve(blob), type, quality)
  );
}

// Oriented (EXIF-aware) size via an <img> — the load event only
// needs the header, so this does not decode the pixels.
function naturalSize(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      const size = {
        w: img.naturalWidth,
        h: img.naturalHeight
      };
      URL.revokeObjectURL(url);
      resolve(size);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };

    img.src = url;
  });
}

async function decodeScaled(blob, maxSide) {
  const size = await naturalSize(blob);
  const scale = Math.min(1, maxSide / Math.max(size.w, size.h));

  let bitmap;

  try {
    bitmap =
      scale < 1
        ? await createImageBitmap(blob, {
            resizeWidth: Math.max(1, Math.round(size.w * scale)),
            resizeHeight: Math.max(1, Math.round(size.h * scale)),
            resizeQuality: 'high'
          })
        : await createImageBitmap(blob);
  } catch {
    // Browser without the resize options.
    bitmap = await createImageBitmap(blob);
  }

  const fit = Math.min(
    1,
    maxSide / Math.max(bitmap.width, bitmap.height)
  );

  const width = Math.max(1, Math.round(bitmap.width * fit));
  const height = Math.max(1, Math.round(bitmap.height * fit));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  return { canvas, width, height };
}

async function encode(canvas, hasAlpha, quality) {
  let blob = await canvasToBlob(canvas, 'image/webp', quality);

  if (!blob || blob.type !== 'image/webp') {
    blob = hasAlpha
      ? await canvasToBlob(canvas, 'image/png')
      : await canvasToBlob(canvas, 'image/jpeg', quality);
  }

  canvas.width = 0;
  canvas.height = 0;

  return blob;
}

async function makePoster(blob) {
  const { canvas } = await decodeScaled(blob, POSTER_SIDE);
  return encode(canvas, true, 0.8);
}

function fail(message) {
  return new Error(message);
}

// ---------------- video ----------------

function once(target, type, ms) {
  return new Promise((resolve, reject) => {
    let timer = 0;

    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(type, ok);
      target.removeEventListener('error', bad);
    };

    const ok = () => {
      cleanup();
      resolve();
    };

    const bad = () => {
      cleanup();
      reject(new Error(`${type} failed`));
    };

    target.addEventListener(type, ok);
    target.addEventListener('error', bad);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${type} timed out`));
    }, ms);
  });
}

// Some WebM files (anything a browser's MediaRecorder wrote) report
// an infinite duration until the end has been seeked to once.
async function resolveDuration(video) {
  const changed = once(video, 'durationchange', 4000);
  video.currentTime = 1e7;
  await changed;
  video.currentTime = 0;
}

/**
 * Opens a picked video through an object URL. The browser reads
 * what it needs from the file; the bytes are never copied into a
 * JS buffer. Always call close() — it detaches the source and
 * revokes the URL.
 */
async function openVideo(blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');

  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');

  const close = () => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };

  try {
    const loaded = once(video, 'loadedmetadata', VIDEO_PROBE_TIMEOUT_MS);
    video.src = url;
    await loaded;

    if (!Number.isFinite(video.duration)) {
      await resolveDuration(video);
    }
  } catch (error) {
    close();
    throw error;
  }

  return { video, close };
}

// A still frame from a little way in (t=0 is often black), scaled
// down. Failing to make one is not fatal: without a poster the
// video simply stays paused on its first frame when motion is off.
async function grabPoster(video, width, height, duration) {
  try {
    const at = Math.min(1, duration / 3);

    if (at > 0) {
      const seeked = once(video, 'seeked', 6000);
      video.currentTime = at;
      await seeked;
    }

    if (video.readyState < 2) {
      await once(video, 'loadeddata', 6000);
    }

    const scale = Math.min(1, POSTER_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');

    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    canvas
      .getContext('2d')
      .drawImage(video, 0, 0, canvas.width, canvas.height);

    return await encode(canvas, false, 0.8);
  } catch {
    return null;
  }
}

async function prepareVideoCandidate(file, info) {
  // The picked file itself, re-labelled with the sniffed type (the
  // OS picker often reports none). No copy is made.
  const blob = file.slice(0, file.size, info.mime);

  let handle;

  try {
    handle = await openVideo(blob);
  } catch {
    throw fail(
      "This browser can't play that video. Try an MP4 (H.264) or WebM file."
    );
  }

  let width = 0;
  let height = 0;
  let duration = 0;
  let poster = null;

  try {
    const { video } = handle;

    width = video.videoWidth;
    height = video.videoHeight;
    duration = video.duration;

    if (!width || !height) {
      throw fail("That file doesn't contain a video track.");
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      throw fail("Couldn't read that video's length. Try a different file.");
    }

    if (duration > MAX_VIDEO_SECONDS) {
      throw fail(
        `Video backgrounds can be at most ${MAX_VIDEO_SECONDS} seconds long.`
      );
    }

    if (Math.max(width, height) > MAX_ANIMATED_SIDE) {
      throw fail(
        `Videos can be at most ${MAX_ANIMATED_SIDE}px wide or tall. Try a 1080p version.`
      );
    }

    poster = await grabPoster(video, width, height, duration);
  } finally {
    handle.close();
  }

  return {
    kind: 'video',
    blob,
    poster,
    url: URL.createObjectURL(blob),
    posterUrl: poster ? URL.createObjectURL(poster) : null,
    animated: true,
    mime: info.mime,
    width,
    height,
    duration,
    bytes: blob.size
  };
}

/**
 * Validates and (for large stills) downsizes a picked file,
 * entirely on this device. Resolves to a candidate the settings
 * UI can preview; nothing is stored until applyCandidate().
 */
export async function prepareCandidate(file) {
  if (!file) throw fail('No file selected.');

  const info = await inspect(file);

  if (!info) {
    throw fail(
      'Unsupported file. Choose a JPG, PNG, WebP or GIF image, or an MP4 or WebM video.'
    );
  }

  // Checked on the size the OS reports, before anything is read
  // beyond the 256 KB header sniffed above.
  if (file.size > MAX_INPUT_BYTES) {
    throw fail(
      info.kind === 'video'
        ? 'That video is too large. Choose one under 40 MB.'
        : 'That image is too large. Choose one under 40 MB.'
    );
  }

  if (info.kind === 'video') {
    return prepareVideoCandidate(file, info);
  }

  if (info.w && info.h && info.w * info.h > MAX_PIXELS) {
    throw fail('That image has too many pixels to use safely.');
  }

  let blob;
  let poster = null;
  let width = info.w;
  let height = info.h;

  try {
    if (info.animated) {
      // Untouched bytes: re-encoding would flatten the animation.
      if (file.size > MAX_ANIMATED_BYTES) {
        throw fail(
          'Animated backgrounds must be under 12 MB.'
        );
      }

      if (Math.max(info.w, info.h) > MAX_ANIMATED_SIDE) {
        throw fail(
          `Animated backgrounds can be at most ${MAX_ANIMATED_SIDE}px wide or tall.`
        );
      }

      blob = file.slice(0, file.size, info.mime);
      poster = await makePoster(blob);
    } else {
      const small =
        info.w &&
        info.h &&
        Math.max(info.w, info.h) <= MAX_SIDE &&
        file.size <= KEEP_ORIGINAL_BYTES;

      if (small) {
        blob = file.slice(0, file.size, info.mime);
      } else {
        const { canvas, width: w, height: h } =
          await decodeScaled(file, MAX_SIDE);

        width = w;
        height = h;

        const encoded = await encode(
          canvas,
          info.kind === 'png' || info.kind === 'webp',
          0.86
        );

        // A re-encode that isn't smaller isn't worth it when the
        // original already fits.
        blob =
          encoded &&
          !(
            file.size <= encoded.size &&
            Math.max(info.w, info.h) <= MAX_SIDE
          )
            ? encoded
            : file.slice(0, file.size, info.mime);
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /Animated backgrounds/.test(error.message)
    ) {
      throw error;
    }
    throw fail("Couldn't read that image. Try a different file.");
  }

  const url = URL.createObjectURL(blob);
  const posterUrl = poster ? URL.createObjectURL(poster) : null;

  return {
    kind: info.animated ? 'gif' : 'image',
    blob,
    poster,
    url,
    posterUrl,
    animated: info.animated,
    mime: blob.type || info.mime,
    width,
    height,
    duration: 0,
    bytes: blob.size
  };
}

export function releaseCandidate(candidate) {
  if (!candidate) return;
  if (candidate.url) URL.revokeObjectURL(candidate.url);
  if (candidate.posterUrl) URL.revokeObjectURL(candidate.posterUrl);
}

// ------------------------------------------------------------
// Runtime layer
// ------------------------------------------------------------

const root = document.documentElement;

const reducedMotion = window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

// The layout that swaps the sidebar for the bottom tab bar (same
// query as responsive.css). Phones, and any narrow window.
export const PHONE_LAYOUT_QUERY =
  '(max-width: 900px), (max-height: 480px) and (orientation: landscape)';

// The layout in which an open conversation is an opaque layer of
// its own (responsive.css, `.dm-thread`).
const PHONE_THREAD_QUERY = '(max-width: 760px)';

export function isPhoneLayout() {
  try {
    return window.matchMedia(PHONE_LAYOUT_QUERY).matches;
  } catch {
    return false;
  }
}

let layer = null;
let media = null;       // the one <img> or <video> in the fixed layer
let mediaMode = null;   // 'img' | 'video'
let active = null;      // { main, poster, kind, animated, meta, broken }
let sequence = 0;
let frame = 0;
let playFrame = 0;
let listening = false;

// Why playback is on hold right now ('hidden', 'app', 'preview').
const holds = new Set();

// Where the video was when it last let go of its decoder, so the
// element that takes over carries on from about there.
let resumeAt = 0;

// Phone conversation layer (see ensureThreadLayer).
let threadLayer = null;
let threadVideo = null;
let threadKeeper = null;
let coverObserver = null;
let coverRatio = 0;
let phoneThread = null;

const VAR_KEYS = [
  '--cbg-opacity',
  '--cbg-dim',
  '--cbg-fit',
  '--cbg-pos',
  '--cbg-filter',
  '--cbg-scale',
  '--cbg-url',
  '--cbg-size'
];

export function prefersReducedMotion() {
  return Boolean(reducedMotion && reducedMotion.matches);
}

export function shouldPlayAnimation(prefs = getCustomBackgroundPrefs()) {
  return prefs.animate && !prefersReducedMotion();
}

function positionCss(id) {
  return (
    POSITION_OPTIONS.find(o => o.id === id)?.css || '50% 50%'
  );
}

/**
 * The exact custom properties the background needs. Shared by the
 * live layer (set on <html>) and the Settings preview (set on the
 * preview element), so the two can never look different.
 *
 * Position is global — the same crop on desktop and on phones —
 * so there is nothing here for the caller to pick between.
 *
 * blurScale shrinks the blur radius for a small preview.
 */
export function buildBackgroundVars(
  prefs,
  { src, playing, blurScale = 1 }
) {
  let blur = prefs.blur;

  // Blurring an animation re-filters every frame. Not on phones.
  if (prefs.animated && playing && isLiteDevice()) {
    blur = 0;
  }

  const px = Math.round(blur * blurScale * 10) / 10;

  return {
    '--cbg-opacity': String(prefs.opacity / 100),
    '--cbg-dim': String(prefs.dim / 100),
    '--cbg-fit': prefs.fit,
    '--cbg-pos': positionCss(prefs.position),
    '--cbg-filter': px > 0 ? `blur(${px}px)` : 'none',
    '--cbg-scale':
      px > 0
        ? `scale(${(1 + Math.min(px / 200, 0.12)).toFixed(3)})`
        : 'none',
    // Only a still can be a CSS background (the phone conversation
    // layer copies it); a playing video is drawn by <video>.
    '--cbg-url': src ? `url("${src}")` : 'none',
    '--cbg-size':
      prefs.fit === 'fill'
        ? '100% 100%'
        : prefs.fit === 'none'
          ? 'auto'
          : prefs.fit
  };
}

// ---------------- describing what is selected ----------------

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * { kind, label, detail } for the settings UI, from a candidate or
 * the stored asset's metadata. `label` is what the badge says.
 */
export function describeBackground(meta = {}) {
  const kind = KINDS.includes(meta.kind) ? meta.kind : 'image';

  const label =
    kind === 'video'
      ? 'Video'
      : kind === 'gif'
        ? meta.mime === 'image/gif'
          ? 'GIF'
          : 'Animated image'
        : 'Image';

  const parts = [];

  if (meta.width && meta.height) {
    parts.push(`${meta.width}×${meta.height}`);
  }

  if (kind === 'video' && Number.isFinite(meta.duration) && meta.duration > 0) {
    parts.push(formatDuration(meta.duration));
  }

  if (meta.bytes) parts.push(formatBytes(meta.bytes));

  return { kind, label, detail: parts.join(' · ') };
}

/** What is applied right now (details only while the layer is on). */
export function getBackgroundInfo() {
  const prefs = getCustomBackgroundPrefs();
  if (!prefs.hasImage) return null;

  return describeBackground({
    ...(active?.meta || {}),
    kind: prefs.kind
  });
}

// ---------------- media elements ----------------

/**
 * A <video> configured as a background, not a player: muted,
 * looping, inline (never fullscreen on phones), no controls, no
 * Picture-in-Picture / cast, out of the tab order and the
 * accessibility tree. Playback is driven explicitly, never left to
 * the `autoplay` attribute alone (see playBackgroundVideo).
 */
export function createBackgroundVideo() {
  const video = document.createElement('video');

  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.controls = false;
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.preload = 'auto';
  video.tabIndex = -1;
  video.draggable = false;

  // Attributes as well as properties: older WebKit reads these.
  video.setAttribute('muted', '');
  video.setAttribute('loop', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute(
    'controlslist',
    'nodownload nofullscreen noremoteplayback'
  );
  video.setAttribute('aria-hidden', 'true');

  return video;
}

let gestureRetry = null;

// Autoplay refused (iOS Low Power Mode, data-saver, strict
// browser settings): leave the poster up and try again on the
// first touch or key press, which the browser accepts.
function armGestureRetry() {
  if (gestureRetry) return;

  gestureRetry = new AbortController();

  const retry = () => {
    gestureRetry?.abort();
    gestureRetry = null;
    scheduleSyncPlayback();
    window.dispatchEvent(new Event(PLAYBACK_RETRY_EVENT));
  };

  for (const type of ['pointerdown', 'touchend', 'keydown']) {
    window.addEventListener(type, retry, {
      capture: true,
      passive: true,
      signal: gestureRetry.signal
    });
  }
}

const PLAYBACK_RETRY_EVENT = 'wire:custom-bg-retry-playback';
export { PLAYBACK_RETRY_EVENT };

export function playBackgroundVideo(video) {
  if (!video) return;

  let result;

  try {
    result = video.play();
  } catch {
    return;
  }

  if (result && typeof result.catch === 'function') {
    result.catch(error => {
      // AbortError = we paused or swapped the source meanwhile.
      if (error && error.name === 'NotAllowedError') {
        armGestureRetry();
      }
    });
  }
}

/** Detaches the source so the browser can free the decoder. */
export function releaseBackgroundVideo(video) {
  if (!video) return;

  try {
    video.pause();
  } catch {
    // Nothing to pause.
  }

  if (video.getAttribute('src')) {
    video.removeAttribute('src');
    video.load();
  }
}

function createImage() {
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';
  image.draggable = false;
  return image;
}

function watchVideo(video) {
  // A decode error or a file that vanished: fall back to the still
  // frame instead of a blank layer.
  video.addEventListener('error', () => {
    if (!video.getAttribute('src') || !active || active.broken) return;

    active.broken = true;
    scheduleSync();
  });
}

function ensureLayer() {
  if (layer) return;

  layer = document.createElement('div');
  layer.id = 'custom-bg';
  layer.className = 'cbg-surface';
  layer.setAttribute('aria-hidden', 'true');

  const anchor = document.getElementById('ambient-underlay');

  if (anchor) {
    anchor.after(layer);
  } else {
    document.body.prepend(layer);
  }
}

function disposeMedia() {
  if (media) {
    if (media.tagName === 'VIDEO') {
      releaseBackgroundVideo(media);
      media.removeAttribute('poster');
    } else {
      media.removeAttribute('src');
    }

    media.remove();
  }

  media = null;
  mediaMode = null;
}

function ensureMedia(mode) {
  if (media && mediaMode === mode) return media;

  disposeMedia();

  media = mode === 'video' ? createBackgroundVideo() : createImage();
  mediaMode = mode;

  if (mode === 'video') watchVideo(media);

  // First child: the dimming veil (::after) paints above it.
  layer.prepend(media);

  return media;
}

// ---------------- what to show ----------------

function currentSource(prefs) {
  if (!active) {
    return {
      src: null,
      poster: null,
      playing: false,
      mode: 'img',
      kind: 'image',
      animated: false
    };
  }

  const motion =
    active.animated &&
    !active.broken &&
    shouldPlayAnimation(prefs);

  const base = {
    poster: active.poster,
    kind: active.kind,
    animated: active.animated
  };

  if (active.kind === 'video') {
    if (motion) {
      return {
        ...base,
        src: active.main,
        playing: true,
        mode: 'video'
      };
    }

    // Motion off: a still image, no video element, no decoder.
    if (active.poster) {
      return {
        ...base,
        src: active.poster,
        playing: false,
        mode: 'img'
      };
    }

    // No poster could be made: hold the first frame instead.
    return {
      ...base,
      src: active.main,
      playing: false,
      mode: 'video'
    };
  }

  const still = active.animated && !motion && active.poster;

  return {
    ...base,
    src: still ? active.poster : active.main,
    playing: active.animated && motion,
    mode: 'img'
  };
}

// ---------------- playback ----------------

// The phone conversation layer covers the fixed layer entirely, so
// while it is showing it, IT is where the video plays.
function threadCovers() {
  return Boolean(
    threadVideo &&
      threadLayer?.isConnected &&
      phoneThread?.matches &&
      coverRatio >= 0.5
  );
}

function attachVideo(video) {
  if (!active || !video) return;

  if (active.poster && video.getAttribute('poster') !== active.poster) {
    video.poster = active.poster;
  }

  if (video.getAttribute('src') === active.main) return;

  video.src = active.main;

  const at = resumeAt;

  if (at > 0.05) {
    video.addEventListener(
      'loadedmetadata',
      () => {
        try {
          if (Number.isFinite(video.duration) && video.duration > 0) {
            video.currentTime = at % video.duration;
          }
        } catch {
          // Not seekable yet: starts from the beginning.
        }
      },
      { once: true }
    );
  }
}

function letGo(video) {
  if (!video) return;

  if (video.getAttribute('src')) {
    resumeAt = video.currentTime || resumeAt;
  }

  releaseBackgroundVideo(video);
}

/**
 * The single place that decides what is decoding. At most one of
 * the two video elements holds a source; it plays unless something
 * has put playback on hold.
 */
function syncPlayback() {
  if (!active || !layer) return;

  const state = currentSource(getCustomBackgroundPrefs());

  if (state.mode !== 'video' || !media || mediaMode !== 'video') {
    letGo(threadVideo);
    return;
  }

  const onThread = threadCovers();
  const on = onThread ? threadVideo : media;
  const off = onThread ? media : threadVideo;

  letGo(off);
  attachVideo(on);

  if (state.playing && holds.size === 0) {
    playBackgroundVideo(on);
  } else {
    on.pause();
  }
}

function scheduleSyncPlayback() {
  if (playFrame) return;

  playFrame = requestAnimationFrame(() => {
    playFrame = 0;
    syncPlayback();
  });
}

/**
 * Puts live playback on hold (or releases it) for a named reason.
 * Used by this module for a hidden page / backgrounded app, and by
 * the Settings preview, which plays the same media itself and so
 * must not have a second copy running behind it.
 */
export function setBackgroundPlaybackHold(reason, on) {
  const had = holds.has(reason);

  if (on) {
    holds.add(reason);
  } else {
    holds.delete(reason);
  }

  if (had !== Boolean(on)) syncPlayback();
}

// ---------------- phone conversation layer ----------------

function disposeThreadLayer() {
  threadKeeper?.disconnect();
  coverObserver?.disconnect();
  threadKeeper = null;
  coverObserver = null;
  coverRatio = 0;

  if (threadVideo) {
    releaseBackgroundVideo(threadVideo);
    threadVideo.removeAttribute('poster');
  }

  threadLayer?.remove();
  threadLayer = null;
  threadVideo = null;
}

/**
 * On phones an open conversation is an opaque layer with its own
 * copy of the background (responsive.css; for stills the CSS in
 * custom-background.css copies the image). A video cannot be a CSS
 * background, so while a video is the background this puts a twin
 * <video> inside that layer, at the same size and screen position.
 * It only ever holds a source while the conversation is on screen;
 * see syncPlayback.
 *
 * The conversation's markup is rebuilt with innerHTML whenever a
 * chat is opened, which would wipe the twin, so a childList
 * observer puts it back (in the same microtask, so the browser
 * never sees the video leave the document).
 */
function ensureThreadLayer() {
  const thread = document.getElementById('dm-thread');

  if (
    !active ||
    mediaMode !== 'video' ||
    !thread
  ) {
    disposeThreadLayer();
    return;
  }

  if (threadLayer && threadLayer.parentElement === thread) return;

  disposeThreadLayer();

  threadLayer = document.createElement('div');
  threadLayer.className = 'cbg-thread-layer';
  threadLayer.setAttribute('aria-hidden', 'true');

  threadVideo = createBackgroundVideo();
  watchVideo(threadVideo);
  threadLayer.appendChild(threadVideo);

  thread.prepend(threadLayer);

  if (typeof MutationObserver === 'function') {
    threadKeeper = new MutationObserver(() => {
      if (threadLayer && threadLayer.parentElement !== thread) {
        thread.prepend(threadLayer);
      }
    });

    threadKeeper.observe(thread, { childList: true });
  }

  // Is the conversation actually on screen? display:none (list
  // showing), being swiped away or being removed all read here.
  if (typeof IntersectionObserver === 'function') {
    coverObserver = new IntersectionObserver(
      entries => {
        const last = entries[entries.length - 1];
        coverRatio = last.isIntersecting ? last.intersectionRatio : 0;
        scheduleSyncPlayback();
      },
      { threshold: [0, 0.5, 1] }
    );

    coverObserver.observe(thread);
  }
}

function syncVars() {
  if (!active || !layer) return;

  const prefs = getCustomBackgroundPrefs();
  const state = currentSource(prefs);

  ensureMedia(state.mode);

  if (state.mode === 'img') {
    if (media.getAttribute('src') !== state.src) {
      media.src = state.src;
    }
  } else if (active.poster && media.getAttribute('poster') !== active.poster) {
    media.poster = active.poster;
  }

  root.dataset.customBgMedia = state.mode === 'video' ? 'video' : 'image';

  if (active.animated) {
    root.dataset.customBgMotion = state.playing ? 'playing' : 'still';
  } else {
    delete root.dataset.customBgMotion;
  }

  const vars = buildBackgroundVars(prefs, {
    src: state.mode === 'img' ? state.src : null,
    playing: state.playing
  });

  for (const key of VAR_KEYS) {
    root.style.setProperty(key, vars[key]);
  }

  ensureThreadLayer();
  syncPlayback();

  // Motion state can change what blur is allowed on phones.
  applySurfaces();
}

function scheduleSync() {
  if (frame) return;

  frame = requestAnimationFrame(() => {
    frame = 0;
    syncVars();
  });
}

function revokeActive() {
  if (!active) return;

  // Let go of the video first: a revoked URL under a live decoder
  // is an error waiting to happen.
  if (media?.tagName === 'VIDEO') releaseBackgroundVideo(media);
  releaseBackgroundVideo(threadVideo);

  URL.revokeObjectURL(active.main);
  if (active.poster) URL.revokeObjectURL(active.poster);
  active = null;
}

function deactivate() {
  sequence++;

  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  if (playFrame) {
    cancelAnimationFrame(playFrame);
    playFrame = 0;
  }

  disposeThreadLayer();
  disposeMedia();

  if (layer) layer.remove();
  layer = null;

  revokeActive();
  resumeAt = 0;

  delete root.dataset.customBg;
  delete root.dataset.customBgMedia;
  delete root.dataset.customBgMotion;

  for (const key of VAR_KEYS) {
    root.style.removeProperty(key);
  }

  applySurfaces();
}

async function activate() {
  const mine = ++sequence;
  const prefs = getCustomBackgroundPrefs();

  if (!prefs.enabled || !prefs.hasImage) {
    deactivate();
    return;
  }

  let record = null;

  try {
    record = await dbGet();
  } catch {
    record = null;
  }

  if (mine !== sequence) return;

  if (!record || !record.blob) {
    // Storage was cleared underneath us (or never worked).
    writePrefs({ hasImage: false, enabled: false });
    deactivate();
    notify();
    return;
  }

  const kind = KINDS.includes(record.kind)
    ? record.kind
    : record.animated
      ? 'gif'
      : 'image';

  revokeActive();
  resumeAt = 0;

  active = {
    main: URL.createObjectURL(record.blob),
    poster: record.poster
      ? URL.createObjectURL(record.poster)
      : null,
    kind,
    animated: kind !== 'image',
    broken: false,
    meta: {
      kind,
      mime: record.mime || record.blob.type || '',
      width: record.width || 0,
      height: record.height || 0,
      duration: record.duration || 0,
      bytes: record.bytes || record.blob.size || 0
    }
  };

  // The record is the truth about what is stored.
  if (prefs.kind !== kind) writePrefs({ kind });

  ensureLayer();

  const state = currentSource(getCustomBackgroundPrefs());

  ensureMedia(state.mode);

  // Paint the first frame before switching the layer on, so the
  // background never flashes in half-decoded.
  const first = state.mode === 'img' ? state.src : active.poster;

  if (state.mode === 'img') media.src = first;

  if (first) {
    try {
      const probe = state.mode === 'img' ? media : createImage();
      if (probe !== media) probe.src = first;
      await probe.decode();
    } catch {
      // Show whatever the element can paint.
    }
  }

  if (mine !== sequence) return;

  root.dataset.customBg = 'on';
  syncVars();
  notify();
}

function listen() {
  if (listening) return;
  listening = true;

  // OS "reduce motion" flips while the app is open.
  reducedMotion?.addEventListener?.('change', scheduleSync);

  // Desktop <-> phone layout can change the allowed blur.
  try {
    window
      .matchMedia('(pointer: coarse)')
      .addEventListener('change', scheduleSync);
  } catch {
    // Older WebViews.
  }

  // Phone conversation layer on/off (rotation, window resize).
  try {
    phoneThread = window.matchMedia(PHONE_THREAD_QUERY);
    phoneThread.addEventListener('change', scheduleSyncPlayback);
  } catch {
    phoneThread = null;
  }

  // Nothing should decode video nobody can see: a hidden tab, a
  // backgrounded PWA, and (below) a backgrounded Capacitor app.
  const visibility = () =>
    setBackgroundPlaybackHold('hidden', document.hidden);

  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', () =>
    setBackgroundPlaybackHold('hidden', true)
  );
  window.addEventListener('pageshow', visibility);

  visibility();

  try {
    const app = window.Capacitor?.Plugins?.App;

    Promise.resolve(
      app?.addListener?.('appStateChange', state =>
        setBackgroundPlaybackHold('app', state?.isActive === false)
      )
    ).catch(() => {});
  } catch {
    // Not running inside Capacitor.
  }

  // dm.js announces each freshly built conversation view.
  window.addEventListener('wire:dm-layout', () => {
    if (!active) return;
    ensureThreadLayer();
    scheduleSyncPlayback();
  });
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * App startup. Reads the small localStorage flag synchronously;
 * touches IndexedDB (and decodes anything) only if the feature is
 * on and an image exists.
 */
export function initCustomBackground() {
  listen();

  const prefs = getCustomBackgroundPrefs();

  if (prefs.enabled && prefs.hasImage) {
    activate();
  }
}

/** Live-updating settings change (sliders, selects, toggles). */
export function setCustomBackgroundPrefs(patch) {
  const before = getCustomBackgroundPrefs();
  const after = writePrefs(patch);

  const wasOn = before.enabled && before.hasImage;
  const isOn = after.enabled && after.hasImage;

  if (wasOn !== isOn) {
    if (isOn) {
      activate();
    } else {
      deactivate();
      notify();
    }
  } else if (isOn) {
    scheduleSync();
  }

  return after;
}

/**
 * What the live layer is showing (null while off):
 *   { src, poster, playing, mode: 'img' | 'video', kind, animated }
 * `src` is a blob URL; `poster` is the still frame of an animation
 * or video (null for plain images).
 */
export function getActiveSource() {
  return active ? currentSource(getCustomBackgroundPrefs()) : null;
}

export async function applyCandidate(candidate) {
  await dbPut({
    kind: candidate.kind,
    blob: candidate.blob,
    poster: candidate.poster || null,
    animated: candidate.animated,
    mime: candidate.mime,
    width: candidate.width,
    height: candidate.height,
    duration: candidate.duration || 0,
    bytes: candidate.bytes || candidate.blob.size,
    savedAt: Date.now()
  });

  // Ask the browser not to evict it under storage pressure.
  navigator.storage?.persist?.().catch?.(() => {});

  writePrefs({
    hasImage: true,
    kind: candidate.kind,
    enabled: true
  });

  await activate();
}

/** Deletes the stored background and returns to the preset one. */
export async function removeCustomBackground() {
  try {
    await dbDelete();
  } catch {
    // Nothing stored, or storage unavailable — flags still reset.
  }

  writePrefs({
    hasImage: false,
    enabled: false
  });

  deactivate();
  notify();
}

export function resetBackgroundControls() {
  const patch = {};
  for (const key of CONTROL_KEYS) patch[key] = DEFAULTS[key];
  setCustomBackgroundPrefs(patch);
  notify();
}

export async function resetCustomBackground() {
  await removeCustomBackground();
  resetBackgroundControls();
}