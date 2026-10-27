// public/js/chat/group-key-trust.js
//
// The group-thread banner for R1 (group KDM key pinning). This is the UI half
// of crypto/keys/peer-key-gate.js: the gate records peers whose identity key
// changed and whose KDM was therefore skipped/held, and this module turns that
// list plus the current member roster into one banner with one accept button
// and one safety-number link per affected member. The buttons are delegated
// [data-action] hooks; group.js owns the click handler.
//
// The pin itself, the accept action and the held DM state stay in
// dm-key-trust.js — accepting here calls the SAME acceptNewKey() so a key
// accepted in a group is accepted for DMs too. No wire change.
//
// DOM SAFETY
// Every member-controlled string (the username) is written with textContent.
// There is no innerHTML anywhere in this file.

import {
    getChangedGroupPeers
} from '../crypto/keys/peer-key-gate.js';

import {
    acceptNewKey,
    renderVerifyView
} from './dm-key-trust.js';


const BANNER_ID = 'group-key-trust-banner';

// The group shell has its own safety-number panel; renderVerifyView() is the
// same implementation the DM thread uses, parameterised by ids so the two
// panels can coexist in the DOM.
export const GROUP_VERIFY_IDS = {
    verify: 'group-key-verify',
    verifyNumber: 'group-key-verify-number',
    verifyWho: 'group-key-verify-who',
    verifyMarked: 'group-key-verify-marked',
};


function el(tag, className, text) {
    const node = document.createElement(tag);

    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);

    return node;
}


function affectedMembers(members) {
    const changed = new Set(
        getChangedGroupPeers().map((entry) => Number(entry.peerId))
    );

    if (!Array.isArray(members)) return [];

    return members.filter((member) => changed.has(Number(member?.user_id)));
}


/**
 * Accept the changed key for one member. Same pin/held-state as the DM path;
 * the event tells dm-key-trust.js to release any DM rows held for that peer.
 */
export async function acceptGroupPeerKey(peerId) {
    await acceptNewKey(peerId);

    document.dispatchEvent(new CustomEvent('dm-key-trust-accepted', {
        detail: { peerId: Number(peerId) },
    }));
}


/**
 * Open the existing safety-number view inside the group shell. The rendering
 * (digits, verification state, mark button) is the DM implementation; only the
 * element ids differ.
 */
export async function renderGroupVerifyView(peerId, username) {
    const panel = document.getElementById(GROUP_VERIFY_IDS.verify);
    if (!panel) return null;

    return renderVerifyView(peerId, username, { ids: GROUP_VERIFY_IDS });
}


/**
 * Paint the group key-change banner for the open group.
 *
 * Accepting is handled by group.js's delegated data-action listener, which
 * calls acceptGroupPeerKey() and then forces one re-wrap so the member starts
 * receiving again without a page reload.
 *
 * @param {Array<{user_id: number, username?: string}>} members current roster
 */
export function renderGroupKeyTrustBanner(members) {
    const bar = document.getElementById(BANNER_ID);
    if (!bar) return;

    const affected = affectedMembers(members);

    if (affected.length === 0) {
        bar.replaceChildren();
        return;
    }

    bar.replaceChildren();

    for (const member of affected) {
        const peerId = Number(member.user_id);
        const name = member.username || `User ${peerId}`;

        const row = el('div', 'group-key-trust-row');
        const text = el('span', 'dm-key-trust-text');

        // Plain text: the username is peer-controlled and never becomes HTML.
        text.textContent =
            `${name} is using a new key. ${name} is not receiving this group's ` +
            'new messages until you verify or accept the new key.';

        const verifyBtn = el(
            'button',
            'btn btn-ghost dm-key-trust-verify',
            'View safety number'
        );
        verifyBtn.type = 'button';
        verifyBtn.dataset.action = 'group-key-trust-verify';
        verifyBtn.dataset.peerId = String(peerId);

        const btn = el(
            'button',
            'btn btn-warn dm-key-trust-accept',
            'I verified the new key'
        );
        btn.type = 'button';
        btn.dataset.action = 'group-key-trust-accept';
        btn.dataset.peerId = String(peerId);

        row.appendChild(text);
        row.appendChild(verifyBtn);
        row.appendChild(btn);
        bar.appendChild(row);
    }
}


export function clearGroupKeyTrustBanner() {
    document.getElementById(BANNER_ID)?.replaceChildren();
    document.getElementById(GROUP_VERIFY_IDS.verify)?.setAttribute('hidden', '');
}
