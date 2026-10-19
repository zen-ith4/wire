// tests/dm-v2-protocol-e2e.test.mjs
//
// STEP 1D: protocol-level E2E without a browser. Real server, real client
// crypto modules, plain node. No UI rendering is claimed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { Database, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';
import { makeServerDirs, serverEnv } from './_acceptance-harness.mjs';
import { ROOT } from './_acceptance-harness.mjs';

// ---- shims ----
const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
const ss = new Map();
globalThis.sessionStorage = { getItem: (k) => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: (k) => ss.delete(k), clear: () => ss.clear() };
const stores = new Map();
const store = (n) => { if (!stores.has(n)) stores.set(n, new Map()); return stores.get(n); };
const request = (r) => { const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: r }; queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); }); return req; };
const fakeDb = (name) => ({ name, objectStoreNames: { contains: (n) => n === 'peer-pins' }, transaction(sn, mode) { const data = store(sn); const tx = { oncomplete: null, onerror: null, objectStore() { return { put(v, k) { if (mode === 'readwrite') data.set(k, v); return request(undefined); }, get(k) { const req = request(data.get(k)); queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); }); return req; }, delete(k) { if (mode === 'readwrite') data.delete(k); return request(undefined); } }; } }; queueMicrotask(() => queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); })); return tx; } });
globalThis.indexedDB = { open: (name) => { const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null }; queueMicrotask(() => { req.result = fakeDb(name); if (req.onupgradeneeded) req.onupgradeneeded({ target: req }); if (req.onsuccess) req.onsuccess({ target: req }); }); return req; } };
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.window = { location: { origin: 'http://127.0.0.1:39999' }, Capacitor: { isNativePlatform: () => true } };

let server = null;
let serverOrigin = null;
let dbPath = null;
let dir = null;
let client = null;

before(async () => {
    dir = tmpDir();
    dbPath = path.join(dir, 'wire.db');
    fs.copyFileSync(FIXTURE_DB, dbPath);
    const { runMigrations } = await import('../database/migrations.js');
    const db0 = new Database(dbPath, { readonly: false });
    runMigrations(db0);
    db0.close();
    const script = path.join(ROOT, 'scripts', 'dm-e2ee-optin.mjs');
    spawnSync(process.execPath, [script, 'bob'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });

    const dirs = makeServerDirs(dir);
    const port = 39500 + Math.floor(Math.random() * 100);
    const env = serverEnv({ dirs, port, nodeEnv: 'test', jwtSecret: 'x'.repeat(48), dmE2eeDefaultMinVersion: 2, extraEnv: { DB_PATH: dbPath, BCRYPT_ROUNDS: '4', ALLOWED_SUBNET: '127.0.0.0/8' } });
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const ok = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 30000);
        const iv = setInterval(() => { if (out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); resolve(true); } }, 50);
        child.once('exit', () => { clearTimeout(t); clearInterval(iv); resolve(out.includes('started successfully')); });
    });
    if (!ok) throw new Error('server did not start:\n' + out.slice(-400));
    serverOrigin = `http://127.0.0.1:${port}`;
    server = { child, stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }) };
    ls.set('wire_server_endpoint', serverOrigin);
    globalThis.window.location.origin = serverOrigin;

    client = {
        auth: await import('../public/js/core/auth.js'),
        server: await import('../public/js/core/server.js'),
        identity: await import('../public/js/crypto/identity-service.js'),
        peerKeys: await import('../public/js/crypto/keys/peer-keys.js'),
        messageCrypto: await import('../public/js/crypto/messages/message-crypto.js'),
        payload: await import('../public/js/crypto/messages/payload.js'),
        dmV2: await import('../public/js/crypto/messages/dm-v2.js'),
        dmV2Wire: await import('../public/js/crypto/messages/dm-v2-wire.js'),
    };
});

after(async () => {
    if (server) await server.stop();
    cleanupTmp();
});

async function restLogin(username, password) {
    const r = await fetch(serverOrigin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const body = await r.json();
    return { status: r.status, token: body.token, id: (body.user || body).id, body };
}

async function unlock(username, password) {
    const login = await restLogin(username, password);
    if (!login.token) throw new Error('login failed: ' + JSON.stringify(login.body));
    try { client.identity.lockIdentity(); } catch {}
    client.auth.setToken(login.token);
    client.auth.setCurrentUser({ id: login.id, groups_enabled: true });
    await client.identity.restoreIdentity(password, login.token);
    return login;
}

// Scenario 1
test('1. new account is 2; v1-created (fixture) is 1', async () => {
    const reg = await fetch(serverOrigin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'proto-new2', email: 'p2@x.invalid', password: 'Passw0rd!x' }) });
    assert.equal(reg.status, 201);
    const regBody = await reg.json();
    const uid = regBody.user?.id || regBody.id;
    const db = new Database(dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT dm_e2ee_min_version FROM users WHERE id = ?').get(uid).dm_e2ee_min_version, 2);
    assert.equal(db.prepare('SELECT dm_e2ee_min_version FROM users WHERE id = ?').get(2).dm_e2ee_min_version, 1); // alice fixture
    db.close();
});

// Scenario 4
test('4. v2 send to min-1 recipient refused; v1 accepted', async () => {
    let s = await restLogin('sender2', 'Passw0rd!x');
    if (!s.token) {
        await fetch(serverOrigin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sender2', email: 's2@x.invalid', password: 'Passw0rd!x' }) });
        s = await restLogin('sender2', 'Passw0rd!x');
    }
    const v2env = JSON.stringify({ encryption: { version: 2, algorithm: 'AES-GCM', iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.from('aabb', 'hex').toString('base64'), senderFp: Buffer.alloc(32).toString('base64'), msgId: '0123456789abcdef' }, senderId: s.id, recipientId: 2 });
    const r = await fetch(serverOrigin + '/api/dm/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token }, body: JSON.stringify({ recipient_id: 2, content: v2env }) });
    assert.equal(r.status, 400);
    const v1env = JSON.stringify({ encryption: { version: 1, algorithm: 'AES-GCM', iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.from('aabb', 'hex').toString('base64') }, senderId: s.id, recipientId: 2 });
    const r2 = await fetch(serverOrigin + '/api/dm/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token }, body: JSON.stringify({ recipient_id: 2, content: v1env }) });
    assert.equal(r2.status, 200);
});

// Scenarios 5-8: tamper detection.
//
// HOW THESE ENVELOPES ARE PRODUCED (asked for in STEP 1F section 3.1):
// with **dm-v2.js primitives under plain node** - `encryptDmV2()` over a real
// `deriveDmV2Key()` X25519/HKDF key, freshly generated per run. NOT the real
// `encryptDmTextV2()` + real send route, which cannot run here: restoring an
// identity needs a password-change token that only the browser migration flow
// mints (the blocker behind scenarios 2/3/10). So these prove the CRYPTOGRAPHIC
// BINDING, not the client wiring; the wiring is proven by
// dm-v2-wire-browser-paths.test.mjs (e), which runs the real composer.
//
// WHY THE POSITIVE CONTROL MATTERS: an assertion that "tampering is rejected"
// can be true for the wrong reason - a malformed envelope, a missing key, or a
// test that would have thrown anyway. So every test here first asserts the
// UNTOUCHED envelope decrypts to the EXACT plaintext, and only then tampers.

/** Fresh X25519 pair + the directional v2 key + the sender fingerprint. */
async function realV2Keypair() {
    const a = await crypto.webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const b = await crypto.webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const rawA = new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', a.publicKey));
    const key = await client.dmV2.deriveDmV2Key(2, 3, a.privateKey, b.publicKey);
    return { key, fp: await client.dmV2.senderKeyFingerprint(rawA), senderPrivate: a.privateKey, peerPublic: b.publicKey };
}

/** A REAL v2 envelope for the given plaintext. */
async function realEnvelope(plaintext, replyToId = 0) {
    const k = await realV2Keypair();
    const { envelope } = await client.dmV2.encryptDmV2({
        plaintext, fromUserId: 2, toUserId: 3, senderKeyFp: k.fp, key: k.key, replyToId
    });
    return { envelope, k, replyToId };
}

/**
 * The failure must be the AEAD binding failing, not some incidental error.
 *
 * "Unsupported encryption version" / "Missing encryption payload" / "Invalid
 * Base64" are SHAPE errors: they would fire on an envelope that never had a
 * chance of decrypting, which is exactly what makes a tamper test vacuous. A
 * genuine tamper reaches crypto.subtle.decrypt() with a well-formed envelope and
 * a key, and dies on the authentication tag - a DOMException named
 * OperationError. Anything else is a broken test, not a working ratchet.
 */
function assertAuthenticationFailure(err) {
    const shape = client.dmV2.DmV2ValidationError ? err instanceof client.dmV2.DmV2ValidationError : false;
    assert.equal(shape, false,
        `the tamper died on a SHAPE error, not the authentication tag: ${err.name}: ${err.message}`);
    assert.equal(err.name, 'OperationError',
        `expected the AEAD authentication tag to fail, got ${err.name}: ${err.message}`);
}

// Scenario 5
test('5. server strips version 2->1: validation fails', async () => {
    const env = { encryption: { version: 1, algorithm: 'AES-GCM', iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.from('aabb', 'hex').toString('base64'), senderFp: Buffer.alloc(32).toString('base64'), msgId: '0123456789abcdef' }, senderId: 2, recipientId: 3 };
    assert.throws(() => client.dmV2.validateDmV2Envelope(env), /Unsupported encryption version/);

    // POSITIVE CONTROL: a REAL v2 envelope round-trips to the exact plaintext.
    const { envelope, k } = await realEnvelope('strip me');
    assert.equal(
        await client.dmV2.decryptDmV2({ envelope, senderKeyFp: k.fp, key: k.key, replyToId: 0 }),
        'strip me',
        'the untouched real envelope must decrypt, or the assertion below is vacuous'
    );

    // TAMPER: change ONLY encryption.version, 2 -> 1. Everything else is the
    // same object, so the rejection cannot be attributed to anything else.
    const stripped = structuredClone(envelope);
    stripped.encryption.version = 1;
    assert.throws(
        () => client.dmV2.validateDmV2Envelope(stripped),
        (e) => e.name === 'DmV2ValidationError' && /Unsupported encryption version/.test(e.message),
        'a version strip must be refused as an unsupported version'
    );
    // And it must be refused as a VERSION problem, not as malformed JSON or a
    // missing key - those would make the test pass for the wrong reason.
    // assert.throws() returns undefined, so the error is captured by hand.
    let why = null;
    try {
        client.dmV2.validateDmV2Envelope(stripped);
    } catch (e) {
        why = e;
    }
    assert.ok(why, 'the version strip must be refused');
    assert.equal(why.name, 'DmV2ValidationError');
    assert.ok(/Unsupported encryption version/.test(why.message),
        `the refusal must name the version: ${why.message}`);
    assert.ok(!/Base64|is required|expected bytes/.test(why.message),
        `the refusal must not be a shape problem: ${why.message}`);
});

// Scenario 6
test('6. server rewrites senderId: AAD differs', async () => {
    const iv = new Uint8Array(12);
    const fp = new Uint8Array(32);
    const a = client.dmV2.dmMessageAad({ version: 2, fromUserId: 2, toUserId: 9, senderKeyFp: fp, direction: 'a2b', iv, replyToId: 0 });
    const b = client.dmV2.dmMessageAad({ version: 2, fromUserId: 5, toUserId: 9, senderKeyFp: fp, direction: 'a2b', iv, replyToId: 0 });
    assert.notDeepEqual(a, b);

    // POSITIVE CONTROL
    const { envelope, k } = await realEnvelope('senderId tamper');
    assert.equal(
        await client.dmV2.decryptDmV2({ envelope, senderKeyFp: k.fp, key: k.key, replyToId: 0 }),
        'senderId tamper'
    );

    // TAMPER: rewrite senderId only. The AAD commits to the sender, so the tag
    // must fail - and it must fail on the TAG, not on a shape check.
    const rewritten = structuredClone(envelope);
    rewritten.senderId = 5;
    await assert.rejects(
        () => client.dmV2.decryptDmV2({ envelope: rewritten, senderKeyFp: k.fp, key: k.key, replyToId: 0 }),
        (e) => { assertAuthenticationFailure(e); return true; }
    );
});

// Scenario 7
test('7. server rewrites recipientId: AAD differs', async () => {
    const iv = new Uint8Array(12);
    const fp = new Uint8Array(32);
    const a = client.dmV2.dmMessageAad({ version: 2, fromUserId: 2, toUserId: 3, senderKeyFp: fp, direction: 'a2b', iv, replyToId: 0 });
    const b = client.dmV2.dmMessageAad({ version: 2, fromUserId: 2, toUserId: 99, senderKeyFp: fp, direction: 'a2b', iv, replyToId: 0 });
    assert.notDeepEqual(a, b);

    // POSITIVE CONTROL
    const { envelope, k } = await realEnvelope('recipientId tamper');
    assert.equal(
        await client.dmV2.decryptDmV2({ envelope, senderKeyFp: k.fp, key: k.key, replyToId: 0 }),
        'recipientId tamper'
    );

    // TAMPER: rewrite recipientId only. This also FLIPS the direction label, so
    // both the recipient and the derived-key direction are wrong: the tag must
    // still be what rejects it.
    const rewritten = structuredClone(envelope);
    rewritten.recipientId = 99;
    await assert.rejects(
        () => client.dmV2.decryptDmV2({ envelope: rewritten, senderKeyFp: k.fp, key: k.key, replyToId: 0 }),
        (e) => { assertAuthenticationFailure(e); return true; }
    );
});

// Scenario 8
test('8. server changes reply_to_id: AAD differs', async () => {
    const iv = new Uint8Array(12);
    const fp = new Uint8Array(32);
    const a = client.dmV2.dmMessageAad({ version: 2, fromUserId: 2, toUserId: 3, senderKeyFp: fp, direction: 'a2b', iv, replyToId: 0 });
    const b = client.dmV2.dmMessageAad({ version: 2, fromUserId: 2, toUserId: 3, senderKeyFp: fp, direction: 'a2b', iv, replyToId: 5 });
    assert.notDeepEqual(a, b);

    // POSITIVE CONTROL
    const { envelope, k } = await realEnvelope('replyToId tamper', 0);
    assert.equal(
        await client.dmV2.decryptDmV2({ envelope, senderKeyFp: k.fp, key: k.key, replyToId: 0 }),
        'replyToId tamper'
    );

    // TAMPER: the row's reply_to_id changes, so the caller now decrypts with a
    // different replyToId. The envelope bytes are untouched - the binding that
    // breaks is the one between the stored row and the AAD, which is the whole
    // point of putting replyToId in the AAD.
    await assert.rejects(
        () => client.dmV2.decryptDmV2({ envelope, senderKeyFp: k.fp, key: k.key, replyToId: 5 }),
        (e) => { assertAuthenticationFailure(e); return true; }
    );

    // A non-zero replyToId the sender really used must decrypt with that SAME
    // value, so the test above is "the value matters", not "non-zero fails".
    const withReply = await realEnvelope('has a reply', 11);
    assert.equal(
        await client.dmV2.decryptDmV2({ envelope: withReply.envelope, senderKeyFp: withReply.k.fp, key: withReply.k.key, replyToId: 11 }),
        'has a reply'
    );
});

// Scenario 9
test('9. replay: same iv on new row dropped; same row twice not replay', () => {
    client.dmV2Wire.resetDmDowngradeNotices();
    // reset replay store by clearing localStorage
    ls.clear();
    const iv = Buffer.alloc(12, 9).toString('base64');
    assert.equal(client.dmV2Wire.classifyDmV2Iv(3, iv, 100), 'new');
    assert.equal(client.dmV2Wire.classifyDmV2Iv(3, iv, 100), 'same-row');
    assert.equal(client.dmV2Wire.classifyDmV2Iv(3, iv, 101), 'replay');
});

// Scenario 11
test('11. downgrade pin: v1 send to pinned-2 peer throws DmDowngradeRefusedError', () => {
    ls.clear();
    client.auth.setCurrentUser({ id: 9, groups_enabled: true });
    globalThis.window.location.origin = serverOrigin;
    client.dmV2Wire.noteDmV2Version(3, 2);
    assert.throws(() => client.dmV2Wire.assertDmVersionAllowed(3, 1), (e) => e && e.code === 'DM_DOWNGRADE_REFUSED');
});

// Scenario 12
test('12. size guard: envelope > 2000 chars refused client-side', () => {
    assert.throws(() => client.dmV2Wire.assertDmV2ContentFits(2001), (e) => e && e.code === 'DM_V2_TOO_LARGE');
    assert.equal(client.dmV2Wire.assertDmV2ContentFits(2000), 2000);
});

// Scenario 2 & 3: v2 end to end + replyToId stability
test('2+3. v2 end to end + replyToId stability (real modules, real server)', { skip: 'SUPERSEDED BY THE BROWSER: covered end to end by tests/dm-v2-wire-browser-paths.test.mjs (b) "bob replies through the real composer", with the reply_to_id and the v2 envelope asserted on the STORED row, and by (a) for history after reload. NOT RUN UNDER NODE because restoreIdentity requires a password-change token (authenticatePasswordChange middleware) that only the browser migration flow mints. The crypto primitives are proven by dm-v2.test.mjs, the server rule and replay by dm-v2-wire-server.test.mjs and dm-v2-wire.test.mjs.' }, () => {});

// Scenario 10
test('10. edit: v2 edit produces new msgId, same replyToId', { skip: 'SUPERSEDED BY THE BROWSER: covered end to end by tests/dm-v2-wire-browser-paths.test.mjs (d) "editing a v2 REPLY through the real UI rewrites the envelope with a new msgId and keeps reply_to_id", which edits through window.editDmMessage + window.sendDm and then reads the stored envelope. NOT RUN UNDER NODE because identity unlock needs a password-change token. The replyToId stability is proven by dm-v2.test.mjs AAD tests and the server edit rule by dm-v2-wire-server.test.mjs.' }, () => {});

// Scenario 13
test('13. key rotation between v2 send and read', { skip: 'SUPERSEDED BY THE BROWSER: covered end to end by tests/dm-v2-wire-browser-paths.test.mjs (h) "after bob rotates his identity key the v2 thread holds, alarms, and releasing it keeps the pre-rotation row readable", which rotates through POST /api/me/identity-key/rotate and then reads the row that was encrypted to the RETIRED key. NOT RUN UNDER NODE because identity rotation requires the browser-only credential migration.' }, () => {});