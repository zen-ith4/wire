// tests/escape-attr-js-string.test.mjs
//
// escapeAttr() (public/js/core/utils.js) is for values that sit in a double-quoted HTML attribute
// which the browser then parses AGAIN as a single-quoted JS string:
//     onclick="window.downloadAttachment(id, '<escapeAttr(name)>', ...)"
// Two parsers run in order, HTML first (it decodes entities), JS second. If '&' is not escaped, a
// filename like  x&#39;);evil();(&#39;  becomes  x');evil();('  after the HTML step and closes the
// JS string (stored XSS, confirmed in real Chromium in phase 2).
//
// What is checked, with no regex on markup:
//   1. through the REAL renderers (media/attachments.js renderAttachment + imageDownloadButtonHtml,
//      call sites :886 and :995): the markup is parsed by jsdom (HTML step), the resulting onclick
//      attribute is executed as JS (JS step) with window.downloadAttachment stubbed. The stub must
//      receive EXACTLY the original filename / mime, and nothing else may run (globalThis.__pwned);
//   2. the same contract on escapeAttr() directly for a corpus of hostile and odd strings
//      (also covers media/audio-player.js:249, which uses the identical template);
//   3. benign strings (no '&', no lone CR / U+2028 / U+2029) produce BYTE-IDENTICAL output to the
//      previous implementation, frozen below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const jsPath = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://wireapp.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.navigator ??= dom.window.navigator;
for (const k of ['MutationObserver', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'Element', 'DOMParser']) {
    if (!(k in globalThis) && dom.window[k]) globalThis[k] = dom.window[k];
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { escapeAttr } = await import(jsPath('core/utils.js'));
const { renderAttachment, imageDownloadButtonHtml } = await import(jsPath('media/attachments.js'));

/** The previous implementation, frozen: used only to prove benign output did not change. */
const legacyEscapeAttr = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\r?\n/g, ' ');

const HOSTILE = [
    "x&#39;);__pwned=1;(&#39;",                 // the confirmed exploit: entity-encoded quote
    'x&apos;);__pwned=1;(&apos;',
    "x&#x27;);__pwned=1;(&#x27;",
    'x&quot;);__pwned=1;(&quot;',
    "x');__pwned=1;('",                          // raw quote
    "x\\');__pwned=1;('",                         // backslash before the quote
    'x\\&#39;);__pwned=1;(&#39;',                 // backslash + entity
    '&amp;#39;);__pwned=1;(&amp;#39;',
    'a"b\'c\\d&e<f>g',
    'line1\nline2\r\nline3\rline4\u2028line5\u2029line6',
    '<img src=x onerror=__pwned=1>.txt',
    '&#10;);__pwned=1;(&#10;',                    // entity newline
];
const BENIGN = ['report.pdf', 'Tom and Jerry.pdf', "O'Brien notes.txt", 'a "quoted" name.txt', 'back\\slash.txt', 'résumé 2026 (final).docx', '日本語のファイル.txt', 'a<b>.txt', 'x=1;y=2.txt', ''];

/** HTML step (jsdom) then JS step (Function): returns what the handler called downloadAttachment with. */
function runHandler(html, selector) {
    const host = document.createElement('div');
    host.innerHTML = html;
    const el = host.querySelector(selector);
    assert.ok(el, `${selector} not found in rendered markup`);
    const code = el.getAttribute('onclick');
    assert.ok(code, 'element has an onclick attribute');
    globalThis.__pwned = 0;
    const calls = [];
    new Function('window', code)({ downloadAttachment: (...a) => calls.push(a) });
    const pwned = globalThis.__pwned;
    globalThis.__pwned = 0;
    return { calls, pwned };
}

const norm = (s) => s.replace(/\r\n|[\r\n\u2028\u2029]/g, ' '); // newlines are deliberately flattened to a space

test('renderAttachment (file card, attachments.js:995): handler receives exactly the filename and mime; nothing else runs', () => {
    for (const name of [...HOSTILE, ...BENIGN]) {
        const html = renderAttachment({ id: 7, attachment_name: name, attachment_mime: 'application/pdf', attachment_size: 12 }, 'dm');
        const { calls, pwned } = runHandler(html, '.chat-attachment');
        assert.equal(pwned, 0, `payload executed for filename ${JSON.stringify(name)}`);
        assert.equal(calls.length, 1, `handler made exactly one call for ${JSON.stringify(name)}`);
        assert.deepEqual(calls[0], [7, norm(name), 'dm', 'application/pdf'], `arguments for ${JSON.stringify(name)}`);
    }
});

test('renderAttachment: hostile mime type cannot break out either', () => {
    for (const mime of HOSTILE) {
        const html = renderAttachment({ id: 8, attachment_name: 'a.bin', attachment_mime: mime, attachment_size: 1 }, 'group');
        const { calls, pwned } = runHandler(html, '.chat-attachment');
        assert.equal(pwned, 0, `payload executed for mime ${JSON.stringify(mime)}`);
        assert.deepEqual(calls[0], [8, 'a.bin', 'group', norm(mime)]);
    }
});

test('imageDownloadButtonHtml (attachments.js:886): handler receives exactly the filename; nothing else runs', () => {
    for (const name of [...HOSTILE, ...BENIGN]) {
        const html = imageDownloadButtonHtml({ id: 9, has_attachment: 1, attachment_name: name, attachment_mime: 'image/png' }, 'dm');
        const { calls, pwned } = runHandler(html, '.chat-msg-download');
        assert.equal(pwned, 0, `payload executed for filename ${JSON.stringify(name)}`);
        assert.deepEqual(calls[0], [9, norm(name), 'dm', 'image/png']);
    }
});

test('escapeAttr contract (also media/audio-player.js:249, same template): value round-trips through HTML then JS', () => {
    for (const v of [...HOSTILE, ...BENIGN]) {
        const host = document.createElement('div');
        host.innerHTML = `<button onclick="window.f('${escapeAttr(v)}')"></button>`;
        globalThis.__pwned = 0;
        const got = [];
        new Function('window', host.firstChild.getAttribute('onclick'))({ f: (x) => got.push(x) });
        assert.equal(globalThis.__pwned, 0, `payload executed for ${JSON.stringify(v)}`);
        assert.deepEqual(got, [norm(v)], `round trip for ${JSON.stringify(v)}`);
    }
});

test('plain attributes (title/data-*/alt): the value reads back exactly (also fixes display of names containing &)', () => {
    for (const v of ['Tom & Jerry.pdf', 'a&amp;b', '&#39;x', 'plain.txt']) {
        const host = document.createElement('div');
        host.innerHTML = `<i title="${escapeAttr(v)}"></i>`;
        assert.equal(host.firstChild.getAttribute('title'), v);
    }
});

test('benign strings: output is BYTE-IDENTICAL to the previous implementation (no "&", no lone CR / U+2028 / U+2029)', () => {
    let n = 0;
    const samples = [...BENIGN, "it's", 'q"uote', 'a\\b', 'multi\nline', 'crlf\r\nline'];
    // deterministic pseudo-random corpus
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const alphabet = "abcXYZ 019_-.()[]{}'\"\\<>=;:/,!?é日\n";
    for (let i = 0; i < 5000; i++) samples.push(Array.from({ length: rnd() % 40 }, () => alphabet[rnd() % alphabet.length]).join(''));
    for (const s of samples) {
        if (/[&\u2028\u2029]|\r(?!\n)/.test(s)) continue; // the only inputs allowed to differ
        assert.equal(escapeAttr(s), legacyEscapeAttr(s), `changed for ${JSON.stringify(s)}`);
        n++;
    }
    assert.ok(n > 4000, `compared ${n} strings`);
    // and the inputs that are allowed to differ really do, in the documented way
    assert.equal(escapeAttr('a&b'), 'a&amp;b');
    assert.equal(escapeAttr('x\u2028y\ry'), 'x y y');
});
