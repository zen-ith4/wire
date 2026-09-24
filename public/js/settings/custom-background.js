// ============================================================
// Custom chat background
//
// A purely local UI preference. The image never leaves the
// device: no upload, no API call, nothing in the service-worker
// cache.
//
// Where things live
//   - Settings (enabled, opacity, dim, blur, fit, position,
//     animate, and a "has an image" flag): one JSON object in
//     localStorage under `wire-custom-bg`, the same store every
//     other appearance preference uses (see theme.js).
//   - The image itself: IndexedDB (`wire-appearance` / `assets`).
//     localStorage is a string store with a ~5 MB quota, which is
//     no place for a photo; IndexedDB stores the Blob as-is and
//     works the same in a browser tab, Electron and the Capacitor
//     Android WebView, with no plugin or new dependency. (Wire
//     already does this for custom message sounds.)
//
// Rendering
//   One fixed <div id="custom-bg"> holding a single <img>, right
//   above #ambient-underlay. It is created only while the feature
//   is on and has an image — when off there is no element, no blob
//   URL and no decode. Every control is a CSS custom property, so a
//   slider drag is a property write, not a re-render.
//
// Large images are downscaled once, at import, with the browser's
// own decoder (createImageBitmap resize hint, so the full-size
// bitmap is never materialised where supported). Animated GIFs /
// WebP / APNG are stored byte-for-byte so they stay animated; a
// still poster frame is stored next to them and used whenever the
// user pauses the animation or prefers reduced motion.
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

export const DEFAULTS = Object.freeze({
  enabled: false,
  hasImage: false,
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
const POSTER_SIDE = 1280;     // still frame of an animation
const KEEP_ORIGINAL_BYTES = 2.5 * 1024 * 1024;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_ANIMATED_BYTES = 12 * 1024 * 1024;
const MAX_ANIMATED_SIDE = 2560;
const MAX_PIXELS = 120e6;

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

  return {
    enabled: p.enabled === true,
    hasImage: p.hasImage === true,
    animated: p.animated === true,

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
      'Unsupported file. Choose a JPG, PNG, WebP or GIF image.'
    );
  }

  if (file.size > MAX_INPUT_BYTES) {
    throw fail('That image is too large. Choose one under 40 MB.');
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
    blob,
    poster,
    url,
    posterUrl,
    animated: info.animated,
    mime: blob.type || info.mime,
    width,
    height
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

let layer = null;
let img = null;
let active = null; // { main, poster, animated } blob URLs
let sequence = 0;
let frame = 0;
let listening = false;

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

/**
 * The exact custom properties the background needs. Shared by the
 * live layer (set on <html>) and the Settings preview (set on the
 * preview element), so the two can never look different.
 *
 * blurScale shrinks the blur radius for the small preview.
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

  const position =
    POSITION_OPTIONS.find(o => o.id === prefs.position)?.css ||
    '50% 50%';

  return {
    '--cbg-opacity': String(prefs.opacity / 100),
    '--cbg-dim': String(prefs.dim / 100),
    '--cbg-fit': prefs.fit,
    '--cbg-pos': position,
    '--cbg-filter': px > 0 ? `blur(${px}px)` : 'none',
    '--cbg-scale':
      px > 0
        ? `scale(${(1 + Math.min(px / 200, 0.12)).toFixed(3)})`
        : 'none',
    '--cbg-url': src ? `url("${src}")` : 'none',
    '--cbg-size':
      prefs.fit === 'fill'
        ? '100% 100%'
        : prefs.fit === 'none'
          ? 'auto'
          : prefs.fit
  };
}

function ensureLayer() {
  if (layer) return;

  layer = document.createElement('div');
  layer.id = 'custom-bg';
  layer.className = 'cbg-surface';
  layer.setAttribute('aria-hidden', 'true');

  img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;

  layer.appendChild(img);

  const anchor = document.getElementById('ambient-underlay');

  if (anchor) {
    anchor.after(layer);
  } else {
    document.body.prepend(layer);
  }
}

function currentSource(prefs) {
  if (!active) return { src: null, playing: false };

  const playing = active.animated && shouldPlayAnimation(prefs);

  const src =
    active.animated && !playing && active.poster
      ? active.poster
      : active.main;

  return { src, playing };
}

function syncVars() {
  if (!active || !img) return;

  const prefs = getCustomBackgroundPrefs();
  const { src, playing } = currentSource(prefs);

  if (img.getAttribute('src') !== src) {
    img.src = src;
  }

  if (active.animated) {
    root.dataset.customBgMotion = playing ? 'playing' : 'still';
  } else {
    delete root.dataset.customBgMotion;
  }

  const vars = buildBackgroundVars(prefs, { src, playing });

  for (const key of VAR_KEYS) {
    root.style.setProperty(key, vars[key]);
  }

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

  if (img) img.removeAttribute('src');
  if (layer) layer.remove();
  layer = null;
  img = null;

  revokeActive();

  delete root.dataset.customBg;
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
    writePrefs({ hasImage: false, enabled: false, animated: false });
    deactivate();
    notify();
    return;
  }

  revokeActive();

  active = {
    main: URL.createObjectURL(record.blob),
    poster: record.poster
      ? URL.createObjectURL(record.poster)
      : null,
    animated: record.animated === true
  };

  ensureLayer();

  const { src } = currentSource(getCustomBackgroundPrefs());
  img.src = src;

  try {
    await img.decode();
  } catch {
    // Show whatever the element can paint.
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

/** The blob URL the live layer is showing (null while off). */
export function getActiveSource() {
  return active ? currentSource(getCustomBackgroundPrefs()) : null;
}

export async function applyCandidate(candidate) {
  await dbPut({
    blob: candidate.blob,
    poster: candidate.poster || null,
    animated: candidate.animated,
    mime: candidate.mime,
    width: candidate.width,
    height: candidate.height,
    savedAt: Date.now()
  });

  // Ask the browser not to evict it under storage pressure.
  navigator.storage?.persist?.().catch?.(() => {});

  writePrefs({
    hasImage: true,
    animated: candidate.animated,
    enabled: true
  });

  await activate();
}

/** Deletes the stored image and returns to the preset background. */
export async function removeCustomBackground() {
  try {
    await dbDelete();
  } catch {
    // Nothing stored, or storage unavailable — flags still reset.
  }

  writePrefs({
    hasImage: false,
    animated: false,
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
