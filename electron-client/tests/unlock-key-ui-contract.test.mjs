// The remember-me failure contract between main.js and the web UI.
//
// When the OS keyring is unavailable, main.js returns the same result it
// returned before Phase 2:
//   store -> { success: false, error: 'OS-level secure storage is not available on this system.' }
//   get   -> null
//
// This test pins the web UI side of that contract by reading the real
// public/js/core/auth.js (importing it in Node would pull in the whole browser
// bundle). It asserts that the UI keeps its pre-Phase-2 behaviour:
//   - persistUnlockKey ignores the store result (it never inspects .success)
//     and only logs a thrown IPC error;
//   - attemptAutoUnlock treats a missing unlockKey as "no cached key" and
//     returns false, falling back to the password prompt.
//
// It is deliberately a source-shape assertion: if either function changes how
// it consumes the result, this test fails and the E2E session D must be
// re-checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUTH_JS = path.join(ROOT, 'public', 'js', 'core', 'auth.js');
const source = fs.readFileSync(AUTH_JS, 'utf-8');

function bodyOf(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function ' + name + ' not found in auth.js');
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, 'function ' + name + ' has no body');
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

test('persistUnlockKey ignores the store result, as it did before Phase 2', () => {
  const body = bodyOf('persistUnlockKey');
  assert.match(body, /storeIdentityUnlockKey\s*\(/, 'must call storeIdentityUnlockKey');
  assert.match(body, /catch\s*\(/, 'must catch a thrown IPC error');
  assert.doesNotMatch(body, /\.success\b/, 'must not branch on the { success } result');
});

test('attemptAutoUnlock returns false when no unlock key was returned', () => {
  const body = bodyOf('attemptAutoUnlock');
  assert.match(body, /getIdentityUnlockKey\s*\(/, 'must read the cached key');
  assert.match(body, /cached\s*&&\s*cached\.unlockKey/, 'must treat a null cache as no key');
  assert.match(body, /if\s*\(\s*!unlockKey\s*\)\s*\{\s*return false;/, 'must return false for a missing key');
  assert.doesNotMatch(body, /storeIdentityUnlockKey\s*\(/, 'must not write from the read path');
});
