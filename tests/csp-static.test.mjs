// tests/csp-static.test.mjs
//
// Static CSP regression checks. These do NOT prove a browser enforces
// the policy (nothing in Node can) -- they pin the two things a test
// CAN pin:
//   1. the header the server actually sends is strict, and
//   2. the front-end source contains no construct that a strict CSP
//      would block (inline handlers, inline style attributes, eval,
//      string timers, javascript: URLs, inline <script>/<style>).
//
// X's pre-existing UI still contains inline handlers / style="" attributes
// and a few other constructs a strict CSP blocks (docs/CSP_TODO.md lists
// them). They are tolerated through a PER-FILE CAPPED allowlist
// (LEGACY_CAPS below), not a blanket exemption: a file fails if its count
// goes ABOVE its cap, and every file not listed -- in particular
// chat/group.js, chat/thread.js and every other new file -- has cap 0.
// Caps may only go down: when legacy code is converted, lower (or delete)
// its entry. CSP is Report-Only by default (middleware/csp.js); these caps
// are what has to reach zero before CSP_ENFORCE=true is safe in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const require = createRequire(import.meta.url);

// Per-file caps for X's legacy code (counts measured with the exact
// regexes below; derived from docs/CSP_TODO.md). Missing file => cap 0.
const LEGACY_CAPS = {
  handlers: {
    'js/chat/dm.js': 9,
    'js/settings/settings-render.js': 8,
    'js/settings/admin.js': 7,
    'js/chat/composer.js': 4,
    'js/media/attachments.js': 3,
    'js/chat/reactions.js': 1,
    'js/media/audio-player.js': 1,
    'js/ui/avatar.js': 1,
    'js/ui/profile-card.js': 1,
    'js/wireguard/wireguard.js': 1,
  },
  styles: {
    'js/core/auth.js': 21,
    'js/settings/settings-render.js': 16,
    'js/chat/dm.js': 3,
    'js/settings/admin.js': 3,
    'js/settings/settings-appearance-custom.js': 3,
    'js/media/video-player.js': 2,
    'js/media/voice-message.js': 2,
    'js/chat/composer.js': 1,
    'js/media/attachments.js': 1,
    'js/media/audio-player.js': 1,
    'js/settings/settings-bubble-gradient.js': 1,
    'js/settings/settings-message-sounds.js': 1,
    'js/ui/emoji-picker.js': 1,
    'js/ui/profile-card.js': 1,
    'js/wireguard/wireguard.js': 1,
  },
  setAttr: {
    'js/media/attachments.js': 4,
    'js/chat/dm.js': 1,
  },
  // All 20 legacy sites now use escapeHtmlAttr(); cap is 0 everywhere.
  // (Explicit zeros kept so the diff shows what was removed. auth.js is
  // excluded from this check by the test below: its local escapeHtml()
  // escapes both quote kinds.)
  escapeHtmlInAttr: {
    'js/settings/settings-render.js': 0,
    'js/settings/settings-shortcuts.js': 0,
    'js/settings/settings-appearance-custom.js': 0,
    'js/chat/composer.js': 0,
    'js/chat/dm.js': 0,
    'js/settings/settings-bubble-gradient.js': 0,
  },
  indexHtml: {"inlineScripts": 1, "styleBlocks": 0, "handlerAttrs": 10, "styleAttrs": 1},
};

// Files whose count exceeds their cap. Same shape as the old allowlist
// check, but capped instead of exempt.
function overCap(list, re, kind) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    return list
        .map((f) => ({ rel: f.rel, n: (f.src.match(g) || []).length }))
        .filter(({ rel, n }) => n > (LEGACY_CAPS[kind][rel] ?? 0))
        .map(({ rel, n }) => `${rel}: ${n} > cap ${LEGACY_CAPS[kind][rel] ?? 0}`);
}

function walk(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (ent.name === 'vendor') continue; // bundled third-party
            walk(p, out);
        } else if (ent.name.endsWith('.js')) out.push(p);
    }
    return out;
}

// Removes // line comments and /* */ blocks so prose that merely
// *mentions* onclick="" doesn't count. Deliberately conservative:
// a `//` only starts a comment at line start or after whitespace, so
// the `//` in https:// inside strings is left alone.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // Split on \r?\n: several front-end files are CRLF, and `.` in a
        // JS regex does not match \r, so a plain split('\n') would leave
        // every comment line in those files un-stripped.
        .split(/\r?\n/)
        .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
        .join('\n');
}

const files = walk(path.join(PUBLIC, 'js')).map((abs) => ({
    rel: path.relative(PUBLIC, abs).split(path.sep).join('/'),
    src: stripComments(fs.readFileSync(abs, 'utf8')),
}));

// HTML attribute form only (`onclick="..."`): preceded by whitespace/quote,
// immediately followed by =" or =' . JS property assignment
// (`btn.onclick = fn`) has a dot before it and spaces around `=`, so it
// does not match -- and it is CSP-safe anyway (not an attribute).
const INLINE_HANDLER = /[\s"'`]on[a-z]{3,}=["'`\\]/;
// `style="..."` attribute, but not data-style="..." (preceded by `-`).
const INLINE_STYLE = /[\s"'`]style=["'\\]/;
const CODE_FROM_STRING =
    /\beval\s*\(|\bnew\s+Function\s*\(|\bsetTimeout\s*\(\s*["'`]|\bsetInterval\s*\(\s*["'`]|["'`]\s*javascript:|\bdocument\.write\s*\(/;

test('CSP header: strict script-src, no unsafe-inline / unsafe-eval anywhere', () => {
    const { csp } = require(path.join(ROOT, 'middleware/csp.js'));
    let header = null;
    const res = { locals: {}, setHeader: (k, v) => { if (k === 'Content-Security-Policy') header = v; } };
    let nexted = false;
    csp({}, res, () => { nexted = true; });

    assert.ok(nexted, 'middleware must call next()');
    assert.ok(header, 'Content-Security-Policy header must be set');
    assert.ok(!/unsafe-inline/i.test(header), 'unsafe-inline must not appear');
    assert.ok(!/unsafe-eval/i.test(header), 'unsafe-eval must not appear');
    assert.ok(!/'nonce-/i.test(header), 'no nonce is emitted (nothing consumes it)');

    const dirs = Object.fromEntries(
        header.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
            const [name, ...vals] = d.split(/\s+/);
            return [name, vals];
        })
    );
    assert.deepEqual(dirs['script-src'], ["'self'"]);
    assert.deepEqual(dirs['object-src'], ["'none'"]);
    assert.deepEqual(dirs['base-uri'], ["'self'"]);
    assert.deepEqual(dirs['default-src'], ["'self'"]);
    // Inline style="" attributes are governed by style-src too (via the
    // style-src-attr fallback) -- this is why they are audited below.
    assert.ok(!dirs['style-src'].some((v) => /unsafe-inline/.test(v)));
});

test('index.html has no inline <script>, <style>, on*= handler, or style="" attribute beyond its legacy cap', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const cap = LEGACY_CAPS.indexHtml;
    const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc=/i.test(m[1])).length;
    assert.ok(inlineScripts <= cap.inlineScripts, `inline <script> found: ${inlineScripts} > cap ${cap.inlineScripts}`);
    const styleBlocks = (html.match(/<style\b/gi) || []).length;
    assert.ok(styleBlocks <= cap.styleBlocks, `inline <style> block found: ${styleBlocks} > cap ${cap.styleBlocks}`);
    const handlerAttrs = (html.match(/\son[a-z]{3,}\s*=/gi) || []).length;
    assert.ok(handlerAttrs <= cap.handlerAttrs, `inline event-handler attribute found: ${handlerAttrs} > cap ${cap.handlerAttrs}`);
    const styleAttrs = (html.match(/\sstyle\s*=/gi) || []).length;
    assert.ok(styleAttrs <= cap.styleAttrs, `inline style attribute found: ${styleAttrs} > cap ${cap.styleAttrs}`);
});

test('no eval / new Function / string timers / javascript: / document.write in front-end code', () => {
    const offenders = files.filter((f) => CODE_FROM_STRING.test(f.src)).map((f) => f.rel);
    assert.deepEqual(offenders, []);
});

test('chat/group.js and chat/thread.js contain NO inline handlers or inline styles', () => {
    for (const rel of ['js/chat/group.js', 'js/chat/thread.js']) {
        const f = files.find((x) => x.rel === rel);
        assert.ok(f, `${rel} not found`);
        assert.ok(!INLINE_HANDLER.test(f.src), `${rel}: inline on*= attribute in markup`);
        assert.ok(!INLINE_STYLE.test(f.src), `${rel}: inline style="" attribute in markup`);
    }
});

test('no inline on*= handler attributes beyond each legacy file\'s cap', () => {
    assert.deepEqual(overCap(files, INLINE_HANDLER, 'handlers'), []);
});

test('no inline style="" attributes beyond each legacy file\'s cap', () => {
    assert.deepEqual(overCap(files, INLINE_STYLE, 'styles'), []);
});

test('no setAttribute("style"|"on*") and no .cssText writes beyond each legacy file\'s cap', () => {
    const re = /setAttribute\(\s*["'](?:style|on[a-z]+)["']|\.cssText\s*=/;
    assert.deepEqual(overCap(files, re, 'setAttr'), []);
});

// ---------------------------------------------------------------------
// XSS context guard. utils.escapeHtml() is the textContent->innerHTML
// trick: it escapes & < > but NOT quotes, so it is only valid in TEXT
// context. Inside a quoted attribute value it lets a `"` (e.g. in a
// group name -- the server allows free text up to 100 chars) break out
// and inject attributes. Attribute values must use escapeHtmlAttr()
// (or files/html.js esc(), or auth.js's local quote-escaping helper).
// ---------------------------------------------------------------------

test('escapeHtml() is not used inside a quoted HTML attribute value beyond each legacy file\'s cap', () => {
    const re = /=\s*"[^"\n]*\$\{\s*escapeHtml\(/;
    // auth.js defines its OWN escapeHtml that does escape quotes.
    const scoped = files.filter((f) => f.rel !== 'js/core/auth.js');
    assert.deepEqual(overCap(scoped, re, 'escapeHtmlInAttr'), []);
});

test('every file that calls escapeHtmlAttr() imports or defines it', () => {
    const offenders = files
        .filter((f) => /\bescapeHtmlAttr\s*\(/.test(f.src))
        .filter((f) => !/\bimport\s*\{[^}]*\bescapeHtmlAttr\b[^}]*\}/.test(f.src)
                    && !/\bfunction\s+escapeHtmlAttr\b/.test(f.src))
        .map((f) => f.rel);
    assert.deepEqual(offenders, []);
});
