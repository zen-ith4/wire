// tests/peer-trust-browser.test.mjs
//
// Phase 2, end to end, in a real browser: a peer rotates its identity key and
// the user is stopped, warned, and loses nothing when they accept.
//
// Two accounts, ONE BROWSER PROCESS EACH (newUserPage), because IndexedDB is
// per profile and the pin store is keyed by (origin, ownUserId, peerId) - two
// accounts sharing a profile would read each other's pins.
//
// RELOAD + RE-LOGIN BETWEEN STEPS is load-bearing. Without it a page's cached
// session key and already-resolved trust state hide the behaviour under test.
// (The same trap made the v15 key-archive test pass for the wrong reason.)
//
// NOTHING HERE CALLS THE GUARD BY HAND.
//
// The earlier version of this file imported dm-key-trust.js and called
// holdMessage(), assertCanSendTo() and the release event itself. That version
// could not tell a working feature from a broken one: delete the gate from
// encryptForActivePeer() in dm.js, or the hold from decryptDmMessage(), or the
// release binding from openDmConversation(), and it stayed green - because it was
// never running any of them. It also took setTimeout(400) on faith and waited
// for nothing in particular.
//
// Everything below goes through the thread's own entry points instead:
// window.openDmConversation(), window.sendDm(), a click on the rendered accept
// button, and a click on the rendered Verify button. Waiting is a bounded poll on
// a postcondition the app actually produces, never a sleep.

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

// A peer-controlled display name. Never registered as an account - it is only
// ever passed to openDmConversation() as the name to SHOW, which is exactly the
// untrusted input the trust banner has to survive.
const HOSTILE = '<img src=x onerror=alert(1)>';

// The liveness CONTROL is a different string on purpose. A real
// `onerror=alert(1)` control opens a modal dialog, and a modal dialog blocks the
// renderer until something dismisses it - so an earlier version of this file did
// not fail on a regression, it hung for the full protocol timeout on an
// unrelated-looking `1 + 1`. A marker handler proves exactly the same thing (the
// attribute parsed, the handler ran, in a real browser) with no dialog.
const CONTROL = '<img src=x onerror="window.__ptControlFired=1">';

let server = null;

after(async () => {
    await closeUserBrowsers();
    if (server) await server.stop().catch(() => {});
});

// -------------------------------------------------------------------- helpers

/**
 * Bounded poll on a postcondition. `probe` returns a truthy value when the
 * condition holds. Throws on timeout with whatever the last value was, so a
 * failure says which postcondition did not happen rather than "timed out".
 */
async function pollUntil(probe, { timeout = 10000, step = 50, what = 'a condition' } = {}) {
    const deadline = Date.now() + timeout;
    let last = null;

    while (Date.now() < deadline) {
        last = await probe();
        if (last) return last;
        await new Promise((r) => setTimeout(r, step));
    }

    throw new Error(
        `timed out after ${timeout}ms waiting for ${what}; last probe returned ${JSON.stringify(last)}`
    );
}

/** Set the page-local helpers the rotation and credential flows read. */
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
 *
 * The point: this re-wraps the SAME key pair. It does not generate a new one, so
 * the public key - and therefore the peer's safety number and pin - must not move.
 */
async function changePasswordInPage(page, newPassword) {
    return page.evaluate(async (pw) => {
        const { api } = await import('/js/core/api.js');
        const { getToken } = await import('/js/core/auth.js');
        const { prepareCredentialChange } = await import('/js/crypto/identity-service.js');

        let out = null;
        let thrown = null;
        try {
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

/**
 * Collect page-level errors.
 *
 * openDmConversation() runs its key-trust init in a fire-and-forget async IIFE
 * whose catch only console.errors, and the accept button's handler is an async
 * listener whose rejection nobody sees. Both have swallowed real failures during
 * the writing of this file, so the sink is attached up front and reported
 * instead of left in the void.
 */
function watchPage(page, sink, dialogs) {
    page.on('pageerror', (e) => sink.push(`pageerror: ${e && e.message ? e.message : e}`));
    page.on('console', (m) => {
        if (m.type() === 'error') sink.push(`console.error: ${m.text()}`);
    });

    // A dialog BLOCKS the renderer until something dismisses it. So an XSS that
    // fires alert() does not fail this file - it wedges it for the full protocol
    // timeout, on an unrelated-looking evaluate, which is exactly what happened
    // the first time this payload ran: `main thread alive? 1+1` hung for 90s.
    //
    // Dismiss every dialog and record it instead, so the same regression becomes
    // a one-line assertion failure. The payload is `<img src=x onerror=alert(1)>`:
    // the browser fetches the relative URL `x`, gets a 404, and fires onerror even
    // on the detached element the control builds.
    page.on('dialog', async (d) => {
        try {
            dialogs.push(`${d.type()}: ${String(d.message()).slice(0, 120)}`);
            await d.dismiss();
        } catch {
            /* the page may already be gone */
        }
    });

    return sink;
}

/** Click the accept button the banner rendered, waiting for it to exist first. */
async function clickAcceptButton(page, sink = []) {
    await pollUntil(
        () => page.evaluate(() => !!document.querySelector('#dm-key-trust-banner .dm-key-trust-accept')),
        { timeout: 15000, what: 'the accept button to be rendered' }
    );

    // Click the rendered button, so the button's OWN listener is what runs -
    // calling acceptNewKey() directly would test the function, not the button.
    //
    // Dispatched in-page rather than with page.click() because the thread's own
    // markup covers the banner in a headless viewport, and an input-level click is
    // then delivered to whatever is on top of it. The assertion immediately below
    // proves the listener really ran, so a missed or swallowed click cannot pass
    // quietly.
    const fired = await page.evaluate(() => {
        const btn = document.querySelector('#dm-key-trust-banner .dm-key-trust-accept');
        if (!btn) return { ok: false, why: 'the accept button is not in the DOM' };
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return { ok: true, disabled: btn.disabled };
    });

    assert.equal(fired.ok, true, fired.why || 'the accept button vanished before it was clicked');
    // The listener's first statement is `btn.disabled = true` and it is set
    // synchronously, so this is a direct observation that the handler ran.
    assert.equal(fired.disabled, true,
        'the accept button listener did not run - the click did not reach it');

    // If the handler then rejected, say so here rather than letting the next poll
    // time out with no explanation.
    const trustErrors = sink.filter((e) => /trust|No signed-in account|verify/i.test(e));
    assert.deepEqual(trustErrors, [],
        `the accept click reported errors: ${trustErrors.join(' | ')}`);
}

// ------------------------------------------------- the real thread, the real way

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
            ? { verifiedAt: pin.verifiedAt, current: pin.current?.fingerprint ?? null }
            : null;
    }, peerId);
}

/** Open the DM thread through dm.js's own entry points, and wait for its composer. */
async function openThread(page, peerId, displayName) {
    await page.evaluate(
        async ({ id, name }) => {
            // Mount the DM layout the way the router does. openDmConversation()
            // writes into #dm-thread and dereferences it unguarded, so it cannot
            // be the first thing to touch the page.
            const dm = await import('/js/chat/dm.js');
            await dm.renderDm();

            // Then open the conversation - the same call a click on a row in the
            // conversation list makes, and the one that runs resolveTrust(),
            // renderKeyTrustBanner() and bindKeyTrustRelease().
            window.openDmConversation(id, name);
        },
        { id: peerId, name: displayName }
    );

    // The thread builds its own markup, including the composer input, the trust
    // banner host and the Verify button. Wait for the composer: without it every
    // assertion below would be about a page state that does not exist.
    await pollUntil(
        () => page.evaluate(() => !!document.getElementById('dm-input')),
        { what: 'the thread composer to mount' }
    );

    // The composer mounts synchronously, but openDmConversation() then kicks off
    // resolveTrust() in a fire-and-forget async IIFE whose failure is swallowed
    // into console.error. Reading trust state before it lands gets 'unknown',
    // which looks like a broken feature rather than a test that raced. 'unknown'
    // is a real state meaning "not resolved yet", so waiting for it to change is
    // a postcondition the app actually produces - and if resolveTrust never runs,
    // this times out and says so.
    await pollUntil(
        async () => {
            const s = await trustStateOf(page, peerId);
            return s.state === 'unknown' ? null : s;
        },
        { what: 'the peer key trust state to resolve', timeout: 15000 }
    );
}

/**
 * Send through the thread's own composer, exactly as the Send button does.
 *
 * The observable is the composer's input value, which composer.js clears only
 * after the POST returns. So:
 *   sent: true   - the input was cleared, so the message went out
 *   sent: false  - the input still holds the text when the wait expires, so the
 *                  send was refused before it left the page
 *
 * This is the whole point of driving window.sendDm(): it runs the composer, which
 * calls encryptForActivePeer(), which calls the gate. Calling the gate directly
 * would have proved only that the gate throws.
 *
 * A timeout is therefore NOT an error here - it is the blocked case. The caller
 * decides: `sent: true` is asserted where a send must succeed, `sent: false` is
 * asserted where it must be refused. What is never allowed is to read `sent`
 * without also reading `leftBehind`, because a send that silently failed for an
 * unrelated reason (a dead composer, a 500) would look identical to a refusal.
 * The callers below assert `leftBehind` in every blocked case.
 */
async function sendThroughComposer(page, text, { timeout = 8000 } = {}) {
    await page.evaluate((body) => {
        const input = document.getElementById('dm-input');
        if (!input) throw new Error('the thread composer input is not mounted');
        input.value = body;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        window.sendDm();
    }, text);

    try {
        return await pollUntil(
            async () => {
                const cleared = await page.evaluate(
                    () => document.getElementById('dm-input')?.value === ''
                );
                return cleared ? { sent: true } : null;
            },
            { timeout, what: `the composer to accept ${JSON.stringify(text)}` }
        );
    } catch {
        // Not cleared in time: the send was refused. Report the text that is
        // still sitting in the composer, so the caller can prove the refusal
        // was the gate and not a composer that never ran.
        const leftBehind = await page.evaluate(
            () => document.getElementById('dm-input')?.value ?? null
        );
        return { sent: false, leftBehind };
    }
}

/** Row ids the server holds for this conversation, oldest first. */
async function recentRowIds(page, peerId) {
    return page.evaluate(async (id) => {
        const { api } = await import('/js/core/api.js');
        const res = await api(`/api/dm/messages/${id}/recent`);
        const rows = Array.isArray(res) ? res : (res?.messages || []);
        return rows.map((r) => Number(r.id));
    }, peerId);
}

/**
 * How many messages the thread has actually rendered into #dm-messages.
 *
 * The "Unable to decrypt" placeholder is also a .chat-msg, and counting it would
 * let a decryption failure masquerade as a successfully rendered message - which
 * is the opposite of what this number is for. Excluded explicitly.
 */
async function renderedMessageCount(page) {
    return page.evaluate(
        () => [...document.querySelectorAll('#dm-messages .chat-msg')]
            .filter((el) => el.textContent.trim() !== 'Unable to decrypt')
            .length
    );
}

/** The text the thread has rendered, so "no message loss" is about the DOM. */
async function renderedText(page) {
    return page.evaluate(() => (document.getElementById('dm-messages')?.textContent || ''));
}

// ------------------------------------------------------------------- reading

/** The trust state and held count, straight from the module. */
async function trustStateOf(page, peerId) {
    return page.evaluate(async (id) => {
        const mod = await import('/js/chat/dm-key-trust.js');
        return { state: mod.trustState(id), held: mod.heldCount(id) };
    }, peerId);
}

/**
 * The trust banner, as DOM facts rather than a serialised string.
 *
 * Escaped text inside a text node still CONTAINS the characters "<img" and
 * "onerror=", so any check on innerHTML would be a false positive - and a string
 * check that PASSED would prove nothing at all. Ask the DOM what nodes exist.
 */
async function readBanner(page, { payload = HOSTILE, control = CONTROL } = {}) {
    const out = await page.evaluate(async ({ hostile, probe }) => {
        const banner = document.getElementById('dm-key-trust-banner');

        // CONTROL, built from the marker payload: if this ever stops firing, the
        // payload has to be replaced with one that is.
        window.__ptControlFired = 0;
        const holder = document.createElement('div');
        holder.appendChild(document.createRange().createContextualFragment(probe));

        return {
            present: !!banner && banner.textContent.trim().length > 0,
            text: banner ? banner.textContent : '',
            acceptButton: !!document.querySelector('#dm-key-trust-banner .dm-key-trust-accept'),

            // DOM nodes, not a string.
            dangerous: banner
                ? banner.querySelectorAll('img, script, iframe, object, embed, svg, a[href^="javascript:"]').length
                : 0,
            handlerAttrs: banner
                ? [...banner.querySelectorAll('*')]
                    .flatMap((el) => [...el.attributes].map((a) => a.name))
                    .filter((n) => /^on/i.test(n))
                : [],

            // Same question asked of the WHOLE page, in case a sibling renderer
            // turns the name into markup. Scoped to what the payload actually
            // produces - `onerror`/`onload` on a tag, or any handler whose value
            // carries the payload text - because the app legitimately uses
            // inline onclick="window.something()" all over its own markup, and a
            // blanket /^on/ scan would flag those and teach everyone to ignore it.
            pagePayloadHandlers: [...document.querySelectorAll('*')]
                .flatMap((el) => [...el.attributes].map((a) => ({ name: a.name, value: a.value })))
                // Inline event handlers are pervasive and legitimate in this app
                // (`onclick="event.stopPropagation(); window.openProfileCard(2)"`,
                // `ondragstart="return false;"`, ...), so no rule of the form
                // "no on* attributes" can tell them from an injection - it would
                // flag the app's own markup and make the check worthless. Nor can
                // matching attribute VALUES: an inert
                // `title="View <img src=x onerror=alert(1)>'s profile"` is the
                // app's escaping WORKING.
                //
                // So this asks the one question that separates them: does any
                // handler attribute actually execute the payload? `alert(` is the
                // payload's whole point and appears in nothing the app writes.
                .filter((a) => /^on/i.test(a.name) && /alert\s*\(/.test(a.value))
                .map((a) => `${a.name}=${a.value}`),

            // ...and of the banner re-parsed as markup, which is the only way to
            // be sure nothing is hiding behind an encoding the DOM hides.
            reparsed: (() => {
                if (!banner) return { dangerous: 0, handlers: [] };
                const doc = new DOMParser().parseFromString(banner.innerHTML, 'text/html');
                return {
                    dangerous: doc.querySelectorAll('img, script, iframe, object, embed, svg').length,
                    handlers: [...doc.querySelectorAll('*')]
                        .flatMap((el) => [...el.attributes].map((a) => a.name))
                        .filter((n) => /^on/i.test(n)),
                };
            })(),

            controlShape: {
                elements: holder.querySelectorAll('*').length,
                handlers: [...holder.querySelectorAll('*')]
                    .flatMap((el) => [...el.attributes].map((a) => a.name))
                    .filter((n) => /^on/i.test(n)),
            },
        };
    }, { hostile: payload, probe: control });

    // Wait for the control's handler to actually RUN. An attribute merely being
    // present is weaker than an attribute having fired in a real browser, and it
    // is the same guarantee the other assertions need.
    await pollUntil(
        () => page.evaluate(() => window.__ptControlFired === 1),
        { timeout: 10000, what: 'the control payload to fire its handler' }
    );

    return out;
}

/**
 * The Verify panel, opened by clicking the thread's own Verify button.
 *
 * The button TOGGLES, so this only clicks when the panel is closed. Clicking it
 * again to "refresh" would close it and the poll below would then never see a
 * number - a failure that looks like the safety number stopped rendering.
 */
async function openVerifyPanel(page, { reopen = false } = {}) {
    await pollUntil(
        () => page.evaluate(() => !!document.getElementById('dm-key-verify-open')),
        { what: 'the Verify button to be rendered' }
    );

    // `reopen` closes first. The panel is rendered once, when it is opened, so
    // reading it again after something changed (a key accepted) shows the STALE
    // text unless it is actually re-rendered - which the toggle is what causes.
    await page.evaluate((doReopen) => {
        if (!doReopen) return;
        const panel = document.getElementById('dm-key-verify');
        const btn = document.getElementById('dm-key-verify-open');
        if (panel && !panel.hasAttribute('hidden')) btn?.click();   // close
    }, reopen);

    // Pressing the button on every poll iteration, rather than once up front,
    // because openDmConversation() attaches the Verify listener in a
    // fire-and-forget async IIFE AFTER resolving trust - and "trust has
    // resolved" is observable a moment before the listener exists. A click that
    // lands opens the panel and the next read sees it; a click that does not land
    // changes nothing, so this converges without ever toggling the panel shut.
    try {
        return await pollUntil(
            async () => page.evaluate(() => {
                const panel = document.getElementById('dm-key-verify');
                if (!panel) return null;

                if (!panel.hasAttribute('hidden')) {
                    const number = document.getElementById('dm-key-verify-number')?.textContent || '';
                    if (!number) return null;          // open but not rendered yet
                    const markBtn = panel.querySelector('[data-action="mark-verified"]');
                    return {
                        number,
                        marked: document.getElementById('dm-key-verify-marked')?.textContent || '',
                        markDisabled: !!markBtn && markBtn.disabled,
                    };
                }

                document.getElementById('dm-key-verify-open')?.click();
                return null;
            }),
            { what: 'the Verify panel to show a safety number', timeout: 20000 }
        );
    } catch (e) {
        // "timed out, last probe returned null" is useless on its own. Say what
        // the panel actually looks like, so the next reader does not have to
        // re-derive it.
        const state = await page.evaluate(() => {
            const panel = document.getElementById('dm-key-verify');
            const btn = document.getElementById('dm-key-verify-open');
            return {
                panelExists: !!panel,
                panelHidden: panel ? panel.hasAttribute('hidden') : null,
                number: document.getElementById('dm-key-verify-number')?.textContent ?? null,
                marked: document.getElementById('dm-key-verify-marked')?.textContent ?? null,
                buttonExists: !!btn,
                threadPresent: !!document.getElementById('dm-thread'),
            };
        });
        throw new Error(`${e.message}; panel state: ${JSON.stringify(state)}`);
    }
}

// ---------------------------------------------------------------------- tests

test('a peer key change stops the real send, holds every row through the real decrypt, and the real accept button loses nothing', async () => {
    server = await startRealServer({ extraEnv: { GROUPS_ENABLED: 'true' } });

    await registerUser(server.origin, ALICE);
    await registerUser(server.origin, BOB);

    const a = await newUserPage();
    const b = await newUserPage();
    const dialogs = [];
    const errors = [...watchPage(a.page, [], dialogs), ...watchPage(b.page, [], dialogs)];

    await loginUi(a.page, server.origin, ALICE);
    await loginUi(b.page, server.origin, BOB);
    await primePage(a.page);
    await primePage(b.page);

    const aliceId = await a.page.evaluate(() => window.__ptMeId);
    const bobId = await b.page.evaluate(() => window.__ptMeId);

    // 1. Bob opens the thread and sends through his own composer, so a
    //    conversation row exists before Alice ever looks at it.
    await openThread(b.page, aliceId, ALICE);
    const first = await sendThroughComposer(b.page, 'before the rotation');
    assert.equal(first.sent, true, `bob's first send must go out: ${JSON.stringify(first)}`);

    // 2. Alice opens Bob's thread. This is the wiring under test: dm.js calls
    //    resolveTrust(), renderKeyTrustBanner() and bindKeyTrustRelease() here,
    //    and renders every row through addDmMessage -> decryptDmMessage.
    await openThread(a.page, bobId, BOB);

    const pinned = await trustStateOf(a.page, bobId);
    assert.equal(pinned.state, 'ok', 'first contact pins and does not alarm');
    assert.equal(pinned.held, 0);

    const rowsBeforeRotation = await recentRowIds(a.page, bobId);
    assert.equal(rowsBeforeRotation.length, 1, 'one row before the rotation');

    // 3. Bob rotates through the real endpoint, then sends again under the new key.
    const rotated = await rotateInPage(b.page);
    assert.equal(rotated.error, null, `rotation: ${rotated.error}`);
    assert.notEqual(rotated.retired, rotated.installed);

    const second = await sendThroughComposer(b.page, 'after the rotation');
    assert.equal(second.sent, true, `bob's send after rotating must go out: ${JSON.stringify(second)}`);

    // 4. Alice RELOADS: a fresh client that has only ever seen the current key,
    //    with a pin for the retired one. The thread-open path alone must now do
    //    all of the alarming, the holding and the banner.
    await a.page.reload({ waitUntil: 'domcontentloaded' });
    await loginUi(a.page, server.origin, ALICE);
    await primePage(a.page);

    // The hostile name is only ever a DISPLAY string: never an account.
    await openThread(a.page, bobId, HOSTILE);

    const alarmed = await trustStateOf(a.page, bobId);
    assert.equal(alarmed.state, 'changed',
        `alice must be in the changed state after bob rotated; got ${alarmed.state}`);

    // The rows must be held BY THE REAL decrypt path - the thread rendered them,
    // so the hold could only have come from decryptDmMessage().
    const held = await pollUntil(
        async () => {
            const s = await trustStateOf(a.page, bobId);
            return s.held > 0 ? s : null;
        },
        { what: 'the thread to hold the undecryptable rows' }
    );

    const rowsAfterRotation = await recentRowIds(a.page, bobId);
    assert.equal(rowsAfterRotation.length, 2, 'two rows after the rotation');
    assert.equal(held.held, rowsAfterRotation.length,
        `EVERY row must be held while the key is unrecognised: held=${held.held} rows=${rowsAfterRotation.length}`);

    // And nothing may have been rendered into the thread.
    assert.equal(await renderedMessageCount(a.page), 0,
        'a held message must not appear in the thread');
    assert.ok(!(await renderedText(a.page)).includes('before the rotation'),
        'a held message must not be readable in the thread');

    // 5. The banner, and the DOM-safety assertions. Guard first: an assertion
    //    about a banner that does not exist, or exists empty, is vacuous.
    const banner = await readBanner(a.page);

    assert.ok(banner.present, 'the banner must exist and carry text');
    assert.ok(banner.text.includes(HOSTILE),
        `the hostile name must still be shown, as text: ${banner.text}`);
    assert.equal(banner.acceptButton, true,
        'the banner must render the accept button the test is about to click');

    // CONTROL: the payload really is live markup. Without this, "no dangerous
    // elements" could be true because the payload is inert rather than because
    // the banner is safe.
    assert.ok(banner.controlShape.elements > 0,
        `the control produced no elements, so the checks below are vacuous: ${JSON.stringify(banner.controlShape)}`);
    assert.ok(banner.controlShape.handlers.includes('onerror'),
        `the control produced no handler, so the checks below are vacuous: ${JSON.stringify(banner.controlShape)}`);

    assert.equal(banner.dangerous, 0,
        `the hostile name became an element: ${banner.text}`);
    assert.deepEqual(banner.handlerAttrs, [],
        `an event handler attribute leaked into the banner: ${banner.text}`);
    assert.deepEqual(banner.reparsed.dangerous, 0,
        `the re-parsed banner contains live elements: ${banner.text}`);
    assert.deepEqual(banner.reparsed.handlers, [],
        `the re-parsed banner contains event handlers: ${banner.text}`);
    assert.deepEqual(banner.pagePayloadHandlers, [],
        'the payload produced a live handler somewhere on the page');

    // The decisive one. If the hostile name had become markup, `src=x` would
    // 404, `onerror` would fire and alert(1) would open a modal dialog - and
    // with nothing to dismiss it the whole renderer hangs, which is how this
    // regression presents. A recorded dialog is a loud, fast failure instead.
    assert.deepEqual(dialogs, [],
        `the hostile payload EXECUTED: it opened ${dialogs.length} dialog(s) - ${dialogs.join(' | ')}`);

    // 6. The REAL send path must refuse. Nothing about the gate is called here:
    //    dm.js's own composer runs encryptForActivePeer() -> the gate.
    const blocked = await sendThroughComposer(a.page, 'this must not go out');
    assert.equal(blocked.sent, false,
        `the composer cleared its input, so the blocked message went out: ${JSON.stringify(blocked)}`);
    assert.equal(blocked.leftBehind, 'this must not go out',
        `a refused send must leave the text in the composer: ${JSON.stringify(blocked)}`);

    // Proof from the server's side, not from the page's own report.
    const rowsAfterBlockedSend = await recentRowIds(a.page, bobId);
    assert.deepEqual(rowsAfterBlockedSend, rowsAfterRotation,
        'the blocked message must not have been stored at all');

    // 7. Click the REAL accept button. Nothing is dispatched by hand and the
    //    release handler is dm.js's own, installed by openDmConversation().
    await clickAcceptButton(a.page, errors);

    // Bounded poll on the postcondition the release actually produces: the queue
    // drained AND both messages rendered. The previous version waited 400ms and
    // then asserted on whatever had happened.
    await pollUntil(
        async () => {
            const s = await trustStateOf(a.page, bobId);
            if (s.held !== 0) return null;
            const rendered = await renderedMessageCount(a.page);
            return rendered >= 2 ? { state: s.state, rendered } : null;
        },
        { timeout: 15000, what: 'the held rows to be released and rendered' }
    );

    const afterAccept = await trustStateOf(a.page, bobId);
    assert.equal(afterAccept.state, 'ok', 'accepting must clear the alarm');
    assert.equal(afterAccept.held, 0, 'the held queue must be drained');

    // NO MESSAGE LOSS. Both texts, including the one encrypted to the RETIRED key,
    // must be readable in the thread. Read from the DOM, not from the module.
    const finalText = await renderedText(a.page);
    assert.ok(finalText.includes('before the rotation'),
        `the pre-rotation message must appear after accepting: ${finalText.slice(0, 200)}`);
    assert.ok(finalText.includes('after the rotation'),
        `the post-rotation message must appear after accepting: ${finalText.slice(0, 200)}`);

    // And the gate must be open again, through the real path.
    const after = await sendThroughComposer(a.page, 'after accepting');
    assert.equal(after.sent, true,
        `sending must work again after accepting: ${JSON.stringify(after)}`);

    assert.deepEqual(dialogs, [],
        `the hostile payload EXECUTED at some point: ${dialogs.join(' | ')}`);
});

test('both sides show the IDENTICAL safety number, and a key change clears the verified flag', async () => {
    if (!server) server = await startRealServer({ extraEnv: { GROUPS_ENABLED: 'true' } });
    if (!server) return assert.fail('no server');

    const a = await newUserPage();
    const b = await newUserPage();
    const dialogs = [];
    const errors = [...watchPage(a.page, [], dialogs), ...watchPage(b.page, [], dialogs)];

    await loginUi(a.page, server.origin, ALICE);
    await loginUi(b.page, server.origin, BOB);
    await primePage(a.page);
    await primePage(b.page);

    const aliceId = await a.page.evaluate(() => window.__ptMeId);
    const bobId = await b.page.evaluate(() => window.__ptMeId);

    // A conversation has to exist before either side opens a thread.
    await openThread(b.page, aliceId, ALICE);
    const seed = await sendThroughComposer(b.page, 'let us compare keys');
    assert.equal(seed.sent, true,
        `a conversation must exist before either side opens a thread: ${JSON.stringify(seed)}`);

    await openThread(a.page, bobId, BOB);
    await openThread(b.page, aliceId, ALICE);

    // Both open the thread's own Verify panel by clicking its own button.
    const aliceSees = await openVerifyPanel(a.page);
    const bobSees = await openVerifyPanel(b.page);

    // Non-vacuity: a panel that rendered nothing would compare equal to nothing.
    assert.ok(aliceSees.number.length > 0, 'alice must be shown a safety number');
    assert.ok(bobSees.number.length > 0, 'bob must be shown a safety number');

    // Shape: 60 digits in 12 groups of five. Asserted so that "identical" cannot
    // be satisfied by two empty strings or by a placeholder.
    const shape = /^(?:\d{5} ){11}\d{5}$/;
    assert.ok(shape.test(aliceSees.number),
        `the safety number must be 12 groups of 5 digits: ${JSON.stringify(aliceSees.number)}`);
    assert.equal(aliceSees.number.replace(/\D/g, '').length, 60,
        `the safety number must be 60 digits: ${JSON.stringify(aliceSees.number)}`);

    assert.equal(aliceSees.number, bobSees.number,
        `the two sides must show the same safety number; alice ${JSON.stringify(aliceSees.number)} vs bob ${JSON.stringify(bobSees.number)}`);

    // Nobody has marked it yet.
    assert.match(aliceSees.marked, /Not yet marked/,
        `a fresh conversation must not claim to be verified: ${aliceSees.marked}`);

    // Alice marks it, through the panel's own button.
    await a.page.click('#dm-key-verify [data-action="mark-verified"]');
    await pollUntil(
        async () => {
            const t = await a.page.evaluate(
                () => document.getElementById('dm-key-verify-marked')?.textContent || ''
            );
            return /Marked as verified/.test(t) ? t : null;
        },
        { what: 'the panel to record the verification' }
    );

    // Bob rotates. Alice's VERIFIED flag is about the key she actually compared,
    // so it must NOT carry over to the new one.
    const rotated = await rotateInPage(b.page);
    assert.equal(rotated.error, null, `rotation: ${rotated.error}`);

    await a.page.reload({ waitUntil: 'domcontentloaded' });
    await loginUi(a.page, server.origin, ALICE);
    await primePage(a.page);
    await openThread(a.page, bobId, BOB);

    const afterChange = await openVerifyPanel(a.page);

    // The number is for a different key now.
    assert.notEqual(afterChange.number, aliceSees.number,
        'a rotated key must produce a different safety number');

    // And the verified flag must be GONE.
    //
    // This was a real bug. The flag lives on the pin's `verifiedAt`, which
    // describes pin.current - the PREVIOUS key. renderVerifyView read it without
    // looking at the evaluation state, so while the state was 'changed' it told
    // the user they had verified a number they had never seen. It also left the
    // Mark button live, and pressing it would have stamped the old key.
    assert.match(afterChange.marked, /Not yet marked/,
        `the verified flag must be cleared after a key change: ${afterChange.marked}`);
    assert.ok(!/Marked as verified/.test(afterChange.marked),
        `the verify view still claims the NEW key was verified: ${afterChange.marked}`);
    assert.equal(afterChange.markDisabled, true,
        'the Mark button must be disabled while the key is unrecognised');

    // Pressing it anyway must not stamp the NEW key.
    //
    // Note what is NOT being asserted here: verifiedAt is not null yet. The flag
    // describes the key Alice actually compared, and it is cleared when she
    // ACCEPTS the new one (asserted below), not the moment the key changes -
    // otherwise accepting would hand the new key the old key's verification.
    // What must hold is that this button cannot change it.
    const beforeForced = await readPin(a.page, bobId);
    assert.ok(beforeForced, 'the pin must still exist');
    assert.ok(beforeForced.verifiedAt,
        'the earlier "mark verified" must still be recorded at this point');

    await a.page.evaluate(() => {
        const btn = document.querySelector('#dm-key-verify [data-action="mark-verified"]');
        btn?.removeAttribute('disabled');           // defeat the UI guard
        btn?.click();
    });

    const afterForced = await readPin(a.page, bobId);
    assert.equal(afterForced.verifiedAt, beforeForced.verifiedAt,
        'the Mark button must not be able to stamp an unrecognised key as verified');
    assert.equal(afterForced.current, beforeForced.current,
        'the pinned key must not move');

    // Accepting. The button is labelled "I verified the new key", so accepting IS
    // the user asserting they compared the numbers - which is why
    // acceptPeerKey() stamps verifiedAt. The flag now belongs to the NEW key.
    const beforeAccept = await readPin(a.page, bobId);
    await clickAcceptButton(a.page, errors);

    const accepted = await pollUntil(
        async () => {
            const s = await trustStateOf(a.page, bobId);
            return s.state === 'ok' ? s : null;
        },
        { what: 'the alarm to clear after accepting' }
    );
    assert.equal(accepted.state, 'ok');

    const stored = await readPin(a.page, bobId);
    assert.ok(stored.verifiedAt && stored.verifiedAt >= beforeAccept.verifiedAt,
        `accepting is the user claiming verification, so verifiedAt must move forward; ${JSON.stringify(stored)} vs ${JSON.stringify(beforeAccept)}`);
    assert.notEqual(stored.current, beforeAccept.current,
        'accepting must move the pin to the new key');

    // ...and now the flag DOES describe the key on screen, so the view says so
    // and the Mark button is available again.
    const afterAcceptView = await openVerifyPanel(a.page, { reopen: true });
    assert.match(afterAcceptView.marked, /Marked as verified/,
        `the accepted key was verified by pressing the button; the view must say so: ${afterAcceptView.marked}`);
    assert.equal(afterAcceptView.markDisabled, false,
        'the Mark button must be available again once the key is accepted');
});

test('a normal password change does NOT raise the alarm (real credential flow)', async () => {
    if (!server) return assert.fail('no server');

    const b = await newUserPage();
    await loginUi(b.page, server.origin, BOB);
    await primePage(b.page);

    const a = await newUserPage();
    await loginUi(a.page, server.origin, ALICE);
    await primePage(a.page);

    const aliceId = await a.page.evaluate(() => window.__ptMeId);
    const bobId = await b.page.evaluate(() => window.__ptMeId);

    // Alice pins Bob's current key by opening the thread.
    await openThread(a.page, bobId, BOB);
    assert.equal((await trustStateOf(a.page, bobId)).state, 'ok');

    // Bob changes his PASSWORD (not his key) through the real endpoint.
    const changed = await changePasswordInPage(b.page, 'An0therPassw0rd!');
    assert.equal(changed.error, null, `password change: ${changed.error}`);

    // Alice reloads and re-opens the thread: the identity key is unchanged, so
    // nothing may alarm.
    await a.page.reload({ waitUntil: 'domcontentloaded' });
    await loginUi(a.page, server.origin, ALICE);
    await primePage(a.page);
    await openThread(a.page, bobId, BOB);

    const after = await trustStateOf(a.page, bobId);
    assert.equal(after.state, 'ok',
        `a password change must not alarm; state was ${after.state}`);

    const banner = await readBanner(a.page);
    assert.equal(banner.present, false, 'no banner for a password change');

    // And messaging still works afterwards.
    await openThread(b.page, aliceId, ALICE);
    const sent = await sendThroughComposer(b.page, 'after my password change');
    assert.equal(sent.sent, true, `send after password change: ${JSON.stringify(sent)}`);
});