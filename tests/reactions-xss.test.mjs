// tests/reactions-xss.test.mjs
//
// Regression test for a stored-XSS bug in public/js/chat/reactions.js.
//
// The bug: renderReactionsRow() interpolated group.emoji straight into
// innerHTML (and into an inline onclick="" JS string). The server only
// length-checks the emoji field (<= 32 chars; see chat/dm/groups
// controllers), so any authenticated user could POST an arbitrary
// string as a "reaction" via a direct API call and have it execute in
// every other participant's chat/DM/group view.
//
// This renders the REAL renderReactionsRow() with hostile data and
// checks, without needing an HTML parser:
//   * structure invariant -- a hostile value must not change the number
//     of <, > or " characters in the output vs. a benign value, i.e. it
//     cannot open a tag or break out of an attribute;
//   * no inline event-handler attributes are emitted at all;
//   * the value round-trips exactly through the data-* attribute into
//     the delegated click handler (so escaping doesn't corrupt it).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// mock.module() and import() both need a URL on Windows; a raw absolute path
// is rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME (protocol 'c:'), and a URL
// *pathname* ("/C:/...") silently fails to match the mock.
const js = (rel) => pathToFileURL(path.join(ROOT, 'public/js', rel)).href;

// ---- Browser-faithful minimal DOM stub ----
// escapeHtml() in core/utils.js is textContent -> innerHTML. Real
// browsers serialize text nodes escaping & < > (and nbsp) but NOT
// quote characters -- that detail is exactly why title="..." values need
// escapeHtmlAttr rather than escapeHtml, so the stub must match it.
const clickHandlers = [];
globalThis.window = globalThis;
globalThis.document = {
    createElement() {
        let text = '';
        return {
            set textContent(v) { text = String(v); },
            get innerHTML() {
                return text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/\u00a0/g, '&nbsp;');
            },
        };
    },
    addEventListener(type, fn) { if (type === 'click') clickHandlers.push(fn); },
};

mock.module(js('core/api.js'), { namedExports: { api: async () => ({}) } });
mock.module(js('core/auth.js'), { namedExports: { getCurrentUser: () => ({ id: 1 }) } });
mock.module(js('ui/emoji-picker.js'), { namedExports: { openEmojiPicker: () => {} } });

const { renderReactionsRow } = await import(js('chat/reactions.js'));

// ---- helpers ----
const count = (s, ch) => s.split(ch).length - 1;
// Split into tag tokens and text tokens. A `"` inside a *text* node is
// harmless (and browsers don't escape it there), so quotes are only
// counted inside tags, where an unescaped one would end an attribute.
const tagsOf = (html) => html.split(/(<[^>]*>)/).filter((_, i) => i % 2 === 1);
const shape = (html) => {
    const tags = tagsOf(html);
    return {
        lt: count(html, '<'),
        gt: count(html, '>'),
        tags: tags.length,
        quotesInTags: tags.reduce((n, t) => n + count(t, '"'), 0),
    };
};

// True if any tag has an on*= attribute *outside* of a quoted value.
const hasInlineHandler = (html) =>
    tagsOf(html).some((t) => /\son[a-z]+\s*=/i.test(t.replace(/"[^"]*"/g, '""')));

function decodeEntities(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

const render = (emoji, usernames = ['alice']) =>
    renderReactionsRow(
        { id: 7, reactions: [{ emoji, count: 1, user_ids: [2], usernames }] },
        'dm'
    );

const BENIGN = render('👍');
assert.ok(!/<img|<script/i.test(BENIGN), 'test premise: benign markup has no <img>/<script>');

const HOSTILE = [
    '"><img src=x onerror=alert(1)>',
    "');alert(document.cookie);//",
    '</span><script>alert(1)</script>',
    '" onmouseover="alert(1)',
    "\\'); alert(1); //",
    '<svg/onload=alert(1)>',
    '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;',
];

test('hostile emoji values cannot alter the markup structure', () => {
    for (const payload of HOSTILE) {
        const html = render(payload);
        assert.deepEqual(shape(html), shape(BENIGN), `structure changed for: ${payload}`);
        // (<svg> is excluded: the add-reaction button legitimately contains an
        // icon. Injected <svg> is still caught by the tag-count invariant above.)
        assert.ok(!/<img|<script/i.test(html), `raw tag leaked for: ${payload}`);
    }
});

test('hostile usernames in the title attribute cannot break out of it', () => {
    for (const payload of ['" onmouseover="alert(1)', '"><img src=x onerror=alert(1)>', "' onfocus='alert(1)"]) {
        const html = render('👍', [payload]);
        assert.deepEqual(shape(html), shape(BENIGN), `structure changed for username: ${payload}`);
    }
});

test('no inline event-handler attributes are emitted (CSP: no unsafe-inline)', () => {
    assert.ok(!hasInlineHandler(BENIGN), 'inline on*= handler found in reactions markup');
    for (const payload of HOSTILE) {
        assert.ok(!hasInlineHandler(render(payload)), `handler attribute appeared for: ${payload}`);
        assert.ok(!hasInlineHandler(render('👍', [payload])), `handler attribute appeared via username: ${payload}`);
    }
});

test('emoji round-trips exactly through data-emoji into the click handler', async () => {
    assert.ok(clickHandlers.length >= 1, 'reactions.js did not register a delegated click handler');

    const toggled = [];
    window.toggleMessageReaction = (scope, id, emoji) => toggled.push({ scope, id, emoji });

    for (const payload of ['👍', "it's", 'back\\slash', 'say "hi"', 'a&b', '<b>', ...HOSTILE]) {
        const html = render(payload);
        const attr = html.match(/data-emoji="([^"]*)"/);
        assert.ok(attr, `data-emoji attribute missing/broken for: ${payload}`);

        // Simulate the browser: entity-decode the attribute into dataset.
        const dataset = {
            action: 'toggle-reaction', scope: 'dm', msgId: '7', emoji: decodeEntities(attr[1]),
        };
        const btn = { dataset };
        for (const fn of clickHandlers) fn({ target: { closest: () => btn } });

        assert.equal(toggled.at(-1).emoji, payload, `value corrupted in transit for: ${payload}`);
        assert.equal(toggled.at(-1).id, 7);
        assert.equal(toggled.at(-1).scope, 'dm');
    }
});
