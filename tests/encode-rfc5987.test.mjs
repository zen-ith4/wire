// C3: encodeRfc5987 must be used instead of encodeURIComponent in
// Content-Disposition filename*= headers. encodeRfc5987 additionally
// encodes ' ( ) * which encodeURIComponent leaves alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRfc5987 } from '../utils/mediaKind.js';

test('encodeRfc5987 encodes apostrophe, parens, asterisk', () => {
  const name = "it's (1).jpg";
  const encoded = encodeRfc5987(name);
  // encodeURIComponent leaves ' ( ) * unencoded; encodeRfc5987 encodes them.
  assert.equal(
    encoded,
    "it%27s%20%281%29.jpg",
    'RFC 5987 must encode apostrophe and parens'
  );
  assert.notEqual(
    encoded,
    encodeURIComponent(name),
    'encodeRfc5987 differs from encodeURIComponent'
  );
});

test('encodeRfc5987 handles normal filenames', () => {
  assert.equal(encodeRfc5987('document.pdf'), 'document.pdf');
  assert.equal(encodeRfc5987('photo.jpg'), 'photo.jpg');
});
