import { fetchBlob } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';
import { isUserOnline, onPresenceChange } from '../chat/presence.js';

// ---------------------------------------------------------------------------
// Media Cache & Pending Requests
//
// Shared by both avatars and banners — same fetch/cache/dedupe/LRU-eviction
// logic applies to either, just keyed by `${kind}:${userId}` instead of
// bare userId, and pointed at a different endpoint. Kept as one cache
// (rather than duplicating this whole block for banners) per the "avoid
// duplicate code" requirement — avatarHtml()/applyAvatar()'s public
// behavior below is unchanged from before.
// ---------------------------------------------------------------------------
const mediaCache = {};            // "kind:userId" → objectURL (or null for missing)
const pendingFetches = new Map(); // "kind:userId" → { promise, controller }
const pendingElementLoads = new Map(); // elId → controller (for aborting per element)

let avatarSeq = 0;
let bannerSeq = 0;

// Maximum cache size to prevent unbounded memory growth. Bumped up a
// bit from the original 100 since the same cache now also holds
// banner entries.
const MAX_CACHE_SIZE = 150;
const cacheInsertOrder = [];      // cache key insertion order (most recent at end)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers `signal` as an interested party in a shared, in-flight
 * fetch. Multiple callers (different elements, or the same element
 * reloaded multiple times) can all be waiting on the *same* underlying
 * request via the dedup path below. The shared request must only be
 * cancelled once every last one of them has dropped out - not the
 * instant any single one does - otherwise one element's own routine
 * reentry-abort (e.g. applyAvatar() called again for that element)
 * kills the network request for every other consumer still relying on
 * its result, even ones that never asked to cancel anything.
 */
function registerWaiter(entry, signal) {
  if (!signal) return;

  entry.waiters++;

  const drop = () => {
    entry.waiters--;
    if (entry.waiters <= 0) {
      entry.controller.abort();
    }
  };

  if (signal.aborted) {
    drop();
  } else {
    signal.addEventListener('abort', drop, { once: true });
  }
}

/**
 * Shared fetch/cache implementation for both avatars and banners.
 */
async function getMediaUrl(kind, userId, endpoint, signal = null) {
  const key = `${kind}:${userId}`;

  // 1. Return cached value immediately
  if (key in mediaCache) {
    return mediaCache[key];
  }

  // 2. Deduplicate in-flight requests - return the existing promise.
  // Register as a waiter so THIS caller's abort can't unilaterally
  // cancel a fetch other callers still need (see registerWaiter above).
  if (pendingFetches.has(key)) {
    const entry = pendingFetches.get(key);
    registerWaiter(entry, signal);
    return entry.promise;
  }

  // 3. First caller for this key: create the shared AbortController
  // that the actual network request will use, and register this
  // caller as its first waiter.
  const controller = new AbortController();
  const entry = { controller, waiters: 0, promise: null };
  registerWaiter(entry, signal);

  entry.promise = (async () => {
    try {
      const blob = await fetchBlob(endpoint, {
        signal: controller.signal
      });

      // Validate that the blob is actually an image (graceful handling)
      const objectURL = URL.createObjectURL(blob);
      const isValidImage = await validateImageBlob(objectURL);

      if (!isValidImage) {
        URL.revokeObjectURL(objectURL);
        throw new Error('Invalid image data');
      }

      // Cache the valid object URL
      mediaCache[key] = objectURL;
      updateCacheOrder(key);
      return objectURL;
    } catch (e) {
      // An aborted request (element removed/re-requested mid-flight,
      // page navigated away, etc.) is not an answer about whether the
      // media exists - it's just an incomplete attempt. Caching `null`
      // for it would permanently "poison" this key: every future
      // getAvatarUrl()/getBannerUrl() call hits the `key in mediaCache`
      // check up top and returns the cached `null` without ever
      // fetching again, until something happens to call
      // invalidateAvatar()/invalidateBanner() for this exact user.
      // That's a real path to a stuck old/blank avatar that only a
      // manual page refresh (which rebuilds the whole module and its
      // cache from scratch) would clear. Only genuine failures - the
      // media doesn't exist (404), or is corrupt - should be cached,
      // so we don't hammer the server with repeat requests for
      // something that's actually just missing.
      if (e.name === 'AbortError') {
        return null;
      }

      // Store null in cache to avoid repeated requests for missing media
      mediaCache[key] = null;
      updateCacheOrder(key);
      return null;
    } finally {
      pendingFetches.delete(key);
    }
  })();

  pendingFetches.set(key, entry);
  return entry.promise;
}

/**
 * Fetch a user's avatar as a blob URL.
 * The optional signal can be used to abort the request.
 * If a request for the same userId is already in flight, it returns that promise.
 */
export async function getAvatarUrl(userId, signal = null) {
  return getMediaUrl('avatar', userId, `/api/me/avatar/${userId}`, signal);
}

/**
 * Fetch a user's banner as a blob URL. Same caching/dedup behavior as
 * getAvatarUrl.
 */
export async function getBannerUrl(userId, signal = null) {
  return getMediaUrl('banner', userId, `/api/me/banner/${userId}`, signal);
}

function invalidateMedia(key) {
  const url = mediaCache[key];
  if (url) {
    URL.revokeObjectURL(url);
    delete mediaCache[key];
    const idx = cacheInsertOrder.indexOf(key);
    if (idx !== -1) cacheInsertOrder.splice(idx, 1);
  }
}

/**
 * Remove a cached avatar and revoke its blob URL.
 */
export function invalidateAvatar(userId) {
  invalidateMedia(`avatar:${userId}`);
}

/**
 * Remove a cached banner and revoke its blob URL.
 */
export function invalidateBanner(userId) {
  invalidateMedia(`banner:${userId}`);
}

/**
 * Set the background image of an element to the user's avatar.
 * If the element no longer exists or the avatar is missing, the operation is silently skipped.
 */
export async function applyAvatar(elId, userId) {
  const el = document.getElementById(elId);
  if (!el) return;

  // متن فعلی (حروف اول اسم) را قبل از فراخوانی async ذخیره می‌کنیم
  // تا اگر آواتار موجود نبود/حذف شده بود بتوانیم برش گردانیم.
  //
  // Read/write through the dedicated .avatar-initials child instead
  // of el.textContent directly — avatarHtml() may also render a
  // sibling .presence-dot span inside this element, and
  // `el.textContent = ...` would silently delete that sibling too.
  const initialsEl = el.querySelector('.avatar-initials');
  const fallbackText = initialsEl ? initialsEl.textContent : el.textContent;

  // Abort any previous load for this specific element to avoid race conditions
  if (pendingElementLoads.has(elId)) {
    pendingElementLoads.get(elId).abort();
    pendingElementLoads.delete(elId);
  }

  const controller = new AbortController();
  pendingElementLoads.set(elId, controller);

  try {
    const url = await getAvatarUrl(userId, controller.signal);
    // Re-check element existence after async operation
    if (!document.getElementById(elId)) return;

    const targetInitialsEl = el.querySelector('.avatar-initials');

    if (url) {
      el.style.backgroundImage = `url("${url}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      if (targetInitialsEl) targetInitialsEl.textContent = ''; // hide initials
      else el.textContent = '';
    } else {
      // بدون آواتار: هر عکس قبلی را پاک و حروف اول اسم را نمایش بده
      el.style.backgroundImage = '';
      if (targetInitialsEl) targetInitialsEl.textContent = fallbackText;
      else el.textContent = fallbackText;
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      // Request was intentionally aborted – do nothing
    } else {
      // Other errors: keep the initials visible
    }
  } finally {
    pendingElementLoads.delete(elId);
  }
}

/**
 * Set an element's background image to the user's banner.
 * Adds/removes a 'has-banner' class so CSS can show a placeholder
 * gradient when there's no banner, instead of an empty box.
 */
export async function applyBanner(elId, userId) {
  const el = document.getElementById(elId);
  if (!el) return;

  if (pendingElementLoads.has(elId)) {
    pendingElementLoads.get(elId).abort();
    pendingElementLoads.delete(elId);
  }

  const controller = new AbortController();
  pendingElementLoads.set(elId, controller);

  try {
    const url = await getBannerUrl(userId, controller.signal);
    if (!document.getElementById(elId)) return;

    if (url) {
      el.style.backgroundImage = `url("${url}")`;
      el.classList.add('has-banner');
    } else {
      el.style.backgroundImage = '';
      el.classList.remove('has-banner');
    }
  } catch (e) {
    // Other errors: leave the placeholder showing
  } finally {
    pendingElementLoads.delete(elId);
  }
}

/**
 * Generate HTML for an avatar placeholder and schedule its image load.
 * Pass showPresence=true to overlay a green/gray online status dot
 * (used in the DM list and Admin user list — omitted elsewhere, e.g.
 * chat message avatars, to avoid visual noise).
 */
export function avatarHtml(userId, username, className = 'chat-avatar', showPresence = false) {
  const id = `avatar-${avatarSeq++}`;
  const initials = username ? username.charAt(0).toUpperCase() : '?';

  queueMicrotask(() => {
    applyAvatar(id, userId);
  });

  const dotHtml = showPresence
    ? `<span class="presence-dot${isUserOnline(userId) ? ' online' : ''}" data-presence-user="${userId}"></span>`
    : '';

  return `
  <div
    class="${className} clickable-avatar"
    id="${id}"
    data-avatar-user="${Number(userId)}"
    onclick="event.stopPropagation(); window.openProfileCard(${Number(userId)})"
    title="View profile">
    <span class="avatar-initials">${escapeHtml(initials)}</span>${dotHtml}
  </div>`;
}

/**
 * Generate HTML for a banner placeholder and schedule its image load.
 * Not clickable by itself — it's always rendered inside a context
 * (Settings, the profile card) that already has its own interactions.
 */
export function bannerHtml(userId, className = 'profile-banner') {
  const id = `banner-${bannerSeq++}`;

  queueMicrotask(() => {
    applyBanner(id, userId);
  });

  return `<div class="${className}" id="${id}" data-banner-user="${Number(userId)}"></div>`;
}

/**
 * Refresh a user's avatar everywhere it's currently mounted in the DOM
 * (sidebar, chat/DM messages, DM list, profile card, settings, etc.),
 * without a page reload.
 *
 * Rather than manually patching individual known elements (which misses
 * any avatar rendered elsewhere in the UI at the time of the update),
 * this drops the cached copy and re-applies to every element tagged
 * with data-avatar-user for this user — the same broadcast pattern
 * already used for presence dots.
 */
export function refreshAvatarEverywhere(userId) {
  invalidateAvatar(userId);
  document
    .querySelectorAll(`[data-avatar-user="${userId}"]`)
    .forEach(el => applyAvatar(el.id, userId));
}

/**
 * Same as refreshAvatarEverywhere(), for banners.
 */
export function refreshBannerEverywhere(userId) {
  invalidateBanner(userId);
  document
    .querySelectorAll(`[data-banner-user="${userId}"]`)
    .forEach(el => applyBanner(el.id, userId));
}

// Registered once for the lifetime of the app (not per avatar — see
// the note at the top of presence.js for why). On every presence
// change, just sync whichever dots for that user happen to be in the
// DOM right now; a full snapshot refresh (userId === null) syncs all
// of them.
onPresenceChange((userId, isOnline) => {
  const selector = userId === null
    ? '.presence-dot'
    : `.presence-dot[data-presence-user="${userId}"]`;

  document.querySelectorAll(selector).forEach((dot) => {
    const uid = dot.dataset.presenceUser;
    dot.classList.toggle('online', isUserOnline(uid));
  });
});

// ---------------------------------------------------------------------------
// Cleanup & Abort Functions
// ---------------------------------------------------------------------------

/**
 * Abort the avatar fetch associated with a specific element (e.g. before removing it).
 */
export function abortAvatarLoad(elId) {
  const controller = pendingElementLoads.get(elId);
  if (controller) {
    controller.abort();
    pendingElementLoads.delete(elId);
  }
}

/**
 * Revoke **all** cached avatar/banner blob URLs and clear the cache.
 * Useful during logout or full UI reset.
 */
export function revokeAllAvatars() {
  for (const key in mediaCache) {
    const url = mediaCache[key];
    if (url) {
      URL.revokeObjectURL(url);
      delete mediaCache[key];
    }
  }
  cacheInsertOrder.length = 0;
  // Also abort all pending fetches
  for (const { controller } of pendingFetches.values()) {
    controller.abort();
  }
  pendingFetches.clear();
  // Abort all per‑element requests
  for (const controller of pendingElementLoads.values()) {
    controller.abort();
  }
  pendingElementLoads.clear();
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a blob URL points to a loadable image.
 * Returns true if the image decodes successfully.
 */
function validateImageBlob(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/**
 * Maintain the insertion order list and enforce cache size limit.
 * When the cache exceeds MAX_CACHE_SIZE, the oldest entry is evicted.
 */
function updateCacheOrder(key) {
  // Remove existing entry if present (e.g., cache update)
  const idx = cacheInsertOrder.indexOf(key);
  if (idx !== -1) cacheInsertOrder.splice(idx, 1);
  cacheInsertOrder.push(key);

  // Evict oldest entries if over limit
  while (cacheInsertOrder.length > MAX_CACHE_SIZE) {
    const oldest = cacheInsertOrder.shift();
    if (oldest in mediaCache) {
      const oldUrl = mediaCache[oldest];
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      delete mediaCache[oldest];
    }
  }
}