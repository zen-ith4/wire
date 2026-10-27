// public/js/sw-media/bundle-entry.js
//
// The single entry of the Service Worker's generated media bundle
// (scripts/build-sw-media-bundle.mjs). It keeps the phase-3B range/decrypt API
// and adds the phase-3C pure handler core, the in-memory stream registry and
// the partial-ciphertext decryptor. The bundle publishes them as the global
// `WireMedia`.
//
// This file is bundled, not imported by the page. It has no DOM or worker
// globals; it only re-exports pure modules.

export * from '../crypto/messages/attachment-range.js';
export * from './handler-core.js';
export * from './stream-registry.js';
export * from './media-ciphertext.js';
export { encryptedSizeFor } from '../crypto/messages/attachment-stream.js';
