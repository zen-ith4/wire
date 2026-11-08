// public/js/sw-media/stream-registry.js
//
// The Service Worker's in-memory stream registry (Item 3, phase 3C, C2).
//
// A stream is a per-file key, a client binding, a plaintext size, a ciphertext
// path, a short-lived media token and an idle timestamp. Everything lives in a
// plain Map in worker memory. This module deliberately has no Cache Storage,
// IndexedDB, localStorage, network, timer or console calls: the worker passes
// the platform's clock and AbortController in, and drops the whole Map when
// the worker is terminated.
//
// messageId is the DM message id of the attachment: the server route is
// /api/dm/attachments/:messageId and the media token is bound to (type 'dm',
// id = messageId) in middleware/mediaAuth.js.
//
// The worker (public/sw.js) owns registration validation, token waiters and
// HTTP; this module owns the state transitions the tests can inspect directly.
//
// The idle TTL is enforced lazily: sweep() runs on register/get/updateToken/
// unregister/size, so a key may remain in worker memory until the next
// registry call or until the worker is terminated. There is no background
// timer.

export const MEDIA_STREAM_IDLE_TTL_MS = 10 * 60 * 1000;

const STREAM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_TRANSPORT_PATH_RE = /^\/api\/[A-Za-z0-9/_-]+$/;

function isUint8ArrayOfLength(value, length) {
  return value instanceof Uint8Array && value.length === length;
}

function isTransportPath(value) {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    !value.includes('..') &&
    !value.includes('//') &&
    SAFE_TRANSPORT_PATH_RE.test(value)
  );
}

function validateRegistration(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid stream registration');
  if (typeof input.streamId !== 'string' || !STREAM_ID_RE.test(input.streamId)) {
    throw new TypeError('Invalid stream id');
  }
  if (typeof input.clientId !== 'string' || !input.clientId) {
    throw new TypeError('Invalid client id');
  }
  if (!isUint8ArrayOfLength(input.rawKey, 32)) {
    throw new TypeError('Invalid stream key');
  }
  if (!isUint8ArrayOfLength(input.baseIv, 12)) {
    throw new TypeError('Invalid stream IV');
  }
  if (!Number.isInteger(input.plainSize) || input.plainSize < 0) {
    throw new TypeError('Invalid stream size');
  }
  if (!isTransportPath(input.path)) {
    throw new TypeError('Invalid stream path');
  }
  if (input.abortController != null && typeof input.abortController.abort !== 'function') {
    throw new TypeError('Invalid abort controller');
  }
}

function abortEntry(entry) {
  if (entry && entry.abortController) {
    try {
      entry.abortController.abort();
    } catch {
      /* an AbortController.abort() is not allowed to break cleanup */
    }
  }
}

/**
 * @param {{ now?: () => number, idleTtlMs?: number }} [options]
 */
export function createMediaStreamRegistry({
  now = () => Date.now(),
  idleTtlMs = MEDIA_STREAM_IDLE_TTL_MS,
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0) {
    throw new TypeError('idleTtlMs must be positive');
  }

  const streams = new Map();

  function sweep(at = now()) {
    for (const [streamId, entry] of streams) {
      if (at - entry.lastAccessAt >= idleTtlMs) {
        abortEntry(entry);
        streams.delete(streamId);
      }
    }
  }

  function register(input) {
    sweep();
    validateRegistration(input);

    const previous = streams.get(input.streamId);
    if (previous && previous.clientId !== input.clientId) {
      throw new TypeError('Stream id already belongs to another client');
    }
    if (previous) abortEntry(previous);

    const at = now();
    const entry = {
      streamId: input.streamId,
      clientId: input.clientId,
      messageId: input.messageId,
      scope: input.scope,
      groupId: input.groupId,
      path: input.path,
      rawKey: input.rawKey,
      baseIv: input.baseIv,
      mime: typeof input.mime === 'string' ? input.mime : '',
      plainSize: input.plainSize,
      token: null,
      expiresAt: 0,
      lastAccessAt: at,
      deadStatus: null,
      abortController: input.abortController ?? null,
    };

    streams.set(entry.streamId, entry);
    return entry;
  }

  function peek(streamId) {
    return streams.get(streamId) || null;
  }

  function get(streamId) {
    sweep();
    const entry = streams.get(streamId);
    if (!entry) return null;
    entry.lastAccessAt = now();
    return entry;
  }

  function updateToken(streamId, clientId, token, expiresAt) {
    sweep();
    if (typeof token !== 'string' || !token) return false;
    if (!Number.isFinite(expiresAt)) return false;

    const entry = streams.get(streamId);
    if (!entry || entry.clientId !== clientId) return false;

    entry.token = token;
    entry.expiresAt = expiresAt;
    entry.lastAccessAt = now();
    return true;
  }

  function unregister(streamId, clientId) {
    const entry = streams.get(streamId);
    if (!entry || entry.clientId !== clientId) return false;
    abortEntry(entry);
    streams.delete(streamId);
    return true;
  }

  function purgeClient(clientId) {
    if (typeof clientId !== 'string' || !clientId) return [];

    const removed = [];
    for (const [streamId, entry] of streams) {
      if (entry.clientId !== clientId) continue;
      abortEntry(entry);
      streams.delete(streamId);
      removed.push(streamId);
    }
    return removed;
  }

  function markDead(streamId, status) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new TypeError('Invalid stream status');
    }
    const entry = streams.get(streamId);
    if (!entry) return false;
    entry.deadStatus = status;
    return true;
  }

  return {
    register,
    peek,
    get,
    updateToken,
    unregister,
    purgeClient,
    markDead,
    sweep,
    get size() {
      sweep();
      return streams.size;
    },
  };
}
