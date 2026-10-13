// Shared helpers for the F12 credential-migration tests.
//
// Rule: NOTHING ever opens tests/fixtures/legacy-x.db directly. Every test copies it
// into a fresh temp directory first (copyLegacyFixture) and works on the copy. The
// committed fixture is protected by its SHA-256 (legacy-x.meta.json): copying
// verifies it first, and assertFixtureUntouched() (also run in every test file's
// `after`) fails if anything modified it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures');
export const FIXTURE_DB = path.join(FIXTURE_DIR, 'legacy-x.db');
export const META = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'legacy-x.meta.json'), 'utf8'));

const require = createRequire(import.meta.url);
export const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

export function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function assertFixtureUntouched() {
    assert.equal(sha256File(FIXTURE_DB), META.sha256, 'tests/fixtures/legacy-x.db was modified (tests must only use a copy)');
    for (const ext of ['-wal', '-shm', '-journal']) {
        assert.equal(fs.existsSync(FIXTURE_DB + ext), false, `stray ${ext} file next to the fixture`);
    }
}

const dirs = [];

export function tmpDir(prefix = 'wire-f12-') {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
}

export function cleanupTmp() {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** Copies the legacy fixture into a fresh temp dir; returns {dir, dbPath}. */
export function copyLegacyFixture() {
    assertFixtureUntouched(); // never copy from a damaged fixture
    const dir = tmpDir();
    const dbPath = path.join(dir, 'data.db');
    fs.copyFileSync(FIXTURE_DB, dbPath);
    return { dir, dbPath };
}

export function freshDbPath() {
    return path.join(tmpDir(), 'fresh.db');
}

/** Opens `dbPath` like config/database.js does, but without the process-wide singleton or seed. */
export function openRaw(dbPath) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
}

/** The two steps initDatabase() runs before seeding. Returns the backup path (or null). */
export function upgrade(db, dbPath, now) {
    const { backupBeforeCredentialMigration } = require(path.join(ROOT, 'database', 'backup.js'));
    const { ensureSchema } = require(path.join(ROOT, 'database', 'schema.js'));
    const backup = backupBeforeCredentialMigration(db, dbPath, now);
    ensureSchema(db);
    return backup;
}

export function columns(db, table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

export function triggers(db) {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name);
}
