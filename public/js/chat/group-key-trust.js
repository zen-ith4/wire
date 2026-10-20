// public/js/chat/group-key-trust.js
//
// The group-thread banner for R1 (group KDM key pinning). This is the UI half
// of crypto/keys/peer-key-gate.js: the gate records peers whose identity key
// changed and whose KDM was therefore skipped/held, and this module turns that
// list plus the current member roster into one banner with one accept button
// per affected member.
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
    acceptNewKey
} from './dm-key-trust.js';


const BANNER_ID = 'group-key-trust-banner';


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
 * Paint the group key-change banner for the open group.
 *
 * @param {Array<{user_id: number, username?: string}>} members current roster
 * @param {{onAccepted?: (peerId: number) => Promise<void>|void}} [options]
 *   called after the pin is accepted; group.js uses it to force one re-wrap so
 *   the member starts receiving again without a page reload.
 */
export function renderGroupKeyTrustBanner(members, { onAccepted } = {}) {
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

        const btn = el(
            'button',
            'btn btn-warn dm-key-trust-accept',
            'I verified the new key'
        );
        btn.type = 'button';

        btn.addEventListener('click', async () => {
            btn.disabled = true;

            try {
                await acceptNewKey(peerId);

                // The DM layer listens for this to release any held DM rows for
                // the same peer; the pin is shared, so the alarm is shared too.
                document.dispatchEvent(new CustomEvent('dm-key-trust-accepted', {
                    detail: { peerId },
                }));

                if (onAccepted) await onAccepted(peerId);
            } catch (e) {
                console.error('[group] could not accept the new peer key:', e);
                btn.disabled = false;
            }
        });

        row.appendChild(text);
        row.appendChild(btn);
        bar.appendChild(row);
    }
}


export function clearGroupKeyTrustBanner() {
    document.getElementById(BANNER_ID)?.replaceChildren();
}
