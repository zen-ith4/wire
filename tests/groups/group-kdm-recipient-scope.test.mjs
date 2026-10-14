// tests/groups/group-kdm-recipient-scope.test.mjs
//
// buildTextBody() awaits ensureSenderKeyReady(group.id), and that function
// defaults `members` to the module-global `activeGroupMembers` before wrapping
// the Sender Key. If that global ever holds another group's roster, the KDM
// fan-out reaches people who are not in the group at all.
//
// The one thing standing in the way is the guard in loadMembers():
//
//     if (groupId === activeGroupId) activeGroupMembers = members;
//
// handleGroupSocketConnected() calls loadMembers() for EVERY group it has a
// thread for, including groups the user is not looking at, so on a reconnect
// the guard is the only thing keeping the roster correct. This test drives
// that exact path, forces a re-key, and asserts the distribution.
//
// Same real harness as group-audit.test.mjs: real Express + Socket.IO + SQLite
// server, real auth/identity, the unmodified client modules. No app logic is
// mocked.

import './_env.mjs';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './_test-server.mjs';
import { createBrowserActor } from './_browser-actor.mjs';
import { sleep, waitForConnect, signUpAndUnlock, apiCall } from './_roundtrip-helpers.mjs';

globalThis.__nodeFetch = globalThis.fetch;

let seq = 0;
let shared = null;
const cleanups = [];
after(async () => {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* ignore */ } }
});

// One server and three users for the whole file: the registration rate limiter
// only allows a handful of sign-ups per process.
async function boot(_t, names) {
    if (!shared) {
        const server = await startTestServer();
        cleanups.push(() => server.stop());
        const users = {};
        for (const name of names) {
            const n = `${name}${seq++}`;
            const actor = createBrowserActor(n, server.origin);
            cleanups.push(() => actor.window.close());
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

// Force the next send to mint a fresh Sender Key, so it really does fan a KDM
// out again instead of no-opping on the key the device already holds.
async function forgetOwnKey(u, groupId) {
    const store = await u.actor.importModule('crypto/groups/sender-key-store.js');
    u.actor.use();
    const rows = await store.getAllSenderKeysForGroup(groupId);
    for (const r of rows.filter((r) => r.isMine)) await store.deleteSenderKeyRecord(r.senderKeyId);
    (await u.actor.importModule('crypto/groups/sender-key.js')).clearSenderKeyCache();
}

const recipientsOf = (server, groupId) =>
    server.db.prepare(
        'SELECT DISTINCT to_user_id FROM group_key_distributions WHERE group_id = ?'
    ).all(groupId).map((r) => Number(r.to_user_id)).sort((a, b) => a - b);

test('a reconnect that reloads members of other groups cannot make group A fan its Sender Key out to the wrong people', async (t) => {
    const { server, users } = await boot(t, ['alice', 'bob', 'carol']);
    const alice = users.alice;
    const bob = users.bob;
    const carol = users.carol;

    // apiCall throws on a non-2xx and returns the parsed body.
    const mk = async (name) => apiCall(server.origin, alice.ident.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name }),
    });
    const add = async (group, user) => {
        const r = await apiCall(server.origin, alice.ident.token, `/api/groups/${group.id}/members`, {
            method: 'POST', body: JSON.stringify({ user_id: user.ident.id }),
        });
        assert.ok(r && r.added, `member added to group ${group.id}: ${JSON.stringify(r)}`);
    };

    // A contains Bob, B contains Carol. Neither user is in the other group.
    const groupA = await mk(`scopeA${seq++}`);
    await add(groupA, bob);
    const groupB = await mk(`scopeB${seq++}`);
    await add(groupB, carol);

    await mount(t, alice);

    // Open both once so Alice has a thread for each (groupThreads), then leave
    // A as the active group.
    await openG(alice, groupA.id);
    await openG(alice, groupB.id);
    await openG(alice, groupA.id);
    await sleep(400);
    assert.equal(alice.group.getActiveGroupId(), groupA.id, 'group A is the active one');

    // The real reconnect path: it iterates every group Alice has a thread for
    // and calls loadMembers() for each, active or not.
    await alice.group.handleGroupSocketConnected();
    await sleep(600);

    // Make the next send re-key, so a KDM is really distributed.
    await forgetOwnKey(alice, groupA.id);
    const marker = `scope ${Date.now()}`;
    await send(alice, marker);
    await sleep(900);

    const aRecipients = recipientsOf(server, groupA.id);

    assert.deepEqual(
        aRecipients,
        [Number(alice.ident.id), Number(bob.ident.id)].sort((x, y) => x - y),
        `A's Sender Key went to A's members and nobody else (got ${JSON.stringify(aRecipients)})`
    );
    assert.ok(
        !aRecipients.includes(Number(carol.ident.id)),
        'Carol is not in group A and must never receive A\'s Sender Key'
    );

    // The stronger half. If the roster used for the fan-out were group B's, the
    // KDM submit is rejected ("Recipient N is not a current member"), no Sender
    // Key is kept, and the send dies with "No Sender Key to send with yet".
    // Asserting only on the DB rows would miss that: the bad distribution never
    // reaches the database, the server's membership validation rejects it, and
    // the rows look right while the feature is broken. Group message bodies are
    // ciphertext on the wire, so this reads the DECRYPTED bubble the user sees.
    const end = Date.now() + 15000;
    let delivered = false;
    while (Date.now() < end) {
        alice.actor.use();
        const texts = [...alice.actor.window.document.querySelectorAll('#group-messages .chat-msg')]
            .map((e) => e.textContent);
        if (texts.some((t) => t.includes(marker))) { delivered = true; break; }
        await sleep(150);
    }
    assert.ok(
        delivered,
        'the message actually rendered in group A: with a foreign roster the distribution is refused and the send fails outright'
    );
});