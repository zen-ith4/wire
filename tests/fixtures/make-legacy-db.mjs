#!/usr/bin/env node
// tests/fixtures/make-legacy-db.mjs
//
// Builds the "legacy X" SQLite fixture (tests/fixtures/legacy-x.db) by running the
// BASE application code, i.e. a database exactly as the pre-F12 build creates it
// (password_hash = bcrypt(raw password), identity v1, no auth_scheme column).
//
//   node tests/fixtures/make-legacy-db.mjs <baseTreeDir> [outDir]
//
// <baseTreeDir> must be an extracted tree of the BASE zip (wire-no-chat_4.zip) with
// the Phase 0.5 patch (wire-phase0_5-ad52de1.zip, 4 test files) applied, with
// node_modules reachable (symlink is fine). It is NOT a git commit: the script only
// needs the files. The tree used for the committed fixture is recorded in
// legacy-x.meta.json (zip sha256s). The script never touches the new tree's code.
//
// Contents (all passwords are test values listed in the meta file):
//   alice     v1 identity wrapped with PBKDF2 100,000 iterations
//   bob       v1 identity, 600,000 iterations
//   carol     no identity yet
//   Admin     mixed-case admin created by the base seed from DEFAULT_ADMIN_USER/PASS
//   dave      email 2FA enabled, verified email, v1 identity
//   erin      deactivated
//   frank     dormant legacy account (created 2020), v1 identity
//   MixedCase mixed-case username inserted directly (legacy rows can look like this)
//   one DM alice -> bob encrypted with the base DM session crypto
//
// Use only to (re)generate the fixture. Tests copy the committed file first.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const baseTree = path.resolve(process.argv[2] || '');
const outDir = path.resolve(process.argv[3] || path.dirname(new URL(import.meta.url).pathname));
if (!process.argv[2] || !fs.existsSync(path.join(baseTree, 'config', 'database.js'))) {
    console.error('usage: make-legacy-db.mjs <baseTreeDir> [outDir]');
    process.exit(2);
}

const dbFile = path.join(outDir, 'legacy-x.db');
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });

const PASSWORDS = {
    alice: 'alice-legacy-pass',
    bob: 'bob-legacy-pass',
    carol: 'carol-legacy-pass',
    Admin: 'admin-legacy-pass',
    dave: 'dave-legacy-pass',
    erin: 'erin-legacy-pass',
    frank: 'frank-legacy-pass',
    MixedCase: 'mixed-legacy-pass',
};

process.env.DB_PATH = dbFile;
process.env.JWT_SECRET = 'fixture-secret-not-for-production-0123456789';
process.env.EMAIL_ENABLED = 'false';
process.env.BCRYPT_ROUNDS = '4';
process.env.NODE_ENV = 'test';
process.env.USER_DATA_ROOT = path.join(outDir, '.tmp-user-data');
process.env.DEFAULT_ADMIN_USER = 'Admin';
process.env.DEFAULT_ADMIN_PASS = PASSWORDS.Admin;

const req = createRequire(path.join(baseTree, 'package.json'));
const imp = (rel) => import(pathToFileURL(path.join(baseTree, rel)).href);

const { initDatabase, getDb } = req('./config/database');
const { createUser } = req('./services/user.service');
const { hashPassword } = req('./utils/password');
const db = initDatabase();

const b64 = (buf) => Buffer.from(buf).toString('base64');

const identityMod = await imp('public/js/crypto/identity.js');
const kd = await imp('public/js/crypto/keys/key-derivation.js');

// Same wire format as the base identity.js (PBKDF2-SHA-256 -> AES-GCM, no AAD,
// pkcs8 plaintext), but with a chosen iteration count (the base always uses 600k).
async function makeV1Identity(password, iterations) {
    const keyPair = await identityMod.generateIdentityKeyPair();
    const publicKey = await identityMod.exportPublicKey(keyPair);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pw = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, pw, 256);
    const aes = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt']);
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, pkcs8);
    return { keyPair, pkcs8: Buffer.from(pkcs8).toString('base64'), row: {
        public_key: publicKey, encrypted_private_key: b64(enc), kdf: 'PBKDF2-SHA-256',
        kdf_params: JSON.stringify({ iterations, hash: 'SHA-256' }), salt: b64(salt), iv: b64(iv), version: 1,
    } };
}

function userId(name) {
    return db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
}

const ids = {};
const publicKeys = {};
const privateKeysPkcs8 = {};
const identities = {};

for (const name of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
    await createUser(name, `${name}@example.test`, PASSWORDS[name], false);
    ids[name] = userId(name);
}
ids.Admin = userId('Admin'); // created by the base seed (mixed case, exactly as configured)

// MixedCase: legacy row with an upper-case letter, bypassing the lowercasing of the API.
db.prepare("INSERT INTO users (username, email, password_hash, email_verified) VALUES ('MixedCase', 'mixed@example.test', ?, 1)")
    .run(await hashPassword(PASSWORDS.MixedCase));
ids.MixedCase = userId('MixedCase');

db.prepare('UPDATE users SET email_verified = 1').run();
db.prepare('UPDATE users SET email_2fa_enabled = 1 WHERE username = ?').run('dave');
db.prepare('UPDATE users SET is_active = 0 WHERE username = ?').run('erin');
db.prepare("UPDATE users SET created_at = '2020-01-01 00:00:00' WHERE username = 'frank'").run();

const plan = { alice: 100000, bob: 600000, dave: 600000, frank: 600000 };
for (const [name, iterations] of Object.entries(plan)) {
    const id = await makeV1Identity(PASSWORDS[name], iterations);
    db.prepare(`INSERT INTO identity_keys (user_id, public_key, encrypted_private_key, kdf, kdf_params, salt, iv, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(ids[name], id.row.public_key, id.row.encrypted_private_key,
        id.row.kdf, id.row.kdf_params, id.row.salt, id.row.iv, id.row.version);
    publicKeys[name] = id.row.public_key;
    privateKeysPkcs8[name] = id.pkcs8;
    identities[name] = id;
}

// One DM alice -> bob with the base DM session crypto (default info string).
const sessionKey = await kd.deriveSessionKeyFromPeer(
    identities.alice.keyPair.privateKey,
    await crypto.subtle.importKey('raw', Buffer.from(publicKeys.bob, 'base64'), { name: 'X25519' }, true, [])
);
const dmPlain = 'hello bob, this DM predates the credential migration';
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sessionKey, new TextEncoder().encode(dmPlain));
const dmContent = JSON.stringify({ version: 1, algorithm: 'AES-GCM', iv: b64(iv), ciphertext: b64(ct) });
db.prepare('INSERT INTO direct_messages (sender_id, recipient_id, content) VALUES (?, ?, ?)').run(ids.alice, ids.bob, dmContent);

db.pragma('wal_checkpoint(TRUNCATE)');
db.pragma('journal_mode = DELETE');
db.close();
fs.rmSync(process.env.USER_DATA_ROOT, { recursive: true, force: true });
for (const f of [`${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
const builtFrom = process.env.FIXTURE_BUILT_FROM || '(set FIXTURE_BUILT_FROM to record the source zips)';
fs.writeFileSync(path.join(outDir, 'legacy-x.meta.json'), JSON.stringify({
    built_from: builtFrom,
    note: 'Built by tests/fixtures/make-legacy-db.mjs from the BASE tree (wire-no-chat_4.zip + Phase 0.5 patch). Test data only.',
    sha256,
    passwords: PASSWORDS,
    ids,
    public_keys: publicKeys,
    private_keys_pkcs8: privateKeysPkcs8,
    identity_iterations: plan,
    dm: { sender: 'alice', recipient: 'bob', plaintext: dmPlain },
}, null, 2) + '\n');

console.log(`wrote ${dbFile} sha256=${sha256}`);
