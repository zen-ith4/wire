// tests/groups/group-hardening-f12-credentials.test.mjs
//
// F12: the server never sees the password, nor anything it could turn into the key
// that encrypts the identity private key. Real Express + SQLite + client.
//
// The leak test records EVERYTHING that crosses a trust boundary during
// register / login / wrong login / identity create+restore / password change /
// admin create-user, then proves the password and the wrapKey (in every common
// encoding), as well as the PBKDF2 master they come from, appear nowhere in:
//   - any HTTP request body or header the client sent,
//   - every row of every table in the server database,
//   - every line the server (this process) printed.

import './_env.mjs';

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { test, after } from 'node:test';
import { createScenario, assert } from './_scenario.mjs';

const require = createRequire(import.meta.url);
const sc = require('../../utils/credentials');
const browser = await import('../../public/js/crypto/credentials.js');

// ---- capture server-side output (the server runs in this process) -------------
const logged = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); orig(...a); };
}
for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => { logged.push(String(chunk)); return orig(chunk, ...rest); };
}

const scenarios = [];
after(async () => { for (const s of scenarios) await s.stop(); });

let shared = null;
async function scenario() {
    if (!shared) {
        shared = await createScenario(['alice', 'bob', 'carol']);
        scenarios.push(shared);
    }
    return shared;
}

const enc = {
    all(bytes) {
        const b = Buffer.from(bytes);
        const b64 = b.toString('base64');
        return [b.toString('hex'), b64, b64.replace(/=+$/, ''), b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), encodeURIComponent(b64)];
    },
};

/** Every encoding under which a secret could show up on the wire / in storage. */
function forms(secret) {
    const utf8 = Buffer.from(secret, 'utf8');
    return [
        secret,
        encodeURIComponent(secret),
        JSON.stringify(secret).slice(1, -1),
        ...enc.all(utf8),
        crypto.createHash('sha256').update(utf8).digest('hex'),
        crypto.createHash('sha256').update(utf8).digest('base64'),
        crypto.createHash('sha1').update(utf8).digest('hex'),
        crypto.createHash('md5').update(utf8).digest('hex'),
    ];
}

function dumpDb(db) {
    const out = [];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
        for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
            out.push(`${name}: ${JSON.stringify(row, (_, v) => (Buffer.isBuffer(v) ? v.toString('hex') + '|' + v.toString('base64') + '|' + v.toString('utf8') : v))}`);
        }
    }
    return out.join('\n');
}

function wireOf(...actors) {
    return actors.flatMap((a) => a.fetchLog).map((f) => `${f.method} ${f.url}\n${f.headers || ''}\n${f.body || ''}`).join('\n----\n');
}

function secretsOf(S, u) {
    const saltB64 = S.server.db.prepare('SELECT kdf_salt FROM users WHERE username = ?').get(u.n).kdf_salt;
    const iterations = 600000;
    const password = u.ident.password;
    const master = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(saltB64, 'base64'), iterations, 32, 'sha256');
    const { authKey, wrapKey } = sc.deriveCredentialsNode(password, saltB64, iterations);
    return { password, saltB64, master, authKey, wrapKey };
}

async function http(S, token, method, path, body) {
    const res = await globalThis.__nodeFetch(`${S.server.origin}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}`, 'X-Wire-Group-Proto': '2' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

// ------------------------------------------------------------------------------

test('F12-a: browser (WebCrypto) and server (Node) derivations are byte-identical', async () => {
    for (const [pw, iters] of [['correct horse battery staple', 600000], ['pässwörd ✓ 密码', 600000]]) {
        const salt = browser.generateKdfSalt();
        const b = await browser.deriveCredentials(pw, salt, iters);
        const n = sc.deriveCredentialsNode(pw, salt, iters);
        assert.equal(b.authKey, n.authKey);
        assert.equal(Buffer.from(b.wrapKeyBytes).toString('hex'), n.wrapKey.toString('hex'));
        assert.match(b.authKey, /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(b.authKey, Buffer.from(b.wrapKeyBytes).toString('base64url'), 'authKey and wrapKey are independent outputs');
    }
});

test('F12-b: no request, log line or DB row contains the password, the wrapKey, or the PBKDF2 master', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;

    // Exercise every flow that touches credentials, as Alice.
    const secrets = secretsOf(S, alice);
    const bobSecrets = secretsOf(S, bob);

    // wrong-password login attempt and a fresh login (new process = new module graph)
    const wrong = await S.restartProcess(alice);
    wrong.actor.use();
    const auth = await wrong.actor.importModule('core/auth.js');
    await assert.rejects(() => auth.login(alice.n, 'definitely-not-her-password'));
    await auth.login(alice.n, alice.ident.password);              // (restartProcess already restored the identity)

    // password change with the identity re-wrapped client-side
    const idsvc = await wrong.actor.importModule('crypto/identity-service.js');
    const change = await idsvc.prepareCredentialChange(alice.ident.password, 'a-brand-new-passphrase-42', auth.getToken());
    const r = await http(S, auth.getToken(), 'PUT', '/api/me/password', change);
    assert.equal(r.status, 200, JSON.stringify(r));
    const newSecrets = (() => {
        const saltB64 = S.server.db.prepare('SELECT kdf_salt FROM users WHERE username = ?').get(alice.n).kdf_salt;
        const { authKey, wrapKey } = sc.deriveCredentialsNode('a-brand-new-passphrase-42', saltB64, 600000);
        const master = crypto.pbkdf2Sync(Buffer.from('a-brand-new-passphrase-42'), Buffer.from(saltB64, 'base64'), 600000, 32, 'sha256');
        return { password: 'a-brand-new-passphrase-42', saltB64, master, authKey, wrapKey };
    })();

    // admin creates a user from a browser
    S.server.db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(bob.n);
    const adminSalt = browser.generateKdfSalt();
    const created = await browser.deriveCredentials('password-typed-by-the-admin', adminSalt, 600000);
    const mk = await http(S, bob.ident.token, 'POST', '/api/admin/users', {
        username: 'carol_f12', email: 'carol_f12@example.test', auth_key: created.authKey, kdf_salt: adminSalt, kdf_iterations: 600000, is_admin: false,
    });
    assert.equal(mk.status, 201, JSON.stringify(mk));

    // ---- collect everything ----
    const wire = wireOf(...[alice, bob].map((u) => u.actor), wrong.actor) + '\n' + JSON.stringify(change);
    const wireAdmin = `${JSON.stringify({ auth_key: created.authKey })}`;
    const db = dumpDb(S.server.db);
    const logs = logged.join('\n');

    const secretSets = [
        ['alice password', forms(secrets.password)],
        ['alice wrapKey', enc.all(secrets.wrapKey)],
        ['alice master', enc.all(secrets.master)],
        ['alice NEW password', forms(newSecrets.password)],
        ['alice NEW wrapKey', enc.all(newSecrets.wrapKey)],
        ['alice NEW master', enc.all(newSecrets.master)],
        ['bob password', forms(bobSecrets.password)],
        ['bob wrapKey', enc.all(bobSecrets.wrapKey)],
        ['bob master', enc.all(bobSecrets.master)],
        ['admin-typed password', forms('password-typed-by-the-admin')],
        ['admin-created wrapKey', enc.all(Buffer.from(created.wrapKeyBytes))],
    ];

    // control: the test really can see the wire and the DB (the authKey IS sent, and is NOT stored)
    assert.ok(wire.includes(secrets.authKey), 'control: the authKey travels in login/register requests');
    assert.ok(wire.includes(newSecrets.authKey), 'control: new_auth_key travels in the password-change request');
    assert.ok(wire.length > 500 && db.length > 500 && logs.length > 50, 'control: captured something');

    for (const [name, variants] of secretSets) {
        for (const v of variants) {
            assert.ok(!wire.includes(v), `${name} appears in an HTTP request (${v.slice(0, 12)}...)`);
            assert.ok(!db.includes(v), `${name} appears in the server database (${v.slice(0, 12)}...)`);
            assert.ok(!logs.includes(v), `${name} appears in a server log line (${v.slice(0, 12)}...)`);
            assert.ok(!wireAdmin.includes(v), `${name} appears in the admin request`);
        }
    }

    // The authKey is a credential: it is stored only as a bcrypt hash, never in clear.
    for (const k of [secrets.authKey, newSecrets.authKey, created.authKey]) {
        assert.ok(!db.includes(k), 'authKey stored in the database in clear');
        assert.ok(!logs.includes(k), 'authKey written to a log');
    }
    const hash = S.server.db.prepare('SELECT password_hash FROM users WHERE username = ?').get(alice.n).password_hash;
    assert.match(hash, /^\$2[aby]\$/, 'credential is a bcrypt hash');
    assert.ok(require('bcrypt').compareSync(newSecrets.authKey, hash), 'the hash is of the (new) authKey');
    assert.ok(!require('bcrypt').compareSync('a-brand-new-passphrase-42', hash), 'and NOT of the password');
});

test('F12-c: what the server holds cannot decrypt the identity; only the wrapKey can', async () => {
    const S = await scenario();
    const { bob } = S.users;
    const secrets = secretsOf(S, bob);
    const row = S.server.db.prepare('SELECT * FROM identity_keys WHERE user_id = ?').get(bob.ident.id);
    assert.ok(row, 'control: Bob has an identity');
    assert.equal(row.version, 2);
    assert.equal(row.kdf, 'PBKDF2-SHA-256+HKDF-SHA-256');
    assert.equal(row.salt, secrets.saltB64, 'identity is wrapped under the ACCOUNT salt');
    assert.equal(JSON.parse(row.kdf_params).iterations, 600000);

    const tryKey = async (bytes) => {
        const key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['decrypt']);
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row.iv, 'base64') }, key, Buffer.from(row.encrypted_private_key, 'base64'));
    };

    // control: the wrapKey (known only to the browser) decrypts it
    const pkcs8 = await tryKey(secrets.wrapKey);
    assert.ok(pkcs8.byteLength > 30);

    // everything the server does receive/hold fails
    const authBytes = Buffer.from(secrets.authKey, 'base64url');
    await assert.rejects(() => tryKey(authBytes), 'the authKey (which the server sees) must not decrypt the identity');
    await assert.rejects(() => tryKey(secrets.master), 'the PBKDF2 master must not decrypt the identity either');
    await assert.rejects(() => tryKey(crypto.createHash('sha256').update(secrets.password).digest()));
});

test('F12-d: no endpoint accepts a raw password any more', async () => {
    const S = await scenario();
    const { bob } = S.users;
    S.server.db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(bob.n);
    const salt = browser.generateKdfSalt();
    const { authKey } = await browser.deriveCredentials('whatever-long-password', salt, 600000);

    const attempts = [
        ['POST', '/api/auth/login', null, { username: bob.n, password: bob.ident.password }],
        ['POST', '/api/auth/login', null, { username: bob.n, auth_key: authKey, password: bob.ident.password }],
        ['POST', '/api/auth/register', null, { username: 'rawpw', email: 'rawpw@example.test', password: 'raw-password-1' }],
        ['POST', '/api/auth/register', null, { username: 'rawpw', email: 'rawpw@example.test', auth_key: authKey, kdf_salt: salt, kdf_iterations: 600000, password: 'x' }],
        ['PUT', '/api/me/password', bob.ident.token, { current_password: 'a', new_password: 'bbbbbb' }],
        ['POST', '/api/admin/users', bob.ident.token, { username: 'rawpw2', email: 'rawpw2@example.test', password: 'raw-password-1', is_admin: false }],
        ['POST', '/api/settings/2fa/email/enable', bob.ident.token, { current_password: 'x' }],
        ['POST', '/api/settings/2fa/email/disable', bob.ident.token, { current_password: 'x' }],
    ];

    for (const [m, path, token, body] of attempts) {
        const r = await http(S, token, m, path, body);
        assert.equal(r.status, 400, `${m} ${path} ${JSON.stringify(Object.keys(body))}: ${JSON.stringify(r)}`);
        assert.ok(!r.body?.token, 'no session issued');
    }
    assert.equal(S.server.db.prepare("SELECT COUNT(*) c FROM users WHERE username LIKE 'rawpw%'").get().c, 0);
});

test('F12-e: the 600,000-iteration floor is enforced by the server and by the client', async () => {
    const S = await scenario();
    const { bob } = S.users;
    const salt = browser.generateKdfSalt();
    const { authKey } = await browser.deriveCredentials('another-long-password', salt, 600000);

    // (registration is validated by the service; the HTTP register route is rate limited per IP)
    const { registerUser } = require('../../services/auth.service');
    const reg = (extra) => registerUser('weak_kdf', 'weak_kdf@example.test', ...[extra.auth_key ?? authKey, extra.kdf_salt ?? salt, extra.kdf_iterations ?? 600000]);
    for (const bad of [{ kdf_iterations: 599999 }, { kdf_iterations: 100000 }, { kdf_salt: 'AAAA' }, { auth_key: 'short' }, { auth_key: 'a'.repeat(44) }]) {
        await assert.rejects(() => reg(bad), (e) => e.code === 'INVALID_CREDENTIALS', JSON.stringify(Object.keys(bad)));
    }
    assert.equal(S.server.db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'weak_kdf'").get().c, 0);

    // identity PUT: old version / weak KDF / wrong salt are refused
    const row = S.server.db.prepare('SELECT * FROM identity_keys WHERE user_id = ?').get(bob.ident.id);
    const good = { publicKey: row.public_key, encryptedPrivateKey: row.encrypted_private_key, kdf: row.kdf, kdfParams: JSON.parse(row.kdf_params), salt: row.salt, iv: row.iv, version: 2 };
    assert.equal((await http(S, bob.ident.token, 'PUT', '/api/me/identity-key', good)).status, 200, 'control');
    for (const [label, bad] of [
        ['version 1', { ...good, version: 1 }],
        ['old kdf name', { ...good, kdf: 'PBKDF2-SHA-256' }],
        ['100k iterations', { ...good, kdfParams: { iterations: 100000, hash: 'SHA-256' } }],
        ['foreign salt', { ...good, salt: browser.generateKdfSalt() }],
    ]) {
        assert.equal((await http(S, bob.ident.token, 'PUT', '/api/me/identity-key', bad)).status, 400, label);
    }

    // The client never lets the server talk it into a cheaper KDF.
    await assert.rejects(() => browser.deriveCredentials('pw', salt, 1000), /weaker/i);
    bob.actor.use();
    const mod = await bob.actor.importModule('crypto/account-kdf.js');
    // (a hostile server answering kdf-params with 1 iteration, then with an old-style 100k)
    for (const iterations of [1, 100000, 599999]) {
        bob.actor.respondNext('GET', /\/api\/auth\/kdf-params/, { json: { salt, iterations } });
        await assert.rejects(() => mod.fetchPublicKdfParams('anyone'), /weaker|KDF/i, `iterations=${iterations}`);
    }
    bob.actor.respondNext('GET', /\/api\/auth\/kdf-params/, { json: { salt, iterations: 600000 } });
    assert.deepEqual(await mod.fetchPublicKdfParams('anyone'), { salt, iterations: 600000 }, 'control: a proper answer is accepted');
});

test('F12-f: kdf-params does not reveal which usernames exist', async () => {
    const S = await scenario();
    const { alice } = S.users;
    const get = async (u) => (await globalThis.__nodeFetch(`${S.server.origin}/api/auth/kdf-params?username=${encodeURIComponent(u)}`)).json();

    const real = await get(alice.n);
    const ghost1 = await get('nobody_here_1');
    const ghost1again = await get('nobody_here_1');
    const ghost2 = await get('nobody_here_2');

    for (const r of [real, ghost1, ghost2]) {
        assert.deepEqual(Object.keys(r).sort(), ['iterations', 'salt']);
        assert.equal(r.iterations, 600000);
        assert.match(r.salt, /^[A-Za-z0-9+/]{22}==$/);
    }
    assert.deepEqual(ghost1, ghost1again, 'a fake salt is stable (not random per call, which would give it away)');
    assert.notEqual(ghost1.salt, ghost2.salt);
    assert.notEqual(real.salt, ghost1.salt);
    assert.equal((await globalThis.__nodeFetch(`${S.server.origin}/api/auth/kdf-params`)).status, 400);
});

test('F12-g: password change re-wraps the SAME identity: new password works, old one and old wrapKey do not', async () => {
    const S = await scenario();
    const { carol } = S.users;
    const NEW = 'carols-brand-new-passphrase-9';
    const before = S.server.db.prepare('SELECT * FROM identity_keys WHERE user_id = ?').get(carol.ident.id);
    const uBefore = S.server.db.prepare('SELECT kdf_salt, password_hash FROM users WHERE username = ?').get(carol.n);

    // wrong current password is refused and changes nothing
    const p0 = await S.restartProcess(carol);
    p0.actor.use();
    const a0 = await p0.actor.importModule('core/auth.js');
    const i0 = await p0.actor.importModule('crypto/identity-service.js');
    // (the client itself refuses to even prepare a change with a wrong current password)
    await assert.rejects(() => i0.prepareCredentialChange('not-the-current-password', 'zzzzzz-new-zzzzzz', a0.getToken()), /decrypt/i);
    const wrongAuth = (await browser.deriveCredentials('not-the-current-password', uBefore.kdf_salt, 600000)).authKey;
    const goodFirst = await i0.prepareCredentialChange(carol.ident.password, NEW, a0.getToken());
    const rej = await http(S, a0.getToken(), 'PUT', '/api/me/password', { ...goodFirst, current_auth_key: wrongAuth });
    assert.equal(rej.status, 401);
    assert.equal(S.server.db.prepare('SELECT encrypted_private_key FROM identity_keys WHERE user_id = ?').get(carol.ident.id).encrypted_private_key, before.encrypted_private_key);

    // a payload whose identity was wrapped under a different salt than the one being stored is refused
    const good = goodFirst;
    const forged = { ...good, identity: { ...good.identity, salt: browser.generateKdfSalt() } };
    assert.equal((await http(S, a0.getToken(), 'PUT', '/api/me/password', forged)).status, 400);
    assert.equal(S.server.db.prepare('SELECT password_hash FROM users WHERE username = ?').get(carol.n).password_hash, uBefore.password_hash, 'nothing changed');

    // the real change
    const ok = await http(S, a0.getToken(), 'PUT', '/api/me/password', good);
    assert.equal(ok.status, 200, JSON.stringify(ok));

    // old password no longer logs in
    const p1 = await S.restartProcess({ ...carol, ident: { ...carol.ident, password: NEW } }).catch(() => null);
    assert.ok(p1, 'a new process can sign in with the NEW password and restore the identity');
    p1.actor.use();
    const ident = (await p1.actor.importModule('crypto/identity-service.js')).getCurrentIdentity();
    assert.equal(ident.publicKey, before.public_key, 'the X25519 identity (public key) did not change');

    const p2 = await createProbe(S, carol);
    await assert.rejects(() => p2.auth.login(carol.n, carol.ident.password), 'old password rejected');
    await p2.auth.login(carol.n, NEW);
    await assert.rejects(() => p2.auth.initializeIdentity('not-the-password-at-all'), /decrypt/i);

    // stored state moved with the password
    const after = S.server.db.prepare('SELECT * FROM identity_keys WHERE user_id = ?').get(carol.ident.id);
    const uAfter = S.server.db.prepare('SELECT kdf_salt, password_hash FROM users WHERE username = ?').get(carol.n);
    assert.notEqual(after.encrypted_private_key, before.encrypted_private_key);
    assert.notEqual(uAfter.kdf_salt, uBefore.kdf_salt, 'fresh salt on every password change');
    assert.equal(after.salt, uAfter.kdf_salt, 'identity wrapped under the account salt');
    assert.notEqual(uAfter.password_hash, uBefore.password_hash);

    // old wrapKey (old password + old salt) cannot decrypt the new ciphertext
    const oldWrap = sc.deriveCredentialsNode(carol.ident.password, before.salt, 600000).wrapKey;
    const k = await crypto.subtle.importKey('raw', oldWrap, { name: 'AES-GCM' }, false, ['decrypt']);
    await assert.rejects(() => crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(after.iv, 'base64') }, k, Buffer.from(after.encrypted_private_key, 'base64')));
});

/** A fresh browser profile on the server, signed out (no identity unlock). */
async function createProbe(S, u) {
    const { createBrowserActor } = await import('./_browser-actor.mjs');
    const actor = createBrowserActor(`probe-${Math.random().toString(16).slice(2)}`, S.server.origin);
    actor.use();
    const auth = await actor.importModule('core/auth.js');
    return { actor, auth };
}

test('F12-h: "remember me" auto-unlock works with the v2 identity and a cached wrapKey, and never needs the password', async () => {
    const S = await scenario();
    const { bob } = S.users;
    const row = S.server.db.prepare('SELECT * FROM identity_keys WHERE user_id = ?').get(bob.ident.id);

    // What the shell caches after a password login: the raw wrapKey, base64 (stays on the device).
    const probe0 = await createProbe(S, bob);
    probe0.actor.use();
    const identityMod = await probe0.actor.importModule('crypto/identity.js');
    const unlockKey = await identityMod.deriveIdentityUnlockKey(bob.ident.password, row.salt, JSON.parse(row.kdf_params));
    assert.equal(Buffer.from(unlockKey, 'base64').toString('hex'), secretsOf(S, bob).wrapKey.toString('hex'), 'the cached unlock key IS the wrapKey');

    // A new launch: sign in (authKey only), then unlock with the cached key instead of the password.
    const p = await createProbe(S, bob);
    await p.auth.login(bob.n, bob.ident.password);
    const idsvc = await p.actor.importModule('crypto/identity-service.js');
    await idsvc.restoreIdentityWithUnlockKey(unlockKey, p.auth.getToken());
    assert.equal(idsvc.getCurrentIdentity().publicKey, row.public_key);

    // A wrong cached key fails cleanly.
    const q = await createProbe(S, bob);
    await q.auth.login(bob.n, bob.ident.password);
    const idsvc2 = await q.actor.importModule('crypto/identity-service.js');
    await assert.rejects(() => idsvc2.restoreIdentityWithUnlockKey(Buffer.alloc(32, 7).toString('base64'), q.auth.getToken()));
});
