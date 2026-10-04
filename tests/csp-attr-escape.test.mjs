// tests/csp-attr-escape.test.mjs
//
// escapeHtml() (textContent -> innerHTML) does NOT escape quotes, so it is
// only safe in text nodes. Inside a quoted attribute value it lets a payload
// containing " or ' close the attribute and inject new attributes (onfocus=,
// autofocus, ...) or elements. Those sites must use escapeHtmlAttr().
//
// Every test here drives the REAL render function of one site type, with a
// hostile string in the value that reaches the attribute, and inspects the
// result with jsdom's spec-compliant parser (no regexes on markup):
//   1. the attribute reads back EXACTLY as the payload (round-trip),
//   2. the element/attribute structure is identical to a render with a
//      benign value (no extra attribute, no extra element),
//   3. nothing executes (window.__pwned stays false after focus/click).
//
// jsdom is a parser + DOM, not a CSP-enforcing browser; see the header of
// tests/csp-xss-render.test.mjs for the limits of that.
//
// ATTR_DUMP=<file>: also write the BENIGN-input HTML of every site to <file>
// (used for the before/after byte-identical comparison).

import fs from 'node:fs';
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const jsPath = (rel) => new URL(`../public/js/${rel}`, import.meta.url).pathname;

// ---------- DOM ----------
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://wireapp.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.navigator ??= dom.window.navigator;
for (const k of ['MutationObserver', 'CustomEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'Element', 'DOMParser', 'File']) {
    if (!(k in globalThis) && dom.window[k]) globalThis[k] = dom.window[k];
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.__pwned = false;

// Contains BOTH quote kinds, a would-be new attribute for each, an event
// handler that would set the flag, and markup. Benign twin has same length class.
const PAYLOAD = `a" onfocus="window.__pwned=true" autofocus x=' onmouseover='window.__pwned=true' y="<img src=x onerror=window.__pwned=true>`;
const BENIGN = 'Alice Smith';
const HEX_PAYLOAD = `#112233" onfocus="window.__pwned=true" autofocus x='1`;

// ---------- the real modules are used throughout; only ONE function is overridden ----------
const noop = () => {};

// Real theme module with ONE function overridden (stored gradient stops are
// validated by isHexColor() upstream; the sink must still be safe on its own).
const realTheme = await import(jsPath('settings/theme.js'));
let gradientStops = null;
mock.module(jsPath('settings/theme.js'), {
    namedExports: {
        ...realTheme,
        getOwnBubbleGradient: () => (gradientStops ? { ...realTheme.getOwnBubbleGradient(), stops: gradientStops } : realTheme.getOwnBubbleGradient()),
    },
});

// ---------- helpers ----------
function parse(html) {
    const host = document.createElement('div');
    host.innerHTML = html; // the same sink the app uses
    return host;
}

/** tag + sorted attribute names for every element, text ignored. */
function signature(root) {
    return [...root.querySelectorAll('*')].map(
        (el) => `${el.tagName.toLowerCase()}[${[...el.attributes].map((a) => a.name).sort().join(',')}]`
    );
}

// X's own markup legitimately has inline handlers and SVG icons, so only the
// names/elements the PAYLOAD tries to create are forbidden.
// (x=/y= are covered by the structure comparison; SVG icons legitimately have them.)
const INJECTED_ATTRS = ['onfocus', 'onmouseover', 'autofocus'];
function assertNoActiveContent(root, label) {
    for (const el of root.querySelectorAll('*')) {
        for (const name of INJECTED_ATTRS) {
            assert.ok(!el.hasAttribute(name), `${label}: <${el.tagName.toLowerCase()}> grew injected ${name}=`);
        }
    }
    assert.equal(root.querySelectorAll('img[src="x"]').length, 0, `${label}: injected <img>`);
}

/**
 * html(value) renders the site. Asserts: structure(hostile) === structure(benign),
 * no payload-injected attribute or element, and each [selector, attr] reads back as the payload.
 */
function checkSite(label, render, benign, hostile, readbacks) {
    const good = parse(render(benign));
    const bad = parse(render(hostile));
    assert.deepEqual(signature(bad), signature(good), `${label}: payload changed the element/attribute structure`);
    assertNoActiveContent(bad, label);
    for (const [selector, attr] of readbacks) {
        // Same element position as in the benign render; expected value is the
        // benign attribute with the benign text swapped for the payload.
        const goods = [...good.querySelectorAll(selector)];
        const idx = goods.findIndex((el) => (el.getAttribute(attr) || '').includes(benign));
        assert.ok(idx >= 0, `${label}: ${selector}[${attr}] not found in benign render`);
        const el = bad.querySelectorAll(selector)[idx];
        assert.ok(el, `${label}: ${selector} not found`);
        const expected = goods[idx].getAttribute(attr).split(benign).join(hostile);
        assert.equal(el.getAttribute(attr), expected, `${label}: ${selector}[${attr}] did not round-trip`);
    }
    // Run what an injected handler would need: focus + click everything.
    document.body.append(bad);
    for (const el of bad.querySelectorAll('*')) { el.dispatchEvent(new window.Event('focus')); el.dispatchEvent(new window.Event('mouseover')); }
    bad.remove();
    assert.equal(window.__pwned, false, `${label}: payload executed`);
}

const dump = {};
function recordBenign(name, html) { dump[name] = html; }

// ---------- modules under test (real) ----------
const settingsRender = await import(jsPath('settings/settings-render.js'));
const appearanceCustom = await import(jsPath('settings/settings-appearance-custom.js'));
const bubbleGradient = await import(jsPath('settings/settings-bubble-gradient.js'));
const shortcutsCore = await import(jsPath('core/shortcuts.js'));
const shortcutsUi = await import(jsPath('settings/settings-shortcuts.js'));
const { createComposer } = await import(jsPath('chat/composer.js'));
await import(jsPath('chat/dm.js')); // defines window.openDmConversation
const themeMod = realTheme;

// ---------- sites ----------

test('dm.js placeholder="Message <peer username>" (user-controlled) is attribute-safe', async () => {
    const run = async (name) => {
        document.body.innerHTML = '<div class="dm-layout"><div id="dm-thread"></div></div>';
        window.dmActivePeer = null;
        try { await window.openDmConversation(Math.floor(Math.random() * 1e6) + 10, name, { fromNav: true }); } catch { /* post-render async work is irrelevant */ }
        const thread = document.getElementById('dm-thread');
        return thread.outerHTML;
    };
    const goodHtml = await run(BENIGN);
    const badHtml = await run(PAYLOAD);
    recordBenign('dm-placeholder', parse(goodHtml).querySelector('#dm-input')?.outerHTML ?? '');
    const good = parse(goodHtml);
    const bad = parse(badHtml);
    assert.ok(bad.querySelector('#dm-input'), 'thread did not render');
    assert.deepEqual(signature(bad), signature(good), 'payload changed the dm thread structure');
    assert.equal(bad.querySelector('#dm-input').getAttribute('placeholder'), `Message ${PAYLOAD}…`);
    assert.equal(bad.querySelector('#dm-input').hasAttribute('onfocus'), false);
    assert.equal(bad.querySelectorAll('[autofocus]').length, 0);
    assert.equal(window.__pwned, false);
});

test('composer.js attach-chip title="<file name>" (user-controlled) is attribute-safe', () => {
    const run = (name) => {
        document.body.innerHTML = '<input id="ci"><input id="cf" type="file"><div id="cs"></div>';
        const c = createComposer({ inputId: 'ci', fileInputId: 'cf', stagingId: 'cs', sendTextUrl: '/x', uploadUrl: '/y', buildTextBody: () => ({}) });
        c.addFiles([new window.File(['x'], name)]);
        const html = document.getElementById('cs').innerHTML;
        c.destroy?.();
        return html;
    };
    recordBenign('composer-chip', run('report.pdf'));
    checkSite('composer chip', (v) => run(v), 'report.pdf', PAYLOAD, [['.attach-chip-name', 'title']]);
});

test('settings-shortcuts.js data-id / aria-label (default + custom row) are attribute-safe', () => {
    shortcutsCore.DEFAULT_SHORTCUTS.push({
        id: 'zz-test', label: 'Benign Label', sublabel: 's',
        combo: { ctrl: false, alt: true, shift: false, meta: false, code: 'Digit9' }, action: noop,
    });
    const entry = shortcutsCore.DEFAULT_SHORTCUTS.at(-1);
    const run = (value) => {
        entry.id = value; entry.label = value;
        localStorage.setItem('wire-keyboard-shortcuts', JSON.stringify({ [value]: { ctrl: false, alt: true, shift: false, meta: false, code: 'Digit8' } }));
        const html = shortcutsUi.renderShortcuts();
        localStorage.clear();
        return html;
    };
    recordBenign('shortcuts', run('benign-id'));
    const bad = parse(run(PAYLOAD));
    checkSite('shortcuts', (v) => run(v), 'benign-id', PAYLOAD, [
        ['.shortcut-edit-btn', 'data-id'],
        ['.shortcut-edit-btn', 'aria-label'],
        ['.shortcut-reset-btn', 'data-id'],
        ['.shortcut-reset-btn', 'aria-label'],
    ]);
    assert.ok(bad.querySelector('.shortcut-reset-btn'), 'custom (reset) row did not render');
});

const appearanceHtml = (me) => settingsRender.renderCategoryBodyHtml('appearance', { me, security: {}, privacy: {}, hardwareAccelerationEnabled: true });

test('settings-render.js background swatch data-id / title / aria-label are attribute-safe', () => {
    const presets = themeMod.BACKGROUND_PRESETS;
    const orig = presets[0];
    const run = (value) => {
        presets[0] = { ...orig, id: value, name: value };
        const html = appearanceHtml({ id: 1, accent_color: '#5F84AD' });
        presets[0] = orig;
        return html;
    };
    recordBenign('bg-swatch', run('benign-bg'));
    checkSite('bg swatch', (v) => run(v), 'benign-bg', PAYLOAD, [
        ['.bg-swatch[data-id]', 'data-id'], ['.bg-swatch[data-id]', 'title'], ['.bg-swatch[data-id]', 'aria-label'],
    ]);
});

test('settings-render.js accent swatch data-name / title / aria-label are attribute-safe', () => {
    const presets = themeMod.ACCENT_PRESETS;
    const orig = presets[0];
    const run = (value) => {
        presets[0] = { ...orig, name: value };
        const html = appearanceHtml({ id: 1, accent_color: '#5F84AD' });
        presets[0] = orig;
        return html;
    };
    recordBenign('accent-swatch', run('benign-accent'));
    checkSite('accent swatch', (v) => run(v), 'benign-accent', PAYLOAD, [
        ['.accent-swatch[data-name]', 'data-name'], ['.accent-swatch[data-name]', 'title'],
    ]);
    const bad = parse(run(PAYLOAD));
    assert.equal(bad.querySelector('.accent-swatch[data-name]').getAttribute('aria-label'), `Select ${PAYLOAD} accent color`);
});

test('settings-render.js custom accent value="<me.accent_color>" (user-controlled) is attribute-safe', () => {
    const run = (value) => appearanceHtml({ id: 1, accent_color: value });
    recordBenign('accent-value', run('#5F84AD'));
    checkSite('accent value', run, '#5F84AD', HEX_PAYLOAD, [
        ['#custom-accent-color', 'value'], ['#custom-accent-hex', 'value'],
    ]);
});

test('settings-render.js category row id / data-category / aria-label are attribute-safe', () => {
    const cats = settingsRender.SETTINGS_CATEGORIES;
    const orig = { ...cats[0] };
    const run = (value) => {
        Object.assign(cats[0], { id: value, label: value, sublabel: value });
        const html = settingsRender.renderSettingsHtml({ me: { id: 1 }, security: {}, privacy: {}, hardwareAccelerationEnabled: true, activeCategoryId: null });
        Object.assign(cats[0], orig);
        return html;
    };
    recordBenign('category-row', run('benign-cat'));
    const good = parse(run('benign-cat'));
    const bad = parse(run(PAYLOAD));
    assert.deepEqual(signature(bad), signature(good), 'category row: payload changed structure');
    assertNoActiveContent(bad, 'category row');
    const row = bad.querySelector('.settings-category-row');
    assert.equal(row.getAttribute('data-category'), PAYLOAD);
    assert.equal(row.getAttribute('id'), `settings-category-row-${PAYLOAD}`);
    assert.equal(row.getAttribute('aria-label'), `${PAYLOAD}: ${PAYLOAD}`);
});

test('settings-bubble-gradient.js stop color value= is attribute-safe', () => {
    const run = (value) => {
        gradientStops = [{ color: value, position: 0 }, { color: '#00FF00', position: 100 }];
        const html = bubbleGradient.renderOwnBubbleGradientSection();
        gradientStops = null;
        return html;
    };
    recordBenign('gradient-stop', run('#112233'));
    checkSite('gradient stop', run, '#112233', HEX_PAYLOAD, [['.own-gradient-color', 'value']]);
});

test('settings-appearance-custom.js sliderRow / switchButton aria-label are attribute-safe', () => {
    const run = (value) =>
        appearanceCustom.sliderRow({ id: 's1', label: value, min: 0, max: 10, value: 5, unit: '' }) +
        appearanceCustom.switchButton({ id: 'sw1', on: true, label: value });
    recordBenign('appearance-custom', run('Blur strength'));
    checkSite('appearance-custom', run, 'Blur strength', PAYLOAD, [['#s1', 'aria-label'], ['#sw1', 'aria-label']]);
});

after(() => {
    if (process.env.ATTR_DUMP) fs.writeFileSync(process.env.ATTR_DUMP, JSON.stringify(dump, null, 1));
});
