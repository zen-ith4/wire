// tests/dm-e2ee-admin-inserts.test.mjs
//
// R5: every internal admin-account INSERT sets dm_e2ee_min_version from the
// shared DM_E2EE_DEFAULT_MIN_VERSION constant. The seed, setup wizard and live
// admin-create path are covered end to end by
// tests/credentials/f12-setup-seed.test.mjs and f12-admin-create.test.mjs.
// services/user.service.js createAdmin() has NO caller in this tree (C7), so
// its INSERT is pinned here by calling it directly on a real migrated DB.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-r5-'));
process.env.DB_PATH = path.join(dir, 'r5.db');
process.env.USER_DATA_ROOT = path.join(dir, 'user-data');
process.env.CHAT_UPLOAD_DIR = path.join(dir, 'chat-uploads');
process.env.DM_UPLOAD_DIR = path.join(dir, 'dm-uploads');
process.env.GROUP_UPLOAD_DIR = path.join(dir, 'group-uploads');
process.env.AVATAR_DIR = path.join(dir, 'avatars');
process.env.BANNER_DIR = path.join(dir, 'banners');
process.env.BCRYPT_ROUNDS = '4';
process.env.DM_E2EE_DEFAULT_MIN_VERSION = '2';
// Keep seedDatabase() from creating an operator account in this isolated DB.
process.env.DEFAULT_ADMIN_USER = '';
process.env.DEFAULT_ADMIN_PASS = '';

const require = createRequire(import.meta.url);
const { initDatabase, getDb } = require('../config/database');
const { createAdmin } = require('../services/user.service');

const db = initDatabase();

after(() => {
    try { getDb().close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
});

test('dead createAdmin(): stores dm_e2ee_min_version from the shared default', async () => {
    const result = await createAdmin('deadadmin', 'a-long-enough-password');
    const row = db.prepare(
        'SELECT is_admin, dm_e2ee_min_version FROM users WHERE id = ?'
    ).get(Number(result.lastInsertRowid));

    assert.equal(row.is_admin, 1);
    assert.equal(row.dm_e2ee_min_version, 2);
});

test('the four internal INSERTs all name the column and the constant', () => {
    const read = (rel) => fs.readFileSync(
        path.join(import.meta.dirname, '..', rel),
        'utf8'
    );

    const expectedInserts = {
        'database/seed.js': 1,
        'utils/setupWizard.js': 1,
        'services/user.service.js': 2,
    };

    for (const [file, count] of Object.entries(expectedInserts)) {
        const source = read(file);
        const inserts = source.match(/INSERT INTO users/gi) || [];
        const columns = source.match(/dm_e2ee_min_version/g) || [];
        assert.equal(inserts.length, count, `${file}: unexpected INSERT INTO users count`);
        assert.ok(columns.length >= inserts.length, `${file}: every INSERT must name dm_e2ee_min_version`);
        assert.match(source, /DM_E2EE_DEFAULT_MIN_VERSION/, `${file} must use the shared constant`);
    }
});
