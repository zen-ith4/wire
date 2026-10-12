// tests/dm-attachments/_env.mjs
//
// MUST be the first import of a test file: config/constants.js reads
// these once, at its own first require. Unlike the group tests, the DB
// here is a real FILE (so a test can grep the .db / -wal / -shm files)
// and every upload directory lives under one throw-away root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-dm-att-'));

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-dm-attachments-do-not-use-in-prod';
process.env.GROUPS_ENABLED = 'false';
process.env.EMAIL_ENABLED = 'false';
process.env.DB_PATH = path.join(TEST_ROOT, 'wire.db');
process.env.DM_UPLOAD_DIR = path.join(TEST_ROOT, 'dm-uploads');
process.env.CHAT_UPLOAD_DIR = path.join(TEST_ROOT, 'chat-uploads');
process.env.GROUP_UPLOAD_DIR = path.join(TEST_ROOT, 'group-uploads');
process.env.AVATAR_DIR = path.join(TEST_ROOT, 'avatars');
process.env.BANNER_DIR = path.join(TEST_ROOT, 'banners');
process.env.USER_DATA_ROOT = path.join(TEST_ROOT, 'user-data');
delete process.env.DM_E2EE_ATTACHMENTS_ENFORCED; // default: ON
// The real upload limiter (20/min per user) would 429 this suite, which
// sends dozens of uploads from one user. Test-only switch; the server
// refuses it in production.
process.env.LOADTEST_DISABLE_RATE_LIMITS = 'true';
