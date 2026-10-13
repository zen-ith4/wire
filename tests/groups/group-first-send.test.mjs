// Regression: the FIRST message in a brand-new group must send, with no page
// refresh and no settling time.
//
// The bug shape this pins: chat/group.js wires the composer's buildTextBody
// straight to encryptOutgoingGroupMessage(), which throws
// "No Sender Key to send with yet" when this device has no key for the group.
// ensureSenderKeyReady() is called from openGroup(), from the membership-change
// handler and on reconnect - but not from the send path. It is also a no-op
// when myMembership(groupId) is not yet known, because it returns before
// ensuring anything. So the first send of a brand-new group can hit the throw.
//
// Deliberately does NOT reuse the "mount everyone, sleep 900ms, open" preamble
// the other group tests use: that preamble lets every connected device rotate
// and settle, which is exactly what hides the bug.
//
// No Chromium: real client modules in the actor DOM, real server, real socket.

import './_env.mjs';
import { test, after, before } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

let S;

before(async () => { S = await createScenario(['alice', 'bob']); });
after(async () => { await S?.stop(); });

// The actor's jsdom window is not console-captured by the harness, so the
// spy is installed here, on the actor's own console, before any action.
function watchConsole(u) {
    u.actor.use();
    const w = u.actor.window;
    w.__consoleLines = [];
    for (const level of ['error', 'warn']) {
        const original = w.console[level].bind(w.console);
        w.console[level] = (...args) => {
            try { w.__consoleLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); }
            catch { /* unserialisable */ }
            original(...args);
        };
    }
    return u;
}

function consoleLines(u) {
    u.actor.use();
    return u.actor.window.__consoleLines.slice();
}

test('first send in a brand-new group works: no refresh, no settle, one member added', async () => {
    const { alice, bob } = S.users;

    // Only Alice is mounted: Bob has no connected device, so there is no
    // membership-triggered rotation to wait for.
    watchConsole(alice);
    await S.mount(alice);

    const g = await S.createGroup(alice, 'first-send');
    assert.ok(g?.id, 'group created');

    // A membership change: the epoch bump is what normally makes every device
    // rotate and distribute.
    await S.addMember(alice, g.id, bob);

    // No sleep. Open and send immediately, the way a user clicks a group that
    // has just appeared in the list and types.
    await S.open(alice, g.id);

    const cleared = await S.send(alice, 'first message');

    const errors = consoleLines(alice);
    const senderKeyErrors = errors.filter((l) => /No Sender Key/i.test(l));

    // The user-visible symptom: the composer does not clear on failure.
    assert.deepEqual(senderKeyErrors, [], `send path hit "No Sender Key":\n${senderKeyErrors.join('\n')}`);
    assert.ok(cleared, 'composer must clear, i.e. the send succeeded');

    // And the message really is on the server, encrypted.
    const rows = S.envelopes(g.id);
    assert.equal(rows.length, 1, 'exactly one group message stored');
    assert.equal(rows[0].sender_id, alice.ident.id);
    assert.equal(typeof rows[0].env.v, 'number', 'stored content is an envelope, not plaintext');
    assert.ok(!JSON.stringify(rows[0]).includes('first message'), 'plaintext must not be stored');
});

test('the first send of a group with no other member still works (solo group)', async () => {
    const { alice } = S.users;
    watchConsole(alice);
    await S.mount(alice);

    const g = await S.createGroup(alice, 'first-send-solo');
    await S.open(alice, g.id);

    const cleared = await S.send(alice, 'hello to nobody');
    const errors = consoleLines(alice);
    const senderKeyErrors = errors.filter((l) => /No Sender Key/i.test(l));

    assert.deepEqual(senderKeyErrors, [], `solo send hit "No Sender Key":\n${senderKeyErrors.join('\n')}`);
    assert.ok(cleared, 'composer must clear for a solo group too');
    assert.equal(S.envelopes(g.id).length, 1);
});

test('a second send in the same group is unaffected', async () => {
    const { alice, bob } = S.users;
    watchConsole(alice);
    await S.mount(alice);

    const g = await S.createGroup(alice, 'first-send-repeat');
    await S.addMember(alice, g.id, bob);
    await S.open(alice, g.id);

    assert.ok(await S.send(alice, 'one'), 'first send');
    await sleep(200);
    assert.ok(await S.send(alice, 'two'), 'second send');

    const rows = S.envelopes(g.id);
    assert.equal(rows.length, 2, 'both messages stored');
    const ids = new Set(rows.map((r) => r.env.senderKeyId));
    assert.equal(ids.size, 1, 'both messages under the same Sender Key id');
});