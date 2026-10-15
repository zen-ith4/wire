// tests/peer-trust-browser.test.mjs
//
// Phase 2, end to end, in a real browser: a peer rotates its identity key and
// the user is stopped, warned, and loses nothing when they accept.
//
// Two accounts, ONE BROWSER PROCESS EACH (newUserPage), because IndexedDB is
// per profile and the pin store is keyed by (origin, ownUserId, peerId) — two
// accounts sharing a profile would read each other's pins.
//
// RELOAD + RE-LOGIN BETWEEN STEPS is load-bearing. Without it a page's cached
// session key and already-resolved trust state hide the behaviour under test.
// (The same trap made the v15 key-archive test pass for the wrong reason.)

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

const ALICE = 'pt-alice';
const BOB = 'pt-bob';

let server = null;

after(async () => {
    await closeUserBrowsers();
    if (server) await server.stop().catch(() => {});
});

/** Set the page-local helpers the rotation and send flows read. */
async function primePage(page, text) {
    await page.evaluate((pw) => { window.__ptPassword = pw; }, PASSWORD);
    await page.evaluate(async () => {
        const { api } = await import('/js/core/api.js');
        const me = await api('/api/me/');
        window.__ptMeId = (me.user || me).id;
    });
    if (text !== undefined) {
        await page.evaluate((t) => { window.__ptText = t; }, text);
    }
}

/** Rotate this page's account's identity key, through the real endpoint. */
async function rotateInPage(page) {
    return page.evaluate(async () => {
        const { api } = await import('/js/core/api.js');
        const { deriveCredentials } = await import('/js/crypto/credentials.js');
        const {
            generateIdentityKeyPair,
            exportPublicKey,
            exportPrivateKey,
            encryptIdentityPkcs8,
        } = await import('/js/crypto/identity.js');

        const password = window.__ptPassword;
        const kdf = await api('/api/me/kdf-params');
        if (kdf.scheme !== 2) throw new Error(`expected scheme 2, got ${kdf.scheme}`);

        const { authKey } = await deriveCredentials(password, kdf.salt, kdf.iterations);
        const before = await api('/api/me/identity-key');

        const pair = await generateIdentityKeyPair();
        const publicKeyB64 = await exportPublicKey(pair);
        const pkcs8 = await exportPrivateKey(pair);
        const wrapped = await encryptIdentityPkcs8(pkcs8, password, {
            salt: kdf.salt,
            iterations: kdf.iterations,
        });

        let out = null;
        let thrown = null;
        try {
            out = await api('/api/me/identity-key/rotate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    current_auth_key: authKey,
                    expected_public_key: before.publicKey,
                    expected_updated_at: before.updatedAt,
                    identity: { publicKey: publicKeyB64, ...wrapped },
                }),
            });
        } catch (e) {
            thrown = String(e && e.message ? e.message : e);
        }

        return {
            error: thrown || out?.error || null,
            retired: before.publicKey,
            installed: publicKeyB64,
        };
    });
}

/**
 * Change this page's OWN password through the real credential flow.
 *
 * Uses the app's own prepareCredentialChange(), not a hand-rolled body: the
 * restored identity CryptoKey is non-extractable on purpose, so exporting the
 * private key to re-wrap it is exactly what the pre-F12 code did and failed at.
 * That helper decrypts and re-wraps the raw PKCS#8 without exporting it.
 *
 * The point of the test: this re-wraps the SAME key pair. It does not generate a
 * new one, so the public key - and therefore the peer's safety number and pin -
 * must not move.
 */
async function changePasswordInPage(page, newPassword) {
    return page.evaluate(async (pw) => {
        const { api } = await import('/js/core/api.js');
        const { getToken } = await import('/js/core/auth.js');
        const { prepareCredentialChange } = await import('/js/crypto/identity-service.js');

        let out = null;
        let thrown = null;
        try {
            // prepareCredentialChange returns the PUT body itself.
            const body = await prepareCredentialChange(window.__ptPassword, pw, getToken());
            out = await api('/api/me/password', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (e) {
            thrown = String(e && e.message ? e.message : e);
        }

        return { error: thrown || out?.error || null };
    }, newPassword);
}

/** Send one real encrypted DM. */
async function sendDm(page, recipientId, text) {
    return page.evaluate(async ({ id, body }) => {
        const { encryptOutgoingMessage } = await import('/js/crypto/messages/message-crypto.js');
        const { api } = await import('/js/core/api.js');
        const content = await encryptOutgoingMessage(body, window.__ptMeId, id);
        const res = await api('/api/dm/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient_id: id, content: JSON.stringify(content) }),
        });
        return { id: res?.id, error: res?.error || null };
    }, { id: recipientId, body: text });
}

/**
 * Create the same trust markup the DM thread builds, then resolve trust.
 *
 * NOT the thread-open path: the conversation sidebar is not mounted in this
 * page state, so clicking through it would be testing the router rather than key
 * trust. The markup below is copied from the thread template in dm.js, so the
 * real render functions run against the real element ids. That the thread wires
 * it up is asserted statically in tests/peer-trust.test.mjs.
 */
async function primeTrustUi(page, peerId) {
    return page.evaluate(async (id) => {
        document.body.insertAdjacentHTML('beforeend', `
            <div class="dm-key-trust-host"><div class="dm-key-trust" id="dm-key-trust-banner"></div></div>
            <section class="dm-key-verify" id="dm-key-verify" hidden>
              <div class="dm-key-verify-head">Safety number</div>
              <p class="dm-key-verify-help">Compare these digits with <span id="dm-key-verify-who"></span></p>
              <div class="dm-key-verify-number" id="dm-key-verify-number"></div>
              <div class="dm-key-verify-state" id="dm-key-verify-marked"></div>
              <button type="button" data-action="mark-verified">Mark as verified</button>
            </section>`);

        const mod = await import('/js/chat/dm-key-trust.js');
        return await mod.resolveTrust(id);
    }, peerId);
}

/** Read the trust state, banner and held-message count straight from the module. */
async function readTrustState(page, peerId) {
    return page.evaluate(async (id) => {
        const mod = await import('/js/chat/dm-key-trust.js');
        const banner = document.getElementById(mod.KEY_TRUST_IDS.banner);

        // DOM facts, not a serialised string: escaped text inside a text node
        // still CONTAINS the characters "<img" and "onerror=", so any check on
        // innerHTML would be a false positive. Ask the DOM what nodes exist.
        let imgCount = 0;
        let handlerCount = 0;
        if (banner) {
            imgCount = banner.querySelectorAll('img, script, iframe, object, embed').length;
            handlerCount = [...banner.querySelectorAll('*')].filter((el) =>
                [...el.attributes].some((a) => /^on/i.test(a.name))
            ).length;
        }

        return {
            state: mod.trustState(id),
            held: mod.heldCount(id),
            bannerPresent: !!banner && banner.textContent.trim().length > 0,
            bannerText: banner ? banner.textContent : '',
            imgCount,
            handlerCount,
        };
    }, peerId);
}

/** Try to send through the real client encrypt path; report whether it was blocked. */
async function trySendViaClient(page, peerId, text) {
    return page.evaluate(async ({ id, body }) => {
        const { encryptOutgoingMessage } = await import('/js/crypto/messages/message-crypto.js');
        const trust = await import('/js/chat/dm-key-trust.js');
        try {
            await trust.assertCanSendTo(id);
            const content = await encryptOutgoingMessage(body, window.__ptMeId, id);
            const { api } = await import('/js/core/api.js');
            const res = await api('/api/dm/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipient_id: id, content: JSON.stringify(content) }),
            });
            return { blocked: false, id: res?.id, error: res?.error || null };
        } catch (e) {
            return { blocked: true, code: e?.code || null, error: String(e?.message || e) };
        }
    }, { id: peerId, body: text });
}

test('a peer key change stops sending, holds messages, and accepting loses nothing', async (t) => {
    server = await startRealServer({ extraEnv: { GROUPS_ENABLED: 'true' } });

    await registerUser(server.origin, ALICE);
    await registerUser(server.origin, BOB);

    const a = await newUserPage();
    const b = await newUserPage();

    await loginUi(a.page, server.origin, ALICE);
    await loginUi(b.page, server.origin, BOB);
    await primePage(a.page);
    await primePage(b.page);

    const aliceId = await a.page.evaluate(() => window.__ptMeId);
    const bobId = await b.page.evaluate(() => window.__ptMeId);

    // 1. Bob sends first: a conversation row only exists once there is a message,
    //    and Alice needs the thread open to pin Bob's key.
    const first = await sendDm(b.page, aliceId, 'before the rotation');
    assert.equal(first.error, null, `first send: ${JSON.stringify(first.error)}`);

    // 2. Alice meets Bob. First contact pins his key and must NOT alarm.
    const firstTrust = await primeTrustUi(a.page, bobId);
    assert.equal(firstTrust.state, 'ok', 'first contact pins and does not alarm');

    const initial = await readTrustState(a.page, bobId);
    assert.equal(initial.state, 'ok');
    assert.equal(initial.held, 0);

    // 3. Bob rotates through the real endpoint.
    const rotated = await rotateInPage(b.page);
    assert.equal(rotated.error, null, `rotation: ${rotated.error}`);
    assert.notEqual(rotated.retired, rotated.installed);

    // 4. Bob sends AGAIN under the new key.
    const second = await sendDm(b.page, aliceId, 'after the rotation');
    assert.equal(second.error, null, `second send: ${JSON.stringify(second.error)}`);

    // 5. Alice RELOADS: a fresh client that has only ever seen the current key.
    await a.page.reload({ waitUntil: 'domcontentloaded' });
    await loginUi(a.page, server.origin, ALICE);
    await primePage(a.page);

    // 6. The alarm must be up, and sending must be refused.
    await primeTrustUi(a.page, bobId);
    await a.page.evaluate(async (id) => {
        const mod = await import('/js/chat/dm-key-trust.js');
        mod.renderKeyTrustBanner(id, '<img src=x onerror=alert(1)>');
    }, bobId);

    const alarmed = await readTrustState(a.page, bobId);
    assert.equal(alarmed.state, 'changed',
        `alice must be in the changed state after bob rotated; got ${alarmed.state}`);
    assert.equal(alarmed.bannerPresent, true, 'the banner must be visible');

    // A hostile username must stay TEXT. Checked against the DOM, not against a
    // serialised innerHTML: escaped text inside a text node still contains the
    // characters "<img" and "onerror=", so a string test would be a false
    // positive and a string test that PASSES would prove nothing.
    assert.equal(alarmed.imgCount, 0,
        `the hostile username became an element: ${alarmed.bannerText}`);
    assert.equal(alarmed.handlerCount, 0,
        `an event handler attribute leaked into the DOM: ${alarmed.bannerText}`);
    assert.ok(alarmed.bannerText.includes('<img src=x onerror=alert(1)>'),
        `the hostile username must still be shown, as text: ${alarmed.bannerText}`);

    const blocked = await trySendViaClient(a.page, bobId, 'should not go out');
    assert.equal(blocked.blocked, true, `sending must be blocked; got ${JSON.stringify(blocked)}`);
    assert.equal(blocked.code, 'PEER_KEY_CHANGED');
    assert.equal(blocked.id, undefined, 'nothing may be sent');

    // 7. While alarmed, EVERY row is held - including the one from before the
    //    rotation. That is what the thread does: resolveTrust runs per row, so a
    //    conversation opened while the key is unrecognised holds its whole
    //    history. It is also the case that makes "no message loss" meaningful.
    const heldNow = await a.page.evaluate(async (id) => {
        const mod = await import('/js/chat/dm-key-trust.js');
        const { api } = await import('/js/core/api.js');
        const res = await api(`/api/dm/messages/${id}/recent`);
        const rows = Array.isArray(res) ? res : (res?.messages || []);
        if (!rows.length) return { found: false, ids: [] };
        for (const row of rows) {
            if (mod.shouldHoldMessage(id)) mod.holdMessage(id, row);
        }
        return { found: true, held: mod.heldCount(id), ids: rows.map((r) => r.id) };
    }, bobId);

    assert.equal(heldNow.found, true, 'both rows must be on the server');
    assert.equal(heldNow.held, heldNow.ids.length,
        `every row must be held while the key is unrecognised: held=${heldNow.held} rows=${heldNow.ids.length}`);

    // 8. Accept. The held message must then be readable - NO message loss.
    const accepted = await a.page.evaluate(async (id) => {
        const mod = await import('/js/chat/dm-key-trust.js');
        await mod.acceptNewKey(id);
        return mod.trustState(id);
    }, bobId);
    assert.equal(accepted, 'ok', 'accepting must clear the alarm');

    // Release, exactly as the UI button does: the held RAW rows go back through
    // the normal decrypt path, so accepting cannot lose a message.
    const released = await a.page.evaluate(async (id) => {
        const mod = await import('/js/chat/dm-key-trust.js');
        const { decryptIncomingMessage } = await import('/js/crypto/messages/message-crypto.js');
        const { api } = await import('/js/core/api.js');

        const delivered = [];
        mod.bindKeyTrustRelease(id, async (msg) => {
            const payload = JSON.parse(msg.content);
            delivered.push(await decryptIncomingMessage(payload, id));
        });

        document.dispatchEvent(new CustomEvent('dm-key-trust-accepted', {
            detail: { peerId: Number(id) },
        }));
        await new Promise((r) => setTimeout(r, 400));

        return { delivered, stillHeld: mod.heldCount(id) };
    }, bobId);

    assert.equal(released.stillHeld, 0, 'the held queue must be drained');
    assert.deepEqual(
        [...released.delivered].sort(),
        ['after the rotation', 'before the rotation'],
        'BOTH messages must appear after accepting - nothing may be lost'
    );
});

test('a normal password change does NOT raise the alarm (real credential flow)', async (t) => {
    if (!server) return t.skip('no server');

    const b = await newUserPage();
    await loginUi(b.page, server.origin, BOB);
    await primePage(b.page);

    // Alice pins Bob's current key.
    const a = await newUserPage();          // a = alice's page
    await loginUi(a.page, server.origin, ALICE);
    await primePage(a.page);

    const aliceId = await a.page.evaluate(() => window.__ptMeId);
    const bobId = await b.page.evaluate(() => window.__ptMeId);

    assert.equal((await primeTrustUi(a.page, bobId)).state, 'ok');

    // Bob changes his PASSWORD (not his key) through the real endpoint.
    const changed = await changePasswordInPage(b.page, 'An0therPassw0rd!');
    assert.equal(changed.error, null, `password change: ${changed.error}`);

    // Alice reloads and re-checks: the identity key is unchanged, so no alarm.
    await a.page.reload({ waitUntil: 'domcontentloaded' });
    await loginUi(a.page, server.origin, ALICE);
    await primePage(a.page);
    await primeTrustUi(a.page, bobId);

    const after = await readTrustState(a.page, bobId);
    assert.equal(after.state, 'ok',
        `a password change must not alarm; state was ${after.state}`);
    assert.equal(after.bannerPresent, false, 'no banner for a password change');

    // And messaging still works afterwards.
    const sent = await sendDm(b.page, aliceId, 'after my password change');
    assert.equal(sent.error, null, `send after password change: ${JSON.stringify(sent.error)}`);
});