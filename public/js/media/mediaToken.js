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

// 60 s = the server's 90 s TTL minus a 30 s margin for clock skew and a
// request already in flight. The worker is told the same expiry.
const TOKEN_CACHE_TTL_MS = 60_000;
const tokenCache = new Map(); // key: `${scope}:${id}` -> { token, expiresAt }

function attachmentBaseUrl(scope, id) {
  return scope === 'dm'
    ? `/api/dm/attachments/${encodeURIComponent(id)}`
    : `/api/chat/attachments/${encodeURIComponent(id)}`;
}

/**
 * Returns the token together with the conservative expiry the Service Worker
 * needs. It reuses the existing cache; a cached token is returned with its
 * original expiry, so the worker is never told a token lives longer than it
 * really does.
 */
export async function getMediaToken(scope, id) {
  const key = `${scope}:${id}`;
  const cached = tokenCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return { token: cached.token, expiresAt: cached.expiresAt };
  }

  const data = await api(`${attachmentBaseUrl(scope, id)}/media-token`);
  const token = data?.token || null;

  if (!token) return { token: null, expiresAt: 0 };

  const expiresAt = Date.now() + TOKEN_CACHE_TTL_MS;
  tokenCache.set(key, { token, expiresAt });
  return { token, expiresAt };
}

async function fetchMediaToken(scope, id) {
  const { token } = await getMediaToken(scope, id);
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

// ======================================================
// PLAYBACK TYPE OF A DECRYPTED AUDIO BLOB
//
// An encrypted attachment's MIME type is whatever the SENDER's browser put on
// the File (attachment-e2ee.js seals file.type into the metadata), and
// browsers disagree: Chrome on Windows labels .m4a "audio/x-m4a", other
// platforms say "audio/mp3" or "audio/x-wav", and an extension the OS does not
// know arrives as "" - which parseAttachmentMeta() turns into
// "application/octet-stream". Chromium sniffs past all of that, but Safari and
// Firefox choose the decoder from the type, so the same file could play in one
// browser and fail in another. The aliases map to the registered type, and
// the extension recovers the type when the label says nothing.
//
// Playback only: nothing stored, sent or downloaded changes, and a non-audio
// type (video, image, ...) is never touched. Kept in this module (rather than
// a new one) because it is exactly the "what does the element get" decision
// resolveMediaSrc() makes.
// ======================================================

const AUDIO_TYPE_ALIASES = Object.freeze({
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-mp4': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-mpeg-3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-pn-wav': 'audio/wav',
  'audio/x-flac': 'audio/flac',
  'audio/x-aac': 'audio/aac',
  'audio/aacp': 'audio/aac',
  'audio/opus': 'audio/ogg',
  'audio/x-ogg': 'audio/ogg',
  'audio/vorbis': 'audio/ogg',
});

// The extensions audio-player.js's isAudio() treats as audio, minus the one no
// browser decodes (wma).
const AUDIO_TYPE_BY_EXTENSION = Object.freeze({
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  weba: 'audio/webm',
});

const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

function fileExtension(name) {
  const value = String(name || '');
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return '';
  return value.slice(dot + 1).toLowerCase();
}

/**
 * The registered audio type to play `mime`/`name` as, or null when this is not
 * audio (the caller then keeps whatever type it had).
 */
export function playbackAudioType(mime, name) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();

  if (base.startsWith('audio/')) return AUDIO_TYPE_ALIASES[base] || base;
  if (base === 'application/ogg') return 'audio/ogg';

  if (GENERIC_TYPES.has(base)) {
    return AUDIO_TYPE_BY_EXTENSION[fileExtension(name)] || null;
  }

  return null;
}

/**
 * `blob` labelled with its playback audio type. A Blob built from another Blob
 * references the same bytes (nothing is copied); `blob` itself comes back when
 * there is nothing to change.
 */
export function withPlaybackAudioType(blob, { mime, name } = {}) {
  if (!blob || typeof Blob === 'undefined') return blob;

  const type = playbackAudioType(mime || blob.type, name);
  if (!type || type === blob.type) return blob;

  return new Blob([blob], { type });
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
 *
 * Audio is labelled with its registered type for playback (see
 * media-mime.js): the sender's browser may have sealed an alias such as
 * "audio/x-m4a", or no type at all, and only Chromium sniffs past that.
 */
export async function resolveMediaSrc(msg, scope = 'dm') {
  const id = msg && msg.id;
  const secret = getAttachmentSecret(scope, id);

  if (secret) {
    const blob = await fetchDecryptedAttachment(scope, id);
    const playable = withPlaybackAudioType(blob, {
      mime: secret.mime,
      name: secret.name || (msg && msg.attachment_name),
    });
    return { src: URL.createObjectURL(playable), isBlob: true };
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
