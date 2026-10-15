// tests/identity-key-history.test.mjs
//
// STEP A: the read side of the identity-key archive.
//
// The premise this file was written against was "rotation destroys the old public
// key". It does not. me.controller.js writes the outgoing key into
// identity_key_rotations in the SAME transaction as the UPDATE that replaces it,
// and the table is append-only. What was actually missing is that nothing ever
// READ it — the repo had exactly two references to identity_key_rotations, the
// CREATE TABLE and the INSERT.
//
// So these tests pin down two things that could both silently regress:
//   1. the outgoing key really is preserved, survives being read, and comes back
//      in the right order after more than one rotation;
//   2. the table exists on an old database without a manual step, and creating
//      it twice is harmless.
//
// The committed fixture is never opened for writing: every test copies it first
// (copyLegacyFixture), and assertFixtureUntouched() runs in `after`.
//
// Nothing here touches how a message is encrypted or decrypted.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import {
    copyLegacyFixture,
    assertFixtureUntouched,
    cleanupTmp,
    ROOT,
    META,
} from './credentials/_fixture.mjs';
import { bootServer, migrateLegacyUser, wrapIdentityV2 } from './credentials/_server.mjs';

const require = createRequire(import.meta.url);
// Read from the middleware rather than hardcoding, so bumping GROUP_PROTOCOL_MIN
// cannot silently make every group call below a 426.
const { GROUP_PROTOCOL_MIN } = require(path.join(ROOT, 'middleware', 'groupProtocol.js'));

/** A fresh X25519 pair, in the same shape the browser hands the rotate endpoint. */
function newX25519() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const pkcs8 = privateKey.export({ format: 'pem', type: 'pkcs8' })
        .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    return { pkcs8, publicKeyB64: raw.toString('base64') };
}

/**
 * Rotate `session`'s account to a brand new identity key, through the real
 * endpoint, exactly as the browser does: the CURRENT authKey stays the authKey and
 * only the wrapped identity changes.
 */
async function rotate(srv, session) {
    const before = await srv.call('GET', '/api/me/identity-key', { token: session.token });
    assert.equal(before.status, 200, `read identity-key: ${before.status} ${JSON.stringify(before.body)}`);

    const fresh = newX25519();
    const { identity } = wrapIdentityV2(
        fresh.pkcs8, fresh.publicKeyB64, session.password, session.salt, session.iterations
    );

    const res = await srv.call('POST', '/api/me/identity-key/rotate', {
        token: session.token,
        body: {
            current_auth_key: session.authKey,
            expected_public_key: before.body.publicKey,
            expected_updated_at: before.body.updatedAt,
            identity,
        },
    });

    assert.equal(res.status, 200, `rotate: ${res.status} ${JSON.stringify(res.body)}`);
    return { retired: before.body.publicKey, installed: fresh.publicKeyB64 };
}

function tableExists(db, name) {
    return !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function fingerprint(publicKey) {
    return crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64');
}

/** One shared server: these tests each need a migrated, scheme-2 session. */
let srv = null;

after(async () => {
    if (srv) await srv.stop().catch(() => {});
    cleanupTmp();
    assertFixtureUntouched();
});

// ---------------------------------------------------------------- migration

test('the archive table is created on an old database, and creating it twice is harmless', async () => {
    const { openRaw, upgrade } = await import('./credentials/_fixture.mjs');
    const { dbPath } = copyLegacyFixture();
    const db = openRaw(dbPath);

    try {
        // The committed fixture predates the credential schema entirely.
        assert.equal(tableExists(db, 'identity_key_rotations'), false,
            'fixture is expected to predate identity_key_rotations');
        assert.equal(tableExists(db, 'auth_migration_tickets'), false);

        upgrade(db, dbPath, new Date());

        assert.equal(tableExists(db, 'identity_key_rotations'), true,
            'upgrade() must create the archive on an existing database');
        assert.equal(tableExists(db, 'auth_migration_tickets'), true);

        const cols = db.prepare('PRAGMA table_info(identity_key_rotations)').all().map((c) => c.name);
        for (const c of ['user_id', 'old_public_key', 'new_public_key', 'at']) {
            assert.ok(cols.includes(c), `archive must keep ${c}; got ${cols.join(', ')}`);
        }

        // Idempotent: every later boot runs this again. It must not throw, must
        // not duplicate the table and must not drop rows.
        db.prepare('INSERT INTO identity_key_rotations (user_id, old_public_key, new_public_key) VALUES (?,?,?)')
            .run(META.ids.bob, 'OLD', 'NEW');
        const before = db.prepare('SELECT COUNT(*) AS n FROM identity_key_rotations').get().n;
        assert.equal(before, 1);

        upgrade(db, dbPath, new Date());

        assert.equal(tableExists(db, 'identity_key_rotations'), true);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identity_key_rotations').get().n, before,
            'a second upgrade() must not lose rows');
    } finally {
        db.close();
    }
});

test('the committed fixture is byte-identical after all of that', () => {
    assertFixtureUntouched();
});

// ---------------------------------------------------------------- rotation

test('rotating twice keeps BOTH old keys, oldest first, with the current one separate', async (t) => {
    if (!srv) {
        const { dbPath } = copyLegacyFixture();
        // GROUPS_ENABLED: the group routes answer 404 without it, and one of the
        // authorization branches below is reached only by sharing a group.
        srv = await bootServer(dbPath, path.dirname(dbPath), { GROUPS_ENABLED: 'true' });
    }
    if (!srv) return t.skip('no server');

    const bob = await migrateLegacyUser(srv, META, 'bob');
    const original = (await srv.call('GET', '/api/me/identity-key', { token: bob.token })).body.publicKey;

    const first = await rotate(srv, bob);
    assert.equal(first.retired, original, 'rotation #1 must retire the original key');

    const second = await rotate(srv, bob);
    assert.equal(second.retired, first.installed, 'rotation #2 must retire what rotation #1 installed');

    const seen = await srv.call('GET', `/api/me/identity-key-history/${META.ids.bob}`, { token: bob.token });
    assert.equal(seen.status, 200, `own history: ${seen.status} ${JSON.stringify(seen.body)}`);

    assert.equal(seen.body.current.publicKey, second.installed, 'current must be the newest key');
    assert.equal(seen.body.current.retiredAt, null, 'the current key is not retired');

    assert.deepEqual(
        seen.body.history.map((k) => k.publicKey),
        [original, first.installed],
        'history must hold both retired keys, oldest first'
    );

    for (const k of [seen.body.current, ...seen.body.history]) {
        assert.equal(k.fingerprint, fingerprint(k.publicKey),
            'fingerprint must be SHA-256 over the raw key bytes');
    }
    const fps = [seen.body.current, ...seen.body.history].map((k) => k.fingerprint);
    assert.equal(new Set(fps).size, fps.length, 'fingerprints must be distinct');

    const retiredAts = seen.body.history.map((k) => k.retiredAt);
    assert.ok(retiredAts.every(Boolean), 'every archived key has a retirement time');
    assert.deepEqual([...retiredAts].sort(), retiredAts, 'history must be ordered oldest retired first');

    // The rotation log itself must be untouched by all of that reading.
    const direct = await srv.call('GET', `/api/me/identity-key-history/${META.ids.bob}`, { token: bob.token });
    assert.deepEqual(direct.body, seen.body, 'reads must be side-effect free');
});

// ---------------------------------------------------------- authorization

test('a DM contact may read it; a stranger may not, and cannot tell "no" from "does not exist"', async (t) => {
    if (!srv) return t.skip('server not booted');

    const bobId = META.ids.bob;
    const alice = await migrateLegacyUser(srv, META, 'alice');   // DM contact
    const dave = await migrateLegacyUser(srv, META, 'dave');     // no contact with bob

    const dm = await srv.call('POST', '/api/dm/messages', {
        token: alice.token,
        body: { recipient_id: bobId, content: 'hello' },
    });
    assert.ok(dm.status === 200 || dm.status === 201, `dm send: ${dm.status} ${JSON.stringify(dm.body)}`);

    const asContact = await srv.call('GET', `/api/me/identity-key-history/${bobId}`, { token: alice.token });
    assert.equal(asContact.status, 200,
        `a DM contact must be allowed: ${asContact.status} ${JSON.stringify(asContact.body)}`);
    assert.ok(asContact.body.current.publicKey, 'the contact sees the current key');

    const asStranger = await srv.call('GET', `/api/me/identity-key-history/${bobId}`, { token: dave.token });
    const nobody = await srv.call('GET', '/api/me/identity-key-history/999999', { token: dave.token });

    assert.equal(asStranger.status, 404, `a stranger must be refused: ${asStranger.status}`);
    assert.deepEqual(asStranger.body, nobody.body,
        'the "not a contact" answer must be indistinguishable from "no such user"');

    const leaked = JSON.stringify(asStranger.body);
    for (const key of [asContact.body.current.publicKey, ...asContact.body.history.map((k) => k.publicKey)]) {
        assert.ok(!leaked.includes(key), 'no key may leak to a stranger');
    }

    const anon = await srv.call('GET', `/api/me/identity-key-history/${bobId}`);
    assert.equal(anon.status, 401, `unauthenticated must be refused: ${anon.status}`);

    for (const bad of ['abc', '0', '-1', '1.5']) {
        const r = await srv.call('GET', `/api/me/identity-key-history/${bad}`, { token: alice.token });
        assert.equal(r.status, 400, `id ${bad} must be a 400, got ${r.status}`);
    }
});

test('a shared-group member with no DM still gets the history', async (t) => {
    if (!srv) return t.skip('server not booted');

    const bobId = META.ids.bob;
    const frank = await migrateLegacyUser(srv, META, 'frank');

    // No DM between frank and bob at this point.
    const before = await srv.call('GET', `/api/me/identity-key-history/${bobId}`, { token: frank.token });
    assert.equal(before.status, 404, 'frank is a stranger until they share a group');

    const created = await srv.call('POST', '/api/groups', {
        token: frank.token,
        headers: { 'X-Wire-Group-Proto': String(GROUP_PROTOCOL_MIN) },
        body: { name: 'KeyHistoryTest' },
    });
    assert.equal(created.status, 201, `create group: ${created.status} ${JSON.stringify(created.body)}`);
    const groupId = created.body.id ?? created.body.group?.id;

    // Add bob. Read the members endpoint to find the shape rather than assume it.
    const added = await srv.call('POST', `/api/groups/${groupId}/members`, {
        token: frank.token,
        headers: { 'X-Wire-Group-Proto': String(GROUP_PROTOCOL_MIN) },
        body: { user_id: bobId },
    });
    assert.ok(added.status === 200 || added.status === 201,
        `add member: ${added.status} ${JSON.stringify(added.body)}`);

    const after = await srv.call('GET', `/api/me/identity-key-history/${bobId}`, { token: frank.token });
    assert.equal(after.status, 200,
        `a shared-group member must be allowed: ${after.status} ${JSON.stringify(after.body)}`);
    assert.ok(after.body.current.publicKey, 'the group member sees the current key');
});