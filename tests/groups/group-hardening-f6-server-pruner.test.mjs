// F6 wiring test: the device pruner must actually be started by the REAL
// server entry point (server.js), not only exist as an exported function.
//
// The other F6 tests call pruneStaleDevices() directly, so deleting the
// `startDevicePruner()` call from server.js would leave them green while
// production never prunes. This test boots `node server.js` as a child
// process against a throw-away SQLite file:
//   boot 1: creates the schema, then the process is stopped
//   seed:   a stale device (last_seen_at far in the past), a fresh device,
//           and an orphan receipt (device id nobody registered)
//   boot 2: startDevicePruner() prunes synchronously at start-up
// and asserts that the stale device and the orphan receipt are gone while
// the fresh device survives. It FAILS if server.js does not start the pruner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const require = createRequire(import.meta.url);
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

const STALE_DEVICE = 'a'.repeat(32);
const FRESH_DEVICE = 'b'.repeat(32);
const ORPHAN_DEVICE = 'c'.repeat(32);

function bootServer(env) {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const ready = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server did not start in 30s:\n' + out)), 30000);
        const iv = setInterval(() => {
            if (out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); resolve(); }
        }, 50);
        child.once('exit', (code) => {
            clearTimeout(t); clearInterval(iv);
            if (!out.includes('started successfully')) reject(new Error(`server exited early (${code}):\n` + out));
        });
    });
    const stop = () => new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    });
    return { ready, stop, log: () => out };
}

test('server.js starts the device pruner: stale devices and orphan receipts are removed at boot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-pruner-'));
    const dbPath = path.join(dir, 'data.db');
    const env = {
        DB_PATH: dbPath,
        USER_DATA_ROOT: path.join(dir, 'user-data'),
        SETUP_COMPLETED: 'true',
        JWT_SECRET: 'x'.repeat(48),
        HOST: '127.0.0.1',
        PORT: String(39000 + Math.floor(Math.random() * 900)),
        NODE_ENV: 'test',
        EMAIL_ENABLED: 'false',
    };

    try {
        // boot 1: schema only
        const first = bootServer(env);
        await first.ready;
        await first.stop();

        // seed
        const db = new Database(dbPath);
        // The orphan receipt deliberately points at a KDM/device that do not exist.
        db.pragma('foreign_keys = OFF');
        // A fresh DB has no users (SETUP_COMPLETED=true skips the wizard).
        const user = { id: db.prepare(
            "INSERT INTO users (username, email, password_hash) VALUES ('pruner-test', 'pruner@test.invalid', 'x')"
        ).run().lastInsertRowid };
        const now = Date.now();
        const ins = db.prepare('INSERT INTO group_devices (user_id, device_id, created_at, last_seen_at) VALUES (?,?,?,?)');
        ins.run(user.id, STALE_DEVICE, 1000, 1000);
        ins.run(user.id, FRESH_DEVICE, now, now);
        db.prepare("INSERT INTO group_kdm_receipts (kdm_id, device_id, delivered_at) VALUES (?,?,?)")
            .run(1, ORPHAN_DEVICE, new Date().toISOString());
        db.close();

        // boot 2: the real server must prune
        const second = bootServer(env);
        try {
            await second.ready;
            const check = new Database(dbPath, { readonly: true });
            const devices = check.prepare('SELECT device_id FROM group_devices').all().map((r) => r.device_id);
            const orphans = check.prepare('SELECT COUNT(*) AS n FROM group_kdm_receipts WHERE device_id = ?').get(ORPHAN_DEVICE).n;
            check.close();
            assert.ok(!devices.includes(STALE_DEVICE), 'stale device must be pruned by the real server at boot');
            assert.ok(devices.includes(FRESH_DEVICE), 'fresh device must survive');
            assert.equal(orphans, 0, 'orphan receipt must be pruned');
        } finally {
            await second.stop();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
