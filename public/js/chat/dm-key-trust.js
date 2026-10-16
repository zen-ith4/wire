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
// DOM SAFETY
// Every peer-controlled string (the username) is written with textContent or as
// an attribute value assigned through the DOM, NEVER via innerHTML. There is no
// innerHTML anywhere in this file. That is deliberate and is what
// tests/peer-trust-xss.test.mjs pins.
//
// It changes no wire format: no HKDF info, no AAD, no envelope field.

import { getCurrentUser } from '../core/auth.js';
import { getServerEndpoint } from '../core/server.js';
import { getPeerPublicKey, getPeerKeyCandidates } from '../crypto/keys/peer-keys.js';
import { getCurrentIdentity } from '../crypto/identity-service.js';
import {
    computeSafetyNumber,
    evaluatePeerKey,
    pinOnFirstUse,
    acceptPeerKey,
    markPeerVerified,
    mayTryRetiredKey,
} from '../crypto/keys/peer-trust.js';

const IDS = {
    banner: 'dm-key-trust-banner',
    actions: 'dm-key-trust-actions',
    verify: 'dm-key-verify',
    verifyNumber: 'dm-key-verify-number',
    verifyWho: 'dm-key-verify-who',
    verifyMarked: 'dm-key-verify-marked',
};

/**
 * peerId -> { held: Array<{id, msg}>, state, pending }
 *
 * `held` keeps the RAW server rows, not decrypted text, so releasing after an
 * accept re-runs the normal decrypt+render path and nothing is lost or rendered
 * from a cache of half-decrypted values.
 */
const held = new Map();

export function heldCount(peerId) {
    return held.get(Number(peerId))?.held.length ?? 0;
}

export function trustState(peerId) {
    return held.get(Number(peerId))?.state ?? 'unknown';
}

function slot(peerId) {
    const id = Number(peerId);
    if (!held.has(id)) {
        held.set(id, { held: [], state: 'unknown', pending: null });
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

/** The peer's CURRENT public key, base64. Throws if the peer has none. */
async function currentPeerKey(peerId) {
    const key = await getPeerPublicKey(Number(peerId));
    // getPeerPublicKey imports non-extractable, so the base64 comes from the same
    // endpoint as the CryptoKey rather than being exported back out of it.
    const { api } = await import('../core/api.js');
    const data = await api(`/api/me/identity-key/${Number(peerId)}`);
    if (typeof data?.publicKey !== 'string') {
        throw new Error('Peer has no identity key');
    }
    return data.publicKey;
}

/* =========================================================
 * Trust resolution
 * ========================================================= */

/**
 * Work out the trust state for a peer and apply TOFU on first contact.
 *
 * @param {number} peerId
 * @returns {Promise<{state: string, fingerprint: string|null, pending: object|null}>}
 */
export async function resolveTrust(peerId) {
    const context = ctx();
    if (!context) {
        return { state: 'unknown', fingerprint: null, pending: null };
    }

    let publicKey;
    try {
        publicKey = await currentPeerKey(peerId);
    } catch {
        return { state: 'no-key', fingerprint: null, pending: null };
    }

    let evaluated = await evaluatePeerKey(peerId, publicKey, context);

    // TOFU: the very first time we meet this peer we pin what we see and carry
    // on. Never overwrites an existing pin. The peer's retired keys come from the
    // same exchange and are recorded with it - see pinOnFirstUse(), which
    // explains why that is TOFU rather than a hole.
    if (evaluated.state === 'first-contact') {
        let retired = [];
        try {
            retired = (await getPeerKeyCandidates(peerId)).history;
        } catch {
            retired = [];
        }
        await pinOnFirstUse(peerId, publicKey, context, retired);
        evaluated = { ...evaluated, state: 'ok' };
    }

    const s = slot(peerId);
    s.state = evaluated.state;
    s.pending = evaluated.pending;

    return { state: evaluated.state, fingerprint: evaluated.fingerprint, pending: evaluated.pending };
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

export class SendBlockedError extends Error {
    constructor(peerId) {
        super("This peer's key has changed. Verify the new key before sending.");
        this.name = 'SendBlockedError';
        this.code = 'PEER_KEY_CHANGED';
        this.peerId = Number(peerId);
    }
}

/** Throws SendBlockedError while the peer's key is unrecognised. */
export async function assertCanSendTo(peerId) {
    const state = await resolveTrust(peerId);

    if (state.state === 'changed') {
        throw new SendBlockedError(peerId);
    }

    return state;
}

/* =========================================================
 * Accept
 * ========================================================= */

/**
 * The explicit "I verified / accept new key" action.
 *
 * After this, the key is current AND recorded in `accepted`, so a later rotation
 * back to it is recognised rather than alarming again.
 */
export async function acceptNewKey(peerId) {
    const context = ctx();
    if (!context) throw new Error('No signed-in account');

    const publicKey = await currentPeerKey(peerId);
    const pin = await acceptPeerKey(peerId, publicKey, context);

    const s = slot(peerId);
    s.state = 'ok';
    s.pending = null;

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

    if (trustState(peerId) !== 'changed') {
        bar.remove();
        return;
    }

    bar.replaceChildren();

    const text = el('span', 'dm-key-trust-text');
    // Plain text; the username is a peer-controlled string and never becomes HTML.
    text.textContent =
        `${username} is using a new key. Messages are held until you verify it.`;
    bar.appendChild(text);

    const btn = el('button', 'btn btn-warn dm-key-trust-accept', 'I verified the new key');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        await acceptNewKey(peerId);
        bar.remove();
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
 */
export function bindKeyTrustRelease(peerId, deliver) {
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

export async function renderVerifyView(peerId, username) {
    const panel = document.getElementById(IDS.verify);
    if (!panel) return null;

    const context = ctx();
    if (!context) return null;

    let publicKey;
    try {
        publicKey = await currentPeerKey(peerId);
    } catch {
        return null;
    }

    const identity = getCurrentIdentity();
    if (!identity?.publicKey) return null;

    const { fingerprint, number } = await computeSafetyNumber(identity.publicKey, publicKey);

    const numberEl = document.getElementById(IDS.verifyNumber);
    const whoEl = document.getElementById(IDS.verifyWho);
    const markedEl = document.getElementById(IDS.verifyMarked);

    // Digits and a username: textContent, never innerHTML.
    if (numberEl) numberEl.textContent = number;
    if (whoEl) whoEl.textContent = username;

    const pin = await evaluatePeerKey(peerId, publicKey, context);

    // `verifiedAt` belongs to the key this device PINNED - `pin.current`. While the
    // evaluation is 'changed' the key on screen is `pin.pending`, not
    // `pin.current`, so the flag describes a different key from the number the
    // user is being asked to compare. Showing it would claim the user verified
    // something they never saw.
    //
    // This was a real bug: until they act, this view reported the PREVIOUS key's
    // verification against the NEW key's safety number, and offered a Mark button
    // that would have stamped the old key.
    //
    // Note this is NOT about when verifiedAt is cleared. It is cleared only when
    // a key becomes pinned: pinOnFirstUse() writes null (trust on first sight is
    // not verification), and acceptPeerKey() writes Date.now() - correctly, since
    // the button that calls it is labelled "I verified the new key" and is the
    // user asserting exactly that. So a pin that is verified and then changed
    // keeps a stale verifiedAt on purpose; it is this view's job not to read it
    // as if it described the pending key.
    const verifiedHere = pin.state !== 'changed' && Boolean(pin.pin?.verifiedAt);

    if (markedEl) {
        markedEl.textContent = verifiedHere
            ? 'Marked as verified on this device.'
            : 'Not yet marked as verified on this device.';
    }

    const markBtn = panel.querySelector('[data-action="mark-verified"]');
    if (markBtn) {
        if (pin.state === 'changed') {
            // Same reason: pressing this would stamp the old pinned key, not the
            // one whose digits are on screen. Offer nothing rather than something
            // that means the wrong thing.
            markBtn.disabled = true;
            markBtn.title = 'Accept the new key for this conversation first.';
        } else {
            markBtn.disabled = false;
            markBtn.addEventListener('click', async () => {
                const marked = await markPeerVerified(peerId, context);
                if (markedEl && marked) markedEl.textContent = 'Marked as verified on this device.';
            }, { once: true });
        }
    }

    return { fingerprint, number };
}

export const KEY_TRUST_IDS = IDS;