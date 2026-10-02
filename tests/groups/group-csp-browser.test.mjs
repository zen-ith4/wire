// tests/groups/group-csp-browser.test.mjs
//
// Group/E2EE audit section 9, real-browser part.
//
// jsdom does not enforce CSP, so this loads the ACTUAL app from the real
// Express server (real middleware/csp.js header, real static assets) in
// headless Chromium, injects the exact markup strings the real Group UI
// generates (recorded from the client's innerHTML/insertAdjacentHTML sinks
// while a real session opens a group, sends, and opens both dialogs), and
// asserts the browser reports zero CSP violations.
//
// Controls (so a PASS cannot be vacuous):
//   - a known-bad inline style="" MUST raise a style-src-attr violation
//   - the new .grp-* classes MUST compute to the intended layout
//
// If no Chromium can be launched the tests are SKIPPED and reported as
// BLOCKED -- never as passed. Chromium comes from @sparticuz/chromium,
// installed OUTSIDE the repo (CHROMIUM_DIR, default /tmp/browser-check).

import './_env.mjs';

import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { test, after } from 'node:test';
import { createScenario, assert, sleep } from './_scenario.mjs';

const require = createRequire(import.meta.url);

/**
 * The app's own static hosting, minimal: the REAL middleware/csp.js and the
 * REAL public/ directory, in the same order server.js applies them
 * (csp first, then express.static), so index.html and every asset carry the
 * production header.
 */
async function startStaticApp() {
    const express = require('express');
    const { csp } = require('../../middleware/csp');
    const app = express();
    app.use(csp);
    app.use(express.static(path.resolve(import.meta.dirname, '../../public')));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const CHROMIUM_DIR = process.env.CHROMIUM_DIR || '/tmp/browser-check';

async function launchBrowser() {
    try {
        const req = createRequire(path.join(CHROMIUM_DIR, 'noop.js'));
        const chromiumMod = await import(pathToFileURL(req.resolve('@sparticuz/chromium')).href);
        const puppeteer = await import(pathToFileURL(req.resolve('puppeteer-core')).href);
        const chromium = chromiumMod.default;
        const exe = await chromium.executablePath();
        const browser = await puppeteer.default.launch({
            args: [...chromium.args, '--no-sandbox'],
            executablePath: exe,
            headless: 'shell',
        });
        return { browser, reason: null };
    } catch (e) {
        return { browser: null, reason: e.message };
    }
}

let S = null;
let browser = null;
let staticApp = null;
after(async () => { await browser?.close(); await staticApp?.close(); await S?.stop(); });

/** Runs a real Group session and returns every markup string the UI parsed. */
async function recordGroupMarkup() {
    S = await createScenario(['alice', 'bob']);
    const { alice, bob } = S.users;
    const group = await S.createGroup(alice, 'csp browser');
    await S.addMember(alice, group.id, bob);
    await S.mount(alice);

    alice.actor.use();
    const w = alice.actor.window;
    const markup = [];
    const EP = w.Element.prototype;
    const inner = Object.getOwnPropertyDescriptor(EP, 'innerHTML');
    Object.defineProperty(EP, 'innerHTML', {
        ...inner,
        set(v) { if (String(v).trim()) markup.push(String(v)); inner.set.call(this, v); },
    });
    const iah = EP.insertAdjacentHTML;
    EP.insertAdjacentHTML = function (pos, v) { if (String(v).trim()) markup.push(String(v)); return iah.call(this, pos, v); };

    await S.open(alice, group.id);
    await S.send(alice, 'markup for the browser');
    await sleep(300);
    const d = w.document;
    d.querySelector('[data-action="group-settings"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    d.querySelector('[data-action="group-new"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(300);
    return markup;
}

test('CSP (real Chromium): Group UI markup raises no violations; controls prove enforcement', async (t) => {
    const launched = await launchBrowser();
    if (!launched.browser) {
        t.skip(`BLOCKED: no Chromium available (${launched.reason})`);
        return;
    }
    browser = launched.browser;

    const markup = await recordGroupMarkup();
    assert.ok(markup.length > 5, `control: recorded real Group markup (${markup.length} strings)`);
    assert.ok(markup.some((m) => m.includes('member-list')), 'control: recorded markup includes the settings dialog');

    staticApp = await startStaticApp();
    const page = await browser.newPage();
    const response = await page.goto(`${staticApp.origin}/index.html`, { waitUntil: 'domcontentloaded' });
    const header = response.headers()['content-security-policy'] || '';
    assert.match(header, /script-src 'self'/, 'server sent the real CSP');
    assert.ok(!/style-src[^;]*'unsafe-inline'/.test(header), 'style-src has no unsafe-inline');
    assert.ok(!/unsafe-eval/.test(header), 'no unsafe-eval');

    await page.evaluate(() => {
        window.__violations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__violations.push(`${e.violatedDirective}: ${e.sample || e.blockedURI}`);
        });
        const host = document.createElement('div');
        host.id = '__host';
        document.body.appendChild(host);
    });

    // Positive control: enforcement is really on.
    await page.evaluate(() => {
        document.getElementById('__host').innerHTML = '<div id="__ctl" style="color:red">x</div>';
    });
    await sleep(200);
    const controlViolations = await page.evaluate(() => window.__violations.slice());
    assert.ok(controlViolations.some((v) => v.startsWith('style-src-attr')),
        `control: a known-bad inline style must be blocked, got ${JSON.stringify(controlViolations)}`);

    // Now the real Group markup.
    await page.evaluate(() => { window.__violations.length = 0; });
    await page.evaluate((all) => {
        const host = document.getElementById('__host');
        host.innerHTML = '';
        for (const m of all) {
            const box = document.createElement('div');
            box.innerHTML = m;
            host.appendChild(box);
        }
    }, markup);
    await sleep(400);
    const violations = await page.evaluate(() => window.__violations.slice());
    assert.deepEqual(violations, [], 'Chromium blocked something in the Group UI markup');

    // Layout control: the class-based replacements really apply under the CSP.
    const layout = await page.evaluate(() => {
        const cs = (sel) => { const el = document.querySelector(`#__host ${sel}`); return el ? getComputedStyle(el) : null; };
        return {
            actions: cs('.grp-dialog-actions')?.display ?? null,
            memberRow: cs('.grp-member-row')?.display ?? null,
            top: cs('.grp-top-main')?.minWidth ?? null,
        };
    });
    assert.equal(layout.actions, 'flex', `dialog buttons row is laid out (got ${JSON.stringify(layout)})`);
    assert.equal(layout.memberRow, 'flex', `member row is laid out (got ${JSON.stringify(layout)})`);
});
