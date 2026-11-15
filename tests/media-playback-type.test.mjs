// tests/media-playback-type.test.mjs
//
// Unit tests for the playback type a decrypted audio Blob gets
// (public/js/media/mediaToken.js, Bug 1). The sealed MIME type of an
// encrypted attachment is whatever the SENDER's browser reported - an alias
// such as "audio/x-m4a", or nothing at all (stored as
// application/octet-stream). Chromium sniffs past that, but Safari and Firefox
// choose the decoder from the type. resolveMediaSrc() therefore hands audio to
// the element with its registered type; everything else is untouched.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const js = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

let secret = null;
let decrypted = null;

mock.module(js('core/api.js'), {
  namedExports: { api: async () => ({ token: 'media-token' }) },
});
mock.module(js('media/attachment-e2ee.js'), {
  namedExports: {
    getAttachmentSecret: () => secret,
    fetchDecryptedAttachment: async () => decrypted,
  },
});

const { playbackAudioType, withPlaybackAudioType, resolveMediaSrc } = await import(js('media/mediaToken.js'));

test('aliases map to the registered audio type; parameters are dropped', () => {
  const cases = {
    'audio/x-m4a': 'audio/mp4',
    'audio/m4a': 'audio/mp4',
    'audio/mp3': 'audio/mpeg',
    'audio/x-mp3': 'audio/mpeg',
    'audio/x-wav': 'audio/wav',
    'audio/wave': 'audio/wav',
    'audio/vnd.wave': 'audio/wav',
    'audio/x-flac': 'audio/flac',
    'audio/x-aac': 'audio/aac',
    'audio/opus': 'audio/ogg',
    'application/ogg': 'audio/ogg',
    'audio/webm;codecs=opus': 'audio/webm',
    'AUDIO/MPEG': 'audio/mpeg',
    'audio/mpeg': 'audio/mpeg',
    'audio/mp4': 'audio/mp4',
  };
  for (const [given, want] of Object.entries(cases)) {
    assert.equal(playbackAudioType(given, 'x'), want, given);
  }
});

test('a missing or generic type is recovered from the extension; nothing is invented', () => {
  assert.equal(playbackAudioType('', 'song.mp3'), 'audio/mpeg');
  assert.equal(playbackAudioType('application/octet-stream', 'Voice Note.M4A'), 'audio/mp4');
  assert.equal(playbackAudioType('application/octet-stream', 'take.opus'), 'audio/ogg');
  assert.equal(playbackAudioType(undefined, 'clip.weba'), 'audio/webm');
  assert.equal(playbackAudioType('', 'notes.txt'), null);
  assert.equal(playbackAudioType('', 'noextension'), null);
  assert.equal(playbackAudioType('application/octet-stream', 'legacy.wma'), null, 'no browser decodes wma');
});

test('non-audio types are never touched', () => {
  assert.equal(playbackAudioType('video/mp4', 'movie.mp3'), null);
  assert.equal(playbackAudioType('image/png', 'x.wav'), null);
  assert.equal(playbackAudioType('application/pdf', 'x.mp3'), null);
});

test('the Blob keeps its bytes; it is re-labelled only when the label changes', async () => {
  const canonical = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
  assert.equal(withPlaybackAudioType(canonical, { mime: 'audio/mpeg', name: 'a.mp3' }), canonical);

  const alias = new Blob([new Uint8Array([4, 5, 6, 7])], { type: 'audio/x-m4a' });
  const relabelled = withPlaybackAudioType(alias, { mime: 'audio/x-m4a', name: 'a.m4a' });
  assert.notEqual(relabelled, alias);
  assert.equal(relabelled.type, 'audio/mp4');
  assert.deepEqual([...new Uint8Array(await relabelled.arrayBuffer())], [4, 5, 6, 7]);

  const video = new Blob([new Uint8Array([9])], { type: 'video/mp4' });
  assert.equal(withPlaybackAudioType(video, { mime: 'video/mp4', name: 'v.mp4' }), video);
});

test('resolveMediaSrc gives an encrypted audio attachment its playback type, and leaves video alone', async () => {
  const created = [];
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    created.push(blob);
    return `blob:test/${created.length}`;
  };
  try {
    secret = { mime: 'application/octet-stream', name: 'take.m4a' };
    decrypted = new Blob([new Uint8Array([1, 2])], { type: 'application/octet-stream' });
    const audio = await resolveMediaSrc({ id: 7, attachment_name: 'take.m4a' }, 'dm');
    assert.deepEqual(audio, { src: 'blob:test/1', isBlob: true });
    assert.equal(created[0].type, 'audio/mp4', 'played as audio/mp4, not octet-stream');
    assert.equal(created[0].size, 2);

    secret = { mime: 'video/mp4', name: 'clip.mp4' };
    decrypted = new Blob([new Uint8Array([3])], { type: 'video/mp4' });
    await resolveMediaSrc({ id: 8 }, 'dm');
    assert.equal(created[1], decrypted, 'a video blob is passed through unchanged');
  } finally {
    URL.createObjectURL = originalCreate;
    secret = null;
  }
});
