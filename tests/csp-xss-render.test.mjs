// tests/csp-xss-render.test.mjs
//
// Renders the REAL reactions.js / reply.js / thread.js / group.js with
// hostile data and inspects the result through jsdom's spec-compliant
// HTML parser (parse5) -- i.e. what the DOM actually becomes, not what
// a regex thinks the string looks like (tests/reactions-xss.test.mjs
// covers the string-level invariants with a hand-rolled stub).
//
// IMPORTANT LIMIT: jsdom is a parser + DOM, not a browser. It does not
// enforce Content-Security-Policy. This file therefore proves
//   (a) hostile data cannot change DOM structure / create attributes,
//   (b) the buttons that used to rely on inline onclick="" now work
//       through delegated listeners (i.e. they do not NEED inline
//       handlers, which is what a CSP-enforcing browser would strip),
// and does NOT prove that any browser blocked anything.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const jsPath = (rel) => new URL(`../public/js/${rel}`, import.meta.url).pathname;

// ---------- DOM ----------
const dom = new JSDOM('<!doctype html><html><body><div id="content-area"></div></body></html>', {
    url: 'https://wireapp.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

// ---------- Hostile corpus ----------
const HOSTILE = [
    '"><img src=x onerror=alert(1)>',
    "');alert(document.cookie);//",
    '</span><script>alert(1)</script>',
    '" onmouseover="alert(1)',
    "\\'); alert(1); //",
    '<svg/onload=alert(1)>',
    '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;',
    "' onfocus='alert(1)' autofocus='",
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<style>*{display:none}</style>',
    'javascript:alert(1)',
    '<a href="javascript:alert(1)">x</a>',
];

const FORBIDDEN_TAGS = 'script,img,iframe,object,embed,style,link,form,input,textarea,select,base,meta,a[href^="javascript:" i]';

/** Fails if any element carries an on* or style attribute, or a javascript: URL. */
function assertNoActiveAttrs(root, label) {
    for (const el of root.querySelectorAll('*')) {
        for (const attr of el.attributes) {
            assert.ok(!/^on/i.test(attr.name), `${label}: <${el.tagName.toLowerCase()}> has ${attr.name}=`);
            assert.ok(attr.name.toLowerCase() !== 'style', `${label}: inline style attribute on <${el.tagName.toLowerCase()}>`);
            if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(attr.name.toLowerCase())) {
                assert.ok(!/^\s*javascript:/i.test(attr.value), `${label}: javascript: URL in ${attr.name}`);
            }
        }
    }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 12) { for (let i = 0; i < n; i++) await tick(); }

function parse(html) {
    const host = document.createElement('div');
    host.innerHTML = html; // same sink the app uses
    return host;
}

// ---------- Mocks for genuinely unrelated dependencies ----------
const apiCalls = [];
let apiRoutes = {};
mock.module(jsPath('core/api.js'), {
    namedExports: {
        api: async (url, opts = {}) => {
            apiCalls.push({ url, method: opts.method || 'GET' });
            const key = `${opts.method || 'GET'} ${url}`;
            if (key in apiRoutes) return typeof apiRoutes[key] === 'function' ? apiRoutes[key](opts) : apiRoutes[key];
            if (url in apiRoutes) return typeof apiRoutes[url] === 'function' ? apiRoutes[url](opts) : apiRoutes[url];
            return {};
        },
        fetchBlob: async () => new Blob(['x']),
    },
});
mock.module(jsPath('core/auth.js'), {
    namedExports: { getCurrentUser: () => ({ id: 1, username: 'alice', is_admin: false }), getToken: () => 't', logout() {} },
});
mock.module(jsPath('core/socket.js'), { namedExports: { getSocket: () => null } });

const pickerCalls = [];
mock.module(jsPath('ui/emoji-picker.js'), {
    namedExports: { openEmojiPicker: (o) => pickerCalls.push(o), closeEmojiPicker() {}, isEmojiPickerOpen: () => false },
});
mock.module(jsPath('ui/avatar.js'), { namedExports: { avatarHtml: () => '<div class="avatar-stub"></div>' } });
mock.module(jsPath('ui/confirm.js'), { namedExports: { showConfirm: async () => true } });
mock.module(jsPath('chat/message-accent.js'), {
    namedExports: { setMessageAccent() {}, repaintAllMessageAccents() {} },
});
mock.module(jsPath('chat/presence.js'), { namedExports: { isUserOnline: () => false } });
mock.module(jsPath('chat/typing.js'), {
    namedExports: {
        createTypingEmitter: () => ({}),
        createTypingIndicator: () => ({ set() {}, clear() {}, clearAll() {} }),
        wireTypingInput() {},
    },
});

// Protected media module: mocked ONLY so thread.js can be imported without
// pulling in the whole media stack. Group messages have no attachments.
mock.module(jsPath('media/attachments.js'), {
    namedExports: {
        renderAttachment: () => '',
        loadChatImage() {},
        mountAttachmentMedia() {},
        cleanupImageUrls() {},
        revokeAttachmentImage() {},
        revokeMediaPlayerBlobUrls() {},
        imageDownloadButtonHtml: () => '',
    },
});

class MissingSenderKeyError extends Error {}
class ReplayedMessageError extends Error {}
mock.module(jsPath('crypto/messages/group-message-crypto.js'), {
    namedExports: {
        encryptOutgoingGroupMessage: async (_g, t) => t,
        decryptIncomingGroupMessage: async (_g, c) => c,
        // A's group.js decrypts reply previews via the Detailed variant.
        // Pure passthrough: the payload must reach the renderer unsanitized.
        decryptIncomingGroupMessageDetailed: async (_g, c) => ({ plaintext: c }),
        readEnvelopeSenderKeyId: () => '1',
        ensureSenderKeyForGroup: async () => {},
        drainGroupKdms: async () => {},
        forgetGroupKeys: async () => {},
        MissingSenderKeyError,
        ReplayedMessageError,
    },
});

const composerCalls = { send: 0, setReplyTo: [], destroy: 0 };
mock.module(jsPath('chat/composer.js'), {
    namedExports: {
        createComposer: () => ({
            send: () => { composerCalls.send++; },
            setReplyTo: (p) => composerCalls.setReplyTo.push(p),
            destroy: () => { composerCalls.destroy++; },
        }),
    },
});

let lastDialog = null;
mock.module(jsPath('files/dialog.js'), {
    namedExports: {
        openDialog: ({ label }) => {
            const panel = document.createElement('div');
            panel.dataset.dialogLabel = label;
            document.body.appendChild(panel);
            lastDialog = { label, panel, closed: false };
            return { panel, close: () => { lastDialog.closed = true; panel.remove(); } };
        },
        closeAllDialogs() {},
    },
});

// ---------- Real modules under test ----------
const { renderReactionsRow } = await import(jsPath('chat/reactions.js'));
const { buildReplyQuoteHtml } = await import(jsPath('chat/reply.js'));
const group = await import(jsPath('chat/group.js'));

// =====================================================================
// TASK 3 -- reaction XSS, verified through a real HTML parser
// =====================================================================

const reactionRow = (emoji, opts = {}) =>
    renderReactionsRow(
        {
            id: opts.msgId ?? 7,
            reactions: [{ emoji, count: opts.count ?? 1, user_ids: [2], usernames: opts.usernames ?? ['bob'] }],
        },
        opts.scope ?? 'group'
    );

test('reaction: hostile group.emoji becomes inert TEXT in every scope (real parser)', () => {
    // Baseline is per scope: in X, chat/dm rows carry no add-reaction button
    // (it lives in the message action bar) while the group row does, so the
    // benign element count legitimately differs by scope. The assertion below
    // is unchanged: a hostile payload must not change the count for its scope.
    for (const scope of ['chat', 'dm', 'group']) {
        const benignCount = parse(reactionRow('👍', { scope })).querySelectorAll('*').length;
        for (const payload of HOSTILE) {
            const root = parse(reactionRow(payload, { scope }));
            const label = `[${scope}] ${payload}`;

            assert.equal(root.querySelectorAll('*').length, benignCount, `element count changed: ${label}`);
            assert.equal(root.querySelectorAll(FORBIDDEN_TAGS).length, 0, `forbidden element injected: ${label}`);
            assertNoActiveAttrs(root, label);

            const pill = root.querySelector('.reaction-pill');
            assert.ok(pill, `pill missing: ${label}`);
            assert.equal(pill.querySelector('.reaction-emoji').textContent, payload, `visible text differs: ${label}`);
            assert.equal(pill.dataset.emoji, payload, `data-emoji does not round-trip: ${label}`);
            assert.equal(pill.dataset.scope, scope);
        }
    }
});

test('reaction: hostile usernames / msg id / count cannot break out of attributes', () => {
    const benignCount = parse(reactionRow('👍')).querySelectorAll('*').length;
    for (const payload of HOSTILE) {
        const viaName = parse(reactionRow('👍', { usernames: [payload] }));
        assert.equal(viaName.querySelectorAll('*').length, benignCount, `username: ${payload}`);
        assertNoActiveAttrs(viaName, `username ${payload}`);
        assert.equal(viaName.querySelector('.reaction-pill').getAttribute('title'), payload);

        // Numeric fields are coerced, so a string smuggled into id/count
        // cannot reach an attribute or text node as markup.
        const viaNums = parse(reactionRow('👍', { msgId: payload, count: payload }));
        assert.equal(viaNums.querySelectorAll('*').length, benignCount, `id/count: ${payload}`);
        assertNoActiveAttrs(viaNums, `id/count ${payload}`);
        assert.equal(viaNums.querySelector('.reaction-count').textContent, '0');
    }
});

test('reaction: a REAL DOM click delivers the exact hostile emoji to toggleMessageReaction', () => {
    const toggled = [];
    window.toggleMessageReaction = (scope, id, emoji) => toggled.push({ scope, id, emoji });

    for (const payload of ['👍', "it's", 'back\\slash', 'say "hi"', 'a&b', '<b>', ...HOSTILE]) {
        const root = parse(reactionRow(payload, { scope: 'group', msgId: 42 }));
        document.body.appendChild(root);
        root.querySelector('.reaction-pill').click();
        root.remove();

        assert.deepEqual(toggled.at(-1), { scope: 'group', id: 42, emoji: payload }, `mismatch for ${payload}`);
    }
});

// =====================================================================
// TASK 2 -- reply preview (attachment metadata + usernames)
// =====================================================================

const replyMsg = (over) => ({
    reply_to_id: 10,
    reply_to: {
        id: 10, username: 'bob', content: '', has_attachment: false,
        attachment_name: null, attachment_mime: null, ...over,
    },
});

test('reply quote: hostile attachment filename is rendered as text, not markup', () => {
    for (const payload of HOSTILE) {
        // application/pdf -> attachmentLabel() falls through to the raw filename
        const root = parse(buildReplyQuoteHtml(
            replyMsg({ has_attachment: true, attachment_name: payload, attachment_mime: 'application/pdf' }), 'group'));
        assert.equal(root.querySelectorAll(FORBIDDEN_TAGS).length, 0, `forbidden element from filename: ${payload}`);
        assertNoActiveAttrs(root, `filename ${payload}`);
        assert.equal(root.querySelector('.reply-quote-text').textContent, payload);
    }
});

test('reply quote: hostile username and content are rendered as text', () => {
    for (const payload of HOSTILE) {
        const root = parse(buildReplyQuoteHtml(replyMsg({ username: payload, content: payload }), 'dm'));
        assert.equal(root.querySelectorAll(FORBIDDEN_TAGS).length, 0, payload);
        assertNoActiveAttrs(root, payload);
        assert.equal(root.querySelector('.reply-quote-name').textContent, payload);
        assert.equal(root.querySelector('.reply-quote-text').textContent, payload);
    }
});

test('reply quote: hostile scope / reply id cannot escape data-* attributes', () => {
    for (const payload of HOSTILE) {
        const root = parse(buildReplyQuoteHtml(replyMsg({ id: payload }), payload));
        assertNoActiveAttrs(root, payload);
        assert.equal(root.querySelectorAll('*').length, parse(buildReplyQuoteHtml(replyMsg({}), 'group')).querySelectorAll('*').length);
        assert.equal(root.querySelector('.reply-quote').dataset.scope, payload);
    }
});

// =====================================================================
// TASK 1 + 4 -- Group / Thread UI without inline handlers
// =====================================================================

const HOSTILE_GROUP_NAME = `Eve's "<img src=x onerror=alert(1)>" club`;
const HOSTILE_MEMBER = `<b onmouseover=alert(1)>mallory</b>`;
const HOSTILE_ROLE = `admin"><script>alert(1)</script>`;
const HOSTILE_USER_OPT = `</option><img src=x onerror=alert(1)>`;

apiRoutes = {
    '/api/groups': [{ id: 5, name: HOSTILE_GROUP_NAME, role: 'owner', key_epoch: 1 }],
    '/api/groups/5/members': [
        { user_id: 1, username: 'alice', role: 'owner', key_epoch: 1 },
        { user_id: 2, username: HOSTILE_MEMBER, role: HOSTILE_ROLE },
    ],
    '/api/groups/5/messages/recent?limit=50': [
        {
            id: 11, group_id: 5, sender_id: 2, sender_username: HOSTILE_MEMBER,
            content: '<img src=x onerror=alert(1)> see https://example.com/a?b=1&c="2"',
            timestamp: '2026-09-28T10:00:00Z',
            reactions: [{ emoji: HOSTILE[0], count: 2, user_ids: [2], usernames: [HOSTILE_MEMBER, 'alice'] }],
            reply_to_id: 10,
            reply_to: { id: 10, username: HOSTILE_MEMBER, content: HOSTILE[2], has_attachment: false },
        },
    ],
    '/api/share/users': [{ id: 1, username: 'alice' }, { id: 3, username: HOSTILE_USER_OPT }],
    'DELETE /api/groups/5/messages/11': {},
};

test('group UI: renders hostile data inertly, with no inline handlers or style attributes', async () => {
    await group.showGroups();
    await settle();

    const content = document.getElementById('content-area');
    assertNoActiveAttrs(content, 'group list');

    const row = content.querySelector('.group-row');
    assert.ok(row, 'group row rendered');
    assert.equal(row.querySelector('.conv-name').textContent, HOSTILE_GROUP_NAME);
    assert.equal(row.querySelector('.group-avatar-badge').getAttribute('title'), HOSTILE_GROUP_NAME);

    row.click();
    await settle(30);

    assertNoActiveAttrs(content, 'group panel');
    assert.equal(content.querySelectorAll(FORBIDDEN_TAGS.replace('textarea,', '')).length, 0, 'forbidden element in group UI');
    assert.equal(content.querySelector('.chat-top-name').textContent, HOSTILE_GROUP_NAME);
    assert.equal(document.getElementById('group-input').getAttribute('placeholder'), `Message ${HOSTILE_GROUP_NAME}…`,
        'placeholder must round-trip the name exactly (no backslash-mangling)');

    const msg = content.querySelector('.chat-msg[data-msg-id="11"]');
    assert.ok(msg, 'message rendered');
    assert.equal(msg.querySelector('.chat-sender').textContent, HOSTILE_MEMBER);
    // decrypted message text: markup is text, real URL is still linkified safely
    const bubble = msg.querySelector('.chat-bubble');
    assert.equal(bubble.querySelectorAll('img').length, 0);
    assert.ok(bubble.textContent.startsWith('<img src=x onerror=alert(1)>'));
    const link = bubble.querySelector('a.chat-link');
    assert.ok(link && /^https:\/\/example\.com\//.test(link.href));
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    // reactions + reply quote inside the same message
    assert.equal(msg.querySelector('.reaction-emoji').textContent, HOSTILE[0]);
    assert.equal(msg.querySelector('.reply-quote-name').textContent, HOSTILE_MEMBER);
});

test('group UI: Send / Emoji / Manage / + New work via delegated listeners', async () => {
    const content = document.getElementById('content-area');

    // "+ New" lives on the list header, which showGroups() re-rendered above.
    content.querySelector('[data-action="group-new"]').click();
    await settle();
    assert.equal(lastDialog?.label, 'Create group', '"+ New" must open the create-group dialog');
    assertNoActiveAttrs(lastDialog.panel, 'create-group dialog');
    lastDialog.panel.remove();

    // Send
    const before = composerCalls.send;
    content.querySelector('[data-action="group-send"]').click();
    assert.equal(composerCalls.send, before + 1, 'send button must call composer.send()');

    // Emoji trigger (dynamic import of the picker is async)
    const trigger = content.querySelector('[data-action="group-emoji"]');
    trigger.click();
    await settle();
    assert.equal(pickerCalls.length, 1, 'emoji trigger must open the picker');
    assert.equal(pickerCalls[0].anchorEl, trigger, 'picker must anchor to the clicked button');

    // Manage group -> settings dialog with hostile member data
    content.querySelector('[data-action="group-settings"]').click();
    await settle(20);
    assert.equal(lastDialog?.label, 'Group settings', 'Manage must open group settings');
    const panel = lastDialog.panel;
    assertNoActiveAttrs(panel, 'group settings dialog');
    assert.equal(panel.querySelectorAll('script,img,iframe').length, 0);
    const roles = [...panel.querySelectorAll('.grp-member-role')].map((n) => n.textContent);
    assert.ok(roles.includes(HOSTILE_ROLE), 'role must render as text (previously interpolated raw)');
    const opt = [...panel.querySelectorAll('#add-member-select option')].find((o) => o.value === '3');
    assert.equal(opt.textContent, HOSTILE_USER_OPT);
    panel.remove();
});

test('thread UI: Reply and Delete buttons work via delegation and pass exact ids', async () => {
    const content = document.getElementById('content-area');
    const msg = content.querySelector('.chat-msg[data-msg-id="11"]');

    const reply = msg.querySelector('[data-action="thread-reply"]');
    const del = msg.querySelector('[data-action="thread-delete"]');
    assert.ok(reply && del, 'reply + delete buttons present (owner can delete)');
    assert.equal(reply.dataset.scope, 'group');
    assert.equal(reply.dataset.msgId, '11');

    reply.click();
    assert.equal(composerCalls.setReplyTo.length, 1, 'Reply must call composer.setReplyTo');
    assert.equal(composerCalls.setReplyTo[0].id, 11);

    apiCalls.length = 0;
    del.click();
    await settle();
    assert.deepEqual(apiCalls.filter((c) => c.method === 'DELETE'),
        [{ url: '/api/groups/5/messages/11', method: 'DELETE' }], 'Delete must call the DELETE endpoint once');
    assert.equal(content.querySelector('.chat-msg[data-msg-id="11"]'), null, 'message removed from DOM after delete');
});

// =====================================================================
// Regression: thread.js keeps ONE registry slot per scope, but group.js
// keeps one thread PER GROUP. Opening group B used to steal group A's
// slot, so after switching back to (cached) A, A's Delete button sent
// DELETE to B's endpoint and Reply silently did nothing.
// =====================================================================

test('thread UI: after switching A -> B -> A, Reply/Delete act on A (not the last-created thread)', async () => {
    const mk = (gid, mid, text) => ({
        id: mid, group_id: gid, sender_id: 1, sender_username: 'alice', content: text,
        timestamp: '2026-09-28T11:00:00Z', reactions: [],
    });
    Object.assign(apiRoutes, {
        '/api/groups': [
            { id: 7, name: 'Alpha', role: 'owner', key_epoch: 1 },
            { id: 8, name: 'Beta', role: 'owner', key_epoch: 1 },
        ],
        '/api/groups/7/members': [{ user_id: 1, username: 'alice', role: 'owner' }],
        '/api/groups/8/members': [{ user_id: 1, username: 'alice', role: 'owner' }],
        '/api/groups/7/messages/recent?limit=50': [mk(7, 21, 'in alpha')],
        '/api/groups/8/messages/recent?limit=50': [mk(8, 31, 'in beta')],
        'DELETE /api/groups/7/messages/21': {},
        'DELETE /api/groups/8/messages/21': {},
    });

    await group.loadGroupsList();
    await group.showGroups();
    await settle();

    await group.openGroup(7); await settle(30);   // creates thread 7
    await group.openGroup(8); await settle(30);   // creates thread 8 (used to steal the slot)
    await group.openGroup(7); await settle(30);   // back to cached 7

    const content = document.getElementById('content-area');
    const msg = content.querySelector('.chat-msg[data-msg-id="21"]');
    assert.ok(msg, 'alpha message rendered after switching back');

    composerCalls.setReplyTo.length = 0;
    msg.querySelector('[data-action="thread-reply"]').click();
    assert.equal(composerCalls.setReplyTo.length, 1, 'Reply must resolve message 21 in the ACTIVE group');
    assert.equal(composerCalls.setReplyTo[0].id, 21);

    apiCalls.length = 0;
    msg.querySelector('[data-action="thread-delete"]').click();
    await settle();
    assert.deepEqual(apiCalls.filter((c) => c.method === 'DELETE').map((c) => c.url),
        ['/api/groups/7/messages/21'], 'Delete must target the group actually on screen');
});
