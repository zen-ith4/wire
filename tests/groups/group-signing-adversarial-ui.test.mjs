// Phase C4 (client + real server): reply abuse and swapped KDM rows, as a member SEES them.
// The "hostile server" is the test editing group_messages / group_key_distributions rows.

import './_env.mjs';
import { test, after, before } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

let S;
let n = 0;

before(async () => { S = await createScenario(['alice', 'bob', 'mallory', 'carol']); });
after(async () => { await S?.stop(); });

const db = () => S.server.db;
const rows = (g) => S.envelopes(g.id);

async function newGroup({ withCarol = false } = {}) {
    const { alice, bob, mallory, carol } = S.users;
    for (const u of [alice, bob, mallory]) await S.mount(u);
    const g = await S.createGroup(alice, `adversarial-${n++}`);
    await S.addMember(alice, g.id, bob);
    await S.addMember(alice, g.id, mallory);
    if (withCarol) await S.addMember(alice, g.id, carol);
    await sleep(900);
    await S.open(alice, g.id);
    await sleep(300);
    return g;
}

/** `u` posts through the REAL crypto with an explicit signed reply target (and, optionally, another one in the request body). */
async function sendReply(u, g, text, replyToId, bodyReplyToId = replyToId) {
    u.actor.use();
    const c = await u.actor.importModule('crypto/messages/group-message-crypto.js');
    const content = await c.encryptOutgoingGroupMessage(g.id, text, { replyToId });
    return S.api(u, `/api/groups/${g.id}/messages`, { method: 'POST', body: JSON.stringify({ content, reply_to_id: bodyReplyToId }) });
}

async function bobView(g) {
    await S.open(S.users.bob, g.id);
    await sleep(350);
    const { bob } = S.users;
    bob.actor.use();
    return [...bob.actor.window.document.querySelectorAll('#group-messages .chat-msg')].map((m) => ({
        id: Number(m.dataset.msgId),
        text: m.querySelector('.chat-bubble')?.textContent ?? null,
        quote: m.querySelector('.reply-quote')?.textContent.trim().replace(/\s+/g, ' ') ?? null,
        quoteText: m.querySelector('.reply-quote-text')?.textContent ?? null,
    }));
}

const UNVERIFIED = /could not be verified/;
const DELETED = /Original message deleted/;

test('C4-9 (reply abuse): a signed reply target in ANOTHER group verifies, the server drops it, and the foreign message is never shown', async () => {
    const { alice } = S.users;
    const g = await newGroup();
    const other = await newGroup();
    assert.ok(await S.send(alice, 'secret of the other group'));
    const foreign = rows(other).at(-1);

    await sendReply(alice, g, 'cross-group reply', foreign.id);
    const stored = rows(g).at(-1);
    assert.equal(db().prepare('SELECT reply_to_id FROM group_messages WHERE id = ?').get(stored.id).reply_to_id, null, 'control: the server dropped the foreign target');

    const view = await bobView(g);
    const m = view.find((x) => x.id === stored.id);
    assert.equal(m.text, 'cross-group reply');
    assert.match(m.quote, DELETED);
    assert.ok(!JSON.stringify(view).includes('secret of the other group'));
});

test('C4-10 (reply abuse): a reply to a DELETED message still verifies and shows "deleted"', async () => {
    const { alice } = S.users;
    const g = await newGroup();
    assert.ok(await S.send(alice, 'soon deleted'));
    const target = rows(g).at(-1);
    await sendReply(alice, g, 'reply to the doomed one', target.id);
    const reply = rows(g).at(-1);
    db().prepare('DELETE FROM group_messages WHERE id = ?').run(target.id);

    const view = await bobView(g);
    const m = view.find((x) => x.id === reply.id);
    assert.equal(m.text, 'reply to the doomed one');
    assert.match(m.quote, DELETED);
    assert.ok(!view.some((x) => x.id === target.id));
});

test('C4-11 (reply abuse): a reply whose signed target is ITSELF renders once, with no loop and no crash', async () => {
    const { alice } = S.users;
    const g = await newGroup();
    // the next message id is predictable (autoincrement): sign a reply to the id this very message will get
    const last = db().prepare("SELECT seq FROM sqlite_sequence WHERE name = 'group_messages'").get();
    const predicted = Number(last?.seq ?? 0) + 1;
    await sendReply(alice, g, 'I reply to myself', predicted);
    const stored = rows(g).at(-1);
    assert.equal(stored.id, predicted, 'control: the id was predicted correctly');

    const view = await bobView(g);
    const own = view.filter((x) => x.id === predicted);
    assert.equal(own.length, 1, 'rendered exactly once');
    assert.equal(own[0].text, 'I reply to myself');
    // however the quote ends up (its own text, or "deleted"), it can never show anything else
    assert.ok(own[0].quote === null || DELETED.test(own[0].quote) || own[0].quoteText === 'I reply to myself', JSON.stringify(own[0]));
});

test('C4-12 (reply abuse): a server that CHANGES the reply target (to another message, another group\'s message, a nonexistent id) makes the reply unverified; nulling it is allowed and shows "deleted"', async () => {
    const { alice } = S.users;
    const g = await newGroup();
    const other = await newGroup();
    assert.ok(await S.send(alice, 'other group message'));
    const foreign = rows(other).at(-1);

    assert.ok(await S.send(alice, 'original')); // placed in `other` (alice's open group): use a fresh message in g instead
    await S.open(alice, g.id);
    await sleep(200);
    assert.ok(await S.send(alice, 'target one'));
    assert.ok(await S.send(alice, 'target two'));
    const [t1, t2] = rows(g).slice(-2);

    const cases = {};
    for (const [name, newTarget] of Object.entries({
        'to another message of the same group': t2.id,
        'to a message of another group': foreign.id,
        'to a nonexistent id': 987654,
    })) {
        await sendReply(alice, g, `signed ${t1.id} / server says ${name}`, t1.id);
        const row = rows(g).at(-1);
        db().prepare('UPDATE group_messages SET reply_to_id = ? WHERE id = ?').run(newTarget, row.id);
        cases[name] = row.id;
    }
    await sendReply(alice, g, 'server nulls the target', t1.id);
    const nulled = rows(g).at(-1);
    db().prepare('UPDATE group_messages SET reply_to_id = NULL WHERE id = ?').run(nulled.id);

    const view = await bobView(g);
    for (const [name, id] of Object.entries(cases)) {
        const m = view.find((x) => x.id === id);
        assert.match(m.text, UNVERIFIED, `${name}: unverified`);
        assert.ok(!m.text.includes('signed'), `${name}: nothing of the message is shown`);
    }
    const nm = view.find((x) => x.id === nulled.id);
    assert.equal(nm.text, 'server nulls the target');
    assert.match(nm.quote, DELETED, 'a nulled target is shown as deleted, never as another message');
});

test('C4-13 (swapped KDM rows, end to end): a server that relabels Alice\'s KDM rows as Mallory\'s leaves Carol with no key; Alice\'s message is "waiting", never shown and never attributed', async () => {
    const { alice, mallory, carol } = S.users;
    const g = await newGroup({ withCarol: true });
    assert.ok(await S.send(alice, 'for carol, from alice'));

    // Carol is not mounted yet: the hostile server rewrites the KDM rows waiting for her
    const swapped = db().prepare('UPDATE group_key_distributions SET from_user_id = ? WHERE to_user_id = ? AND group_id = ?')
        .run(mallory.ident.id, carol.ident.id, g.id);
    assert.ok(swapped.changes >= 1, 'control: rows were relabelled');

    await S.mount(carol);
    await S.open(carol, g.id);
    await sleep(500);
    carol.actor.use();
    const texts = [...carol.actor.window.document.querySelectorAll('#group-messages .chat-bubble')].map((e) => e.textContent);

    assert.ok(!texts.some((t) => t.includes('for carol, from alice')), `the message is not readable without the key: ${JSON.stringify(texts)}`);
    assert.ok(!texts.some((t) => /could not be verified/.test(t)), 'it is "waiting for key" (a history fetch simply omits those), not a verified or misattributed message');

    // Alice's key was never stored: not under Alice (the unwrap failed) and not under Mallory (ownership
    // follows the pairwise unwrap). What Carol does hold is Mallory's OWN genuine key (that row unwrapped
    // for real, whatever the server wrote on it) and her own freshly minted one.
    const keys = await carol.actor.importModule('crypto/groups/sender-key-store.js');
    carol.actor.use();
    const owners = (await keys.getAllSenderKeysForGroup(g.id)).map((r) => [r.ownerUserId, r.isMine]).sort();
    assert.ok(!owners.some(([o]) => o === alice.ident.id), `no key of Alice: ${JSON.stringify(owners)}`);
    assert.deepEqual(owners, [[mallory.ident.id, 0], [carol.ident.id, 1]].sort());
});
