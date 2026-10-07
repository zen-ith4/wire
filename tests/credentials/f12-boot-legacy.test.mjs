// The REAL server entry point (server.js) booted on a COPY of the legacy database:
// the pre-migration backup appears next to the copy, the server starts, and the
// existing accounts and identities are still there (auth_scheme = 1). Also boots a
// fresh database without a backup.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, META, Database, assertFixtureUntouched, cleanupTmp, copyLegacyFixture, tmpDir, sha256File } from './_fixture.mjs';

after(() => { cleanupTmp(); assertFixtureUntouched(); });

function boot(dbPath, dir) {
    const env = {
        ...process.env, DB_PATH: dbPath, USER_DATA_ROOT: path.join(dir, 'user-data'), SETUP_COMPLETED: 'true',
        JWT_SECRET: 'x'.repeat(48), HOST: '127.0.0.1', PORT: String(39000 + Math.floor(Math.random() * 900)),
        NODE_ENV: 'test', EMAIL_ENABLED: 'false',
    };
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const ready = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no start in 30s:\n' + out)), 30000);
        const iv = setInterval(() => { if (out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); resolve(out); } }, 50);
        child.once('exit', (c) => { if (!out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); reject(new Error(`exited ${c}:\n${out}`)); } });
    });
    const stop = () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); });
    return { ready, stop };
}

test('real server on a copy of the legacy DB: backup first, then it serves with legacy accounts intact', async () => {
    const { dir, dbPath } = copyLegacyFixture();
    const s = boot(dbPath, dir);
    try {
        const log = await s.ready;
        assert.match(log, /pre-migration backup written/);
    } finally { await s.stop(); }

    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('data.db.pre-f12.'));
    assert.equal(backups.length, 1);

    const b = new Database(path.join(dir, backups[0]), { readonly: true });
    assert.ok(!b.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'auth_scheme'));
    assert.equal(b.prepare('SELECT COUNT(*) AS n FROM users').get().n, Object.keys(META.passwords).length);
    b.close();

    const db = new Database(dbPath, { readonly: true });
    const users = db.prepare('SELECT username, auth_scheme FROM users ORDER BY id').all();
    assert.equal(users.length, Object.keys(META.passwords).length);
    assert.ok(users.every((u) => u.auth_scheme === 1), 'accounts stay legacy until their owner logs in');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identity_keys WHERE version = 1').get().n, 4);
    db.close();

    // second start: no second backup
    const s2 = boot(dbPath, dir);
    try { await s2.ready; } finally { await s2.stop(); }
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('data.db.pre-f12.')).length, 1);
});

test('real server on a fresh database: starts, no backup', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'fresh.db');
    const s = boot(dbPath, dir);
    try { await s.ready; } finally { await s.stop(); }
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.pre-f12.')).length, 0);
    const db = new Database(dbPath, { readonly: true });
    assert.ok(db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'auth_scheme'));
    db.close();
    assert.equal(sha256File(path.join(dir, 'fresh.db')).length, 64);
});
