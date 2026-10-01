// tests/groups/group-ui-security.test.mjs
//
// Group/E2EE audit sections 8 and 9: hostile data must never become
// executable markup, and the Group UI must not emit anything the app CSP
// (no 'unsafe-inline' for scripts OR styles) would block.
//
// Real server + Socket.IO + unmodified client. Assertions are structural
// (no injected element, no on* attribute, no style attribute), because that
// is what actually decides whether a browser can execute the payload, and
// because it does not depend on jsdom running scripts.
//
//   X-1  hostile group name / username / message / reply quote / reaction /
//        attachment metadata render as inert text
//   X-2  names containing ' \ " & < > display exactly as typed in title/placeholder
//   X-3  Group UI markup contains no inline style attributes, inline event
//        handlers, or javascript: URLs (shell, dialogs, thread)

import './_env.mjs';

import { test, after } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

const HOSTILE_NAME = `"><img src=x onerror="window.__pwned='group-name'">`;
const HOSTILE_USER = `<svg onload="window.__pwned='username'">`;
const HOSTILE_TEXT = `<img src=x onerror="window.__pwned='text'"><script>window.__pwned='script'</script>`;
const HOSTILE_LINK = `www.example.com/"onmouseover="window.__pwned='link'`;
const HOSTILE_EMOJI = `"><b onmouseover=1>x`;
const HOSTILE_FILE = `"><img src=x onerror="window.__pwned='file'">.pdf`;
const QUIRKY_NAME = `O'Brien \\ "quoted" & <co>`;

let S = null;
async function scenario() {
    if (!S) S = await createScenario(['alice', 'bob', 'mallory']);
    return S;
}
after(async () => { await S?.stop(); });

/** Elements/attributes that would let hostile data execute or escape. */
function dangerousNodes(root) {
    const found = [];
    for (const el of root.querySelectorAll('*')) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'script') found.push(`<script>`);
        if (tag === 'svg' && el.hasAttribute('onload')) found.push('svg[onload]');
        for (const a of [...el.attributes]) {
            if (/^on/i.test(a.name)) found.push(`${tag}[${a.name}]`);
            if (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) {
                found.push(`${tag}[${a.name}=javascript:]`);
            }
        }
    }
    return found;
}

function uiRoots(u) {
    u.actor.use();
    const d = u.actor.window.document;
    return [d.getElementById('group-messages'), d.getElementById('group-panel'), d.getElementById('groups-list'), d.body]
        .filter(Boolean);
}

test('X-1: hostile group name, username, message, reply quote, reaction and attachment metadata render inert', async () => {
    const s = await scenario();
    const { alice, bob, mallory } = s.users;

    // A legacy/lenient account whose username is markup (the DB has no constraint).
    s.server.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(HOSTILE_USER, mallory.ident.id);

    const group = await s.createGroup(alice, HOSTILE_NAME);
    await s.addMember(alice, group.id, bob);
    await s.addMember(alice, group.id, mallory);

    await s.mount(alice);
    await s.open(alice, group.id);
    await s.mount(bob);
    await s.open(bob, group.id);
    await s.mount(mallory);
    await s.open(mallory, group.id);
    await sleep(500);

    // Hostile plaintext through the real composer and real E2EE path.
    await s.send(mallory, HOSTILE_TEXT);
    await s.send(mallory, HOSTILE_LINK);
    assert.ok(await s.waitFor(bob, () => s.bubbles(bob).includes(HOSTILE_TEXT)), 'hostile text arrives as literal text');

    // Reply to the hostile message: the quoted preview carries hostile plaintext too.
    bob.actor.use();
    bob.actor.window.document.querySelector('#group-messages [data-action="thread-reply"]')
        .dispatchEvent(new bob.actor.window.MouseEvent('click', { bubbles: true }));
    await s.send(bob, 'replying to the hostile one');
    await s.waitFor(alice, () => s.bubbles(alice).some((t) => t.includes('replying to the hostile one')));

    // Hostile reaction (emoji is only length-checked by the API) and reaction title
    // (usernames), plus hostile attachment metadata via a stored row.
    const lastMsg = s.envelopes(group.id).at(-1);
    await s.api(mallory, `/api/groups/${group.id}/messages/${lastMsg.id}/reactions`, {
        method: 'POST', body: JSON.stringify({ emoji: HOSTILE_EMOJI }),
    }).catch(() => null);
    // Hostile attachment metadata on a row that carries a genuine encrypted caption.
    const captioned = s.envelopes(group.id).find((e) => e.sender_id === mallory.ident.id);
    s.server.db.prepare(
        `UPDATE group_messages SET attachment_path = 'x', attachment_name = ?, attachment_size = 10,
                                   attachment_mime = 'application/pdf', attachment_iv = 'AAAAAAAAAAAAAAAA'
         WHERE id = ?`
    ).run(HOSTILE_FILE, captioned.id);

    // Force a full history render on every client (bulk path) as well as the live one.
    for (const u of [alice, bob, mallory]) {
        u.actor.use();
        u.actor.window.dispatchEvent(new u.actor.window.Event('wire:logout'));
        await s.open(u, group.id);
    }
    await sleep(500);

    for (const u of [alice, bob, mallory]) {
        u.actor.use();
        const w = u.actor.window;
        assert.equal(w.__pwned, undefined, `${u.name}: hostile code executed (${w.__pwned})`);
        for (const root of uiRoots(u)) {
            assert.deepEqual(dangerousNodes(root), [], `${u.name}: executable markup created from hostile data`);
        }
        // no <img>/<b> elements were conjured by the payloads inside the thread
        const thread = w.document.getElementById('group-messages');
        assert.equal(thread.querySelectorAll('img[src="x"]').length, 0, `${u.name}: <img src=x> injected`);
        assert.equal(thread.querySelectorAll('b').length, 0, `${u.name}: <b> injected via reaction/emoji`);
    }

    // Non-vacuity: the reaction and attachment rows really rendered on Bob's screen.
    const pills = [...bob.actor.window.document.querySelectorAll('#group-messages .reaction-pill')];
    assert.ok(pills.some((p) => p.getAttribute('data-emoji') === HOSTILE_EMOJI),
        `hostile reaction not rendered as an inert data-emoji attribute; pills=${JSON.stringify(pills.map((p) => p.getAttribute('data-emoji')))}`);
    assert.ok(bob.actor.window.document.getElementById('group-messages').textContent.includes(HOSTILE_FILE),
        'hostile attachment file name not rendered (attachment path not exercised)');

    // The hostile text is displayed, literally.
    assert.ok(s.bubbles(bob).includes(HOSTILE_TEXT), 'literal hostile text visible to Bob');
    const quotes = [...bob.actor.window.document.querySelectorAll('#group-messages .reply-quote-text')].map((e) => e.textContent.trim());
    assert.ok(quotes.includes(HOSTILE_TEXT), `hostile reply quote shown literally, got ${JSON.stringify(quotes)}`);
    assert.ok([...bob.actor.window.document.querySelectorAll('#group-messages .chat-sender')].some((e) => e.textContent === HOSTILE_USER),
        'hostile username shown literally as the sender name');

    // The auto-linker must not turn the attribute-break-out URL into a live handler.
    const links = [...bob.actor.window.document.querySelectorAll('#group-messages .chat-bubble a')];
    for (const a of links) {
        assert.ok(![...a.attributes].some((x) => /^on/i.test(x.name)), 'link carries an event-handler attribute');
    }
});

test('X-2: group names with quote/backslash/ampersand display exactly as typed (title, placeholder)', async () => {
    const s = await scenario();
    const { alice } = s.users;
    const group = await s.createGroup(alice, QUIRKY_NAME);
    await s.mount(alice);
    await s.open(alice, group.id);

    alice.actor.use();
    const d = alice.actor.window.document;
    const input = d.getElementById('group-input');
    assert.equal(input.getAttribute('placeholder'), `Message ${QUIRKY_NAME}…`, 'composer placeholder mangled or unsafe');

    const badges = [...d.querySelectorAll('.group-avatar-badge')].map((e) => e.getAttribute('title'));
    assert.ok(badges.length > 0 && badges.every((t) => t === QUIRKY_NAME || t === HOSTILE_NAME || typeof t === 'string'), 'badges present');
    assert.ok(badges.includes(QUIRKY_NAME), `avatar title attribute mangled: ${JSON.stringify(badges)}`);
});

test('X-3: Group UI emits no inline style attributes, inline handlers or javascript: URLs', async () => {
    const s = await scenario();
    const { alice, bob } = s.users;
    const group = await s.createGroup(alice, 'csp shape');
    await s.addMember(alice, group.id, bob);
    await s.mount(alice);

    // Record every CSP-relevant sink. A browser enforcing this app's CSP
    // (no 'unsafe-inline' in script-src or style-src) blocks style="" and on*=""
    // that arrive as MARKUP (innerHTML/insertAdjacentHTML/outerHTML) or via
    // setAttribute; it does NOT block CSSOM writes (el.style.setProperty),
    // which is how the app sets --message-accent. So this hooks the sinks
    // instead of scanning serialized attributes, which cannot tell the two apart.
    alice.actor.use();
    const w = alice.actor.window;
    const sinks = [];
    const EP = w.Element.prototype;

    // Parse the markup like a browser would and inspect REAL attributes. A regex
    // over the source cannot tell an attribute from escaped text that merely
    // contains the characters "onerror=" (e.g. a hostile group name shown as text).
    // DOMParser is used because it does not go through the hooked setters below.
    const parser = new w.DOMParser();
    function badAttributes(html) {
        const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html');
        const bad = [];
        for (const el of doc.body.querySelectorAll('*')) {
            for (const a of [...el.attributes]) {
                if (a.name === 'style') bad.push(`${el.tagName.toLowerCase()}[style]`);
                if (/^on/i.test(a.name)) bad.push(`${el.tagName.toLowerCase()}[${a.name}]`);
                if (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) {
                    bad.push(`${el.tagName.toLowerCase()}[${a.name}=javascript:]`);
                }
            }
        }
        return bad;
    }
    const record = (sink, html) => { const bad = badAttributes(String(html)); if (bad.length) sinks.push(`${sink}: ${bad.join(',')}`); };

    const inner = Object.getOwnPropertyDescriptor(EP, 'innerHTML');
    Object.defineProperty(EP, 'innerHTML', {
        ...inner,
        set(v) { record('innerHTML', v); inner.set.call(this, v); },
    });
    const outer = Object.getOwnPropertyDescriptor(EP, 'outerHTML');
    if (outer?.set) {
        Object.defineProperty(EP, 'outerHTML', { ...outer, set(v) { record('outerHTML', v); outer.set.call(this, v); } });
    }
    const iah = EP.insertAdjacentHTML;
    EP.insertAdjacentHTML = function (pos, v) { record('insertAdjacentHTML', v); return iah.call(this, pos, v); };
    const sa = EP.setAttribute;
    EP.setAttribute = function (n, v) {
        if (/^(style|on[a-z]+)$/i.test(n)) sinks.push(`setAttribute(${n})`);
        if (/^(href|src)$/i.test(n) && /^\s*javascript:/i.test(String(v))) sinks.push(`setAttribute(${n}=javascript:)`);
        return sa.call(this, n, v);
    };

    await s.open(alice, group.id);
    await s.send(alice, 'hello csp');
    await sleep(300);

    const d = w.document;
    // Open the real settings dialog (delegated click), then the create dialog.
    d.querySelector('[data-action="group-settings"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    const createBtn = d.querySelector('[data-action="group-new"]');
    assert.ok(createBtn, 'create-group control found');
    createBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(300);

    assert.ok(d.querySelector('.member-list'), 'control: a Group dialog actually rendered (settings or create)');
    assert.deepEqual(sinks, [], 'Group UI emitted markup the app CSP would block');

    for (const root of uiRoots(alice)) {
        assert.deepEqual(dangerousNodes(root), [], 'inline event handler or javascript: URL in Group UI');
    }
});
