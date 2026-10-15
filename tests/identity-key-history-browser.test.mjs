// tests/identity-key-history-browser.test.mjs
//
// STEP A, end to end, in a real browser: a DM sent BEFORE a peer rotates its
// identity key must still decrypt AFTER the rotation.
//
// This is the only test that exercises the actual client fallback
// (messages/decrypt.js -> keys/session.js -> keys/peer-keys.js) against a real
// server, real WebCrypto and a real HTTP round trip to the key-history endpoint.
//
// WHAT IS AND IS NOT EXERCISED
// Exercised: encryption by the real client, storage by the real server, rotation
// through the real endpoint with the real client crypto, and decryption by the
// real client including the retired-key fallback.
// NOT exercised: the DM UI's rendering of the result. The assertion calls the
// client module directly in the page (decryptIncomingMessage) rather than
// clicking through the conversation view, because the thing under test is the
// key selection, not the rendering.
//
// ACCOUNTS
// Two accounts, one browser PROCESS each (newUserPage), because IndexedDB is per
// profile and two accounts sharing a profile corrupt each other's key rows.
// closeUserBrowsers() in `after`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
    startRealServer,
    registerUser,
    newUserPage,
    closeUserBrowsers,
    loginUi,
    PASSWORD,
} from './_acceptance-harness.mjs';

const ALICE = 'ikh-alice';
const BOB = 'ikh-bob';
const PLAINTEXT = 'sent before the rotation, read after it';

let server = null;
let alice = null;
let bob = null;

/**
 * Rotate BOB's identity key, from inside bob's own page.
 *
 * Everything here is the real client: the real authKey derivation from the real
 * password, the real PKCS#8 export, the real re-wrap under the account's KDF
 * parameters, and the real POST /api/me/identity-key/rotate. Only the browser's
 * "do it now" comes from the test.
 *
 * @returns {Promise<{retired: string, installed: string}>} base64 keys; never
 *   logged, only compared inside the page.
 */
async function rotateIdentityInPage(page) {
    return page.evaluate(async () => {
        const { api } = await import('/js/core/api.js');
        const { deriveCredentials } = await import('/js/crypto/credentials.js');
        const {
            generateIdentityKeyPair,
            exportPublicKey,
            exportPrivateKey,
            encryptIdentityPkcs8,
        } = await import('/js/crypto/identity.js');

        const password = window.__ikhPassword;

        const kdf = await api('/api/me/kdf-params');
        if (kdf.scheme !== 2) throw new Error(`expected scheme 2, got ${kdf.scheme}`);

        const { authKey } = await deriveCredentials(password, kdf.salt, kdf.iterations);

        const before = await api('/api/me/identity-key');
        const keyPair = await generateIdentityKeyPair();
        const publicKeyB64 = await exportPublicKey(keyPair);
        const pkcs8 = await exportPrivateKey(keyPair);

        const wrapped = await encryptIdentityPkcs8(pkcs8, password, {
            salt: kdf.salt,
            iterations: kdf.iterations,
        });
        // encryptIdentityPkcs8 returns only the wrapped half; the rotate
        // endpoint requires publicKey alongside it, same shape
        // credential-migration.js builds.
        const identity = { publicKey: publicKeyB64, ...wrapped };

        // api() THROWS on a non-2xx with the server's message, so capture it rather
        // than letting it escape and hide which field was rejected.
        let res = null;
        let thrown = null;
        try {
            res = await api('/api/me/identity-key/rotate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    current_auth_key: authKey,
                    expected_public_key: before.publicKey,
                    expected_updated_at: before.updatedAt,
                    identity,
                }),
            });
        } catch (e) {
            thrown = String(e && e.message ? e.message : e);
        }

        // Shapes only, never key material: enough to say WHICH field the server
        // rejected without printing a secret.
        const shape = {
            authKeyType: typeof authKey,
            authKeyLen: typeof authKey === 'string' ? authKey.length : -1,
            publicKeyLen: publicKeyB64.length,
            updatedAtType: typeof before.updatedAt,
            updatedAtValue: before.updatedAt,
            identityKeys: Object.keys(identity || {}).sort().join(','),
            identityVersion: identity?.version,
            identityKdf: identity?.kdf,
            identityHasParams: !!identity?.kdfParams,
            identityPublicKeyLen: typeof identity?.publicKey === 'string' ? identity.publicKey.length : -1,
        };

        if (thrown || res?.error) {
            return { error: thrown || JSON.stringify(res), shape };
        }
        return { retired: before.publicKey, installed: publicKeyB64, shape };
    });
}

/** Bob sends one real encrypted DM to alice, over the real endpoint. */
async function bobSendsDm(page, recipientId) {
    return page.evaluate(async (id) => {
        const { encryptOutgoingMessage } = await import('/js/crypto/messages/message-crypto.js');
        const { api } = await import('/js/core/api.js');

        // Same body shape chat/dm.js builds: { recipient_id, content }, where
        // `content` is the encrypted payload STRING (sendMessage does content.trim()).
        const content = await encryptOutgoingMessage(window.__ikhText, window.__ikhMyId, id);
        const res = await api('/api/dm/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient_id: id, content: JSON.stringify(content) }),
        });
        return { id: res?.id, error: res?.error || null };
    }, recipientId);
}

/** Alice tries to decrypt one stored row, in her own page, using the real client. */
async function aliceDecrypts(page, bobId, messageId) {
    return page.evaluate(async (peerId, msgId) => {
        const { api } = await import('/js/core/api.js');
        const { decryptIncomingMessage } = await import('/js/crypto/messages/message-crypto.js');

        const res = await api(`/api/dm/messages/${peerId}/recent`);
        const rows = Array.isArray(res) ? res : (res?.messages || res?.items || []);
        const row = rows.find((r) => Number(r.id) === Number(msgId));

        if (!row) {
            return { found: false, ids: rows.map((r) => r.id) };
        }

        // Diagnostics for a failure message: SHAPES only, never key bytes.
        let diag = null;
        try {
            // chat/dm.js parses the stored string into a payload before handing
            // it to decryptIncomingMessage; same here.
            const payload = JSON.parse(row.content);

            try {
                const hist = await api(`/api/me/identity-key-history/${peerId}`);
                diag = {
                    historyLen: Array.isArray(hist?.history) ? hist.history.length : -1,
                    hasCurrent: !!hist?.current,
                    historyKeyLens: Array.isArray(hist?.history)
                        ? hist.history.map((k) => (typeof k.publicKey === 'string' ? k.publicKey.length : -1))
                        : null,
                };
            } catch (e) {
                diag = { historyFetchError: String(e && e.message ? e.message : e) };
            }

            const text = await decryptIncomingMessage(payload, peerId);
            return { found: true, ok: true, text, diag };
        } catch (e) {
            // Probe the internals so a failure says WHICH stage broke.
            const probe = { error: String(e && e.message ? e.message : e) };
            try {
                const { getSessionKeyCandidates } = await import('/js/crypto/keys/session.js');
                const { getPeerKeyCandidates } = await import('/js/crypto/keys/peer-keys.js');
                const { getCurrentIdentity } = await import('/js/crypto/identity-service.js');

                const ident = getCurrentIdentity();
                probe.identityUnlocked = !!(ident && ident.privateKey);

                const kc = await getPeerKeyCandidates(peerId);
                probe.keyCandidates = {
                    currentLen: typeof kc.current === 'string' ? kc.current.length : -1,
                    historyLen: kc.history.length,
                };

                // What does the retired-key rule actually decide, and why?
                const { mayTryRetiredKey, getPeerPin } = await import('/js/crypto/keys/peer-trust.js');
                const { getServerEndpoint } = await import('/js/core/server.js');
                const { getCurrentUser } = await import('/js/core/auth.js');
                const context = { origin: String(getServerEndpoint()), ownUserId: Number(getCurrentUser()?.id) };
                probe.context = { originOk: !!context.origin, ownUserId: context.ownUserId };

                let pin = null;
                try {
                    pin = await getPeerPin(peerId, context);
                } catch (e) {
                    probe.pinError = String(e && e.message ? e.message : e);
                }
                probe.pin = pin
                    ? { current: pin.current?.fingerprint?.length, acceptedCount: (pin.accepted || []).length }
                    : null;

                if (kc.history.length) {
                    try {
                        const v = await mayTryRetiredKey(peerId, kc.history[0], context);
                        probe.verdict = { allowed: v.allowed, reason: v.reason };
                    } catch (e) {
                        probe.verdictError = String(e && e.message ? e.message : e);
                    }
                }

                probe.sessionCandidates =
                    (await getSessionKeyCandidates(peerId)).length;
            } catch (pe) {
                probe.probeError = String(pe && pe.message ? pe.message : pe);
            }
            return { found: true, ok: false, error: String(e && e.message ? e.message : e), diag, probe };
        }
    }, bobId, messageId);
}

after(async () => {
    await closeUserBrowsers();
    if (server) await server.stop().catch(() => {});
});

test('a DM sent before a peer rotates its key still decrypts afterwards', async (t) => {
    server = await startRealServer({ extraEnv: { GROUPS_ENABLED: 'true' } });

    await registerUser(server.origin, ALICE);
    await registerUser(server.origin, BOB);

    const a = await newUserPage();
    const b = await newUserPage();
    alice = a.page;
    bob = b.page;

    await loginUi(alice, server.origin, ALICE);
    await loginUi(bob, server.origin, BOB);

    // bob's page needs the password later, to derive his own authKey for the
    // rotation. Set it now; it is never read outside bob's page.
    await bob.evaluate((pw) => { window.__ikhPassword = pw; }, PASSWORD);
    await bob.evaluate((id) => { window.__ikhMyId = id; }, await bob.evaluate(async () => {
        const { api } = await import('/js/core/api.js');
        const me = await api('/api/me/');
        return (me.user || me).id;
    }));
    await bob.evaluate((t2) => { window.__ikhText = t2; }, PLAINTEXT);

    // 1. bob sends the message, sealed to the key he is about to replace.
    const aliceId = await alice.evaluate(async () => {
        const { api } = await import('/js/core/api.js');
        const me = await api('/api/me/');
        return (me.user || me).id;
    });

    const sent = await bobSendsDm(bob, aliceId);

    assert.equal(sent.error, null, `send failed: ${JSON.stringify(sent.error)}`);
    assert.ok(sent.id, 'the message must be stored with an id');

    const bobId = await bob.evaluate(async () => {
        const { api } = await import('/js/core/api.js');
        const me = await api('/api/me/');
        return (me.user || me).id;
    });

    // 2. sanity: alice can read it while bob's key is still current.
    const before = await aliceDecrypts(alice, bobId, sent.id);
    assert.equal(before.found, true, `the row must be visible: ${JSON.stringify(before)}`);
    assert.equal(before.ok, true, `alice must decrypt it before the rotation: ${before.error}`);
    assert.equal(before.text, PLAINTEXT);

    // Record which public key bob was actually using for that message, so the
    // archive can be checked against it afterwards.
    const bobKeyBefore = await alice.evaluate(async (id) => {
        const { api } = await import('/js/core/api.js');
        const d = await api(`/api/me/identity-key/${id}`);
        return d?.publicKey || null;
    }, bobId);
    assert.ok(bobKeyBefore, 'must be able to read bob current public key');

    // 3. bob rotates through the real endpoint.
    const rotated = await rotateIdentityInPage(bob);
    assert.ok(!rotated.error,
        `rotation must succeed; server said ${rotated.error} - shapes: ${JSON.stringify(rotated.shape)}`);
    assert.ok(rotated.retired && rotated.installed, 'rotation must report both keys');
    assert.notEqual(rotated.retired, rotated.installed, 'the new key must differ from the old');

    // 4. RELOAD alice's page and log her in again.
    //
    //    This step is load-bearing and an earlier version of this test omitted
    //    it, which made the test pass for the wrong reason: alice's session-key
    //    cache still held the key derived from bob's ORIGINAL public key, so
    //    the old message decrypted with no fallback at all. A real user opens
    //    the conversation after the rotation with a client that has only ever
    //    seen the NEW key, which is the situation this feature exists for.
    await alice.reload({ waitUntil: 'domcontentloaded' });
    await loginUi(alice, server.origin, ALICE);

    // 5. alice reads the SAME row again. This is the assertion that matters: the
    //    retired-key fallback has to find bob's previous public key and use it.
    const after = await aliceDecrypts(alice, bobId, sent.id);
    assert.equal(after.found, true, 'the row must still be visible');
    assert.equal(after.ok, true,
        `alice must still decrypt after bob rotated (got: ${after.error}). ` +
        `diag: ${JSON.stringify(after.diag)} probe: ${JSON.stringify(after.probe)}. ` +
        `This is the retired-key fallback in messages/decrypt.js.`);
    assert.equal(after.text, PLAINTEXT, 'the plaintext must be identical');

    // 5b. and the archive really does hold the key that message was sealed to.
    const archive = await alice.evaluate(async (id) => {
        const { api } = await import('/js/core/api.js');
        const h = await api(`/api/me/identity-key-history/${id}`);
        return { current: h?.current?.publicKey, history: (h?.history || []).map((k) => k.publicKey) };
    }, bobId);

    assert.ok(archive.history.includes(bobKeyBefore),
        `the archive must hold the exact key the old message was sealed to. ` +
        `sealed-to-len=${bobKeyBefore && bobKeyBefore.length} archive-history-lens=${JSON.stringify(archive.history.map((k) => k.length))}`);
    assert.notEqual(archive.current, bobKeyBefore, 'the current key must be the new one');

    // 5. a NEW message sent after the rotation uses the current key and still
    //    decrypts, so the fallback did not break the ordinary path.
    const second = 'sent after the rotation';
    await bob.evaluate((text) => { window.__ikhText = text; }, second);
    const sent2 = await bobSendsDm(bob, aliceId);
    assert.equal(sent2.error, null, `second send failed: ${JSON.stringify(sent2.error)}`);

    const afterNew = await aliceDecrypts(alice, bobId, sent2.id);
    assert.equal(afterNew.ok, true, `alice must decrypt the NEW message: ${afterNew.error}`);
    assert.equal(afterNew.text, second);

    // 6. and the OLD row must still decrypt too, now that the fallback has run
    //    once, so the cached candidate path is exercised as well.
    const afterOld = await aliceDecrypts(alice, bobId, sent.id);
    assert.equal(afterOld.ok, true, `the old row must still decrypt: ${afterOld.error}`);
    assert.equal(afterOld.text, PLAINTEXT);
});