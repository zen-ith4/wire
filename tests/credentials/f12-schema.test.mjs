// F12 schema migration (B1): backup first, then columns/tables/triggers; legacy data
// untouched; idempotent; fresh databases work; the invariants hold at SQL level.
// All tests work on COPIES of the legacy fixture.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    META, Database, assertFixtureUntouched, cleanupTmp, copyLegacyFixture, freshDbPath,
    openRaw, upgrade, columns, triggers, sha256File, tmpDir,
} from './_fixture.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { backupBeforeCredentialMigration } = require('../../database/backup.js');
const { ensureSchema } = require('../../database/schema.js');

after(() => { cleanupTmp(); assertFixtureUntouched(); });

const NEW_USER_COLS = ['auth_scheme', 'kdf_salt', 'kdf_iterations', 'scheme_migrated_at', 'legacy_last_login_at',
    'must_change_password', 'legacy_login_closed', 'legacy_login_closed_at'];
const TRIGGERS = ['trg_users_auth_scheme_monotonic', 'trg_users_scheme2_params_insert', 'trg_users_scheme2_params_update',
    'trg_identity_keys_version_monotonic'];

function snapshotLegacy(db) {
    return {
        users: db.prepare('SELECT id, username, email, password_hash, is_admin, is_active, email_2fa_enabled, created_at FROM users ORDER BY id').all(),
        identities: db.prepare('SELECT * FROM identity_keys ORDER BY id').all(),
        dms: db.prepare('SELECT * FROM direct_messages ORDER BY id').all(),
    };
}

test('T0: legacy copy gets a VACUUM INTO backup BEFORE any change, then the new schema', () => {
    const { dir, dbPath } = copyLegacyFixture();
    const db = openRaw(dbPath);
    const before = snapshotLegacy(db);
    assert.ok(!columns(db, 'users').includes('auth_scheme'));

    const backup = upgrade(db, dbPath, new Date('2026-10-07T12:00:00Z'));

    assert.equal(path.basename(backup), 'data.db.pre-f12.20261007T120000Z');
    assert.equal(path.dirname(backup), dir);
    assert.ok(fs.existsSync(backup));

    // the backup is the PRE-migration snapshot: legacy schema, identical rows
    const b = new Database(backup, { readonly: true });
    assert.ok(!columns(b, 'users').includes('auth_scheme'), 'backup must be taken before the ALTERs');
    assert.deepEqual(snapshotLegacy(b), before);
    b.close();

    // the live DB now has the new schema and all legacy data intact
    for (const c of NEW_USER_COLS) assert.ok(columns(db, 'users').includes(c), `missing column ${c}`);
    for (const t of TRIGGERS) assert.ok(triggers(db).includes(t), `missing trigger ${t}`);
    assert.deepEqual(snapshotLegacy(db), before, 'legacy rows changed by the schema upgrade');

    const rows = db.prepare('SELECT auth_scheme, kdf_salt, kdf_iterations, must_change_password, legacy_login_closed FROM users').all();
    assert.equal(rows.length, Object.keys(META.passwords).length);
    assert.ok(rows.every((r) => r.auth_scheme === 1 && r.kdf_salt === null && r.kdf_iterations === null
        && r.must_change_password === 0 && r.legacy_login_closed === 0));
    db.close();
});

test('T0: running the upgrade again is a no-op (no second backup, rows unchanged)', () => {
    const { dir, dbPath } = copyLegacyFixture();
    const db = openRaw(dbPath);
    upgrade(db, dbPath, new Date('2026-10-07T12:00:00Z'));
    const after1 = snapshotLegacy(db);
    const files1 = fs.readdirSync(dir).sort();

    assert.equal(upgrade(db, dbPath, new Date('2026-10-07T12:00:05Z')), null);
    assert.deepEqual(fs.readdirSync(dir).sort(), files1);
    assert.deepEqual(snapshotLegacy(db), after1);
    db.close();

    // a "restart": new connection, still nothing to do
    const db2 = openRaw(dbPath);
    assert.equal(upgrade(db2, dbPath, new Date('2026-10-07T12:01:00Z')), null);
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.pre-f12.')).length, 1);
    db2.close();
});

test('T0: a backup that cannot be written stops the migration (schema untouched)', () => {
    const { dbPath } = copyLegacyFixture();
    const db = openRaw(dbPath);
    const badPath = path.join(tmpDir(), 'no-such-dir', 'x', 'data.db'); // VACUUM INTO target dir does not exist

    assert.throws(() => backupBeforeCredentialMigration(db, badPath), /unable to open|no such|SQLITE|cannot/i);
    assert.ok(!columns(db, 'users').includes('auth_scheme'), 'schema must not change when the backup failed');
    db.close();
});

test('T0: an existing backup target is never overwritten', () => {
    const { dbPath } = copyLegacyFixture();
    const db = openRaw(dbPath);
    const now = new Date('2026-10-07T12:00:00Z');
    fs.writeFileSync(`${dbPath}.pre-f12.20261007T120000Z`, 'precious');
    assert.throws(() => backupBeforeCredentialMigration(db, dbPath, now), /already exists/);
    assert.equal(fs.readFileSync(`${dbPath}.pre-f12.20261007T120000Z`, 'utf8'), 'precious');
    assert.ok(!columns(db, 'users').includes('auth_scheme'));
    db.close();
});

test('fresh database: no backup, full schema, scheme-2 rows insertable', () => {
    const dbPath = freshDbPath();
    const db = openRaw(dbPath);
    assert.equal(upgrade(db, dbPath), null);
    assert.equal(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.pre-f12.')).length, 0);
    for (const c of NEW_USER_COLS) assert.ok(columns(db, 'users').includes(c));
    for (const t of TRIGGERS) assert.ok(triggers(db).includes(t));
    db.prepare("INSERT INTO users (username, password_hash, auth_scheme, kdf_salt, kdf_iterations) VALUES ('n', 'h', 2, 'AAAAAAAAAAAAAAAAAAAAAA==', 600000)").run();
    db.close();
});

test('in-memory databases are never backed up', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)');
    assert.equal(backupBeforeCredentialMigration(db, ':memory:'), null);
    db.close();
});

test('triggers: the scheme cannot go down; scheme 2 needs salt and >= 600,000 iterations', () => {
    const dbPath = freshDbPath();
    const db = openRaw(dbPath);
    ensureSchema(db);
    const ins = (extra) => db.prepare(`INSERT INTO users (username, password_hash ${extra.cols}) VALUES (?, 'h' ${extra.marks})`);

    // scheme 2 insert without parameters / below the floor
    assert.throws(() => db.prepare("INSERT INTO users (username, password_hash, auth_scheme) VALUES ('a', 'h', 2)").run(), /scheme 2 requires/);
    assert.throws(() => db.prepare("INSERT INTO users (username, password_hash, auth_scheme, kdf_salt, kdf_iterations) VALUES ('a', 'h', 2, 'AAAAAAAAAAAAAAAAAAAAAA==', 599999)").run(), /scheme 2 requires/);
    assert.throws(() => db.prepare("INSERT INTO users (username, password_hash, auth_scheme, kdf_salt, kdf_iterations) VALUES ('a', 'h', 2, NULL, 600000)").run(), /scheme 2 requires/);

    // a legacy row may be upgraded only with proper parameters
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('legacy', 'h')").run();
    assert.throws(() => db.prepare("UPDATE users SET auth_scheme = 2 WHERE username = 'legacy'").run(), /scheme 2 requires/);
    assert.throws(() => db.prepare("UPDATE users SET auth_scheme = 2, kdf_salt = 's', kdf_iterations = 100000 WHERE username = 'legacy'").run(), /scheme 2 requires/);
    db.prepare("UPDATE users SET auth_scheme = 2, kdf_salt = 'AAAAAAAAAAAAAAAAAAAAAA==', kdf_iterations = 600000 WHERE username = 'legacy'").run();

    // ...and can never go back, nor have its parameters weakened
    assert.throws(() => db.prepare("UPDATE users SET auth_scheme = 1 WHERE username = 'legacy'").run(), /downgrade refused/);
    assert.throws(() => db.prepare("UPDATE users SET kdf_iterations = 1000 WHERE username = 'legacy'").run(), /scheme 2 requires/);
    assert.throws(() => db.prepare("UPDATE users SET kdf_salt = NULL WHERE username = 'legacy'").run(), /scheme 2 requires/);
    assert.equal(db.prepare("SELECT auth_scheme FROM users WHERE username = 'legacy'").get().auth_scheme, 2);

    // unrelated updates are not blocked
    db.prepare("UPDATE users SET bio = 'x' WHERE username = 'legacy'").run();
    db.close();
});

test('triggers: the identity record version cannot decrease', () => {
    const dbPath = freshDbPath();
    const db = openRaw(dbPath);
    ensureSchema(db);
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('u', 'h')").run();
    db.prepare("INSERT INTO identity_keys (user_id, public_key, encrypted_private_key, kdf, kdf_params, salt, iv, version) VALUES (1, 'p', 'e', 'k', '{}', 's', 'i', 1)").run();
    db.prepare('UPDATE identity_keys SET version = 2 WHERE user_id = 1').run();
    assert.throws(() => db.prepare('UPDATE identity_keys SET version = 1 WHERE user_id = 1').run(), /version downgrade refused/);
    db.close();
});

test('new tables exist and cascade with the user', () => {
    const dbPath = freshDbPath();
    const db = openRaw(dbPath);
    ensureSchema(db);
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('u', 'h')").run();
    db.prepare("INSERT INTO auth_migration_tickets (user_id, ticket_hash, expires_at, created_at) VALUES (1, 'x', 1, 1)").run();
    db.prepare("INSERT INTO identity_key_rotations (user_id, old_public_key, new_public_key) VALUES (1, 'a', 'b')").run();
    db.prepare('DELETE FROM users WHERE id = 1').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_migration_tickets').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identity_key_rotations').get().n, 0);
    db.close();
});

test('the legacy copy is byte-different from the fixture after upgrade, the fixture is not', () => {
    const { dbPath } = copyLegacyFixture();
    const db = openRaw(dbPath);
    upgrade(db, dbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    assert.notEqual(sha256File(dbPath), META.sha256);
    assertFixtureUntouched();
});
