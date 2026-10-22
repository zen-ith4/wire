// public/js/sw-media/handler-core.js
//
// Pure routing and response planning for the Service Worker media stream route
// (Item 3, phase 3C, C1).
//
// No DOM, no Service Worker, no fetch, no Response. The worker (C2) supplies
// the already-checked stream/client/token state and turns the returned plan
// into a Response; this module only decides the status, the headers and which
// plaintext bytes (and therefore which ciphertext Range) the response covers.
//
// The MIME allowlist is NOT duplicated here: utils/inlineSafeMime.js stays the
// single source. The route only narrows it to video/* and audio/*.

import {
  ATTACHMENT_RANGE_MAX_RESPONSE_CHUNKS,
  RangeNotSatisfiableError,
  rangeToChunks,
} from '../crypto/messages/attachment-range.js';
import {
  STREAM_CHUNK_SIZE,
  STREAM_TAG_BYTES,
  STREAM_HEADER_BYTES,
  encryptedSizeFor,
} from '../crypto/messages/attachment-stream.js';
import { isInlineSafeMime } from '../../../utils/inlineSafeMime.js';

export const MEDIA_STREAM_PATH_PREFIX = '/__wire_media_stream/';
export const MEDIA_STREAM_MAX_RESPONSE_CHUNKS = ATTACHMENT_RANGE_MAX_RESPONSE_CHUNKS;
export const MEDIA_STREAM_FALLBACK_MIME = 'application/octet-stream';

const STREAM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The stream id from a media-route pathname, or null when the path is not the
 * media route. The id is opaque; the pattern only keeps the route a single,
 * finite path segment.
 */
export function parseMediaStreamPath(pathname) {
  if (typeof pathname !== 'string') return null;
  if (!pathname.startsWith(MEDIA_STREAM_PATH_PREFIX)) return null;

  const streamId = pathname.slice(MEDIA_STREAM_PATH_PREFIX.length);
  return STREAM_ID_RE.test(streamId) ? streamId : null;
}

export function isMediaStreamPath(pathname) {
  return parseMediaStreamPath(pathname) !== null;
}

export function isMediaMethodAllowed(method) {
  return method === 'GET' || method === 'HEAD';
}

export function isMediaDestinationAllowed(destination) {
  return destination === 'video' || destination === 'audio';
}

/**
 * video/* and audio/* only, and only when the shared server allowlist accepts
 * the exact type. A type such as "video/mp4; codecs=..." is not in the
 * allowlist and therefore falls back to application/octet-stream.
 */
export function isMediaMimeAllowed(mimeType) {
  if (typeof mimeType !== 'string') return false;

  const lower = mimeType.toLowerCase();
  return (
    (lower.startsWith('video/') || lower.startsWith('audio/')) &&
    isInlineSafeMime(lower)
  );
}

export function mediaContentType(mimeType) {
  return isMediaMimeAllowed(mimeType) ? mimeType : MEDIA_STREAM_FALLBACK_MIME;
}

function baseHeaders() {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
  };
}

function errorPlan(status, extra = {}) {
  return {
    status,
    headers: {
      ...baseHeaders(),
      'Content-Length': '0',
      ...extra,
    },
    bodyMode: 'none',
    served: null,
    requested: null,
    contentLength: 0,
    chunkIndices: null,
    totalSize: null,
    ciphertextRange: null,
  };
}

/**
 * The ciphertext Range that contains the served plaintext bytes.
 *
 * Plaintext chunk k starts at 8 + k * (65536 + 16). The response may start or
 * end inside a chunk, but the worker has to fetch whole chunks: a chunk is the
 * authenticated unit and cannot be decrypted from a partial tag. The last
 * chunk is shorter than 65536 bytes, so its ciphertext end is the file end,
 * not the fixed-size formula.
 */
export function ciphertextRangeFor({ totalSize, served } = {}) {
  if (!served || !Number.isInteger(totalSize) || totalSize <= 0) return null;
  if (!Number.isInteger(served.start) || !Number.isInteger(served.end)) return null;
  if (served.start < 0 || served.start > served.end || served.end >= totalSize) return null;

  const chunks = Math.max(1, Math.ceil(totalSize / STREAM_CHUNK_SIZE));
  const ctChunk = STREAM_CHUNK_SIZE + STREAM_TAG_BYTES;
  const firstChunk = Math.floor(served.start / STREAM_CHUNK_SIZE);
  const lastChunk = Math.floor(served.end / STREAM_CHUNK_SIZE);

  if (firstChunk < 0 || lastChunk >= chunks) return null;

  const start = STREAM_HEADER_BYTES + firstChunk * ctChunk;
  const end = lastChunk === chunks - 1
    ? encryptedSizeFor(totalSize) - 1
    : STREAM_HEADER_BYTES + (lastChunk + 1) * ctChunk - 1;

  return { start, end };
}

/**
 * Decide the response for a media-route request.
 *
 * The caller has already resolved `streamKnown`, `clientMatches` and
 * `authorized`; this function never reads a header other than the Range value
 * it is given. `totalSize` is the PLAINTEXT size, so every Content-Range is in
 * plaintext coordinates. The checks run coarse-to-specific so an unknown
 * stream fails closed as 404 instead of leaking a 401.
 */
export function planMediaResponse({
  method = 'GET',
  destination = '',
  streamKnown = false,
  clientMatches = false,
  authorized = false,
  mimeType = '',
  totalSize,
  rangeHeader = null,
  maxResponseChunks = MEDIA_STREAM_MAX_RESPONSE_CHUNKS,
} = {}) {
  if (!isMediaMethodAllowed(method)) {
    return errorPlan(405, { Allow: 'GET, HEAD' });
  }

  if (!isMediaDestinationAllowed(destination)) {
    return errorPlan(404);
  }

  if (!streamKnown || !clientMatches) {
    return errorPlan(404);
  }

  if (!authorized) {
    return errorPlan(401);
  }

  if (!Number.isInteger(totalSize) || totalSize < 0) {
    return errorPlan(404);
  }

  if (rangeHeader == null) {
    const served = { start: 0, end: totalSize - 1 };
    return {
      status: 200,
      headers: {
        ...baseHeaders(),
        'Accept-Ranges': 'bytes',
        'Content-Type': mediaContentType(mimeType),
        'Content-Length': String(totalSize),
      },
      bodyMode: method === 'HEAD' ? 'none' : 'full',
      served,
      requested: served,
      contentLength: totalSize,
      chunkIndices: null,
      totalSize,
      ciphertextRange: ciphertextRangeFor({ totalSize, served }),
    };
  }

  if (typeof rangeHeader !== 'string' || totalSize === 0) {
    return errorPlan(416, {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${totalSize}`,
    });
  }

  let info;
  try {
    info = rangeToChunks(rangeHeader, totalSize, { maxResponseChunks });
  } catch (error) {
    if (error instanceof RangeNotSatisfiableError) {
      return errorPlan(416, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${totalSize}`,
      });
    }
    throw error;
  }

  return {
    status: 206,
    headers: {
      ...baseHeaders(),
      'Accept-Ranges': 'bytes',
      'Content-Type': mediaContentType(mimeType),
      'Content-Length': String(info.byteLength),
      'Content-Range': `bytes ${info.served.start}-${info.served.end}/${totalSize}`,
    },
    bodyMode: method === 'HEAD' ? 'none' : 'range',
    served: info.served,
    requested: info.requested,
    contentLength: info.byteLength,
    chunkIndices: info.chunkIndices,
    totalSize,
    ciphertextRange: ciphertextRangeFor({ totalSize, served: info.served }),
  };
}
