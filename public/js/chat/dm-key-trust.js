// public/js/chat/dm-key-trust.js
//
// The DM-thread side of peer key trust (Phase 2 of docs/e2ee-dm-hardening.md).
//
// Responsibilities, and nothing else:
//   - resolve the trust state for the open conversation;
//   - BLOCK SENDING while the peer's key is unrecognised;
//   - HOLD messages that arrived under an unrecognised key instead of rendering
//     them, and release them once the user accepts - so accepting must never lose
//     a message;
//   - render the safety-number view and the changed-key banner.
//
// This is the UI half. What actually stops a substituted key is one layer down:
// the crypto layer only encrypts to bytes keys/peer-key-gate.js has just checked,
// and only decrypts with keys already in the pin, whatever this module has or has
// not been asked to do first.
//
// ACCEPTING IS NOT VERIFYING. Accepting says "let me read my messages and keep
// talking"; verifying says "I compared the numbers". They are two actions so that
// getting past the alarm never requires claiming a comparison nobody made, and so
// "verified" keeps meaning something.
//
// DOM SAFETY
// Every peer-controlled string (the username) is written with textContent or as
// an attribute value assigned through the DOM, NEVER via innerHTML. There is no
// innerHTML anywhere in this file. That is deliberate and is what
// tests/peer-trust-xss.test.mjs pins.
//
// It changes no wire format: no HKDF info, no AAD, no envelope field.

import { getCurrentUser } from '../core/auth.js';
import { getServerEndpoint } from '../core/server.js';
import {
    getPeerPublicKeyBase64
} from '../crypto/keys/peer-keys.js';

import {
    clearChangedGroupPeer,
    evaluateAndPin,
    PeerKeyChangedError
} from '../crypto/keys/peer-key-gate.js';
import { getCurrentIdentity } from '../crypto/identity-service.js';
import {
    computeSafetyNumber,
    getPeerPin,
    acceptPeerKey,
    markPeerVerified,
} from '../crypto/keys/peer-trust.js';

const IDS = {
    banner: 'dm-key-trust-banner',
    actions: 'dm-key-trust-actions',
    verify: 'dm-key-verify',
    verifyOpen: 'dm-key-verify-open',
    verifyNumber: 'dm-key-verify-number',
    verifyWho: 'dm-key-verify-who',
    verifyMarked: 'dm-key-verify-marked',
};

/**
 * peerId -> { held: Array<{id, msg}>, state, pending, wasVerified }
 *
 * `held` keeps the RAW server rows, not decrypted text, so releasing after an
 * accept re-runs the normal decrypt+render path and nothing is lost or rendered
 * from a cache of half-decrypted values.
 */
const held = new Map();

/** The listener a render attached to a Mark button, so the next render can drop it. */
const markListeners = new WeakMap();

export function heldCount(peerId) {
    return held.get(Number(peerId))?.held.length ?? 0;
}

export function trustState(peerId) {
    return held.get(Number(peerId))?.state ?? 'unknown';
}

function slot(peerId) {
    const id = Number(peerId);
    if (!held.has(id)) {
        held.set(id, { held: [], state: 'unknown', pending: null, wasVerified: false });
    }
    return held.get(id);
}

function ctx() {
    const origin = getServerEndpoint();
    const ownUserId = Number(getCurrentUser()?.id);

    if (!origin || !Number.isInteger(ownUserId) || ownUserId <= 0) {
        return null;
    }

    return { origin: String(origin), ownUserId };
}

/**
 * Drop every key derived for this peer, after the pin changed under it.
 *
 * Loaded lazily, the same way this module's callers reach session.js: the group UI
 * tests mock that module with only the exports the code under test uses.
 */
async function forgetDerivedKeys(peerId) {
    const { removeSessionKey } = await import('../crypto/keys/session.js');
    removeSessionKey(peerId);
}

/* =========================================================
 * Trust resolution
 * ========================================================= */

/**
 * Work out the trust state for a peer and apply TOFU on first contact.
 *
 * `pending` is the key the user is being asked about, and it stays the FIRST one
 * they were told about until they act. The number on the verify panel and the key
 * the accept button pins both read it, so they cannot disagree: a server that
 * changes its answer while the user is comparing digits does not get the new key
 * accepted under the old key's number. It just raises a fresh alarm afterwards.
 *
 * @param {number} peerId
 * @returns {Promise<{state: string, publicKey: string|null, fingerprint: string|null, pending: object|null, pin: object|null}>}
 */
export async function resolveTrust(peerId) {
    const context = ctx();
    if (!context) {
        return { state: 'unknown', publicKey: null, fingerprint: null, pending: null, pin: null };
    }

    // Fetched once. The evaluation below is about these bytes and no others.
    let publicKey;
    try {
        publicKey = await getPeerPublicKeyBase64(Number(peerId));
    } catch {
        return { state: 'no-key', publicKey: null, fingerprint: null, pending: null, pin: null };
    }

    // TOFU: the very first time we meet this peer we pin what we see and carry
    // on. Never overwrites an existing pin.
    const evaluated = await evaluateAndPin(peerId, publicKey, context);

    const s = slot(peerId);
    s.state = evaluated.state;
    s.pending = evaluated.state === 'changed' ? (s.pending ?? evaluated.pending) : null;
    s.wasVerified = evaluated.state === 'changed' && Boolean(evaluated.pin?.verifiedAt);

    // The pin is shared with the group gate. If this resolution sees a known
    // or re-known key, any group "not receiving" marker for the peer is stale.
    if (evaluated.state !== 'changed') {
        clearChangedGroupPeer(peerId);
    }

    return {
        state: evaluated.state,
        publicKey,
        fingerprint: evaluated.fingerprint,
        pending: s.pending,
        pin: evaluated.pin,
    };
}

/**
 * May a message be decrypted and shown?
 *
 * Returns false while the peer's key is unrecognised; the caller then HOLDs the
 * row. Holding is what stops a substituted key from being used to decrypt
 * anything at all — we never hand the row to the crypto layer.
 */
export function shouldHoldMessage(peerId) {
    return trustState(peerId) === 'changed';
}

export function holdMessage(peerId, msg) {
    const s = slot(peerId);
    if (!s.held.some((h) => Number(h.id) === Number(msg.id))) {
        s.held.push({ id: msg.id, msg });
    }
}

export function takeHeldMessages(peerId) {
    const s = held.get(Number(peerId));
    if (!s) return [];
    const out = s.held;
    s.held = [];
    return out;
}

export function clearHeldMessages(peerId) {
    const s = held.get(Number(peerId));
    if (s) s.held = [];
}

/* =========================================================
 * Send gate
 * ========================================================= */

/**
 * Throws PeerKeyChangedError while the peer's key is unrecognised.
 *
 * This keeps the thread's own state and banner current. It does not choose the key:
 * the encryption goes through the gate itself and derives from what that returns.
 */
export async function assertCanSendTo(peerId) {
    const state = await resolveTrust(peerId);

    if (state.state === 'changed') {
        throw new PeerKeyChangedError(peerId);
    }

    return state;
}

/* =========================================================
 * Accept
 * ========================================================= */

/**
 * The explicit "accept this new key" action. It does not mark the key verified.
 *
 * After this, the key is current AND recorded in `accepted`, so a later rotation
 * back to it is recognised rather than alarming again.
 *
 * What gets pinned is `pending`: the key the user was told about, never a fresh
 * answer from the server (see resolveTrust). The group banner can get here without
 * a DM thread having resolved this peer, so that one case resolves first, with no
 * digits on screen yet to disagree with.
 */
export async function acceptNewKey(peerId) {
    const context = ctx();
    if (!context) throw new Error('No signed-in account');

    const s = slot(peerId);

    if (!s.pending) {
        const trust = await resolveTrust(peerId);

        if (trust.state === 'no-key' || trust.state === 'unknown') {
            throw new Error("Could not read this contact's current key. Try again.");
        }
    }

    // Nothing is waiting: the key is no longer one this device needs to ask about.
    if (!s.pending) {
        return getPeerPin(peerId, context);
    }

    const pin = await acceptPeerKey(peerId, s.pending.publicKey, context);

    s.state = 'ok';
    s.pending = null;
    s.wasVerified = false;

    // The group banner reads the same changed-peer list; clear it here so a DM
    // accept and a group accept cannot leave different views disagreeing.
    clearChangedGroupPeer(peerId);

    await forgetDerivedKeys(peerId);

    return pin;
}

/* =========================================================
 * Rendering
 *
 * textContent / setAttribute only. No innerHTML, no template strings carrying
 * peer data.
 * ========================================================= */

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

export function renderKeyTrustBanner(peerId, username) {
    const bar = document.getElementById(IDS.banner);
    if (!bar) return;

    // Emptied rather than removed: a key can change while the thread is open, and
    // the bar has to still be here when it does. An empty bar is hidden by its CSS.
    if (trustState(peerId) !== 'changed') {
        bar.replaceChildren();
        return;
    }

    // Already showing. This runs for every held row, and re-rendering would swap
    // out a button the user may be in the middle of pressing.
    if (bar.childElementCount > 0) return;

    const text = el('span', 'dm-key-trust-text');
    // Plain text; the username is a peer-controlled string and never becomes HTML.
    text.textContent = slot(peerId).wasVerified
        ? `${username}'s key changed after you verified it. This can mean someone is ` +
          'intercepting this conversation. Compare safety numbers again before accepting. ' +
          'Messages are held until then.'
        : `${username} is using a new key. Messages are held until you accept it. ` +
          'Compare safety numbers first if you can.';
    bar.appendChild(text);

    // The header's Verify button owns opening the panel; this is the same action,
    // placed where the user is being asked to decide.
    const review = el('button', 'btn btn-ghost dm-key-trust-verify', 'View safety number');
    review.type = 'button';
    review.addEventListener('click', () => {
        const panel = document.getElementById(IDS.verify);
        if (panel?.hasAttribute('hidden')) {
            document.getElementById(IDS.verifyOpen)?.click();
        }
    });
    bar.appendChild(review);

    const btn = el('button', 'btn btn-warn dm-key-trust-accept', 'Accept new key');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            await acceptNewKey(peerId);
        } catch (e) {
            console.error('Could not accept the new peer key:', e);
            btn.disabled = false;
            return;
        }
        bar.replaceChildren();
        // Deliberately NO clearHeldMessages() here.
        //
        // The release listener (bindKeyTrustRelease) drains the queue with
        // takeHeldMessages(); clearing it first emptied `held` before the event
        // was dispatched, so clicking this button - the only way a user can reach
        // this code - discarded every held message. The backlog was only ever
        // released because the previous version of the test dispatched the event
        // itself instead of pressing the button, and so never took this path.
        document.dispatchEvent(new CustomEvent('dm-key-trust-accepted', {
            detail: { peerId: Number(peerId) },
        }));

        // An open panel still shows the pre-accept state, with Mark disabled.
        if (document.getElementById(IDS.verify)?.hasAttribute('hidden') === false) {
            await renderVerifyView(peerId, username);
        }
    });
    bar.appendChild(btn);
}

export function hideKeyTrustBanner() {
    document.getElementById(IDS.banner)?.remove();
}

/**
 * Wire the "released after accept" path for the currently open conversation.
 *
 * Managed as a SINGLE document listener: the DM thread is rebuilt for every
 * conversation, so a listener added per thread would accumulate and fire the
 * release loop once per historical thread. Binding again replaces the previous
 * binding.
 *
 * @param {number} peerId
 * @param {(msg: object) => Promise<void>} deliver re-runs the normal
 *   decrypt+render path for one raw row. Passed in so this module does not have
 *   to import the DM cache, and so the test can substitute a recorder.
 * @param {() => void} [afterRelease] runs once the queue has drained.
 */
export function bindKeyTrustRelease(peerId, deliver, afterRelease) {
    unbindKeyTrustRelease();

    const handler = async (event) => {
        if (Number(event.detail?.peerId) !== Number(peerId)) return;
        for (const { msg } of takeHeldMessages(peerId)) {
            try {
                await deliver(msg);
            } catch (e) {
                console.error(`Failed to release held DM ${msg.id}:`, e);
            }
        }
        afterRelease?.();
    };

    releaseBinding = { handler };
    document.addEventListener('dm-key-trust-accepted', handler);
}

export function unbindKeyTrustRelease() {
    if (!releaseBinding) return;
    document.removeEventListener('dm-key-trust-accepted', releaseBinding.handler);
    releaseBinding = null;
}

let releaseBinding = null;

export async function renderVerifyView(peerId, username, { ids = IDS } = {}) {
    const panel = document.getElementById(ids.verify);
    if (!panel) return null;

    const context = ctx();
    if (!context) return null;

    const trust = await resolveTrust(peerId);
    if (!trust.publicKey) return null;

    const identity = getCurrentIdentity();
    if (!identity?.publicKey) return null;

    // While the key is unrecognised the digits are for `pending`: the same key the
    // accept button would pin, so what the user compares is what they accept.
    const shownKey = trust.state === 'changed' ? trust.pending.publicKey : trust.publicKey;
    const { fingerprint, number } = await computeSafetyNumber(identity.publicKey, shownKey);

    const numberEl = document.getElementById(ids.verifyNumber);
    const whoEl = document.getElementById(ids.verifyWho);
    const markedEl = document.getElementById(ids.verifyMarked);

    // Digits and a username: textContent, never innerHTML.
    if (numberEl) numberEl.textContent = number;
    if (whoEl) whoEl.textContent = username;

    // `verifiedAt` belongs to the key this device PINNED - `pin.current`. In any
    // state but 'ok' the key on screen is not `pin.current`, so the flag describes
    // a different key from the number the user is being asked to compare. Showing
    // it would claim the user verified something they never saw.
    //
    // This was a real bug: until they act, this view reported the PREVIOUS key's
    // verification against the NEW key's safety number, and offered a Mark button
    // that would have stamped the old key.
    //
    // Note this is NOT about when verifiedAt is cleared. It is cleared only when
    // a key becomes pinned: pinOnFirstUse() and acceptPeerKey() both write null,
    // because neither trusting on first sight nor accepting is a comparison. So a
    // pin that is verified and then changed keeps a stale verifiedAt on purpose;
    // it is this view's job not to read it as if it described the pending key.
    const verifiedHere = trust.state === 'ok' && Boolean(trust.pin?.verifiedAt);

    if (markedEl) {
        markedEl.textContent = verifiedHere
            ? 'Marked as verified on this device.'
            : 'Not yet marked as verified on this device.';
    }

    const markBtn = panel.querySelector('[data-action="mark-verified"]');
    if (markBtn) {
        // One listener per button, however often the panel is rendered: one left
        // over from an earlier render would still run when this one has none.
        const previous = markListeners.get(markBtn);
        if (previous) markBtn.removeEventListener('click', previous);
        markListeners.delete(markBtn);

        if (trust.state !== 'ok') {
            // Same reason: pressing this would stamp the pinned key, not the one
            // whose digits are on screen. Offer nothing rather than something
            // that means the wrong thing.
            markBtn.disabled = true;
            markBtn.title = trust.state === 'changed'
                ? 'Accept the new key for this conversation first.'
                : 'This is not the key pinned on this device.';
        } else {
            markBtn.disabled = false;
            markBtn.title = '';

            const listener = async () => {
                const marked = await markPeerVerified(peerId, context, trust.fingerprint);

                // The pinned key moved after these digits were drawn. Nothing was
                // marked, so show the user what is true now.
                if (!marked) {
                    await renderVerifyView(peerId, username, { ids });
                    return;
                }

                await forgetDerivedKeys(peerId);
                if (markedEl) markedEl.textContent = 'Marked as verified on this device.';
            };

            markListeners.set(markBtn, listener);
            markBtn.addEventListener('click', listener);
        }
    }

    return { fingerprint, number };
}

// A logout must not leave one account's held rows, or a key it was being asked
// about, for the next account on this page. A 401-triggered logout does not reload.
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('wire:logout', () => {
        held.clear();
    });
}

export const KEY_TRUST_IDS = IDS;