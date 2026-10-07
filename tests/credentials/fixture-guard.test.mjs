// The committed legacy fixture must be byte-identical to what legacy-x.meta.json
// records, and it must really be a LEGACY database (no F12 columns, v1 identities,
// raw-password bcrypt hashes). Every other credential test file also re-checks the
// hash in its own `after` hook.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import bcrypt from 'bcrypt';
import { FIXTURE_DB, META, Database, assertFixtureUntouched, sha256File, columns } from './_fixture.mjs';

after(() => assertFixtureUntouched());

test('fixture hash matches legacy-x.meta.json and the build source is recorded', () => {
    assert.equal(sha256File(FIXTURE_DB), META.sha256);
    assert.match(META.built_from, /wire-no-chat_4\.zip/);
    assert.match(META.built_from, /sha256 [0-9a-f]{64}/);
});

test('the fixture is a pre-F12 database (read-only open, nothing is written)', async () => {
    const before = sha256File(FIXTURE_DB);
    const db = new Database(FIXTURE_DB, { readonly: true, fileMustExist: true });

    try {
        const cols = columns(db, 'users');
        assert.ok(!cols.includes('auth_scheme'), 'fixture must not have the F12 columns');
        assert.ok(!cols.includes('kdf_salt'));

        const names = db.prepare('SELECT username FROM users ORDER BY id').all().map((r) => r.username);
        for (const n of ['alice', 'bob', 'carol', 'Admin', 'dave', 'erin', 'frank', 'MixedCase']) {
            assert.ok(names.includes(n), `fixture lacks ${n}`);
        }

        // every stored hash is bcrypt(raw password) of the documented test password
        for (const [name, pw] of Object.entries(META.passwords)) {
            const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(name);
            assert.ok(await bcrypt.compare(pw, row.password_hash), `${name}: legacy hash does not match raw password`);
        }

        const ids = db.prepare('SELECT u.username, i.version, i.kdf, i.kdf_params FROM identity_keys i JOIN users u ON u.id = i.user_id').all();
        assert.deepEqual(ids.map((r) => r.username).sort(), ['alice', 'bob', 'dave', 'frank']);
        assert.ok(ids.every((r) => r.version === 1 && r.kdf === 'PBKDF2-SHA-256'));
        assert.equal(JSON.parse(ids.find((r) => r.username === 'alice').kdf_params).iterations, 100000);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM direct_messages').get().n, 1);
    } finally {
        db.close();
    }

    assert.equal(sha256File(FIXTURE_DB), before, 'read-only open changed the file');
    assert.equal(fs.existsSync(FIXTURE_DB + '-wal'), false);
});
