// tests/groups/group-roundtrip.test.mjs
//
// Run with:
//   node --experimental-test-module-mocks --test tests/groups/group-roundtrip.test.mjs
//
// This is NOT a unit test of the group crypto functions (see
// group-crypto.test.mjs for that). It exercises the actual wired
// path end to end, with nothing about the app's own logic mocked:
//
//   - a real Express + Socket.IO server (real routes, controllers,
//     services, better-sqlite3 database with real schema/migrations,
//     real JWT auth)
//   - two real seeded users, created through the real
//     POST /api/auth/register endpoint
//   - real E2EE identity creation through core/auth.js's
//     initializeIdentity(), which really calls createIdentity() and
//     really PUTs to /api/me/identity-key
//   - a real group created via POST /api/groups, a real member added
//     via POST /api/groups/:id/members
//   - each simulated user's *own, unmodified* copy of
//     public/js/chat/group.js, thread.js, composer.js, core/socket.js
//     etc., running in a real jsdom document
//   - sending through the real send path: group.js's
//     window.sendGroupMessage() -> composer.js's send() ->
//     buildTextBody() -> encryptOutgoingGroupMessage() -> a real
//     POST /api/groups/:id/messages
//   - receiving through the real path: the real server emitting
//     'new-group-message' over a real Socket.IO connection ->
//     core/socket.js's handleGroupMessage -> group.js's
//     addGroupMessage -> thread.js's addLiveMessage -> the real
//     `decorate` callback (group.js's decorateGroupMessages, which
//     calls decryptIncomingGroupMessage) -> thread.js's
//     buildMessageEl rendering the decrypted plaintext into a real
//     DOM node
//
// Pass/fail is decided by reading the decrypted text back out of the
// receiving user's own rendered DOM — the same place a human looking
// at their screen would read it from.

import './_env.mjs'; // must be the first import — see that file's header comment

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './_test-server.mjs';
import { createBrowserActor } from './_browser-actor.mjs';
import { sleep, waitForConnect, signUpAndUnlock, apiCall } from './_roundtrip-helpers.mjs';

// Captured before any actor overwrites globalThis.fetch.
globalThis.__nodeFetch = globalThis.fetch;

test('group.js real round trip: Alice sends, Bob receives and decrypts via the real socket + decorate path', async (t) => {
    const server = await startTestServer();
    // io.close() (not just server.close()) is required for a clean
    // process exit: it force-disconnects the still-open real
    // WebSocket connections below, which plain http.Server#close()
    // waits on indefinitely otherwise.
    t.after(() => server.stop());

    // ---------- Seed two real users ----------

    const alice = createBrowserActor('alice', server.origin);
    const bob = createBrowserActor('bob', server.origin);
    t.after(() => alice.window.close());
    t.after(() => bob.window.close());

    const aliceIdentity = await signUpAndUnlock(alice, {
        username: 'alice_rt',
        email: 'alice_rt@example.test',
        password: 'correct horse battery staple',
    });

    const bobIdentity = await signUpAndUnlock(bob, {
        username: 'bob_rt',
        email: 'bob_rt@example.test',
        password: 'another very strong password',
    });

    // ---------- Real group creation + membership (plain REST, as
    //            group.js's own create-group/add-member dialogs do) ----------

    const group = await apiCall(server.origin, aliceIdentity.token, '/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name: 'Round Trip Test Group' }),
    });
    assert.ok(group?.id, 'group creation did not return an id');

    await apiCall(server.origin, aliceIdentity.token, `/api/groups/${group.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_id: bobIdentity.id }),
    });

    // ---------- Alice opens the group first: real group.js path.
    //            This is what actually generates + distributes her
    //            Sender Key (rotateSenderKey -> POST .../kdms) to
    //            every current member, Bob included. ----------

    alice.use();
    const aliceGroup = await alice.importModule('chat/group.js');
    const aliceSocket = await alice.importModule('core/socket.js');

    aliceSocket.initSocket(aliceIdentity.token);
    t.after(() => aliceSocket.getSocket()?.disconnect());
    await waitForConnect(aliceSocket.getSocket(), 'Alice');

    await aliceGroup.loadGroupsList();
    await aliceGroup.showGroups();
    await aliceGroup.openGroup(group.id);

    // ---------- Bob opens the group second: his own real group.js
    //            path, whose drainGroupKdms() during openGroup()
    //            picks up Alice's just-distributed KDM. ----------

    bob.use();
    const bobGroup = await bob.importModule('chat/group.js');
    const bobSocket = await bob.importModule('core/socket.js');

    bobSocket.initSocket(bobIdentity.token);
    t.after(() => bobSocket.getSocket()?.disconnect());
    await waitForConnect(bobSocket.getSocket(), 'Bob');

    await bobGroup.loadGroupsList();
    await bobGroup.showGroups();
    await bobGroup.openGroup(group.id);

    // ---------- Alice sends through the REAL send path:
    //            window.sendGroupMessage() -> composer.js's send()
    //            -> buildTextBody() -> encryptOutgoingGroupMessage()
    //            -> a real POST /api/groups/:id/messages ----------

    const plaintext = `hello Bob, this is Alice, real round trip ${Date.now()}`;

    alice.use();
    const input = alice.window.document.getElementById('group-input');
    assert.ok(input, 'Alice: composer input not found in rendered DOM');
    input.value = plaintext;

    // composer.js's send() intentionally has no meaningful return value
    // (see its `return;` after both the success and catch paths, and
    // the no-op `onMessage` group.js wires up — the sent message comes
    // back over the socket like any other, deliberately avoiding a
    // double-add). Success is instead observed the same way a user
    // watching the screen would see it: the input is cleared only on
    // the success path (composer.js clears it before `clearReply()`,
    // inside the try block — never on the catch path), and the
    // decrypted text actually lands in the recipient's DOM below.
    await alice.window.sendGroupMessage();
    assert.equal(input.value, '', 'Alice: composer input was not cleared — send() likely hit its catch branch');

    // ---------- Receiving through the REAL path: the real server
    //            emitting 'new-group-message' over the real socket
    //            -> core/socket.js's handleGroupMessage -> group.js's
    //            addGroupMessage -> thread.js's addLiveMessage -> the
    //            real `decorate` callback (decryptIncomingGroupMessage)
    //            -> buildMessageEl rendering into Bob's real DOM ----------

    bob.use();
    let bubbleText = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const el = bob.window.document.querySelector('#group-messages .chat-bubble');
        if (el) {
            bubbleText = el.textContent;
            break;
        }
        await sleep(50);
    }

    assert.equal(
        bubbleText,
        plaintext,
        `Bob's rendered DOM did not show the correct decrypted plaintext (got: ${JSON.stringify(bubbleText)})`
    );

    // Sanity check this was a real E2EE round trip: fetch the message
    // as actually stored server-side and confirm the plaintext never
    // appears in it (only ciphertext should have gone over the wire).
    const stored = await apiCall(server.origin, aliceIdentity.token, `/api/groups/${group.id}/messages/recent?limit=10`);
    assert.ok(
        !JSON.stringify(stored).includes(plaintext),
        'sanity check failed: plaintext leaked into the stored/broadcast message content'
    );
});
