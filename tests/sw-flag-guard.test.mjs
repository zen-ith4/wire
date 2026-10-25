// C5 guard: the repository must ship the media-stream route OFF.
//
// public/sw.js is the only place the flag exists, and the generated media
// bundle must never bake it in. This test runs in the normal (non-browser)
// suite, so any commit that flips the flag - or that regenerates the bundle
// with the flag copied into it - fails before it can reach a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(ROOT, 'public', 'sw.js');
const BUNDLE = path.join(ROOT, 'public', 'sw-media-bundle.js');

const FLAG_OFF = 'const MEDIA_STREAM_ENABLED = false;';

function countExactLine(source, line) {
  return source.split('\n').filter((candidate) => candidate === line).length;
}

test('public/sw.js declares MEDIA_STREAM_ENABLED = false exactly once', () => {
  const source = fs.readFileSync(SW, 'utf8');

  assert.equal(
    countExactLine(source, FLAG_OFF),
    1,
    `public/sw.js must contain exactly one line "${FLAG_OFF}"`
  );

  // No second assignment anywhere (ON or otherwise), not even a commented-out
  // or string spelling that a future edit could turn into the real one.
  assert.ok(
    !/MEDIA_STREAM_ENABLED\s*=\s*true\b/.test(source),
    'public/sw.js must not contain the flag ON'
  );
  assert.equal(
    (source.match(/MEDIA_STREAM_ENABLED\s*=/g) || []).length,
    1,
    'MEDIA_STREAM_ENABLED must be assigned exactly once'
  );
});

test('public/sw-media-bundle.js does not contain the flag assignment', () => {
  const bundle = fs.readFileSync(BUNDLE, 'utf8');

  assert.ok(
    !bundle.includes('MEDIA_STREAM_ENABLED'),
    'the generated media bundle must not mention MEDIA_STREAM_ENABLED'
  );
});
