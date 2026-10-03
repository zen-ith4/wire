// tests/groups/group-senderkeyid.test.mjs
//
// Run with:
//   node --experimental-test-module-mocks --test tests/groups/group-senderkeyid.test.mjs
//
// Proves the contract the future group image / audio / video decrypt
// work builds on:
//
//   group.js's decorate callback (decorateGroupMessages) attaches
//   `senderKeyId` (string) to every successfully decrypted message
//   object, and a caller can hand exactly that value to
//   decryptAttachmentForGroup(ciphertext, ivBase64, senderKeyId) to
//   decrypt an attachment the sender encrypted under the same key.
//
// Deliberately NOT full media wiring: no upload, no attachment
// rendering, no media/* files. The "attachment" here is raw bytes
// encrypted with the real encryptAttachmentForGroup() — the same
// primitive the future upload path will call — and decrypted with the
// real decryptAttachmentForGroup().
//
// Uses the same real-wired harness as group-roundtrip.test.mjs (real
// server, real KDM distribution, two isolated browser actors), so the
// key Bob decrypts with arrived by the real KDM path, not a fixture.

import './_env.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './_test-server.mjs';
import { createBrowserActor } from './_browser-actor.mjs';
import { sleep, waitForConnect, signUpAndUnlock, apiCall } from './_roundtrip-helpers.mjs';

globalThis.__nodeFetch = globalThis.fetch;

test('decorate() attaches senderKeyId, usable with decryptAttachmentForGroup', async (t) => {
    const server = await startTestServer();
    t.after(() => server.stop());

    const alice = createBrowserActor('alice', server.origin);
    const bob = createBrowserActor('bob', server.origin);
    t.after(() => alice.window.close());
    t.after(() => bob.window.close());

    const aliceId = await signUpAndUnlock(alice, {
        username: 'alice_sk', email: 'alice_sk@example.test', password: 'pw-alice-sk-1',
    });
    const bobId = await signUpAndUnlock(bob, {
        username: 'bob_sk', email: 'bob_sk@example.test', password: 'pw-bob-sk-1',
    });

    const group = await apiCall(server.origin, aliceId.token, '/api/groups', {
        method: 'POST', body: JSON.stringify({ name: 'senderKeyId test' }),
    });
    await apiCall(server.origin, aliceId.token, `/api/groups/${group.id}/members`, {
        method: 'POST', body: JSON.stringify({ user_id: bobId.id }),
    });

    // Alice opens first (distributes her Sender Key), then Bob (drains it).
    alice.use();
    const aliceGroup = await alice.importModule('chat/group.js');
    const aliceSocket = await alice.importModule('core/socket.js');
    aliceSocket.initSocket(aliceId.token);
    t.after(() => aliceSocket.getSocket()?.disconnect());
    await waitForConnect(aliceSocket.getSocket(), 'Alice');
    await aliceGroup.loadGroupsList();
    await aliceGroup.showGroups();
    await aliceGroup.openGroup(group.id);

    bob.use();
    const bobGroup = await bob.importModule('chat/group.js');
    const bobSocket = await bob.importModule('core/socket.js');
    bobSocket.initSocket(bobId.token);
    t.after(() => bobSocket.getSocket()?.disconnect());
    await waitForConnect(bobSocket.getSocket(), 'Bob');
    await bobGroup.loadGroupsList();
    await bobGroup.showGroups();
    await bobGroup.openGroup(group.id);

    // Alice sends a text message through the real send path.
    const plaintext = `senderKeyId proof ${Date.now()}`;
    alice.use();
    const input = alice.window.document.getElementById('group-input');
    input.value = plaintext;
    await alice.window.sendGroupMessage();
    assert.equal(input.value, '', 'send() did not take its success path');

    // Alice's ground-truth Sender Key id, read straight from her own
    // key store (independent of anything decorate() computes).
    const aliceCrypto = await alice.importModule('crypto/messages/group-message-crypto.js');
    const aliceSenderKey = await alice.importModule('crypto/groups/sender-key.js');
    const mine = await aliceSenderKey.getMySenderKey(aliceCrypto.getGroupIdentity(), group.id);
    assert.ok(mine?.senderKeyId, 'Alice has no Sender Key id to compare against');

    // Wait until the message is stored, then take Bob's view of the raw row.
    bob.use();
    let raw = null;
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await sleep(50)) {
        const res = await apiCall(server.origin, bobId.token, `/api/groups/${group.id}/messages/recent?limit=10`);
        const rows = Array.isArray(res) ? res : res.messages;
        raw = rows?.[rows.length - 1] ?? null;
        if (raw) break;
    }
    assert.ok(raw, 'no stored message found');
    const rawSnapshot = JSON.stringify(raw);

    // ---- The design under test: the REAL decorate callback ----
    const [decorated] = await bobGroup.decorateGroupMessages(group.id, [raw]);

    assert.equal(decorated.content, plaintext, 'plaintext must still be decrypted correctly');
    assert.equal(typeof decorated.senderKeyId, 'string', 'senderKeyId must be a string');
    assert.equal(decorated.senderKeyId, mine.senderKeyId, "senderKeyId must be Alice's actual Sender Key id");
    assert.equal(decorated.senderKeyId, JSON.parse(raw.content).senderKeyId, 'must equal the envelope field');
    assert.equal(JSON.stringify(raw), rawSnapshot, 'decorate() must not mutate its input');
    // Existing fields preserved (thread.js relies on id/sender_id/timestamp/etc.)
    assert.equal(decorated.id, raw.id);
    assert.equal(decorated.sender_id, raw.sender_id);

    // ---- The future caller's usage, with the real primitives ----
    const fileBytes = crypto.getRandomValues(new Uint8Array(4096)).buffer;

    alice.use();
    const aliceAttach = await alice.importModule('crypto/messages/attachment-crypto.js');
    const { ivBase64, ciphertext } = await aliceAttach.encryptAttachmentForGroup(group.id, fileBytes);

    bob.use();
    const bobAttach = await bob.importModule('crypto/messages/attachment-crypto.js');
    const decrypted = await bobAttach.decryptAttachmentForGroup(group.id, ciphertext, ivBase64, decorated.senderKeyId);
    assert.deepEqual(new Uint8Array(decrypted), new Uint8Array(fileBytes), 'attachment bytes must round-trip');

    // Wrong / missing id must fail as MissingSenderKeyError (the
    // self-heal contract), never yield garbage.
    // A well-formed but unknown id -> the typed self-heal error.
    await assert.rejects(
        () => bobAttach.decryptAttachmentForGroup(group.id, ciphertext, ivBase64, 'not-a-real-key-id'),
        (e) => e.name === 'MissingSenderKeyError',
        'unknown senderKeyId must throw MissingSenderKeyError'
    );

    // A missing id (e.g. a placeholder message that never decrypted, so
    // decorate() never attached one) still rejects — no garbage output —
    // but NOT as MissingSenderKeyError (it surfaces as an IndexedDB
    // DataError from the key lookup). So the caller contract is: check
    // `typeof msg.senderKeyId === 'string'` BEFORE calling, rather than
    // relying on the typed error for this case.
    await assert.rejects(
        () => bobAttach.decryptAttachmentForGroup(group.id, ciphertext, ivBase64, undefined),
        (e) => e.name !== 'MissingSenderKeyError',
        'missing senderKeyId rejects, but as a non-typed error (documented caller-side guard)'
    );

    // Envelope-level guard: a malformed envelope yields no senderKeyId.
    const bobCrypto = await bob.importModule('crypto/messages/group-message-crypto.js');
    assert.throws(() => bobCrypto.readEnvelopeSenderKeyId('not json'), /Malformed/);
    assert.throws(() => bobCrypto.readEnvelopeSenderKeyId(JSON.stringify({ v: 1 })), /Missing senderKeyId/);
});
