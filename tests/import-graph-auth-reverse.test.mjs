// C4b: the REVERSE import order for the cycle C4 introduced.
//
// C4 makes core/auth.js import three media modules so logout() can purge this
// client's streams and drop the cached secrets/tokens. One of those modules,
// media/attachment-e2ee.js, already imported core/auth.js (pre-existing back
// edge), so together they form an ESM cycle:
//
//     core/auth.js  ->  media/attachment-e2ee.js   (new, C4)
//     core/auth.js  <-  media/attachment-e2ee.js   (pre-existing)
//
// tests/import-graph-auth.test.mjs imports auth.js first. That only proves one
// entry point. If attachment-e2ee.js is evaluated FIRST, auth.js runs while
// attachment-e2ee.js is still initialising; every binding auth.js takes from it
// is then in the temporal dead zone. Reading such a binding at module top level
// would throw `ReferenceError: Cannot access '...' before initialization`.
// C4 keeps those reads inside logout(), so both entry points must work.
//
// What this file checks:
//
//   1. REAL source, fresh child process, media/attachment-e2ee.js FIRST, then
//      core/auth.js, then logout(): no TDZ / ReferenceError; the exports
//      auth.js takes from attachment-e2ee.js (clearAllAttachmentSecrets) and
//      that attachment-e2ee.js takes from auth.js (getToken/setToken/logout)
//      exist and are functions after load.
//   2. REAL source, fresh child process, the other order (auth.js first), then
//      attachment-e2ee.js: same checks.
//   3. Module mocks pin the wiring inside logout() for BOTH orders: fresh
//      child processes with --experimental-test-module-mocks register spies
//      for purgeMediaStreams / clearAllAttachmentSecrets / clearMediaTokenCache
//      and assert each is called exactly once, in the documented order
//      (purgeMediaStreams -> clearAllAttachmentSecrets -> clearMediaTokenCache).
//
//   node --experimental-test-module-mocks --test tests/import-graph-auth-reverse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_URL = new URL('../public/js/core/auth.js', import.meta.url).href;
const ATTACHMENT_URL = new URL('../public/js/media/attachment-e2ee.js', import.meta.url).href;
const LAZY_URL = new URL('../public/js/media/lazy-e2ee-media.js', import.meta.url).href;
const MEDIA_TOKEN_URL = new URL('../public/js/media/mediaToken.js', import.meta.url).href;

const CHILD_GLOBALS = `
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const dom = new EventTarget();
globalThis.window = {
  addEventListener: (...args) => dom.addEventListener(...args),
  removeEventListener: (...args) => dom.removeEventListener(...args),
  dispatchEvent: (event) => dom.dispatchEvent(event),
};
`;

const REAL_CHILD = CHILD_GLOBALS + `
const AUTH = ${JSON.stringify(AUTH_URL)};
const ATTACHMENT = ${JSON.stringify(ATTACHMENT_URL)};
const attachmentFirst = process.env.C4B_ORDER === 'attachment-first';
try {
  await import(attachmentFirst ? ATTACHMENT : AUTH);
  await import(attachmentFirst ? AUTH : ATTACHMENT);
  const authMod = await import(AUTH);
  const attachmentMod = await import(ATTACHMENT);
  for (const name of ['clearAllAttachmentSecrets']) {
    if (typeof attachmentMod[name] !== 'function') throw new Error('missing export on attachment-e2ee: ' + name);
  }
  for (const name of ['getToken', 'setToken', 'logout']) {
    if (typeof authMod[name] !== 'function') throw new Error('missing export on auth: ' + name);
  }
  authMod.logout();
  console.log(JSON.stringify({ ok: true, order: attachmentFirst ? 'attachment-first' : 'auth-first' }));
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
`;

async function runRealFresh(order) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--no-warnings', '--input-type=module', '--eval', REAL_CHILD],
    { cwd: ROOT, env: { ...process.env, C4B_ORDER: order } },
  );
  return { stdout, stderr };
}

test('fresh process: attachment-e2ee.js first, then auth.js - no TDZ, exports present, logout() ok', async () => {
  const { stdout, stderr } = await runRealFresh('attachment-first');
  assert.deepEqual(JSON.parse(stdout.trim()), { ok: true, order: 'attachment-first' });
  assert.doesNotMatch(stderr, /ReferenceError/);
  assert.doesNotMatch(stderr, /before initialization/);
});

test('fresh process: auth.js first, then attachment-e2ee.js - no TDZ, exports present, logout() ok', async () => {
  const { stdout, stderr } = await runRealFresh('auth-first');
  assert.deepEqual(JSON.parse(stdout.trim()), { ok: true, order: 'auth-first' });
  assert.doesNotMatch(stderr, /ReferenceError/);
  assert.doesNotMatch(stderr, /before initialization/);
});

function writeMockedScript(order) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4b-mocked-'));
  const file = path.join(dir, 'mocked.mjs');
  const content = `
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const dom = new EventTarget();
globalThis.window = {
  addEventListener: (...args) => dom.addEventListener(...args),
  removeEventListener: (...args) => dom.removeEventListener(...args),
  dispatchEvent: (event) => dom.dispatchEvent(event),
};

import { mock } from 'node:test';
const calls = [];
mock.module(${JSON.stringify(LAZY_URL)}, { namedExports: { purgeMediaStreams: () => { calls.push('purgeMediaStreams'); } } });
mock.module(${JSON.stringify(ATTACHMENT_URL)}, { namedExports: { clearAllAttachmentSecrets: () => { calls.push('clearAllAttachmentSecrets'); } } });
mock.module(${JSON.stringify(MEDIA_TOKEN_URL)}, { namedExports: { clearMediaTokenCache: () => { calls.push('clearMediaTokenCache'); } } });

const attachmentFirst = ${JSON.stringify(order)} === 'attachment-first';
if (attachmentFirst) { await import(${JSON.stringify(ATTACHMENT_URL)}); }
const auth = await import(${JSON.stringify(AUTH_URL)});
if (!attachmentFirst) { await import(${JSON.stringify(ATTACHMENT_URL)}); }

auth.logout();
import assert from 'node:assert/strict';
assert.deepEqual(calls, ['purgeMediaStreams', 'clearAllAttachmentSecrets', 'clearMediaTokenCache']);
console.log(JSON.stringify({ ok: true, order: ${JSON.stringify(order)}, calls }));
`;
  fs.writeFileSync(file, content);
  return { dir, file };
}

async function runMocked(order) {
  const { dir, file } = writeMockedScript(order);
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--no-warnings', '--experimental-test-module-mocks', file],
      { cwd: ROOT, env: { ...process.env } },
    );
    return { stdout, stderr };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('mocked: attachment-first order - logout calls purge, secrets, tokens once in order', async () => {
  const { stdout, stderr } = await runMocked('attachment-first');
  assert.deepEqual(JSON.parse(stdout.trim()), { ok: true, order: 'attachment-first', calls: ['purgeMediaStreams', 'clearAllAttachmentSecrets', 'clearMediaTokenCache'] });
  assert.doesNotMatch(stderr, /ReferenceError/);
});

test('mocked: auth-first order - logout calls purge, secrets, tokens once in order', async () => {
  const { stdout, stderr } = await runMocked('auth-first');
  assert.deepEqual(JSON.parse(stdout.trim()), { ok: true, order: 'auth-first', calls: ['purgeMediaStreams', 'clearAllAttachmentSecrets', 'clearMediaTokenCache'] });
  assert.doesNotMatch(stderr, /ReferenceError/);
});
