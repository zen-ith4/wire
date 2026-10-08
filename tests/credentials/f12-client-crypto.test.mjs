// B4: the browser-side credential code, run in Node against the REAL client modules
// (public/js/crypto/{credentials,identity,credential-migration}.js), with identities taken
// from the base-built legacy fixture (copy).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { META, Database, assertFixtureUntouched, cleanupTmp, copyLegacyFixture } from './_fixture.mjs';
import { cred, unwrapIdentityV2 } from './_server.mjs';

import * as client from '../../public/js/crypto/credentials.js';
import * as identityMod from '../../public/js/crypto/identity.js';
import { buildMigrationPayload, publicKeyFromPkcs8 } from '../../public/js/crypto/credential-migration.js';

after(() => { cleanupTmp(); assertFixtureUntouched(); });

function legacyRecord(user) {
    const { dbPath } = copyLegacyFixture();
    const db = new Database(dbPath, { readonly: true });
    const r = db.prepare('SELECT * FROM identity_keys WHERE user_id = ?').get(META.ids[user]);
    db.close();
    return {
        exists: true, publicKey: r.public_key, encryptedPrivateKey: r.encrypted_private_key, kdf: r.kdf,
        kdfParams: JSON.parse(r.kdf_params), salt: r.salt, iv: r.iv, version: r.version,
    };
}

test('browser derivation == Node twin used by the server (ASCII, non-ASCII, long)', async () => {
    const salt = client.generateKdfSalt();
    for (const pw of ['correct horse battery staple', 'pässwörd-日本語-🔑', 'x'.repeat(300)]) {
        const a = await client.deriveCredentials(pw, salt);
        const b = cred.deriveCredentialsNode(pw, salt);
        assert.equal(a.authKey, b.authKey);
        assert.deepEqual(Buffer.from(a.wrapKeyBytes), b.wrapKey);
        assert.ok(cred.isValidAuthKey(a.authKey));
    }
});

test('authKey and wrapKey are independent outputs; different salts give different keys', async () => {
    const s1 = client.generateKdfSalt(), s2 = client.generateKdfSalt();
    const a = await client.deriveCredentials('same password 123', s1);
    const b = await client.deriveCredentials('same password 123', s2);
    assert.notEqual(a.authKey, b.authKey);
    assert.notEqual(client.bytesToB64Url(a.wrapKeyBytes), a.authKey);
});

test('client refuses a weaker KDF than 600,000 iterations and an empty password', async () => {
    const salt = client.generateKdfSalt();
    await assert.rejects(client.deriveCredentials('some password 1234', salt, 1000), /weaker/);
    await assert.rejects(client.deriveCredentials('some password 1234', salt, 599999), /weaker/);
    await assert.rejects(client.deriveCredentials('', salt), /required/);
    await assert.rejects(client.deriveCredentials('some password 1234', 'AAAA'), /salt/);
});

for (const user of ['alice', 'bob', 'frank']) {
    test(`migration payload for ${user} (v1 identity, ${META.identity_iterations[user]} iterations): same key, v2 wrapper accepted by the server validator`, async () => {
        const record = legacyRecord(user);
        assert.equal(record.version, 1);
        const { body, salt } = await buildMigrationPayload({ password: META.passwords[user], ticket: 't'.repeat(43), identity: record });

        assert.equal(body.ticket, 't'.repeat(43));
        assert.equal(body.kdf_salt, salt);
        assert.equal(body.kdf_iterations, 600000);
        assert.equal(body.auth_key, cred.deriveCredentialsNode(META.passwords[user], salt).authKey);
        assert.equal(body.identity.publicKey, META.public_keys[user]);
        assert.equal(body.identity.version, 2);
        assert.equal(body.identity.salt, salt);

        // the server accepts exactly this shape ...
        const check = cred.validateIdentityV2(body.identity, salt, 600000);
        assert.equal(check.ok, true, check.error);
        // ... and it holds the SAME private key
        assert.equal(unwrapIdentityV2(body.identity, META.passwords[user]), META.private_keys_pkcs8[user]);
        // the password itself appears nowhere in the payload
        assert.ok(!JSON.stringify(body).includes(META.passwords[user]));
    });
}

test('migration payload without an identity (carol): only credentials', async () => {
    const { body } = await buildMigrationPayload({ password: META.passwords.carol, ticket: 't'.repeat(43), identity: { exists: false } });
    assert.equal(body.identity, undefined);
    assert.ok(cred.isValidAuthKey(body.auth_key));
});

test('migration refuses (nothing to send) when the identity does not open with the typed password', async () => {
    const record = legacyRecord('alice');
    await assert.rejects(buildMigrationPayload({ password: 'not-alice-password', ticket: 't'.repeat(43), identity: record }), /decrypt/);
});

test('migration refuses when the stored identity does not match its public key', async () => {
    const record = legacyRecord('alice');
    record.publicKey = META.public_keys.bob;
    await assert.rejects(buildMigrationPayload({ password: META.passwords.alice, ticket: 't'.repeat(43), identity: record }), /public key/);
});

test('migration refuses a v2 identity on a legacy account', async () => {
    const record = { ...legacyRecord('alice'), version: 2 };
    await assert.rejects(buildMigrationPayload({ password: META.passwords.alice, ticket: 't'.repeat(43), identity: record }));
});

test('publicKeyFromPkcs8 matches the fixture public keys', async () => {
    for (const u of ['alice', 'bob', 'dave', 'frank']) {
        assert.equal(await publicKeyFromPkcs8(Buffer.from(META.private_keys_pkcs8[u], 'base64')), META.public_keys[u]);
    }
});

test('identity.js: v1 (legacy) and v2 wrappers both round-trip; unlock keys work for both; mixed (version,kdf) pairs are refused', async () => {
    const pw = 'identity round trip password';
    const kp = await identityMod.generateIdentityKeyPair();
    const pub = await identityMod.exportPublicKey(kp);

    // v1: no kdf argument = the legacy wrapper (unmigrated accounts only)
    const v1 = await identityMod.encryptIdentityPrivateKey(kp.privateKey, pw);
    assert.equal(v1.version, 1);
    assert.equal(v1.kdf, 'PBKDF2-SHA-256');
    const r1 = await identityMod.restoreIdentityFromServer({ exists: true, publicKey: pub, ...v1 }, pw);
    assert.equal(r1.publicKey, pub);
    const uk1 = await identityMod.deriveIdentityUnlockKey(pw, v1.salt, v1.kdfParams);
    assert.ok(await identityMod.decryptIdentityPrivateKeyWithDerivedKey(v1.encryptedPrivateKey, uk1, v1.iv));

    // v2: account KDF
    const kdf = { salt: client.generateKdfSalt(), iterations: 600000 };
    const v2 = await identityMod.encryptIdentityPrivateKey(kp.privateKey, pw, kdf);
    assert.equal(v2.version, 2);
    assert.equal(v2.kdf, 'PBKDF2-SHA-256+HKDF-SHA-256');
    assert.equal(v2.salt, kdf.salt);
    assert.equal(cred.validateIdentityV2({ publicKey: pub, ...v2 }, kdf.salt, 600000).ok, true);
    const r2 = await identityMod.restoreIdentityFromServer({ exists: true, publicKey: pub, ...v2 }, pw);
    assert.equal(r2.publicKey, pub);
    const uk2 = await identityMod.deriveIdentityUnlockKey(pw, v2.salt, v2.kdfParams, v2.version);
    assert.equal(Buffer.from(uk2, 'base64').length, 32);
    assert.ok(await identityMod.decryptIdentityPrivateKeyWithDerivedKey(v2.encryptedPrivateKey, uk2, v2.iv));
    // the v1 unlock key can NOT open the v2 wrapper (this is why auto-unlock is cleared at migration)
    await assert.rejects(identityMod.decryptIdentityPrivateKeyWithDerivedKey(v2.encryptedPrivateKey, uk1, v2.iv));
    // wrong password
    await assert.rejects(identityMod.restoreIdentityFromServer({ exists: true, publicKey: pub, ...v2 }, 'wrong password!!'), /decrypt/);

    assert.throws(() => identityMod.assertKnownIdentityFormat({ version: 2, kdf: 'PBKDF2-SHA-256' }));
    assert.throws(() => identityMod.assertKnownIdentityFormat({ version: 1, kdf: 'PBKDF2-SHA-256+HKDF-SHA-256' }));
    assert.throws(() => identityMod.assertKnownIdentityFormat({ version: 3, kdf: 'x' }));
    identityMod.assertKnownIdentityFormat({ version: 1, kdf: 'PBKDF2-SHA-256' });
    identityMod.assertKnownIdentityFormat({ version: 2, kdf: 'PBKDF2-SHA-256+HKDF-SHA-256' });
});

test('v2 identity: the iteration floor is enforced when decrypting too (a hostile server cannot downgrade the KDF)', async () => {
    const pw = 'floor test password';
    const kdf = { salt: client.generateKdfSalt(), iterations: 600000 };
    const kp = await identityMod.generateIdentityKeyPair();
    const v2 = await identityMod.encryptIdentityPrivateKey(kp.privateKey, pw, kdf);
    await assert.rejects(identityMod.decryptIdentityPrivateKey(v2.encryptedPrivateKey, pw, v2.salt, v2.iv, { iterations: 100000, hash: 'SHA-256' }, 2), /iterations/);
});

test('sanity: node crypto and WebCrypto agree on X25519 PKCS#8 (fixture keys import)', async () => {
    const k = crypto.createPrivateKey({ key: Buffer.from(META.private_keys_pkcs8.alice, 'base64'), format: 'der', type: 'pkcs8' });
    assert.equal(k.asymmetricKeyType, 'x25519');
});
