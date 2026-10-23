// public/js/media/sw-stream-client.js
//
// The page-side half of the C3 encrypted DM media stream.
//
// The Service Worker owns the key registry, the Range/decrypt route and the
// media token wait. This module owns only the client handshake:
//
//   1. ask the controlling worker whether the route is enabled
//      (MEDIA_STREAM_STATUS over a MessageChannel, bounded by a short timeout);
//   2. register one stream with REGISTER_STREAM;
//   3. answer TOKEN_NEEDED with one UPDATE_TOKEN;
//   4. unregister on STREAM_DEAD, MediaError, element removal, or fallback.
//
// Every dependency is injected so the protocol can be tested in Node without
// a browser. The key and base IV exist in this module only as arguments to the
// REGISTER_STREAM postMessage. They are never put in a URL, a DOM attribute, a
// log, storage or Cache Storage.

/** Plaintext size strictly above which encrypted DM audio/video may stream. */
export const MEDIA_STREAM_MIN_PLAIN_BYTES = 8 * 1024 * 1024;

/**
 * How long the page waits for the worker's MEDIA_STREAM_STATUS reply.
 * RFC 9.12(2) uses 1000 ms. A missing reply must not hold up the first play
 * longer than that; an OFF worker replies immediately.
 */
export const MEDIA_STREAM_STATUS_TIMEOUT_MS = 1000;

/**
 * The worker needs an expiry with every media token. The server TTL is 90 s
 * (utils/jwt.js:118). The page tells the worker to renew after 60 s, leaving a
 * 30 s margin for clock skew and for the request already in flight.
 */
export const MEDIA_STREAM_TOKEN_MAX_TTL_MS = 60_000;

export const MEDIA_STREAM_URL_PREFIX = '/__wire_media_stream/';

function isMediaMime(mime) {
  if (typeof mime !== 'string') return false;
  const value = mime.toLowerCase();
  return value.startsWith('video/') || value.startsWith('audio/');
}

/**
 * Pure decision: should this attachment be a streaming candidate at all?
 *
 * `encrypted` is true only when attachment-e2ee.js has registered the
 * authenticated metadata for this message. `plainSize`, `mime` and `isVoice`
 * come from that decrypted envelope, never from a server header.
 */
export function isMediaStreamCandidate({
  encrypted,
  scope,
  mime,
  plainSize,
  isVoice,
  download,
} = {}) {
  if (encrypted !== true || scope !== 'dm') return false;
  if (isVoice === true || download === true) return false;
  if (!Number.isInteger(plainSize) || plainSize <= MEDIA_STREAM_MIN_PLAIN_BYTES) {
    return false;
  }
  return isMediaMime(mime);
}

export function shouldUseMediaStream({ enabled, controlled, ...candidate } = {}) {
  return enabled === true && controlled === true && isMediaStreamCandidate(candidate);
}

function defaultObserveRemoval(element, onRemoved) {
  if (
    !element ||
    typeof MutationObserver !== 'function' ||
    typeof document === 'undefined'
  ) {
    return () => {};
  }

  let observer = null;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (observer) observer.disconnect();
  };

  observer = new MutationObserver(() => {
    if (stopped) return;
    if (element.isConnected === false) {
      stop();
      onRemoved();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return stop;
}

export function createSwStreamClient({
  serviceWorker = null,
  MessageChannelImpl = globalThis.MessageChannel,
  randomUUID = () => globalThis.crypto.randomUUID(),
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  mintMediaToken = null,
  observeRemoval = defaultObserveRemoval,
  statusTimeoutMs = MEDIA_STREAM_STATUS_TIMEOUT_MS,
} = {}) {
  const streams = new Map();

  let cachedController = null;
  let cachedEnabled = null;
  let pendingProbe = null;
  let listening = false;

  function currentController() {
    return serviceWorker && serviceWorker.controller
      ? serviceWorker.controller
      : null;
  }

  function invalidateStatus() {
    cachedController = null;
    cachedEnabled = null;
    pendingProbe = null;
  }

  function requestStatus(controller) {
    return new Promise((resolve) => {
      let settled = false;
      let channel = null;
      let timer = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;

        if (timer !== null) {
          try {
            clearTimeoutFn(timer);
          } catch {
            /* a cleanup failure must not change the answer */
          }
        }

        if (channel) {
          try {
            if (typeof channel.port1.close === 'function') channel.port1.close();
          } catch {
            /* ignore */
          }
        }

        resolve(value);
      };

      try {
        if (typeof MessageChannelImpl !== 'function') {
          finish(false);
          return;
        }

        channel = new MessageChannelImpl();
        channel.port1.onmessage = (event) => {
          const data = event && event.data;
          finish(
            !!data &&
              data.type === 'MEDIA_STREAM_STATUS' &&
              data.enabled === true
          );
        };

        timer = setTimeoutFn(() => finish(false), statusTimeoutMs);
        controller.postMessage({ type: 'MEDIA_STREAM_STATUS' }, [channel.port2]);
      } catch {
        finish(false);
      }
    });
  }

  async function probe() {
    ensureListeners();

    const controller = currentController();
    if (!controller) return false;

    if (cachedController === controller && cachedEnabled !== null) {
      return cachedEnabled;
    }

    if (pendingProbe && pendingProbe.controller === controller) {
      return pendingProbe.promise;
    }

    let promise;
    promise = requestStatus(controller)
      .then((enabled) => {
        if (currentController() !== controller) return false;
        cachedController = controller;
        cachedEnabled = enabled;
        return enabled;
      })
      .catch(() => false)
      .finally(() => {
        if (pendingProbe && pendingProbe.promise === promise) pendingProbe = null;
      });

    pendingProbe = { controller, promise };
    return promise;
  }

  function postToWorker(stream, data) {
    const controller = stream.controller;
    if (!controller || typeof controller.postMessage !== 'function') return false;

    try {
      controller.postMessage(data);
      return true;
    } catch {
      return false;
    }
  }

  function closeStream(stream, reason, fallback) {
    if (!stream || !stream.active) return false;

    stream.active = false;
    streams.delete(stream.streamId);

    if (stream.stopObserving) {
      try {
        stream.stopObserving();
      } catch {
        /* removal observation is best effort */
      }
      stream.stopObserving = null;
    }

    if (stream.cleanup) {
      try {
        stream.cleanup();
      } catch {
        /* listener cleanup must not block the unregister */
      }
      stream.cleanup = null;
    }

    // The worker drops the key and aborts in-flight ciphertext fetches.
    postToWorker(stream, {
      type: 'UNREGISTER_STREAM',
      streamId: stream.streamId,
    });

    if (fallback && typeof stream.onFallback === 'function') {
      try {
        stream.onFallback(reason);
      } catch {
        /* the caller's Blob fallback is responsible for its own errors */
      }
    }

    return true;
  }

  function resolveExpiresAt(minted) {
    const at = now();
    let expiresAt = Number(minted && minted.expiresAt);

    if (!Number.isFinite(expiresAt)) {
      const seconds = Number(minted && minted.expiresIn);
      if (Number.isFinite(seconds)) expiresAt = at + seconds * 1000;
    }

    if (!Number.isFinite(expiresAt)) return 0;
    return Math.min(expiresAt, at + MEDIA_STREAM_TOKEN_MAX_TTL_MS);
  }

  function requestToken(stream) {
    if (!stream.active) return Promise.resolve();
    if (stream.mintPromise) return stream.mintPromise;

    stream.mintPromise = (async () => {
      let minted;
      try {
        minted = await mintMediaToken({
          scope: 'dm',
          messageId: stream.messageId,
        });
      } catch {
        closeStream(stream, 'token-mint-failed', true);
        return;
      }

      if (!stream.active) return;

      const token = minted && typeof minted.token === 'string' ? minted.token : '';
      const expiresAt = resolveExpiresAt(minted);
      if (!token || !(expiresAt > now())) {
        closeStream(stream, 'token-mint-failed', true);
        return;
      }

      postToWorker(stream, {
        type: 'UPDATE_TOKEN',
        streamId: stream.streamId,
        token,
        expiresAt,
      });
    })().finally(() => {
      if (stream.mintPromise) stream.mintPromise = null;
    });

    return stream.mintPromise;
  }

  function onWorkerMessage(event) {
    const data = event && event.data;
    if (!data || typeof data !== 'object' || typeof data.streamId !== 'string') {
      return;
    }

    const stream = streams.get(data.streamId);
    if (!stream || !stream.active) return;

    if (data.type === 'TOKEN_NEEDED') {
      void requestToken(stream);
      return;
    }

    if (data.type === 'STREAM_DEAD') {
      closeStream(stream, data.reason || 'stream-dead', true);
    }
  }

  function ensureListeners() {
    if (
      listening ||
      !serviceWorker ||
      typeof serviceWorker.addEventListener !== 'function'
    ) {
      return;
    }

    serviceWorker.addEventListener('controllerchange', invalidateStatus);
    serviceWorker.addEventListener('message', onWorkerMessage);
    listening = true;
  }

  function start({
    messageId,
    keyB64,
    baseIvB64,
    mime,
    plainSize,
    element = null,
    onFallback = null,
  } = {}) {
    ensureListeners();

    const controller = currentController();
    if (!controller) throw new Error('No service worker controller');
    if (!Number.isInteger(plainSize) || plainSize < 0) {
      throw new Error('Invalid plaintext size');
    }

    const streamId = randomUUID();
    if (typeof streamId !== 'string' || !streamId) {
      throw new Error('Invalid stream id');
    }

    const stream = {
      streamId,
      controller,
      messageId,
      active: true,
      mintPromise: null,
      stopObserving: null,
      cleanup: null,
      onFallback,
    };

    streams.set(streamId, stream);

    try {
      controller.postMessage({
        type: 'REGISTER_STREAM',
        streamId,
        messageId,
        scope: 'dm',
        keyB64,
        baseIvB64,
        mime,
        plainSize,
      });
    } catch (error) {
      streams.delete(streamId);
      throw error;
    }

    if (element && typeof observeRemoval === 'function') {
      try {
        stream.stopObserving = observeRemoval(element, () => {
          closeStream(stream, 'removed', false);
        });
      } catch (error) {
        closeStream(stream, 'registration-failed', false);
        throw error;
      }
    }

    return {
      streamId,
      src: `${MEDIA_STREAM_URL_PREFIX}${streamId}`,
      get active() {
        return stream.active;
      },
      unregister(reason = 'unregistered') {
        return closeStream(stream, reason, false);
      },
      fallback(reason = 'media-error') {
        return closeStream(stream, reason, true);
      },
      setCleanup(fn) {
        stream.cleanup = typeof fn === 'function' ? fn : null;
      },
    };
  }

  function dispose() {
    if (listening && serviceWorker) {
      if (typeof serviceWorker.removeEventListener === 'function') {
        serviceWorker.removeEventListener('controllerchange', invalidateStatus);
        serviceWorker.removeEventListener('message', onWorkerMessage);
      }
      listening = false;
    }

    for (const stream of [...streams.values()]) {
      stream.active = false;
      if (stream.stopObserving) {
        try {
          stream.stopObserving();
        } catch {
          /* ignore */
        }
      }
      if (stream.cleanup) {
        try {
          stream.cleanup();
        } catch {
          /* ignore */
        }
      }
    }

    streams.clear();
    cachedController = null;
    cachedEnabled = null;
    pendingProbe = null;
  }

  return {
    probe,
    start,
    dispose,
  };
}
