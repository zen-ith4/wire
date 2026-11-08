// markOffline returned true for a user who was never online: the expression
// (onlineCounts.get(id) || 1) - 1 yields 0, which counts as "last connection
// closed". Nothing in the current socket code calls it that way, but the
// transition must only be reported for a real online -> offline change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { markOnline, markOffline, isOnline, getOnlineUserIds } = require(
  path.join(ROOT, 'services', 'presence.service.js')
);

test('markOffline for a user never seen online returns false and changes nothing', () => {
  assert.equal(markOffline(424242), false);
  assert.equal(isOnline(424242), false);
  assert.equal(getOnlineUserIds().includes(424242), false);
});

test('ref-counting is unchanged: first connect true, last disconnect true, middle false', () => {
  assert.equal(markOnline(7), true);   // first socket
  assert.equal(markOnline(7), false);  // second socket
  assert.equal(markOffline(7), false); // one socket left open
  assert.equal(isOnline(7), true);
  assert.equal(markOffline(7), true);  // last socket closed
  assert.equal(isOnline(7), false);
});

test('an unknown user does not disturb an online user', () => {
  markOnline(8);
  assert.equal(markOffline(999), false);
  assert.equal(isOnline(8), true);
  markOffline(8);
});
