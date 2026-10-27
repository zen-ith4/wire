// public/js/media/lazy-e2ee-media.js
//
// Lazy download + decrypt for end-to-end encrypted audio/video.
//
// An encrypted attachment is ciphertext on the server, so playing it
// means downloading the whole file and decrypting it into a Blob. Doing
// that for every audio/video the moment its message renders would pull
// (and hold in memory) every large file in a chat. Instead the player is
// rendered WITHOUT a source, and the first play() — from any control:
// the play button, a click on the video, the keyboard — triggers the
// download, decrypt and src assignment, then plays.
//
// C3: encrypted DM video/audio strictly above 8 MiB may instead register a
// stream with the Service Worker (sw-stream-client.js) and point the element
// at /__wire_media_stream/<id>. That path is used only when the worker says
// its flag is ON; every other case, including every error before the stream
// starts, runs the old Blob path below.
//
// Blob lifecycle: the blob: URL is stamped on the element as
// data-blob-url (revokeMediaPlayerBlobUrls() in attachments.js revokes it
// on message removal / leaving the chat). A blob that finishes decrypting
// after its player has already gone away is revoked here, never leaked.

import { getAttachmentSecret } from './attachment-e2ee.js';
import * as mediaToken from './mediaToken.js';
import { streamBytesToBase64 } from '../crypto/messages/attachment-stream.js';
import { createSwStreamClient, isMediaStreamCandidate } from './sw-stream-client.js';

let defaultStreamClient = null;

function streamClientForPage() {
  if (defaultStreamClient) return defaultStreamClient;

  defaultStreamClient = createSwStreamClient({
    serviceWorker: typeof navigator !== 'undefined' ? navigator.serviceWorker : null,
    mintMediaToken: ({ scope, messageId }) => {
      if (typeof mediaToken.getMediaToken !== 'function') {
        return Promise.reject(new Error('Media token helper is unavailable'));
      }
      return mediaToken.getMediaToken(scope, messageId);
    },
  });

  return defaultStreamClient;
}

/**
 * Page-side teardown for C4: purge this client's streams in the worker and
 * detach their elements. The worker derives the client from event.source.id,
 * so no clientId is ever sent and another tab cannot be purged.
 */
export function purgeMediaStreams() {
  try {
    const client = streamClientForPage();
    if (client && typeof client.purge === 'function') {
      client.purge();
    } else if (client && typeof client.purgeClient === 'function') {
      client.purgeClient();
    }
  } catch {
    /* fail closed: a purge error must not stop secret clearing */
  }
}

if (
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  window.addEventListener('pagehide', (event) => {
    if (event && event.persisted === false) {
      try {
        purgeMediaStreams();
      } catch {
        /* best effort */
      }
    }
  });
}
export function isLazyE2eeMedia(msg, scope) {
  return !!getAttachmentSecret(scope, msg && msg.id);
}

/**
 * dm.js calls mountAttachmentMedia() while the message element is still
 * detached (the caller appends it right after). The eager path never
 * noticed because it awaits a network request first; the lazy path has
 * nothing to await, so it must wait for the container to be attached
 * before deciding the message "disappeared". Resolves false if it never
 * gets attached (message really gone).
 */
export async function waitUntilAttached(el, timeoutMs = 3000) {
  const start = Date.now();
  while (!document.body.contains(el)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return true;
}

/**
 * Wraps mediaEl.play() so the first call loads the source first.
 * @param {HTMLMediaElement} mediaEl element WITHOUT a src
 * @param {object} o
 * @param {object} o.msg    message (needs .id)
 * @param {string} o.scope  'dm'
 * @param {() => boolean} o.isAlive false once the player left the DOM
 * @param {(loading: boolean) => void} [o.onLoading]
 * @param {(error: Error) => void} [o.onError]
 * @param {object} [o.streamClient] injected C3 client (tests)
 * @param {(msg: object, scope: string) => Promise<object>} [o.resolveSrc]
 * @param {(scope: string, id: string|number) => object|null} [o.getSecret]
 * @returns {() => Promise<void>} ensureSource()
 */
export function installLazySource(mediaEl, {
  msg,
  scope,
  isAlive,
  onLoading,
  onError,
  streamClient,
  resolveSrc = (message, mediaScope) => mediaToken.resolveMediaSrc(message, mediaScope),
  getSecret = getAttachmentSecret,
} = {}) {
  const nativePlay = mediaEl.play.bind(mediaEl);
  let pending = null;
  let streamHandle = null;
  let streamFailed = false;
  let playRequested = false;

  mediaEl.addEventListener('pause', () => {
    playRequested = false;
  });
  mediaEl.addEventListener('playing', () => {
    playRequested = true;
  });

  function resumePlayback() {
    try {
      const played = nativePlay();
      if (played && typeof played.catch === 'function') {
        played.catch(() => {});
      }
    } catch {
      /* the player's own error state handles a failed resume */
    }
  }

  function applyBlobSource(resolved) {
    if (!isAlive()) {
      if (resolved.isBlob) URL.revokeObjectURL(resolved.src);
      throw new Error('Player was removed before the media was ready');
    }
    if (resolved.isBlob) mediaEl.dataset.blobUrl = resolved.src;
    mediaEl.src = resolved.src;
    return resolved;
  }

  function fallbackToBlob() {
    if (streamFailed) return;
    streamFailed = true;
    streamHandle = null;

    if (!isAlive()) {
      if (onLoading) onLoading(false);
      return;
    }

    const position = Number.isFinite(mediaEl.currentTime) ? mediaEl.currentTime : 0;
    const shouldPlay = !mediaEl.paused || playRequested;

    if (onLoading) onLoading(true);

    let fallbackPromise;
    fallbackPromise = resolveSrc(msg, scope)
      .then((resolved) => {
        if (!isAlive()) {
          if (resolved.isBlob) URL.revokeObjectURL(resolved.src);
          return;
        }

        if (resolved.isBlob) mediaEl.dataset.blobUrl = resolved.src;

        let restored = false;
        const restore = () => {
          if (restored) return;
          restored = true;

          try {
            if (position > 0) mediaEl.currentTime = position;
          } catch {
            /* seeking is best effort */
          }

          if (shouldPlay) resumePlayback();
        };

        mediaEl.addEventListener('loadedmetadata', restore, { once: true });
        mediaEl.src = resolved.src;
        if (mediaEl.readyState >= 1) restore();
      })
      .catch((error) => {
        if (onError && isAlive()) onError(error);
        throw error;
      })
      .finally(() => {
        if (onLoading) onLoading(false);
        if (pending === fallbackPromise) pending = null;
      });

    // The fallback promise is reached through pending (and through a later
    // play); the no-op catch prevents an unhandled rejection when it is not.
    fallbackPromise.catch(() => {});
    pending = fallbackPromise;
  }

  async function resolveLazySource() {
    // A stream that died on this element must not be registered again: the
    // fallback is once per element, including later user-initiated plays.
    if (streamFailed) {
      return applyBlobSource(await resolveSrc(msg, scope));
    }

    let secret = null;
    try {
      secret = getSecret(scope, msg && msg.id);
    } catch {
      secret = null;
    }

    const candidate = !!secret && isMediaStreamCandidate({
      encrypted: true,
      scope,
      mime: secret.mime,
      plainSize: secret.size,
      isVoice: secret.isVoice,
      download: false,
    });

    if (!candidate) {
      return applyBlobSource(await resolveSrc(msg, scope));
    }

    let client;
    try {
      client = streamClient || streamClientForPage();
    } catch {
      return applyBlobSource(await resolveSrc(msg, scope));
    }

    let enabled = false;
    try {
      enabled = await client.probe();
    } catch {
      enabled = false;
    }

    if (!enabled) {
      return applyBlobSource(await resolveSrc(msg, scope));
    }

    if (!isAlive()) {
      throw new Error('Player was removed before the media was ready');
    }

    let handle;
    try {
      handle = client.start({
        messageId: msg && msg.id,
        keyB64: streamBytesToBase64(secret.rawKey),
        baseIvB64: streamBytesToBase64(secret.baseIv),
        mime: secret.mime,
        plainSize: secret.size,
        element: mediaEl,
        onFallback: fallbackToBlob,
      });
    } catch {
      return applyBlobSource(await resolveSrc(msg, scope));
    }

    if (!isAlive()) {
      handle.unregister('removed');
      throw new Error('Player was removed before the media was ready');
    }

    streamHandle = handle;

    const onMediaError = () => {
      if (!streamHandle || !streamHandle.active) return;
      streamHandle.fallback('media-error');
    };

    mediaEl.addEventListener('error', onMediaError);
    if (typeof handle.setCleanup === 'function') {
      handle.setCleanup(() => mediaEl.removeEventListener('error', onMediaError));
    }

    // client.start() posted REGISTER_STREAM synchronously; only now may the
    // element point at the stream route.
    mediaEl.src = handle.src;
  }

  function ensureSource() {
    if (mediaEl.dataset.blobUrl) return Promise.resolve();

    if (!pending) {
      if (onLoading) onLoading(true);

      pending = resolveLazySource()
        .catch((error) => {
          pending = null; // allow a retry on the next play
          if (onError && isAlive()) onError(error);
          throw error;
        })
        .finally(() => {
          if (onLoading) onLoading(false);
        });
    }

    return pending;
  }

  mediaEl.play = () => {
    playRequested = true;
    return ensureSource().then(() => nativePlay());
  };

  return ensureSource;
}
