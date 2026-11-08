// tests/groups/group-audit.test.mjs
//
// Regression tests from the post-merge Group/E2EE audit. Same real
// harness as group-roundtrip.test.mjs: real Express + Socket.IO +
// SQLite server, real auth/identity, the unmodified client modules in
// jsdom. Nothing about app logic is mocked. Assertions read the
// receiving user's rendered DOM.
//
// F-I and G used to be { todo } tests documenting the multi-device design
// flaw (senderKeyId collision -> overwritten keys, (key, nonce) reuse). They
// are now enforced: the scheme-2 senderKeyId fixed them.

import './_env.mjs';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './_test-server.mjs';
import { createBrowserActor } from './_browser-actor.mjs';
import { sleep, waitForConnect, signUpAndUnlock, apiCall } from './_roundtrip-helpers.mjs';

globalThis.__nodeFetch = globalThis.fetch;

let seq = 0;

// One server + two long-lived users for the whole file (the production
// registration rate limiter allows only a handful of sign-ups per
// process; sharing users is also closer to a real session). Each test
// creates its own group(s).
let shared = null;
const cleanups = [];
after(async () => {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* ignore */ } }
});

async function boot(_t, names) {
    if (!shared) {
        const server = await startTestServer();
        cleanups.push(() => server.stop());
        const users = {};
        for (const name of names) {
            const n = `${name}${seq++}`;
            const actor = createBrowserActor(n, server.origin);
            cleanups.push(() => actor.dispose());
            const password = `pw-${n}-long-enough`;
            const ident = await signUpAndUnlock(actor, { username: n, email: `${n}@example.test`, password });
            ident.password = password;
            users[name] = { actor, ident, n };
        }
        shared = { server, users };
    }
    return shared;
}

async function mount(_t, u) {
    if (u.mounted) return;
    u.mounted = true;
    u.actor.use();
    u.group = await u.actor.importModule('chat/group.js');
    u.socketMod = await u.actor.importModule('core/socket.js');
    u.socketMod.initSocket(u.ident.token);
    cleanups.push(() => u.socketMod.getSocket()?.disconnect());
    await waitForConnect(u.socketMod.getSocket(), u.n);
    await u.group.loadGroupsList();
    await u.group.showGroups();
}

// Same as the real UI: refresh the list, then open.
async function openG(u, groupId) {
    u.actor.use();
    await u.group.loadGroupsList();
    await u.group.openGroup(groupId);
}

async function send(u, text) {
    u.actor.use();
    const input = u.actor.window.document.getElementById('group-input');
    input.value = text;
    await u.actor.window.sendGroupMessage();
}

async function waitFor(u, fn, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        u.actor.use();
        const v = fn(u.actor.window.document);
        if (v) return v;
        await sleep(50);
    }
    return null;
}

const bubbles = (u) => {
    u.actor.use();
    return [...u.actor.window.document.querySelectorAll('#group-messages .chat-bubble')].map((e) => e.textContent);
};

// ---------------------------------------------------------------
// F-A: member added AFTER the sender already has a live Sender Key
// ---------------------------------------------------------------
test('F-A: a member added later can read messages from a sender who already had a key', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'late add' }),
    });

    await mount(t, alice);
    await openG(alice, group.id); // Alice alone: key created for [Alice]
    await send(alice, 'before bob joined');

    // Bob joins through the real API while Alice's group view stays open.
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await sleep(800); // let Alice's client react to the real 'added' socket event

    await mount(t, bob);
    await openG(bob, group.id);

    const msg = `after bob joined ${Date.now()}`;
    await send(alice, msg); // Alice does NOT reopen the group

    const seen = await waitFor(bob, () => bubbles(bob).includes(msg));
    assert.ok(seen, `Bob never saw Alice's message. Bob's bubbles: ${JSON.stringify(bubbles(bob))}`);
});

// ---------------------------------------------------------------
// F-A2: the added user's Groups list updates live
// ---------------------------------------------------------------
test('F-A2: an added user sees the new group in their list without reloading', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    await mount(t, bob); // Bob is already looking at his (empty) list
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'live list' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    const row = await waitFor(bob, (d) => d.querySelector(`#group-list [data-group-id="${group.id}"]`));
    assert.ok(row, 'group never appeared in Bob\'s list');
});

// ---------------------------------------------------------------
// F-C: one malformed message must not blank the whole thread
// ---------------------------------------------------------------
test('F-C: a junk message posted by a member does not poison the thread for others', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'poison' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, alice);
    await openG(alice, group.id);
    await send(alice, 'legit message');

    // Bob (a legitimate member) submits garbage as "ciphertext".
    await apiCall(server.origin, bob.ident.token, `/api/groups/${group.id}/messages`, {
        method: 'POST', body: JSON.stringify({ content: 'this is not an envelope' }),
    });
    await apiCall(server.origin, bob.ident.token, `/api/groups/${group.id}/messages`, {
        method: 'POST', body: JSON.stringify({ content: JSON.stringify({ v: 1, alg: 'AES-GCM' }) }),
    });

    // Alice re-opens (fresh fetch of history) — her real legit message must still render.
    alice.actor.use();
    await alice.group.showGroups();
    // force a cold thread: leave and come back through logout-style reset
    alice.actor.window.dispatchEvent(new alice.actor.window.Event('wire:logout'));
    await alice.group.loadGroupsList();
    await alice.group.showGroups();
    await openG(alice, group.id);
    assert.ok(
        bubbles(alice).includes('legit message'),
        `thread was poisoned; bubbles=${JSON.stringify(bubbles(alice))}`
    );
});

// ---------------------------------------------------------------
// F-E: a message for group A must never render inside group B's view
// ---------------------------------------------------------------
test('F-E: live message for a non-active group is not drawn into the active group view', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const mk = async (name) => {
        const g = await apiCall(server.origin, alice.ident.token, '/api/groups', {
            method: 'POST', body: JSON.stringify({ name }),
        });
        await apiCall(server.origin, alice.ident.token, `/api/groups/${g.id}/members`, {
            method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
        });
        return g;
    };
    const g1 = await mk('G1');
    const g2 = await mk('G2');

    await mount(t, alice);
    await openG(alice, g1.id);
    await mount(t, bob);
    await openG(bob, g1.id); // creates Bob's G1 thread
    await openG(bob, g2.id); // Bob is now looking at G2

    await openG(alice, g1.id);
    const secret = `only-for-G1 ${Date.now()}`;
    await send(alice, secret);
    await sleep(1200);

    assert.ok(
        !bubbles(bob).includes(secret),
        `G1 message leaked into G2's visible thread: ${JSON.stringify(bubbles(bob))}`
    );

    // Positive control: the message really was delivered to Bob and belongs in G1.
    await openG(bob, g1.id);
    assert.ok(bubbles(bob).includes(secret), 'control failed: message never reached Bob\'s G1 thread');
});

// ---------------------------------------------------------------
// F-D: message that arrives before its KDM -> placeholder, then must
// resolve; and must never fall back to showing ciphertext JSON.
// ---------------------------------------------------------------
test('F-D: placeholder resolves after the KDM lands and never shows raw ciphertext', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'late kdm' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, bob);
    await openG(bob, group.id); // Bob's thread exists, nothing to drain yet
    await mount(t, alice);
    await openG(alice, group.id); // KDMs for Bob now sit in the mailbox
    await sleep(600); // Bob's client auto-drains on the real kdm-delivered event

    // Rewind: make Bob look like he has NOT received Alice's key yet.
    const idb = await bob.actor.importModule('crypto/groups/sender-key-store.js');
    bob.actor.use();
    const rows = await idb.getAllSenderKeysForGroup(group.id);
    for (const r of rows.filter((r) => !r.isMine)) await idb.deleteSenderKeyRecord(r.senderKeyId);
    const skMod = await bob.actor.importModule('crypto/groups/sender-key.js');
    skMod.clearSenderKeyCache();

    // Ack-race: hold the mailbox empty during the live arrival by acking, then restoring.
    const pending = server.db.prepare('SELECT id FROM group_key_distributions WHERE to_user_id = ?').all(bob.ident.id).map((r) => r.id);
    // Clients now drain by per-DEVICE receipt (group_kdm_receipts), so hold
    // the mailbox closed for Bob's device the same way: pre-acked receipts.
    const bobDevice = await (await bob.actor.importModule('crypto/messages/group-message-crypto.js')).getGroupDeviceId();
    assert.ok(bobDevice, 'Bob has a group device id');
    server.db.prepare('DELETE FROM group_kdm_receipts WHERE device_id = ?').run(bobDevice);
    for (const id of pending) server.db.prepare('INSERT OR IGNORE INTO group_kdm_receipts (kdm_id, device_id) VALUES (?, ?)').run(id, bobDevice);

    const msg = `early bird ${Date.now()}`;
    await send(alice, msg);
    const ph = await waitFor(bob, (d) => /Waiting for encryption key/.test(d.getElementById('group-messages')?.textContent || ''));
    assert.ok(ph, `expected a placeholder while the key is missing; Bob sees: ${JSON.stringify(bob.actor.window.document.getElementById('group-messages')?.textContent)} bubbles=${JSON.stringify(bubbles(bob))}`);

    // The KDM finally becomes drainable (what a late/retried delivery looks like).
    server.db.prepare('DELETE FROM group_kdm_receipts WHERE device_id = ?').run(bobDevice);
    bob.actor.use();
    await bob.group.handleGroupKdmDelivered({ group_id: group.id });

    const resolved = await waitFor(bob, () => bubbles(bob).includes(msg), 4000);
    assert.ok(resolved, `placeholder never resolved to plaintext: ${JSON.stringify(bubbles(bob))}`);

    // Repaint from cache (switch away and back) must not expose the envelope.
    const g2 = await apiCall(server.origin, bob.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'other' }),
    });
    await bob.group.loadGroupsList();
    await openG(bob, g2.id);
    await openG(bob, group.id);
    bob.actor.use();
    const html = bob.actor.window.document.getElementById('group-messages').textContent;
    assert.ok(!html.includes('"ciphertext"') && !html.includes('senderKeyId'), 'raw ciphertext envelope reached the DOM');
});

// ---------------------------------------------------------------
// SECURITY: hostile values through the REAL group path
// ---------------------------------------------------------------
test('XSS: hostile group name, message text and reaction never become live markup', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const evilName = `"><img src=x onerror="window.__pwn=1"><b id=pwn-name>`;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: evilName }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, alice);
    await openG(alice, group.id);
    await mount(t, bob);
    await openG(bob, group.id);

    const evilText = `<img src=x onerror="window.__pwn=2"><script>window.__pwn=3</script> https://a.test/"onmouseover="window.__pwn=4`;
    await send(alice, evilText);
    await waitFor(bob, () => bubbles(bob).length > 0);

    // Hostile reaction straight at the API (bypasses the picker).
    const list = await apiCall(server.origin, bob.ident.token, `/api/groups/${group.id}/messages/recent?limit=5`);
    await apiCall(server.origin, bob.ident.token, `/api/groups/${group.id}/messages/${list.at(-1).id}/reactions`, {
        method: 'POST', body: JSON.stringify({ emoji: `<img src=x onerror=alert(1)>` }),
    });
    await sleep(600);

    for (const u of [alice, bob]) {
        u.actor.use();
        const d = u.actor.window.document;
        const scope = d.getElementById('content-area');
        assert.equal(scope.querySelector('script'), null, `${u.n}: <script> element injected`);
        assert.equal(scope.querySelector('#pwn-name'), null, `${u.n}: group-name markup injected`);
        assert.equal(scope.querySelectorAll('img[src="x"]').length, 0, `${u.n}: <img> injected`);
        for (const el of scope.querySelectorAll('*')) {
            for (const a of el.attributes) {
                // App-authored handlers are covered by the CSP test; here we
                // only care about handlers that carry attacker-supplied text.
                assert.ok(!(/^on/i.test(a.name) && /__pwn|alert\(/.test(a.value)),
                    `${u.n}: attacker-controlled handler ${a.name}=${a.value} on <${el.tagName}>`);
            }
        }
        assert.equal(u.actor.window.__pwn, undefined, `${u.n}: injected script executed`);
    }
    bob.actor.use();
    assert.equal(bubbles(bob)[0], evilText, 'text must render verbatim as text');
});

// ---------------------------------------------------------------
// CSP: group UI must not depend on inline event-handler attributes
// ---------------------------------------------------------------
test('CSP: group UI markup contains no inline on* handlers and buttons work via delegation', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'csp' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, alice);
    await openG(alice, group.id);
    await mount(t, bob);
    await openG(bob, group.id);
    await send(alice, 'csp probe');
    await waitFor(bob, () => bubbles(bob).length > 0);

    for (const u of [alice, bob]) {
        u.actor.use();
        const root = u.actor.window.document.getElementById('content-area');
        const offenders = [...root.querySelectorAll('*')].flatMap((el) =>
            [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `<${el.tagName.toLowerCase()} ${a.name}="${a.value}">`));
        assert.deepEqual(offenders, [], `${u.n}: inline handlers are blocked by script-src 'self': ${offenders.join(' ')}`);
    }

    // The Send button must work with a real click, not only window.sendGroupMessage().
    alice.actor.use();
    const d = alice.actor.window.document;
    d.getElementById('group-input').value = 'sent by button click';
    d.querySelector('#group-input-area .btn-send').dispatchEvent(new alice.actor.window.MouseEvent('click', { bubbles: true }));
    const got = await waitFor(bob, () => bubbles(bob).includes('sent by button click'));
    assert.ok(got, 'clicking the Send button did nothing');
});

// ---------------------------------------------------------------
// F-I / G: multi-device (formerly OPEN todo tests; now enforced -- see
// docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md and group-multidevice.test.mjs)
// ---------------------------------------------------------------
test('F-I (was OPEN, fixed by key-derived senderKeyId): a second device of the same user must not make earlier messages unreadable', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'two devices' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, alice);
    await openG(alice, group.id);
    await mount(t, bob);
    await openG(bob, group.id);

    const before = `sent before device two existed ${Date.now()}`;
    await send(alice, before);
    assert.ok(await waitFor(bob, () => bubbles(bob).includes(before)), 'control: Bob must read the message initially');

    // Alice's second device: same account, same password, fresh browser profile.
    const a2 = { actor: createBrowserActor(`alice2_${seq++}`, server.origin), n: 'alice-dev2' };
    cleanups.push(() => a2.actor.dispose());
    a2.actor.use();
    const auth2 = await a2.actor.importModule('core/auth.js');
    await auth2.login(alice.n, alice.ident.password);
    await auth2.initializeIdentity(alice.ident.password);
    a2.ident = { token: auth2.getToken() };
    await mount(t, a2);
    await openG(a2, group.id); // no local key -> mints ANOTHER key with the same senderKeyId
    await sleep(800);

    const kdmToBob = server.db.prepare(
        'SELECT COUNT(*) c FROM group_key_distributions WHERE group_id = ? AND from_user_id = ? AND to_user_id = ?'
    ).get(group.id, alice.ident.id, bob.ident.id).c;
    assert.equal(kdmToBob, 2, `control: expected two KDM fan-outs from Alice (one per device), got ${kdmToBob}`);

    // Bob reloads the conversation from scratch: history must still be readable.
    bob.actor.use();
    bob.actor.window.dispatchEvent(new bob.actor.window.Event('wire:logout'));
    await openG(bob, group.id);
    assert.ok(bubbles(bob).includes(before), `earlier message is now unreadable for Bob: ${JSON.stringify(bubbles(bob))}`);
});

test('G (was OPEN, fixed by device-local sending keys): two devices of one user must never encrypt with the same (key, nonce)', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'nonce reuse' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, bob);
    await openG(bob, group.id);
    await mount(t, alice);
    await openG(alice, group.id);
    await send(alice, 'd1 m1');

    const a2 = { actor: createBrowserActor(`alice3_${seq++}`, server.origin), n: 'alice-dev2b' };
    cleanups.push(() => a2.actor.dispose());
    a2.actor.use();
    const auth2 = await a2.actor.importModule('core/auth.js');
    await auth2.login(alice.n, alice.ident.password);
    await auth2.initializeIdentity(alice.ident.password);
    a2.ident = { token: auth2.getToken() };
    await mount(t, a2);
    await openG(a2, group.id);
    await sleep(800); // device one adopts device two's key via the shared mailbox

    await send(a2, 'd2 m1');
    await send(a2, 'd2 m2');
    await send(alice, 'd1 m2');
    await send(alice, 'd1 m3');

    const rows = server.db.prepare('SELECT content FROM group_messages WHERE group_id = ?').all(group.id);
    assert.equal(rows.length, 5, 'control: five messages expected');

    // Group envelopes by (senderKeyId, iv). Any group with 2+ members is a
    // nonce collision under one senderKeyId. It is PROVEN AES-GCM key+nonce
    // reuse when Bob's single stored key decrypts both of them.
    const byNonce = new Map();
    for (const { content } of rows) {
        const e = JSON.parse(content);
        const k = `${e.senderKeyId}:${e.iv}`;
        byNonce.set(k, [...(byNonce.get(k) || []), content]);
    }
    const collisions = [...byNonce.values()].filter((v) => v.length > 1);

    bob.actor.use();
    const bobCrypto = await bob.actor.importModule('crypto/messages/group-message-crypto.js');
    const report = [];
    for (const pair of collisions) {
        const ok = [];
        let n = 0;
        for (const c of pair) {
            try { await bobCrypto.decryptIncomingGroupMessage(group.id, c, `audit-${n++}`); ok.push(true); } catch { ok.push(false); }
        }
        report.push(ok.every(Boolean) ? 'PROVEN key+nonce reuse (both decrypt under one key)' : 'same id+nonce, different keys (F-I collision)');
    }
    assert.deepEqual(collisions.map(() => 'none'), [], `nonce collisions: ${JSON.stringify(report)}`);
});

// ---------------------------------------------------------------
// F-R: a rename event must not wipe the open conversation
// ---------------------------------------------------------------
test('F-R: renaming the open group keeps its messages on screen', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'before rename' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, alice);
    await openG(alice, group.id);
    await mount(t, bob);
    await openG(bob, group.id);
    await send(alice, 'still here after rename');
    assert.ok(await waitFor(bob, () => bubbles(bob).includes('still here after rename')), 'control: message delivered');

    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}`, {
        method: 'PATCH', body: JSON.stringify({ name: 'after rename' }),
    }).catch(async () => apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/rename`, {
        method: 'PUT', body: JSON.stringify({ name: 'after rename' }),
    }));
    const renamed = await waitFor(bob, (d) => /after rename/.test(d.querySelector('.chat-top-name')?.textContent || ''));
    assert.ok(renamed, 'control: Bob saw the rename');
    assert.ok(bubbles(bob).includes('still here after rename'), `rename wiped the message list: ${JSON.stringify(bubbles(bob))}`);
});

// ---------------------------------------------------------------
// F-P: undecryptable rows must not break "load older" pagination
// ---------------------------------------------------------------
test('F-P: a full page of undecryptable rows still lets the user load older history', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'pagination' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, alice);
    await openG(alice, group.id);
    await mount(t, bob);
    await openG(bob, group.id);
    await send(alice, 'ancient but legit');
    assert.ok(await waitFor(bob, () => bubbles(bob).includes('ancient but legit')), 'control: legit message delivered');

    // 55 newer rows Bob cannot decrypt (junk posted by a member), inserted
    // straight into the real table with strictly later timestamps.
    const ins = server.db.prepare('INSERT INTO group_messages (group_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)');
    const base = Date.now() + 5000;
    for (let i = 0; i < 55; i++) ins.run(group.id, bob.ident.id, `junk-${i}`, new Date(base + i * 10).toISOString());

    // Cold reload of Bob's thread.
    bob.actor.use();
    bob.actor.window.dispatchEvent(new bob.actor.window.Event('wire:logout'));
    await openG(bob, group.id);

    bob.actor.use();
    const btn = bob.actor.window.document.querySelector('#group-messages .load-more-btn');
    assert.ok(btn, 'no "Load older messages" button although 5+ older rows exist');
    btn.click();
    let ok = await waitFor(bob, () => bubbles(bob).includes('ancient but legit'), 4000);
    if (!ok) { // one more page: 55 junk rows > two pages of 50 minus overlap
        bob.actor.use();
        bob.actor.window.document.querySelector('#group-messages .load-more-btn')?.click();
        ok = await waitFor(bob, () => bubbles(bob).includes('ancient but legit'), 4000);
    }
    assert.ok(ok, `older legit message never reachable: ${JSON.stringify(bubbles(bob))}`);
});

// ---------------------------------------------------------------
// F-S: messages sent while the socket was down appear after reconnect
// ---------------------------------------------------------------
test('F-S: messages missed while disconnected are fetched after the socket reconnects', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'resync' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, alice);
    await openG(alice, group.id);
    await mount(t, bob);
    await openG(bob, group.id);
    await send(alice, 'first');
    assert.ok(await waitFor(bob, () => bubbles(bob).includes('first')), 'control: live delivery works');

    bob.actor.use();
    const sock = bob.socketMod.getSocket();
    sock.disconnect(); // hard disconnect: no connection-state recovery for a manual disconnect
    await sleep(300);

    await send(alice, 'sent while bob was offline');
    await sleep(300);
    bob.actor.use();
    assert.ok(!bubbles(bob).includes('sent while bob was offline'), 'control: Bob really missed it');

    sock.connect();
    const got = await waitFor(bob, () => bubbles(bob).includes('sent while bob was offline'), 5000);
    assert.ok(got, `missed message never appeared after reconnect: ${JSON.stringify(bubbles(bob))}`);
});

test('F-H: signing in as a different user in the same browser profile does not pick up the previous user\'s Sender Key', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob']);
    const { alice, bob } = users;
    const group = await apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'shared browser' }),
    });
    await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bob.ident.id }),
    });
    await mount(t, alice);
    await openG(alice, group.id); // Alice's key lands in THIS browser profile's IndexedDB

    // Bob signs in on Alice's browser profile (same IndexedDB / same module graph).
    alice.actor.use();
    const auth = await alice.actor.importModule('core/auth.js');
    { const E = globalThis.Event; globalThis.Event = alice.actor.window.Event; try { auth.logout(); } finally { globalThis.Event = E; } }
    (await alice.actor.importModule('crypto/identity-service.js')).lockIdentity();
    await auth.login(bob.n, bob.ident.password);
    await auth.initializeIdentity(bob.ident.password);
    const gmc = await alice.actor.importModule('crypto/messages/group-message-crypto.js');
    const skm = await alice.actor.importModule('crypto/groups/sender-key.js');
    const mine = await skm.getMySenderKey(gmc.getGroupIdentity(), group.id);
    assert.equal(mine, null, "Bob's client selected a Sender Key that belongs to a different user");
});
