import { api } from '../core/api.js';

// ======================================================
// SCOPED MEDIA URLS
//
// <video>/<audio> elements set `src` directly and can't send a
// custom Authorization header, so playback has to authenticate via
// a `?token=` query param instead (see middleware/mediaAuth.js on
// the backend). That token is deliberately NOT the long-lived
// session JWT — putting that in a URL risks it leaking via browser
// history or a Referer header for as long as the session lives.
//
// Instead, this fetches a short-lived (~90s) token scoped to one
// specific attachment from `.../attachments/:id/media-token` (an
// ordinary authenticated request, using the normal Authorization
// header) right before building the <video>/<audio> src, and caches
// it briefly so re-rendering the same message shortly after doesn't
// re-request a token every time.
// ======================================================

const TOKEN_CACHE_TTL_MS = 60_000; // stay under the ~90s server-side expiry
const tokenCache = new Map(); // key: `${scope}:${id}` -> { token, expiresAt }

function attachmentBaseUrl(scope, id) {
  return scope === 'dm'
    ? `/api/dm/attachments/${encodeURIComponent(id)}`
    : `/api/chat/attachments/${encodeURIComponent(id)}`;
}

async function fetchMediaToken(scope, id) {
  const key = `${scope}:${id}`;
  const cached = tokenCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const data = await api(`${attachmentBaseUrl(scope, id)}/media-token`);
  const token = data?.token || null;

  if (token) {
    tokenCache.set(key, {
      token,
      expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
    });
  }

  return token;
}

/**
 * Resolves to a playable src URL for a chat/DM attachment, with a
 * freshly (or recently) minted attachment-scoped token attached.
 * Falls back to the bare (unauthenticated-looking) URL if a token
 * couldn't be obtained — the request will then simply 401, same as
 * today when no token is available at all.
 */
export async function getMediaSrcUrl(scope, id) {
  const baseUrl = attachmentBaseUrl(scope, id);

  try {
    const token = await fetchMediaToken(scope, id);
    if (!token) return baseUrl;
    return `${baseUrl}?token=${encodeURIComponent(token)}`;
  } catch (err) {
    console.error('Failed to obtain media token:', err);
    return baseUrl;
  }
}

export function clearMediaTokenCache() {
  tokenCache.clear();
}
