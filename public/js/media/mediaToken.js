import { api } from '../core/api.js';
import { getAttachmentSecret, fetchDecryptedAttachment } from './attachment-e2ee.js';

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

/**
 * Resolves what an <audio>/<video> element should use as its src.
 *
 *  - End-to-end encrypted attachment (a key is registered for it):
 *    downloads the ciphertext, decrypts it, and returns a NEW blob: URL
 *    -> { src, isBlob: true }. The caller owns that URL and MUST revoke
 *    it when the element goes away (see revokeMediaPlayerBlobUrls() in
 *    attachments.js) or if it ends up never being used.
 *  - Legacy plaintext attachment: the scoped token URL, as before
 *    -> { src, isBlob: false }.
 *
 * Rejects (AttachmentDecryptError) when an encrypted file fails
 * authentication, so callers show their normal "failed to load" state.
 */
export async function resolveMediaSrc(msg, scope = 'dm') {
  const id = msg && msg.id;

  if (getAttachmentSecret(scope, id)) {
    const blob = await fetchDecryptedAttachment(scope, id);
    return { src: URL.createObjectURL(blob), isBlob: true };
  }

  return { src: await getMediaSrcUrl(scope, id), isBlob: false };
}

export function clearMediaTokenCache() {
  tokenCache.clear();
}

/**
 * Forces a brand-new, non-cached media token and returns a fresh src
 * URL built from it — for when playback fails because the token baked
 * into the element's `src` at render time has since expired (the
 * ~90s TTL is intentionally short; a message opened a while before the
 * user gets around to pressing play is the normal, expected case, not
 * an error).
 *
 * Propagates whatever error `api()` throws for the underlying
 * `.../media-token` request: in particular, a real expired/invalid
 * *login* session surfaces as `Error('Session expired')` (see
 * core/api.js), which callers can check for to tell "the media token
 * needed a refresh" apart from "the user needs to log in again" —
 * those are different failures and should show different messages.
 */
export async function refreshMediaSrcUrl(scope, id) {
  const key = `${scope}:${id}`;
  tokenCache.delete(key);

  return getMediaSrcUrl(scope, id);
}
