// Phase C3: what a member SEES (real client modules in the actor DOM, real server, real
// socket.io) when the server is hostile or a member forges: unverified placeholders,
// signed reply targets, attribution, no retry of unverified messages.
// The "hostile server" is the test itself editing group_messages rows.

import './_env.mjs';
import { test, after, before } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

let S;
let n = 0;
const STATIC_UNVERIFIED = '<span class="text-muted">⚠️ Message could not be verified</span>';

before(async () => { S = await createScenario(['alice', 'bob', 'mallory']); });
after(async () => { await S?.stop(); });

// All three members stay mounted (connected). They rotate their keys on every membership
// event, so each new group is given a moment to settle before Alice opens it and sends.
async function newGroup() {
    const { alice, bob, mallory } = S.users;
    for (const u of [alice, bob, mallory]) await S.mount(u);
    const g = await S.createGroup(alice, `signed-ui-${n++}`);
    await S.addMember(alice, g.id, bob);
    await S.addMember(alice, g.id, mallory);
    await sleep(900);
    await S.open(alice, g.id);
    await sleep(300);
    return g;
}

const rows = (g) => S.envelopes(g.id);
const db = () => S.server.db;

async function crypto_(u) { u.actor.use(); return u.actor.importModule('crypto/messages/group-message-crypto.js'); }

/** Sends as `u` through the real crypto but with an explicit reply target, posting through the real API. */
async function sendReply(u, g, text, replyToId, bodyReplyToId = replyToId) {
    const c = await crypto_(u);
    u.actor.use();
    const content = await c.encryptOutgoingGroupMessage(g.id, text, { replyToId });
    return S.api(u, `/api/groups/${g.id}/messages`, { method: 'POST', body: JSON.stringify({ content, reply_to_id: bodyReplyToId }) });
}

async function bobSees(g) {
    await S.open(S.users.bob, g.id);
    await sleep(200);
    return S.bubbles(S.users.bob);
}

const bubbleHtml = (u) => {
    u.actor.use();
    return [...u.actor.window.document.querySelectorAll('#group-messages .chat-bubble')].map((e) => e.innerHTML);
};

test('UI-1: signed messages and replies round-trip; the quote is built from the signed reply target', async () => {
    const { alice, bob } = S.users;
    const g = await newGroup();

    assert.ok(await S.send(alice, 'hello bob'));
    await S.open(bob, g.id);
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('hello bob')), 'bob reads it');

    assert.ok(await S.send(bob, 'bob first'));
    const aliceMsg = rows(g).find((r) => JSON.parse(r.raw).sig && r.sender_id === alice.ident.id);
    assert.ok(aliceMsg);
    await sendReply(bob, g, 'bob replies', aliceMsg.id);

    assert.ok(await S.waitFor(alice, (d) => [...d.querySelectorAll('#group-messages .chat-bubble')].some((e) => e.textContent === 'bob replies')));
    alice.actor.use();
    const quote = [...alice.actor.window.document.querySelectorAll('#group-messages .chat-msg')]
        .find((m) => m.querySelector('.chat-bubble')?.textContent === 'bob replies')?.querySelector('.reply-quote-text')?.textContent;
    assert.equal(quote, 'hello bob');

    const env = JSON.parse(rows(g).at(-1).raw);
    assert.equal(env.reply_to_id, aliceMsg.id, 'the target is inside the signed envelope');
    assert.equal(Buffer.from(env.sig, 'base64').length, 64);
});

test('UI-2: a server that relabels the author makes the message unverified: nothing from it is rendered, the placeholder is static', async () => {
    const { alice, bob, mallory } = S.users;
    const g = await newGroup();
    assert.ok(await S.send(alice, 'alice says: the secret is 42'));
    const target = rows(g).at(-1);

    db().prepare('UPDATE group_messages SET sender_id = ? WHERE id = ?').run(mallory.ident.id, target.id);

    const seen = await bobSees(g);
    assert.ok(!seen.some((t) => t.includes('secret is 42')), 'the content is not rendered');
    assert.ok(seen.some((t) => t.includes('Message could not be verified')), `placeholder shown: ${JSON.stringify(seen)}`);
    assert.ok(bubbleHtml(bob).includes(STATIC_UNVERIFIED), 'the placeholder is exactly the static markup');
});

test('UI-3: tampered ciphertext / hostile strings never reach the DOM; the placeholder carries nothing from the message', async () => {
    const { alice, bob } = S.users;
    const g = await newGroup();
    assert.ok(await S.send(alice, 'harmless'));
    const target = rows(g).at(-1);

    const env = JSON.parse(target.raw);
    const hostile = '<img src=x onerror=window.__pwned=1>"\'<script>window.__pwned=1</script>';
    // hostile text in every envelope field the client could ever interpolate
    const tampered = { ...env, ciphertext: Buffer.from(hostile).toString('base64'), iv: env.iv, sig: env.sig, senderKeyId: env.senderKeyId, alg: hostile };
    db().prepare('UPDATE group_messages SET content = ? WHERE id = ?').run(JSON.stringify(tampered), target.id);

    await bobSees(g);
    const html = bubbleHtml(bob);
    assert.ok(html.every((h) => !h.includes('<img') && !h.includes('<script') && !h.includes('onerror')), JSON.stringify(html));
    assert.ok(bob.actor.window.__pwned === undefined);
});

test('UI-4 (A): a server that re-points a reply makes it unverified; a missing or deleted target still verifies and shows "deleted"', async () => {
    const { alice, bob } = S.users;
    const g = await newGroup();
    assert.ok(await S.send(alice, 'first'));
    assert.ok(await S.send(alice, 'second'));
    const [first, second] = rows(g);

    // (a) server swaps reply_to_id -> unverified
    await sendReply(alice, g, 'reply swapped', first.id);
    const swapped = rows(g).at(-1);
    db().prepare('UPDATE group_messages SET reply_to_id = ? WHERE id = ?').run(second.id, swapped.id);

    // (b) target DELETED: the server keeps reply_to_id, the join finds nothing
    await sendReply(alice, g, 'reply to a deleted message', second.id);
    const toDeleted = rows(g).at(-1);

    // (c) the server nulls reply_to_id while the signed one is set
    await sendReply(alice, g, 'reply with server null', first.id);
    const nulled = rows(g).at(-1);
    db().prepare('UPDATE group_messages SET reply_to_id = NULL WHERE id = ?').run(nulled.id);

    db().prepare('DELETE FROM group_messages WHERE id = ?').run(second.id);

    await S.open(bob, g.id);
    await sleep(300);
    bob.actor.use();
    const msgs = [...bob.actor.window.document.querySelectorAll('#group-messages .chat-msg')].map((m) => ({
        id: Number(m.dataset.msgId),
        text: m.querySelector('.chat-bubble')?.textContent,
        quote: m.querySelector('.reply-quote')?.textContent.trim().replace(/\s+/g, ' ') ?? null,
    }));
    const by = (id) => msgs.find((m) => m.id === id);

    assert.match(by(swapped.id).text, /could not be verified/, '(a) re-pointed reply is unverified');
    assert.equal(by(toDeleted.id).text, 'reply to a deleted message', '(b) deleted target: still verifies');
    assert.match(by(toDeleted.id).quote, /Original message deleted/);
    assert.equal(by(nulled.id).text, 'reply with server null', '(c) server null with a signed target: allowed');
    assert.match(by(nulled.id).quote, /Original message deleted/, '(c) ...and shown as deleted, never as the server\'s target');
});

test('UI-5 (A): a reply to a message of ANOTHER group verifies (the server drops the target) and shows "deleted"', async () => {
    const { alice, bob } = S.users;
    const g = await newGroup();
    const other = await newGroup();
    assert.ok(await S.send(alice, 'in the other group'));
    const foreign = rows(other).at(-1);

    await sendReply(alice, g, 'cross-group reply', foreign.id);
    const stored = rows(g).at(-1);
    assert.equal(db().prepare('SELECT reply_to_id FROM group_messages WHERE id = ?').get(stored.id).reply_to_id, null, 'control: the server dropped the foreign target');

    await S.open(bob, g.id);
    await sleep(300);
    bob.actor.use();
    const m = [...bob.actor.window.document.querySelectorAll('#group-messages .chat-msg')].find((e) => Number(e.dataset.msgId) === stored.id);
    assert.equal(m.querySelector('.chat-bubble').textContent, 'cross-group reply');
    assert.ok(!m.textContent.includes('in the other group'), 'the foreign message is never shown');
});

test('UI-6: a re-post of Alice\'s signed message by Mallory arrives live as a static unverified placeholder; Alice\'s genuine message is unaffected', async () => {
    const { alice, bob, mallory } = S.users;
    const g = await newGroup();
    await S.open(bob, g.id);
    assert.ok(await S.send(alice, 'genuine'));
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('genuine')));

    const genuine = rows(g).at(-1);
    // Mallory (a member) posts Alice's exact envelope as her own message
    await S.api(mallory, `/api/groups/${g.id}/messages`, { method: 'POST', body: JSON.stringify({ content: genuine.raw }) });

    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).some((t) => t.includes('Message could not be verified'))), 'placeholder shown live');
    assert.equal(S.bubbles(bob).filter((t) => t === 'genuine').length, 1, 'the genuine message is still shown once');
    assert.equal(S.bubbles(bob).filter((t) => t.includes('could not be verified')).length, 1);
});

test('UI-7 (C): an unverified message is permanent: no retry after a KDM drain / reconnect, the placeholder stays and no signature work is redone', async () => {
    const { alice, bob, mallory } = S.users;
    const g = await newGroup();
    await S.open(bob, g.id);
    assert.ok(await S.send(alice, 'genuine two'));
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).includes('genuine two')));
    const genuine = rows(g).at(-1);
    await S.api(mallory, `/api/groups/${g.id}/messages`, { method: 'POST', body: JSON.stringify({ content: genuine.raw }) });
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).some((t) => t.includes('could not be verified'))));

    bob.actor.use();
    const subtle = bob.actor.window.crypto?.subtle ?? crypto.subtle;
    const originalVerify = subtle.verify.bind(subtle);
    let verifies = 0;
    subtle.verify = (...a) => { verifies++; return originalVerify(...a); };
    try {
        // the two triggers of "retry placeholders" in the real client
        await bob.group.handleGroupSocketConnected();
        await bob.group.handleGroupKdmDelivered({ group_id: g.id });
        await sleep(300);
    } finally {
        subtle.verify = originalVerify;
    }

    assert.equal(verifies, 0, 'no decrypt/verify was attempted for the permanent placeholder');
    assert.equal(S.bubbles(bob).filter((t) => t.includes('could not be verified')).length, 1);
    assert.equal(bubbleHtml(bob).filter((h) => h === STATIC_UNVERIFIED).length, 1);
});

test('UI-8 (C): an unverified message in the middle of a history keeps order, count and the bottom of the thread intact', async () => {
    const { alice, bob } = S.users;
    const g = await newGroup();
    for (const t of ['m1', 'm2', 'm3', 'm4', 'm5']) assert.ok(await S.send(alice, t));
    const all = rows(g);
    db().prepare('UPDATE group_messages SET content = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(all[2].raw), sig: undefined }), all[2].id);

    const seen = await bobSees(g);
    assert.deepEqual(seen.map((t) => (t.includes('could not be verified') ? 'UNVERIFIED' : t)), ['m1', 'm2', 'UNVERIFIED', 'm4', 'm5']);

    bob.actor.use();
    const container = bob.actor.window.document.getElementById('group-messages');
    const ids = [...container.querySelectorAll('.chat-msg')].map((e) => Number(e.dataset.msgId));
    assert.deepEqual(ids, all.map((r) => r.id), 'ids and order are those of the server rows (pagination cursors keep working)');

    // reopening repaints from cache: still a placeholder, still in place
    await S.open(bob, g.id);
    await sleep(150);
    assert.deepEqual(S.bubbles(bob).map((t) => (t.includes('could not be verified') ? 'UNVERIFIED' : t)), ['m1', 'm2', 'UNVERIFIED', 'm4', 'm5']);

    // a new message after it still lands at the bottom
    assert.ok(await S.send(alice, 'm6'));
    assert.ok(await S.waitFor(bob, () => S.bubbles(bob).at(-1) === 'm6'));
});
