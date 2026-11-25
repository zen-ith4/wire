// C8: Removed no-op `options = options` in parseDecryptArgs.
// Verify that options.maxResponseChunks still works through rangeToChunks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeToChunks, RangeNotSatisfiableError } from '../public/js/crypto/messages/attachment-range.js';

test('rangeToChunks passes maxResponseChunks from options object', () => {
  const result = rangeToChunks('bytes=0-', 1000, { maxResponseChunks: 3 });
  assert.equal(result.maxResponseChunks, 3);
});

test('rangeToChunks uses default maxResponseChunks when not provided', () => {
  const result = rangeToChunks('bytes=0-', 1000, {});
  assert.equal(result.maxResponseChunks, 16); // ATTACHMENT_RANGE_MAX_RESPONSE_CHUNKS
});

test('rangeToChunks with invalid maxResponseChunks throws', () => {
  assert.throws(() => rangeToChunks('bytes=0-', 1000, { maxResponseChunks: 0 }), RangeNotSatisfiableError);
});
