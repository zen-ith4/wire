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
// Blob lifecycle: the blob: URL is stamped on the element as
// data-blob-url (revokeMediaPlayerBlobUrls() in attachments.js revokes it
// on message removal / leaving the chat). A blob that finishes decrypting
// after its player has already gone away is revoked here, never leaked.

import { getAttachmentSecret } from './attachment-e2ee.js';
import { resolveMediaSrc } from './mediaToken.js';

/** True when this message is an encrypted attachment (key registered). */
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
 * @returns {() => Promise<void>} ensureSource()
 */
export function installLazySource(mediaEl, { msg, scope, isAlive, onLoading, onError }) {
  const nativePlay = mediaEl.play.bind(mediaEl);
  let pending = null;

  function ensureSource() {
    if (mediaEl.dataset.blobUrl) return Promise.resolve();

    if (!pending) {
      if (onLoading) onLoading(true);

      pending = resolveMediaSrc(msg, scope)
        .then((resolved) => {
          if (!isAlive()) {
            if (resolved.isBlob) URL.revokeObjectURL(resolved.src);
            throw new Error('Player was removed before the media was ready');
          }
          if (resolved.isBlob) mediaEl.dataset.blobUrl = resolved.src;
          mediaEl.src = resolved.src;
        })
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

  mediaEl.play = () => ensureSource().then(() => nativePlay());

  return ensureSource;
}
