// tests/groups/group-key-trust-browser.test.mjs
//
// REAL Chromium, real server, real socket.io, the unmodified client: the group
// KDM key-pinning path from end to end.
//
// Alice, Bob and Carol are in a group. Alice pins Bob on first contact. Bob
// rotates his identity key. A real membership change (a temporary fourth member)
// bumps the group's key epoch, which is the production path that makes Alice
// mint and distribute a fresh Sender Key. The send-side gate must skip Bob, the
// banner must say so, no KDM row may be posted for him, and none of the
// wrapped_key values may decrypt with his new identity key.
//
// Alice then accepts Bob's new key through the rendered banner. The accept
// handler forces a fresh distribution, the pin moves, and Bob can decrypt the
// next message. The KDM Bob's new identity wrapped for Alice is delivered but
// must stay unacked: no Sender Key is stored for it and no message nonce is
// claimed under its senderKeyId.
//
// Nothing here calls the trust gate by hand. The only direct calls are reads
// (pins, changed-peer state, IndexedDB records, SQLite rows) and the app's own
// drain entry point, used to prove a delivered KDM is still undelivered after
// the real group open already tried to consume it. Waiting is always a bounded
// poll on a postcondition the app produces, never a fixed sleep.

import './_env.mjs';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
    startRealServer,
    registerUser,
    newUserPage,
    closeUserBrowsers,
    loginUi,
    sessionFromPage,
    openGroupUi,
    socketConnected,
    PASSWORD,
} from '../_acceptance-harness.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const ALICE = 'gt-alice';
const BOB = 'gt-bob';
const CAROL = 'gt-carol';
const TRIGGER = 'gt-trigger';
const GROUP_NAME = 'group-key-trust';

let server = null;

after(async () => {
    await closeUserBrowsers();
    if (server) await server.stop().catch(() => {});
});

// -------------------------------------------------------------------- helpers

/** Bounded poll on the exact postcondition the caller is about to assert. */
async function pollUntil(probe, {
    timeout = 20000,
    step = 50,
    what = 'a condition',
    describe = null,
} = {}) {
    const deadline = Date.now() + timeout;
    let last = null;

    while (Date.now() < deadline) {
        last = await probe();
        if (last) return last;
        await new Promise((r) => setTimeout(r, step));
    }

    const detail = describe
        ? `; ${await describe(last)}`
        : `; last probe returned ${JSON.stringify(last)}`;

    throw new Error(`timed out after ${timeout}ms waiting for ${what}${detail}`);
}

/** Set the page-local password the rotation flow reads. */
async function primePage(page) {
    await page.evaluate((pw) => { window.__gtPassword = pw; }, PASSWORD);
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

        const password = window.__gtPassword;
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

/** Collect page failures and console lines. */
function watchPage(page, pageErrors, consoleLines) {
    page.on('pageerror', (e) => {
        pageErrors.push(`pageerror: ${e && e.message ? e.message : e}`);
    });
    page.on('console', (m) => {
        consoleLines.push({ type: m.type(), text: m.text() });
    });
    page.on('dialog', async (d) => {
        try {
            consoleLines.push({ type: 'dialog', text: `${d.type()}: ${d.message()}` });
            await d.dismiss();
        } catch {
            // The page may already be gone.
        }
    });
}

/** The stored pin for a peer, read straight from the module. */
async function readPin(page, peerId) {
    return page.evaluate(async (id) => {
        const { getPeerPin } = await import('/js/crypto/keys/peer-trust.js');
        const { api } = await import('/js/core/api.js');
        const me = await api('/api/me/');
        const pin = await getPeerPin(Number(id), {
            origin: location.origin,
            ownUserId: (me.user || me).id,
        });
        return pin
            ? {
                verifiedAt: pin.verifiedAt,
                fingerprint: pin.current?.fingerprint ?? null,
                publicKey: pin.current?.publicKey ?? null,
            }
            : null;
    }, peerId);
}

/** The current identity public key installed in this page. */
async function currentIdentity(page) {
    return page.evaluate(async () => {
        const { getCurrentIdentity } = await import('/js/crypto/identity-service.js');
        const identity = getCurrentIdentity();
        return { publicKey: identity?.publicKey || null };
    });
}

/** Peers the group gate currently refuses to use this session. */
async function changedPeers(page) {
    return page.evaluate(async () => {
        const { getChangedGroupPeers } = await import('/js/crypto/keys/peer-key-gate.js');
        return getChangedGroupPeers().map((entry) => Number(entry.peerId));
    });
}

/** The rendered group key-trust banner, as DOM facts. */
async function readBanner(page, peerId) {
    return page.evaluate((id) => {
        const bar = document.getElementById('group-key-trust-banner');
        if (!bar) {
            return {
                present: false,
                text: '',
                accept: false,
                verify: false,
                dangerous: 0,
                handlers: [],
            };
        }

        return {
            present: true,
            text: bar.textContent || '',
            accept: !!bar.querySelector(
                `[data-action="group-key-trust-accept"][data-peer-id="${Number(id)}"]`
            ),
            verify: !!bar.querySelector(
                `[data-action="group-key-trust-verify"][data-peer-id="${Number(id)}"]`
            ),
            dangerous: bar.querySelectorAll(
                'img, script, iframe, object, embed, svg, a[href^="javascript:"]'
            ).length,
            handlers: [...bar.querySelectorAll('*')]
                .flatMap((el) => [...el.attributes].map((a) => a.name))
                .filter((name) => /^on/i.test(name)),
        };
    }, peerId);
}

/** Click a button the banner rendered, and report whether its sync handler ran. */
async function clickBannerAction(page, action, peerId) {
    const selector =
        `#group-key-trust-banner [data-action="${action}"][data-peer-id="${Number(peerId)}"]`;

    await pollUntil(
        () => page.evaluate((sel) => !!document.querySelector(sel), selector),
        { timeout: 15000, what: `the banner ${action} button` }
    );

    const result = await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return { ok: false, why: 'the button is not in the DOM' };
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return { ok: true, disabled: btn.disabled };
    }, selector);

    assert.equal(result.ok, true, result.why || 'the banner button vanished before it was clicked');
    return result;
}

/** Send through the group composer, exactly as the Send button does. */
async function sendGroupText(page, text) {
    await page.evaluate((body) => {
        const input = document.getElementById('group-input');
        if (!input) throw new Error('the group composer input is not mounted');
        input.value = body;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);

    const clicked = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="group-send"]');
        if (!btn) return false;
        btn.click();
        return true;
    });
    assert.equal(clicked, true, 'the group send button is not in the DOM');

    await pollUntil(
        async () => {
            const state = await page.evaluate((body) => {
                const input = document.getElementById('group-input');
                const bubbles = [...document.querySelectorAll('#group-messages .chat-msg')]
                    .map((el) => el.textContent.trim());
                return {
                    value: input ? input.value : null,
                    rendered: bubbles.some((t) => t.includes(body)),
                };
            }, text);

            return state.value === '' && state.rendered ? state : null;
        },
        {
            timeout: 45000,
            what: `the group composer to send ${JSON.stringify(text)}`,
        }
    );
}

/** Wait until Bob's real thread rendered Alice's plaintext, not a placeholder. */
async function waitForGroupBubble(page, text) {
    return pollUntil(
        () => page.evaluate((body) => {
            const bubbles = [...document.querySelectorAll('#group-messages .chat-msg')]
                .map((el) => el.textContent.trim());
            return bubbles.some((t) => t.includes(body)
                && !/Unable to decrypt|Waiting for encryption key|Could not decrypt/i.test(t)
            ) || null;
        }, text),
        {
            timeout: 45000,
            what: `${JSON.stringify(text)} to render in Bob's group thread`,
        }
    );
}

/** The safety-number panel, as the user sees it. */
async function readVerifyPanel(page) {
    return page.evaluate(() => {
        const panel = document.getElementById('group-key-verify');
        const number = document.getElementById('group-key-verify-number');
        const who = document.getElementById('group-key-verify-who');
        return {
            hidden: !panel || panel.hasAttribute('hidden'),
            number: number?.textContent || '',
            who: who?.textContent || '',
        };
    });
}

// -------------------------------------------------------- server / SQLite reads

function withDb(fn) {
    const db = new Database(server.dbPath);
    try {
        db.pragma('busy_timeout = 5000');
        return fn(db);
    } finally {
        db.close();
    }
}

function maxKdmId(gid) {
    return withDb((db) => Number(db.prepare(
        'SELECT COALESCE(MAX(id), 0) AS id FROM group_key_distributions WHERE group_id = ?'
    ).get(gid).id));
}

function kdmRowsAfter(gid, mark) {
    return withDb((db) => db.prepare(`
        SELECT id, group_id, from_user_id, to_user_id, wrapped_key, epoch
        FROM group_key_distributions
        WHERE group_id = ? AND id > ?
        ORDER BY id ASC
    `).all(gid, mark));
}

function epochFor(gid, userId) {
    return Number(withDb((db) => db.prepare(
        'SELECT key_epoch FROM group_members WHERE group_id = ? AND user_id = ?'
    ).get(gid, userId)?.key_epoch));
}

function receiptExists(kdmId, deviceId) {
    return !!withDb((db) => db.prepare(
        'SELECT 1 FROM group_kdm_receipts WHERE kdm_id = ? AND device_id = ?'
    ).get(kdmId, deviceId));
}

// -------------------------------------------------------------- page crypto reads

/**
 * Decrypt a KDM row with the page's CURRENT identity private key and the
 * supplied peer public key, deliberately bypassing the pin gate.
 *
 * This is evidence, not a production call path: it proves which identity key a
 * wrapped_key actually used. A row wrapped for Bob's NEW key decrypts here with
 * Bob's new private key; a row wrapped for his old key does not.
 */
async function rawUnwrap(page, row, peerPublicKeyB64, { deriveIdFor = null } = {}) {
    return page.evaluate(async ({ kdm, peerKey, idContext }) => {
        try {
            const { getCurrentIdentity } = await import('/js/crypto/identity-service.js');
            const { base64ToBytes } = await import('/js/crypto/keys/peer-trust.js');
            const {
                deriveSessionKeyFromPeer,
                GROUP_KDM_INFO,
            } = await import('/js/crypto/keys/key-derivation.js');
            const { decryptBytes } = await import('/js/crypto/groups/aead.js');
            const { kdmAad } = await import('/js/crypto/groups/kdm.js');

            const identity = getCurrentIdentity();
            if (!identity?.privateKey) {
                return { ok: false, error: 'the page has no unlocked identity' };
            }

            const peerPublic = await crypto.subtle.importKey(
                'raw',
                base64ToBytes(peerKey),
                { name: 'X25519' },
                true,
                []
            );

            const wrapKey = await deriveSessionKeyFromPeer(
                identity.privateKey,
                peerPublic,
                GROUP_KDM_INFO
            );

            const payload = new Uint8Array(await decryptBytes(
                wrapKey,
                JSON.parse(kdm.wrapped_key),
                kdmAad({
                    groupId: Number(kdm.group_id),
                    fromUserId: Number(kdm.from_user_id),
                    toUserId: Number(kdm.to_user_id),
                    epoch: Number(kdm.epoch),
                })
            ));

            const out = { ok: true, length: payload.length };

            if (idContext) {
                if (payload.length !== 97) {
                    return { ok: false, error: `unexpected KDM payload length ${payload.length}` };
                }
                const { deriveSenderKeyId } = await import('/js/crypto/groups/sender-key-id.js');
                out.senderKeyId = await deriveSenderKeyId(
                    Number(idContext.groupId),
                    Number(idContext.ownerUserId),
                    Number(kdm.epoch),
                    payload.slice(0, 32),
                    payload.slice(32)
                );
            }

            return out;
        } catch (e) {
            return { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` };
        }
    }, {
        kdm: row,
        peerKey: peerPublicKeyB64,
        idContext: deriveIdFor,
    });
}

/** The local Sender Key record and claimed-nonce count for one id. */
async function localSenderKeyState(page, gid, senderKeyId) {
    return page.evaluate(async ({ groupId, id }) => {
        const store = await import('/js/crypto/groups/sender-key-store.js');
        const record = await store.getSenderKeyRecord(id);
        return {
            record: record
                ? {
                    ownerUserId: record.ownerUserId,
                    epoch: record.epoch,
                    isMine: record.isMine,
                }
                : null,
            seen: await store.countSeen(id),
        };
    }, { groupId: gid, id: senderKeyId });
}

/** The server's undelivered-mailbox view for this device. */
async function undeliveredRows(page, gid, deviceId) {
    return page.evaluate(async ({ groupId, device }) => {
        const { api } = await import('/js/core/api.js');
        const query =
            `/api/groups/kdms?device_id=${encodeURIComponent(device)}`
            + `&group_id=${encodeURIComponent(groupId)}`;
        return api(query);
    }, { groupId: gid, device: deviceId });
}

// ------------------------------------------------------------------ the scenario

test('group key pinning: a rotated Bob is skipped, accepted, rewrapped, and held', async () => {
    server = await startRealServer({ extraEnv: { GROUPS_ENABLED: 'true' } });
    assert.ok(server, 'the real server did not start');

    await registerUser(server.origin, ALICE);
    await registerUser(server.origin, BOB);
    await registerUser(server.origin, CAROL);
    await registerUser(server.origin, TRIGGER);

    const alice = await newUserPage();
    const bob = await newUserPage();
    const carol = await newUserPage();
    const trigger = await newUserPage();

    const aliceErrors = [];
    const bobErrors = [];
    const aliceConsole = [];
    const bobConsole = [];

    watchPage(alice.page, aliceErrors, aliceConsole);
    watchPage(bob.page, bobErrors, bobConsole);

    await loginUi(alice.page, server.origin, ALICE);
    await loginUi(bob.page, server.origin, BOB);
    await loginUi(carol.page, server.origin, CAROL);
    await loginUi(trigger.page, server.origin, TRIGGER);

    const aliceSession = await sessionFromPage(alice.page, server.origin, ALICE);
    const bobSession = await sessionFromPage(bob.page, server.origin, BOB);
    const carolSession = await sessionFromPage(carol.page, server.origin, CAROL);
    const triggerSession = await sessionFromPage(trigger.page, server.origin, TRIGGER);

    await primePage(bob.page);

    // Create the three-member group over the app's own authenticated API.
    const created = await alice.page.evaluate(async (name) => {
        const { api } = await import('/js/core/api.js');
        return api('/api/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
    }, GROUP_NAME);
    const gid = Number(created?.id);
    assert.ok(Number.isInteger(gid) && gid > 0, `group creation returned no id: ${JSON.stringify(created)}`);

    const added = await alice.page.evaluate(async ({ groupId, ids }) => {
        const { api } = await import('/js/core/api.js');
        return api(`/api/groups/${groupId}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_ids: ids }),
        });
    }, { groupId: gid, ids: [bobSession.id, carolSession.id] });
    assert.deepEqual(added.added.sort((a, b) => a - b), [bobSession.id, carolSession.id].sort((a, b) => a - b));

    // The trigger account only has to exist and have an identity key. It is
    // added later to perform a real membership change; keeping its page closed
    // means it contributes no socket side effects or KDMs of its own.
    await trigger.page.close();

    // A reload is load-bearing here: the group list (and my key_epoch) is read
    // when the app boots, and Alice created the group over REST after her login.
    await loginUi(alice.page, server.origin, ALICE);
    await socketConnected(alice.page);
    await openGroupUi(alice.page, gid);

    // First contact: Alice's first distribution pins Bob (and Carol), with no
    // banner. The row proves the pin came from a real KDM round.
    const bobBefore = await currentIdentity(bob.page);
    const initialPins = await pollUntil(async () => {
        const pin = await readPin(alice.page, bobSession.id);
        const rows = kdmRowsAfter(gid, 0)
            .filter((r) => r.from_user_id === aliceSession.id && r.to_user_id === bobSession.id);
        return pin?.publicKey && rows.length > 0 ? { pin, rows } : null;
    }, {
        timeout: 30000,
        what: 'Alice to pin Bob and distribute a first-contact KDM',
        describe: async (last) => `last=${JSON.stringify(last)}`,
    });

    assert.equal(initialPins.pin.publicKey, bobBefore.publicKey,
        'the first-contact pin is not Bob\'s current identity key');
    const initialBobRows = initialPins.rows;
    assert.ok(initialBobRows.length > 0, 'the first-contact distribution produced no row for Bob');

    const initialBanner = await readBanner(alice.page, bobSession.id);
    assert.equal(initialBanner.text.trim(), '',
        `the group banner is not empty on first contact: ${JSON.stringify(initialBanner.text)}`);

    const alicePublicBefore = (await currentIdentity(alice.page)).publicKey;
    assert.ok(alicePublicBefore, 'Alice has no current identity public key');

    await loginUi(bob.page, server.origin, BOB);
    await socketConnected(bob.page);
    await openGroupUi(bob.page, gid);
    await loginUi(carol.page, server.origin, CAROL);
    await socketConnected(carol.page);
    await openGroupUi(carol.page, gid);

    // A KDM from Bob's first identity must exist and be usable by Alice's pin,
    // so the later change is about Bob's key, not a missing setup.
    const bobInitialPin = await pollUntil(
        () => readPin(bob.page, aliceSession.id),
        { timeout: 20000, what: 'Bob to pin Alice on first contact' }
    );
    assert.ok(bobInitialPin?.publicKey, 'Bob did not pin Alice during the first distribution');

    // ---------------------------------------------------- Bob rotates his key
    // Set the page-local password again: Bob was reloaded after his first login.
    await primePage(bob.page);
    const rotation = await rotateInPage(bob.page);
    assert.equal(rotation.error, null, `Bob's key rotation failed: ${rotation.error}`);
    assert.notEqual(rotation.installed, rotation.retired, 'the rotate endpoint reinstalled the same key');

    await loginUi(bob.page, server.origin, BOB);
    await socketConnected(bob.page);
    const bobAfter = await currentIdentity(bob.page);
    assert.equal(bobAfter.publicKey, rotation.installed,
        'Bob\'s page did not reload with the new identity key');

    // Alice's pin must still be the retired key until she acts.
    const pinBeforeAccept = await readPin(alice.page, bobSession.id);
    assert.equal(pinBeforeAccept?.publicKey, rotation.retired,
        'Alice silently moved her pin to Bob\'s new key before accepting it');

    // -------------------------------------------------- force a new key epoch
    // The only production path that mints a new Sender Key (and therefore calls
    // the send-side gate again) is a membership change. Add the trigger account;
    // it has an identity key but no open page, so it contributes no KDM of its own.
    const triggerMark = maxKdmId(gid);
    const triggerAdded = await alice.page.evaluate(async ({ groupId, id }) => {
        const { api } = await import('/js/core/api.js');
        return api(`/api/groups/${groupId}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_ids: [id] }),
        });
    }, { groupId: gid, id: triggerSession.id });
    assert.deepEqual(triggerAdded.added, [triggerSession.id]);

    const epoch = epochFor(gid, aliceSession.id);
    assert.ok(epoch >= 2, `the membership change did not bump the group epoch: ${epoch}`);

    await loginUi(alice.page, server.origin, ALICE);
    await socketConnected(alice.page);
    await openGroupUi(alice.page, gid);

    const aliceRotation = await pollUntil(async () => {
        const rows = kdmRowsAfter(gid, triggerMark).filter((r) =>
            r.from_user_id === aliceSession.id
            && r.to_user_id === aliceSession.id
            && Number(r.epoch) === epoch
        );
        return rows.length > 0 ? rows[rows.length - 1] : null;
    }, {
        timeout: 45000,
        what: 'Alice to mint and distribute the new epoch\'s Sender Key',
        describe: async () => `epoch=${epoch}, rows=${JSON.stringify(kdmRowsAfter(gid, triggerMark).map((r) => [r.id, r.from_user_id, r.to_user_id, r.epoch]))}`,
    });
    assert.ok(aliceRotation, 'Alice did not rotate after the membership change');

    // The send-side gate must have skipped Bob and nobody else. These assertions
    // are deliberately BEFORE the larger banner poll so a missing send-side gate
    // fails on the row it produced, not on a timeout.
    const aliceToBobAfterTrigger = kdmRowsAfter(gid, triggerMark).filter((r) =>
        r.from_user_id === aliceSession.id && r.to_user_id === bobSession.id
    );
    assert.deepEqual(
        aliceToBobAfterTrigger.map((r) => r.id),
        [],
        `Alice posted a KDM for Bob after his key changed: ${JSON.stringify(
            aliceToBobAfterTrigger.map((r) => ({ id: r.id, epoch: r.epoch }))
        )}`
    );

    // Stronger than "no row": no row for Bob may have been wrapped for his NEW
    // identity key. rawUnwrap bypasses the gate and decrypts with Bob's current
    // private key and Alice's public key.
    for (const row of initialBobRows) {
        const opened = await rawUnwrap(bob.page, row, alicePublicBefore);
        assert.equal(opened.ok, false,
            `Alice->Bob row ${row.id} decrypts with Bob's NEW identity key: ${JSON.stringify(opened)}`);
    }

    const banner = await pollUntil(async () => {
        const b = await readBanner(alice.page, bobSession.id);
        return b.text.includes(BOB) && /not receiving/i.test(b.text) ? b : null;
    }, {
        timeout: 30000,
        what: 'the group banner to name Bob and say he is not receiving',
        describe: async () => JSON.stringify(await readBanner(alice.page, bobSession.id)),
    });

    assert.match(banner.text, new RegExp(BOB), 'the banner did not name Bob in textContent');
    assert.match(banner.text, /not receiving/i, 'the banner did not say Bob is not receiving');
    assert.equal(banner.accept, true, 'the banner has no accept button for Bob');
    assert.equal(banner.verify, true, 'the banner has no safety-number button for Bob');
    assert.deepEqual(banner.handlers, [],
        `the group banner contains inline event handlers: ${banner.handlers.join(', ')}`);
    assert.equal(banner.dangerous, 0,
        'the group banner contains element types that can execute markup');

    assert.deepEqual(
        (await changedPeers(alice.page)).includes(bobSession.id),
        true,
        'the group gate did not record Bob as changed'
    );

    // The safety-number view must open from the banner and show 60 digits.
    const verifyClick = await clickBannerAction(alice.page, 'group-key-trust-verify', bobSession.id);
    assert.equal(verifyClick.disabled, false, 'the safety-number button is disabled');

    const panel = await pollUntil(async () => {
        const p = await readVerifyPanel(alice.page);
        const digits = p.number.replace(/\s/g, '');
        return !p.hidden && p.who === BOB && /^\d{60}$/.test(digits) ? p : null;
    }, {
        timeout: 15000,
        what: 'the group safety-number panel to open with 60 digits',
        describe: async () => JSON.stringify(await readVerifyPanel(alice.page)),
    });

    assert.equal(panel.who, BOB, 'the safety-number panel names the wrong member');
    assert.match(panel.number.replace(/\s/g, ''), /^\d{60}$/,
        `expected 60 digits, got ${JSON.stringify(panel.number)}`);

    // ------------------------------------------- the unaccepted KDM Bob sends
    // Reload Bob after the epoch bump. His page now has the new identity and the
    // current epoch, so opening the group mints a fresh Sender Key and wraps it
    // for the current members. The row addressed to Alice is authentic under
    // Bob's new key, but Alice has not accepted that key.
    await loginUi(bob.page, server.origin, BOB);
    await socketConnected(bob.page);
    await openGroupUi(bob.page, gid);

    const bobToAlice = await pollUntil(async () => {
        const rows = kdmRowsAfter(gid, triggerMark)
            .filter((r) =>
                r.from_user_id === bobSession.id
                && r.to_user_id === aliceSession.id
                && Number(r.epoch) === epoch
            );
        return rows.length > 0 ? rows[rows.length - 1] : null;
    }, {
        timeout: 45000,
        what: 'Bob\'s new identity to distribute a KDM to Alice',
        describe: async () => JSON.stringify(kdmRowsAfter(gid, triggerMark).map((r) => [r.id, r.from_user_id, r.to_user_id, r.epoch])),
    });

    // It must be a valid KDM under Bob's new key (otherwise the row proves
    // nothing). rawUnwrap uses Alice's private key and Bob's new public key.
    const bobToAliceUnwrapped = await rawUnwrap(
        alice.page,
        bobToAlice,
        rotation.installed,
        { deriveIdFor: { groupId: gid, ownerUserId: bobSession.id } }
    );
    assert.equal(bobToAliceUnwrapped.ok, true,
        `Bob's KDM to Alice is not valid under his new key: ${JSON.stringify(bobToAliceUnwrapped)}`);
    assert.equal(bobToAliceUnwrapped.length, 97,
        `unexpected KDM payload length ${bobToAliceUnwrapped.length}`);
    assert.match(bobToAliceUnwrapped.senderKeyId, /^[0-9a-f]{64}$/,
        `no senderKeyId was derived: ${bobToAliceUnwrapped.senderKeyId}`);

    const aliceDeviceId = await alice.page.evaluate(async () => {
        const mod = await import('/js/crypto/messages/group-message-crypto.js');
        return mod.getGroupDeviceId();
    });

    // Re-open through the real group row and then call the app's own drain. The
    // group open already tried; the explicit call makes the outcome deterministic
    // and returns the count this device consumed.
    await openGroupUi(alice.page, gid);
    const consumed = await alice.page.evaluate(async (groupId) => {
        const mod = await import('/js/crypto/messages/group-message-crypto.js');
        return mod.drainGroupKdms(groupId);
    }, gid);

    assert.equal(consumed, 0,
        'Alice consumed the KDM from Bob\'s unaccepted identity key');

    const stillUndelivered = await undeliveredRows(alice.page, gid, aliceDeviceId);
    assert.equal(
        stillUndelivered.some((r) => Number(r.id) === Number(bobToAlice.id)),
        true,
        `the held KDM ${bobToAlice.id} was acknowledged (it is no longer in the mailbox)`
    );
    assert.equal(receiptExists(bobToAlice.id, aliceDeviceId), false,
        `the server has a delivery receipt for held KDM ${bobToAlice.id}`);

    const localState = await localSenderKeyState(
        alice.page,
        gid,
        bobToAliceUnwrapped.senderKeyId
    );
    assert.equal(localState.record, null,
        `a Sender Key was stored for Bob's unaccepted KDM: ${JSON.stringify(localState.record)}`);
    assert.equal(localState.seen, 0,
        `a message nonce was claimed under Bob's unaccepted Sender Key: ${localState.seen}`);

    // -------------------------------------------------------- accept Bob's key
    const acceptMark = maxKdmId(gid);
    const acceptClick = await clickBannerAction(alice.page, 'group-key-trust-accept', bobSession.id);
    assert.equal(acceptClick.disabled, true,
        'the accept button listener did not run - the click did not reach it');

    const acceptedPin = await pollUntil(async () => {
        const pin = await readPin(alice.page, bobSession.id);
        return pin?.publicKey === rotation.installed ? pin : null;
    }, {
        timeout: 30000,
        what: 'Alice\'s pin to move to Bob\'s new identity key',
        describe: async () => JSON.stringify(await readPin(alice.page, bobSession.id)),
    });

    assert.equal(acceptedPin.publicKey, rotation.installed,
        'the pin did not move to Bob\'s new key');
    assert.ok(Number(acceptedPin.verifiedAt) > 0,
        'accepting the new key did not mark it verified');

    const cleared = await pollUntil(async () => {
        const b = await readBanner(alice.page, bobSession.id);
        return b.text.trim() === '' && b.accept === false ? b : null;
    }, {
        timeout: 30000,
        what: 'the group banner to clear after accepting Bob\'s key',
        describe: async () => JSON.stringify(await readBanner(alice.page, bobSession.id)),
    });
    assert.equal(cleared.text.trim(), '', 'the banner still names Bob after accepting his key');
    assert.deepEqual(
        (await changedPeers(alice.page)).includes(bobSession.id),
        false,
        'the gate still lists Bob after accepting his key'
    );

    // The accept handler forces one fresh rotation. A new row for Bob must exist,
    // and it must decrypt with his NEW key. This is the re-wrap the next send uses.
    const rewrapped = await pollUntil(async () => {
        const rows = kdmRowsAfter(gid, acceptMark).filter((r) =>
            r.from_user_id === aliceSession.id && r.to_user_id === bobSession.id
        );
        return rows.length > 0 ? rows[rows.length - 1] : null;
    }, {
        timeout: 45000,
        what: 'Alice to re-wrap her Sender Key for Bob after accepting his key',
        describe: async () => JSON.stringify(kdmRowsAfter(gid, acceptMark).map((r) => [r.id, r.from_user_id, r.to_user_id, r.epoch])),
    });

    const alicePublic = (await currentIdentity(alice.page)).publicKey;
    const rewrappedUnwrapped = await rawUnwrap(
        bob.page,
        rewrapped,
        alicePublic
    );
    assert.equal(rewrappedUnwrapped.ok, true,
        `the post-accept KDM for Bob does not decrypt with his new key: ${JSON.stringify(rewrappedUnwrapped)}`);
    assert.equal(rewrappedUnwrapped.length, 97,
        `the post-accept KDM has an unexpected payload length ${rewrappedUnwrapped.length}`);

    // Re-open Bob's real group thread so its drain is observed, not assumed.
    await openGroupUi(bob.page, gid);

    // --------------------------------------------------- Bob decrypts the next send
    const message = 'after accepting bob writes again';
    await sendGroupText(alice.page, message);
    await waitForGroupBubble(bob.page, message);

    // ------------------------------------------------------------ restore membership
    const removed = await alice.page.evaluate(async ({ groupId, id }) => {
        const { api } = await import('/js/core/api.js');
        return api(`/api/groups/${groupId}/members/${id}`, { method: 'DELETE' });
    }, { groupId: gid, id: triggerSession.id });
    assert.equal(removed.removed, true, 'the temporary membership trigger was not removed');

    // Reload Alice once more so the restored three-member group has a current
    // Sender Key for Bob and Carol, not the trigger round's key.
    await loginUi(alice.page, server.origin, ALICE);
    await socketConnected(alice.page);
    await openGroupUi(alice.page, gid);

    const finalMembers = await alice.page.evaluate(async (groupId) => {
        const { api } = await import('/js/core/api.js');
        return api(`/api/groups/${groupId}/members`);
    }, gid);
    assert.deepEqual(
        finalMembers.map((m) => Number(m.user_id)).sort((a, b) => a - b),
        [aliceSession.id, bobSession.id, carolSession.id].sort((a, b) => a - b),
        'the temporary membership trigger was not removed'
    );

    // --------------------------------------------------------------- page safety
    // The app ships a report-only CSP next to the enforced one, so Chromium logs
    // its pre-existing inline-style/inline-script diagnostics as console INFO on
    // every shell load. "The policy is report-only ... no further action" is not
    // an enforced violation and is not caused by the banner. Keep the assertion
    // on anything that was actually refused/enforced.
    const csp = [...aliceConsole, ...bobConsole]
        .filter((entry) => !/the policy is report-only/i.test(entry.text))
        .filter((entry) => /content security policy|violates the following|refused to (?:load|execute|apply|connect)/i.test(entry.text));
    assert.deepEqual(csp, [], `CSP violations were logged: ${JSON.stringify(csp)}`);

    const pageErrors = [...aliceErrors, ...bobErrors]
        .filter((entry) => entry.startsWith('pageerror:'));
    assert.deepEqual(pageErrors, [],
        `uncaught page errors: ${pageErrors.join(' | ')}`);
});
