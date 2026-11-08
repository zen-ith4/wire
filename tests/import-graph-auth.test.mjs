// C4 import graph: core/auth.js now imports three media modules so logout()
// can purge this client's streams and clear the cached secrets/tokens.
//
// This test proves, from the real source (no mocks):
//
//   1. importing core/auth.js ALONE in Node loads without error — the new
//      media imports do not break module evaluation even though they form an
//      import cycle (see test 3). This is the login page's entry path.
//   2. importing auth.js does NOT pull the media PLAYER / chat / UI stack into
//      that path: the only media/ modules loaded are the four lightweight
//      secret/token/stream modules, never audio-player.js / video-player.js or
//      the chat/UI tree.
//   3. the new media imports DO form an import cycle (auth.js <->
//      attachment-e2ee.js, and transitively via lazy-e2ee-media.js and
//      mediaToken.js). That back-edge (attachment-e2ee.js -> auth.js) is
//      pre-existing; C4 adds the forward edge. The cycle is safe in ESM
//      because no module reads the other's exports at top level — proven by
//      test 1 loading cleanly.
//
//   node --test tests/import-graph-auth.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PUBLIC_JS = path.join(PUBLIC, 'js');
const AUTH = path.join(PUBLIC_JS, 'core', 'auth.js');

// auth.js reads localStorage at module top level (the persisted token).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

/**
 * Static import specifiers of one module: `import ... from 's'`, side-effect
 * `import 's'`, and re-export `export ... from 's'` (a re-export also loads
 * the target). Dynamic `import()` is intentionally NOT followed: it is lazy
 * and does not load at import time.
 */
function importSpecifiers(file) {
  const src = fs.readFileSync(file, 'utf8');
  const specs = [];
  const reImport = /^\s*import\s+(?:[\w$*{},\s]+from\s+)?['"]([^'"]+)['"]/gm;
  const reExport = /^\s*export\s+[\w$*{},\s]*?\bfrom\s+['"]([^'"]+)['"]/gm;
  for (const re of [reImport, reExport]) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) specs.push(m[1]);
  }
  return specs;
}

function resolveSpec(fromFile, spec) {
  if (spec.startsWith('/')) return path.join(PUBLIC, spec);
  return path.resolve(path.dirname(fromFile), spec);
}

/** Set of repo-relative paths loaded when `startFile` is imported. */
function computeClosure(startFile) {
  const seen = new Set();
  const queue = [path.resolve(startFile)];
  while (queue.length) {
    const file = queue.shift();
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const spec of importSpecifiers(file)) {
      const target = resolveSpec(file, spec);
      if (fs.existsSync(target)) queue.push(path.resolve(target));
    }
  }
  return seen;
}

// The four media modules auth.js now depends on (and the ONLY media/ modules
// it may load).
const EXPECTED_MEDIA = [
  'public/js/media/attachment-e2ee.js',
  'public/js/media/mediaToken.js',
  'public/js/media/lazy-e2ee-media.js',
  'public/js/media/sw-stream-client.js',
];

// The media PLAYER / capture / viewer modules that must NOT be pulled into the
// login path by importing auth.js.
const PLAYER_MODULES = [
  'public/js/media/audio-player.js',
  'public/js/media/video-player.js',
  'public/js/media/voice-recorder.js',
  'public/js/media/voice-message.js',
  'public/js/media/preview.js',
  'public/js/media/image-viewer.js',
  'public/js/media/attachments.js',
];

test('importing core/auth.js alone loads without error (new media imports are cycle-safe)', async () => {
  const auth = await import(pathToFileURL(AUTH).href);
  // The login/logout surface the login page actually uses.
  assert.equal(typeof auth.logout, 'function');
  assert.equal(typeof auth.login, 'function');
  assert.equal(typeof auth.setCurrentUser, 'function');
});

test('importing core/auth.js pulls no media player / chat / UI modules', () => {
  const loaded = computeClosure(AUTH);

  // The four lightweight media modules ARE loaded (auth.js depends on them).
  for (const m of EXPECTED_MEDIA) {
    assert.ok(loaded.has(m), `expected auth.js to load ${m}`);
  }

  // No player/capture/viewer module is loaded.
  for (const m of PLAYER_MODULES) {
    assert.ok(!loaded.has(m), `auth.js must not load the player module ${m}`);
  }

  // The media/ intersection is EXACTLY the four expected modules — nothing
  // else under media/ (no player, no attachments.js, no preview/viewer).
  const mediaLoaded = [...loaded].filter((m) => m.startsWith('public/js/media/')).sort();
  assert.deepEqual(mediaLoaded, [...EXPECTED_MEDIA].sort());

  // And no chat / UI / icon / vendor / settings module is pulled in.
  for (const m of [...loaded]) {
    assert.ok(!m.startsWith('public/js/chat/'), `auth.js must not load chat module ${m}`);
    assert.ok(!m.startsWith('public/js/ui/'), `auth.js must not load UI module ${m}`);
    assert.ok(!m.startsWith('public/js/vendor/'), `auth.js must not load vendor module ${m}`);
    assert.ok(!m.startsWith('public/js/settings/'), `auth.js must not load settings module ${m}`);
    assert.ok(!m.endsWith('/icons.js'), `auth.js must not load ${m}`);
  }
});

test('the new media imports form a (safe) import cycle — documented', () => {
  const loaded = computeClosure(AUTH);

  // Forward edge added by C4: auth.js -> attachment-e2ee.js.
  const authSrc = fs.readFileSync(AUTH, 'utf8');
  assert.ok(
    /import[\s\S]*?from\s+['"]\.\.\/media\/attachment-e2ee\.js['"]/.test(authSrc),
    'auth.js must import clearAllAttachmentSecrets from media/attachment-e2ee.js'
  );

  // Back edge (pre-existing): attachment-e2ee.js -> core/auth.js. Together
  // with the forward edge this is a cycle; it is in the loaded set, proving
  // the two modules evaluate together without a top-level read error.
  const attSrc = fs.readFileSync(path.join(PUBLIC_JS, 'media', 'attachment-e2ee.js'), 'utf8');
  assert.ok(
    /import[\s\S]*?from\s+['"]\.\.\/core\/auth\.js['"]/.test(attSrc),
    'attachment-e2ee.js imports getToken/logout from core/auth.js (pre-existing back edge)'
  );
  assert.ok(loaded.has('public/js/media/attachment-e2ee.js'));
  assert.ok(loaded.has('public/js/core/auth.js'));
});

test('lists every module core/auth.js loads', () => {
  const loaded = [...computeClosure(AUTH)].sort();
  // Printed so the exact loaded set is in the TAP log for the owner.
  console.log(`# auth.js loads ${loaded.length} modules:`);
  for (const m of loaded) console.log(`#   ${m}`);
  assert.ok(loaded.length >= 30, 'auth.js closure should be substantial');
});
