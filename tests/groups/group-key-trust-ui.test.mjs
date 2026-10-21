// tests/groups/group-key-trust-ui.test.mjs
//
// Non-browser DOM test for the group key-change banner. The browser suite is
// not evidence on this machine (no Chromium), so this pins the parts that do
// not need layout or CSP: one row per changed member, createElement/textContent
// output, and the delegated data-action hooks group.js binds.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><html><body>
    <div id="group-key-trust-banner"></div>
    <section id="group-key-verify" hidden></section>
</body></html>`, { url: 'https://wire.test/' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;

let changed = [];
const accepted = [];
const verifyCalls = [];

const url = (rel) => new URL(`../../public/js/${rel}`, import.meta.url).href;

mock.module(url('crypto/keys/peer-key-gate.js'), {
    namedExports: {
        getChangedGroupPeers: () => changed,
    },
});

mock.module(url('chat/dm-key-trust.js'), {
    namedExports: {
        acceptNewKey: async (peerId) => {
            accepted.push(Number(peerId));
        },
        renderVerifyView: async (peerId, username, options) => {
            verifyCalls.push({ peerId: Number(peerId), username, options });
            return { number: '00000 00000 00000' };
        },
    },
});

const mod = await import(url('chat/group-key-trust.js'));

beforeEach(() => {
    changed = [];
    accepted.length = 0;
    verifyCalls.length = 0;
    document.getElementById('group-key-trust-banner').replaceChildren();
    document.getElementById('group-key-verify').setAttribute('hidden', '');
});

test('one delegated accept button and one safety-number link per changed member', () => {
    changed = [{ peerId: 7 }, { peerId: 8 }];

    mod.renderGroupKeyTrustBanner([
        { user_id: 7, username: '<img src=x onerror="window.pwned=1">' },
        { user_id: 8, username: 'Bob' },
        { user_id: 9, username: 'Not changed' },
    ]);

    const banner = document.getElementById('group-key-trust-banner');
    assert.equal(banner.querySelectorAll('.group-key-trust-row').length, 2);
    assert.equal(
        banner.querySelectorAll('[data-action="group-key-trust-accept"]').length,
        2,
        'each member gets exactly one accept action'
    );
    assert.equal(
        banner.querySelectorAll('[data-action="group-key-trust-verify"]').length,
        2,
        'each member gets exactly one safety-number action'
    );
    assert.equal(
        banner.querySelector('[data-action="group-key-trust-accept"]').dataset.peerId,
        '7'
    );
    assert.equal(
        banner.querySelector('[data-action="group-key-trust-verify"]').dataset.peerId,
        '7'
    );

    // The hostile username is inert text, never an element.
    assert.equal(banner.querySelector('img'), null);
    assert.match(banner.textContent, /<img src=x onerror=/);

    // The banner itself must not install a click listener: group.js owns the
    // delegated [data-action] handler. Clicking a fresh button here therefore
    // must not accept anything.
    banner.querySelector('[data-action="group-key-trust-accept"]').click();
    assert.deepEqual(accepted, []);
});

test('acceptGroupPeerKey() calls the shared DM accept and dispatches the release event', async () => {
    let released = null;
    const onRelease = (event) => { released = event.detail.peerId; };
    document.addEventListener('dm-key-trust-accepted', onRelease, { once: true });

    await mod.acceptGroupPeerKey(7);

    assert.deepEqual(accepted, [7]);
    assert.equal(released, 7);
});

test('renderGroupVerifyView() reuses renderVerifyView with the group ids', async () => {
    const rendered = await mod.renderGroupVerifyView(7, 'Bob');

    assert.equal(rendered.number, '00000 00000 00000');
    assert.deepEqual(verifyCalls, [{
        peerId: 7,
        username: 'Bob',
        options: { ids: mod.GROUP_VERIFY_IDS },
    }]);
});

test('the group shell and delegated handler are wired to those actions', () => {
    const group = fs.readFileSync(
        new URL('../../public/js/chat/group.js', import.meta.url),
        'utf8'
    );

    assert.match(group, /id="group-key-verify"/);
    assert.match(group, /case 'group-key-trust-accept'/);
    assert.match(group, /case 'group-key-trust-verify'/);
});
