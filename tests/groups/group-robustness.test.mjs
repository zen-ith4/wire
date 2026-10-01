// tests/groups/group-robustness.test.mjs
//
// Group/E2EE audit: message-level robustness and per-thread UI behaviour.
// Real server + Socket.IO + unmodified client (see _scenario.mjs).
//
//   R-1  reply quotes show decrypted plaintext (live AND history), never ciphertext
//   R-2  a stale "load older" for group A must not delete group B's button
//   R-3  removed members are evicted from the group's socket room
//   R-4  removed members cannot drain KDMs, and pending KDMs are purged
//   R-5  Bob's UI updates from the Socket.IO event alone (no history fetch)

import './_env.mjs';

import { test, after, afterEach } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

let shared = null;
async function scenario() {
    if (!shared) shared = await createScenario(['alice', 'bob', 'carol']);
    return shared;
}
after(async () => { await shared?.stop(); });
afterEach(() => { shared?.retireExtras(); });

async function pair(name) {
    const S = await scenario();
    const { alice, bob } = S.users;
    const group = await S.createGroup(alice, name);
    await S.addMember(alice, group.id, bob);
    await S.mount(alice);
    await S.open(alice, group.id);
    await S.mount(bob);
    await S.open(bob, group.id);
    return { S, alice, bob, group };
}

function click(u, selector) {
    u.actor.use();
    const el = u.actor.window.document.querySelector(selector);
    assert.ok(el, `${u.n}: ${selector} not found`);
    el.dispatchEvent(new u.actor.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function quoteTexts(u) {
    u.actor.use();
    return [...u.actor.window.document.querySelectorAll('#group-messages .reply-quote-text')]
        .map((e) => e.textContent.trim());
}

test('R-1: reply quotes show decrypted plaintext (live and history), never the ciphertext envelope', async () => {
    const { S, alice, bob, group } = await pair('r1');

    await S.send(alice, 'quote me please');
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('quote me please')), 'control: Bob receives the original');

    // Bob clicks the real reply button on Alice's message, then sends.
    click(bob, '#group-messages [data-action="thread-reply"]');
    await S.send(bob, 'this is my reply');
    assert.ok(await S.waitFor(alice, () => S.bubbles(alice).some((t) => t.includes('this is my reply'))), 'control: Alice receives the reply');

    // Live path (socket -> decorate).
    const live = quoteTexts(alice);
    assert.deepEqual(live, ['quote me please'], `live reply quote on Alice: ${JSON.stringify(live)}`);

    // History path (bulk fetch -> decorate): drop UI caches and reopen.
    alice.actor.use();
    alice.actor.window.dispatchEvent(new alice.actor.window.Event('wire:logout'));
    await S.open(alice, group.id);
    const hist = quoteTexts(alice);
    assert.deepEqual(hist, ['quote me please'], `history reply quote on Alice: ${JSON.stringify(hist)}`);
    assert.ok(!/ciphertext|senderKeyId/.test(alice.actor.window.document.getElementById('group-messages').innerHTML),
        'raw envelope fields leaked into the DOM');
});

// ---------------------------------------------------------------
// R-2: stale async "load older" must not touch another group's UI
// ---------------------------------------------------------------
function seedOlderRows(S, groupId, senderId, n) {
    // Any member can POST arbitrary text as "ciphertext" (the server cannot
    // check it), so undecryptable history rows are realistic -- and they give
    // the group more than one page of history.
    const ins = S.server.db.prepare(
        'INSERT INTO group_messages (group_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)'
    );
    for (let i = 0; i < n; i++) {
        ins.run(groupId, senderId, `junk-${i}`, `2020-01-01T00:00:${String(i).padStart(2, '0')}.000Z`);
    }
}

test('R-2: a stale "load older" for group A must not delete group B\'s load-more button', async () => {
    const S = await scenario();
    const { alice, bob } = S.users;
    await S.mount(alice);
    await S.mount(bob);

    const gA = await S.createGroup(alice, 'r2-A');
    const gB = await S.createGroup(alice, 'r2-B');
    for (const g of [gA, gB]) await S.addMember(alice, g.id, bob);
    for (const g of [gA, gB]) seedOlderRows(S, g.id, alice.ident.id, 60);

    for (const g of [gA, gB]) {
        await S.open(alice, g.id);
        await S.send(alice, `real message in ${g.name}`);
    }

    // Bob opens A: one real message plus a full page of junk => "Load older".
    await S.open(bob, gA.id);
    const rowA = await S.waitFor(bob, (d) => d.querySelector('#group-messages #chat-load-more-row'));
    assert.ok(rowA, 'control: group A shows a "Load older" button');

    // Bob clicks it; that request is held in flight...
    bob.actor.delayNext('GET', new RegExp(`/api/groups/${gA.id}/messages/before`), 700);
    bob.actor.use();
    rowA.querySelector('.load-more-btn').click();

    // ...and Bob switches to group B, which has its own button.
    await S.open(bob, gB.id);
    assert.ok(bob.actor.window.document.querySelector('#group-messages #chat-load-more-row'),
        'control: group B shows its own "Load older" button');

    await sleep(1200); // A's delayed response lands now, while B is on screen

    assert.ok(
        bob.actor.window.document.querySelector('#group-messages #chat-load-more-row'),
        "group B's Load-older button was deleted by group A's stale response"
    );
    assert.ok(S.bubbles(bob).includes('real message in r2-B'), 'group B content still intact');
    assert.ok(!S.bubbles(bob).includes('real message in r2-A'), 'group A content did not leak into group B');
});

// ---------------------------------------------------------------
// R-3 / R-4: removal
// ---------------------------------------------------------------
test('R-3: a removed member is evicted from the group socket room (no more typing events)', async () => {
    const { S, alice, bob, group } = await pair('r3');

    const events = [];
    bob.actor.use();
    bob.socketMod.getSocket().on('group:typing', (p) => events.push(p));

    // control: while a member, Bob does see Alice typing
    alice.socketMod.getSocket().emit('group:typing', { group_id: group.id });
    await S.waitFor(bob, () => events.length > 0, 2000);
    assert.ok(events.length > 0, 'control: Bob receives typing while a member');

    await S.removeMember(alice, group.id, bob);
    await sleep(400);
    const before = events.length;

    alice.socketMod.getSocket().emit('group:typing', { group_id: group.id });
    await sleep(700);
    assert.equal(events.length, before, 'removed member still receives group room broadcasts');
});

test('R-4: a removed member cannot drain KDMs for the group, and pending KDMs are purged', async () => {
    const S = await scenario();
    const { alice, bob, carol } = S.users;
    const group = await S.createGroup(alice, 'r4');
    await S.addMember(alice, group.id, bob);
    await S.addMember(alice, group.id, carol);
    await S.mount(alice);
    await S.open(alice, group.id);          // Alice distributes a key to Bob and Carol
    await sleep(400);

    const pendingForCarol = () => S.server.db.prepare(
        'SELECT COUNT(*) c FROM group_key_distributions WHERE group_id = ? AND to_user_id = ?'
    ).get(group.id, carol.ident.id).c;
    assert.ok(pendingForCarol() > 0, 'control: Carol has KDM rows waiting (she never drained)');

    await S.removeMember(alice, group.id, carol);

    assert.equal(pendingForCarol(), 0, 'removed member still has KDM rows addressed to her');

    // ...and the drain endpoint, without a group filter, must not hand her rows for groups she left.
    const drained = await S.api(carol, '/api/groups/kdms');
    assert.deepEqual(drained.filter((r) => r.group_id === group.id), [], 'removed member drained KDMs for a group she left');
});

// ---------------------------------------------------------------
// R-5: prove delivery arrives over Socket.IO, not via an HTTP fetch
// ---------------------------------------------------------------
test('R-5: Bob\'s UI updates from the new-group-message Socket.IO event, with no message-history fetch', async () => {
    const { S, alice, bob, group } = await pair('r5');

    // Bob's own socket, observed at the transport level.
    const socketEvents = [];
    bob.actor.use();
    const sock = bob.socketMod.getSocket();
    sock.onAny((name, payload) => socketEvents.push({ name, payload }));

    const historyFetches = () => bob.actor.fetchLog.filter(
        (f) => f.method === 'GET' && new RegExp(`/api/groups/${group.id}/messages/(recent|since|before)`).test(f.url)
    ).length;
    const fetchesBefore = historyFetches();
    const totalBefore = bob.actor.fetchLog.length;

    const text = `over the wire ${Date.now()}`;
    await S.send(alice, text);
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes(text)), 'Bob renders the plaintext');

    const ev = socketEvents.find((e) => e.name === 'new-group-message');
    assert.ok(ev, `Bob's socket never received new-group-message; saw ${JSON.stringify(socketEvents.map((e) => e.name))}`);
    assert.equal(ev.payload.group_id, group.id);
    assert.ok(!ev.payload.content.includes(text), 'the socket payload is ciphertext (server never sees plaintext)');
    assert.equal(JSON.parse(ev.payload.content).v, 1, 'payload is a group envelope');

    assert.equal(historyFetches(), fetchesBefore, 'Bob fetched message history: the UI was NOT driven by the socket event alone');
    const newRequests = bob.actor.fetchLog.slice(totalBefore).map((f) => `${f.method} ${new URL(f.url).pathname}`);
    assert.ok(!newRequests.some((r) => /messages\/(recent|since|before)/.test(r)), `unexpected history requests: ${JSON.stringify(newRequests)}`);
});

// ---------------------------------------------------------------
// R-6: reconnect after missing a membership change (and its KDMs)
// ---------------------------------------------------------------
test('R-6: after reconnecting past a missed membership change, the new member can read the reconnected member', async () => {
    const S = await scenario();
    const { alice, bob, carol } = S.users;
    const group = await S.createGroup(alice, 'r6');
    await S.addMember(alice, group.id, bob);
    await S.mount(alice); await S.open(alice, group.id);
    await S.mount(bob); await S.open(bob, group.id);
    await S.mount(carol);
    await sleep(300);

    // Bob drops off; while he is away Carol joins (epoch bump, everyone rotates)
    // and Alice writes.
    bob.actor.use();
    bob.socketMod.getSocket().disconnect();
    await sleep(200);
    await S.addMember(alice, group.id, carol);
    await S.open(carol, group.id);
    await sleep(800);
    await S.send(alice, 'sent while bob was offline');

    // Bob comes back (same page, no reload).
    bob.actor.use();
    bob.socketMod.getSocket().connect();
    assert.ok(
        await S.waitFor(bob, () => S.bubbles(bob).includes('sent while bob was offline'), 8000),
        `Bob never caught up after reconnecting: ${JSON.stringify(S.bubbles(bob))}`
    );
    assert.equal(S.bubbles(bob).filter((t) => t === 'sent while bob was offline').length, 1, 'rendered exactly once');

    // Bob writes. Carol joined while he was offline, so Bob must have rotated to include her.
    await S.send(bob, 'bob is back');
    assert.ok(
        await S.waitFor(carol, () => S.bubbles(carol).includes('bob is back'), 6000),
        `the member added while Bob was offline cannot read Bob: ${JSON.stringify(S.bubbles(carol))}`
    );
    assert.ok(await S.waitFor(alice, () => S.bubbles(alice).includes('bob is back')), 'Alice reads Bob too');
});
