// tests/groups/_env.mjs
//
// Must be the FIRST import in any test file that uses _test-server.mjs
// — ES module imports are evaluated before the importing file's own
// top-level statements run, so setting process.env.* after importing
// _test-server.mjs would be too late (config/constants.js reads these
// once, at its own first require).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The upload/data dirs below are set for the same reason. config/multer.js calls
// fs.mkdirSync for AVATAR_DIR, BANNER_DIR, CHAT_UPLOAD_DIR, DM_UPLOAD_DIR and
// USER_DATA_ROOT AT MODULE LOAD TIME, and config/constants.js resolves each of
// them from process.env with a path RELATIVE TO THE CWD. Loading the app
// in-process from the repo root therefore created five empty directories in the
// repo root on every full run, which is what made the "the server wrote into the
// repo root" control in tests/acceptance-no-plaintext.test.mjs fail. Same fix as
// tests/dm-attachments/_env.mjs, which already did it.
export const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-group-'));

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-group-roundtrip-do-not-use-in-prod';
process.env.GROUPS_ENABLED = 'true';
process.env.EMAIL_ENABLED = 'false'; // no SMTP in this sandbox; skip email verification
process.env.DB_PATH = ':memory:';
process.env.CHAT_UPLOAD_DIR = path.join(TEST_ROOT, 'chat-uploads');
process.env.DM_UPLOAD_DIR = path.join(TEST_ROOT, 'dm-uploads');
process.env.GROUP_UPLOAD_DIR = path.join(TEST_ROOT, 'group-uploads');
process.env.AVATAR_DIR = path.join(TEST_ROOT, 'avatars');
process.env.BANNER_DIR = path.join(TEST_ROOT, 'banners');
process.env.USER_DATA_ROOT = path.join(TEST_ROOT, 'user-data');
