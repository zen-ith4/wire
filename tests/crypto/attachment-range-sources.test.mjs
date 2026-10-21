// Static source check (Item 3, Phase 3A): the range helpers must NOT carry a
// second copy of the STREAM header bytes, the per-chunk nonce layout or an
// encrypt-capable key import. It reads the two sources as text - no import,
// no runtime, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RANGE_SRC = path.join(ROOT, 'utils/attachment-range.js');
const STREAM_SRC = path.join(ROOT, 'public/js/crypto/messages/attachment-stream.js');

const rangeSrc = fs.readFileSync(RANGE_SRC, 'utf8');
const streamSrc = fs.readFileSync(STREAM_SRC, 'utf8');

test('attachment-range.js does not define its own container header', () => {
  assert.ok(
    !rangeSrc.includes('0x57, 0x41, 0x54, 0x31'),
    'attachment-range.js must not spell out the WAT1 header bytes again - ' +
    'it has to import HEADER from attachment-stream.js'
  );
  assert.ok(
    !/new Uint8Array\(\[\s*0x57/.test(rangeSrc),
    'attachment-range.js must not build a second header array'
  );
});

test('attachment-range.js does not define its own chunk nonce', () => {
  assert.ok(
    !rangeSrc.includes('function chunkNonce'),
    'attachment-range.js must not re-implement chunkNonce - it has to import ' +
    'it from attachment-stream.js so the nonce layout stays single-sourced'
  );
  assert.ok(
    !rangeSrc.includes('setUint32(7, index'),
    'attachment-range.js must not re-implement the chunk index encoding'
  );
});

test('attachment-range.js imports HEADER and chunkNonce from attachment-stream.js', () => {
  assert.match(
    rangeSrc,
    /import\s*\{[^}]*\bHEADER\b[^}]*\bchunkNonce\b[^}]*\}\s*from\s*'[^']*attachment-stream\.js'/s,
    'attachment-range.js must import HEADER and chunkNonce from attachment-stream.js'
  );
  assert.match(
    streamSrc,
    /export\s*\{\s*HEADER\s*,\s*chunkNonce\s*\}/,
    'attachment-stream.js must re-export HEADER and chunkNonce'
  );
});

test('attachment-range.js keeps a decrypt-only key import with the 32-byte check', () => {
  assert.match(
    rangeSrc,
    /rawKey\.length\s*!==\s*32/,
    'the range module must keep the 32-byte key length check'
  );
  assert.match(
    rangeSrc,
    /throw new AttachmentDecryptError\('Invalid attachment key'\)/,
    'the range module must reject a bad key with the same AttachmentDecryptError'
  );
  assert.match(
    rangeSrc,
    /importKey\('raw',\s*rawKey,\s*\{[^}]*\}\s*,\s*false,\s*\['decrypt'\]\)/,
    'the range module must import the key with decrypt usage only'
  );
  assert.ok(
    !/importKey\('raw',\s*rawKey,\s*\{[^}]*\}\s*,\s*false,\s*\[[^\]]*'encrypt'[^\]]*\]\)/.test(rangeSrc),
    'the range module must NOT import the key with encrypt usage - a Service ' +
    'Worker must only ever hold a decrypt-capable key'
  );
});
