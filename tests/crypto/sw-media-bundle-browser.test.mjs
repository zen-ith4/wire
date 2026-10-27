// The Service Worker's media bundle in a real browser (Item 3, phase 3B).
//
// public/sw.js imports public/sw-media-bundle.js with importScripts() and the
// bundle is listed in public/sw-manifest.js, so the worker verifies the
// bundle's SHA-256 while precaching and refuses to install when the served
// bytes do not match (docs/MEDIA_STREAMING_RFC.md 8.2 - 8.4).
//
// What is checked here (a real Chromium, a real service worker):
//   1. a matching bundle activates and the worker really uses it
//   2. a missing bundle keeps the old worker in control
//   3. a tampered bundle keeps the old worker in control
//   4. a matching NEW bundle activates after an update
//
// The test copies public/ into a temporary directory and serves it over
// HTTP; the copy is what gets tampered with, never the repository.
//
//   node --experimental-test-module-mocks --env-file=tests/test.env \
//        --test --test-timeout=900000 tests/crypto/sw-media-bundle-browser.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser } from '../_acceptance-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST_BUILD = path.join(ROOT, 'scripts', 'build-sw-manifest.mjs');
const BUNDLE_NAME = '/sw-media-bundle.js';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
};

let browser = null;
let browserReason = null;
const tmpDirs = [];
const servers = [];

process.on('exit', () => {
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

before(async () => {
    const launched = await launchBrowser();
    browser = launched.browser;
    browserReason = launched.reason;
});

after(async () => {
    for (const server of servers) await new Promise((r) => server.close(r));
    if (browser) await browser.close();
});

function tmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-swbundle-'));
    tmpDirs.push(dir);
    return dir;
}

/** A fresh copy of public/ - the copy is what the test tampers with. */
function copyPublic() {
    const dir = tmpDir();
    const dest = path.join(dir, 'public');
    fs.cpSync(PUBLIC, dest, { recursive: true });
    return dest;
}

/** Regenerate the manifest of a copy (the repo's own build script). */
function regenerateManifest(publicDir) {
    const run = spawnSync(process.execPath, [MANIFEST_BUILD, '--dir', publicDir], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`build-sw-manifest failed: ${run.stderr}${run.stdout}`);
    return run.stdout.trim();
}

/**
 * A static server for a copy of public/.
 *
 * `state.serveBundle` decides whether /sw-media-bundle.js is served.
 * `state.bundleAllowance` lets a test hand out a fixed number of further
 * bundle responses before the 404 starts - that models a bundle that
 * disappears between the update check (the import) and the install (the
 * precache).
 */
async function startServer(publicDir) {
    const state = { serveBundle: true, bundleAllowance: 0, bundleRequests: 0 };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        let rel = decodeURIComponent(url.pathname);
        if (rel === '/') rel = '/index.html';

        if (rel === BUNDLE_NAME) {
            state.bundleRequests += 1;
            if (state.bundleAllowance > 0) {
                state.bundleAllowance -= 1;
            } else if (!state.serveBundle) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'text/plain');
                res.end('not found');
                return;
            }
        }

        const file = path.join(publicDir, rel);
        if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain');
            res.end('not found');
            return;
        }

        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(file).pipe(res);
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);

    return {
        origin: `http://127.0.0.1:${server.address().port}/`,
        state,
        resetBundleRequests() { state.bundleRequests = 0; },
    };
}

/** Register the worker and wait until it controls the page. */
async function installWorker(page, origin) {
    return page.evaluate(async (origin) => {
        const registration = await navigator.serviceWorker.register('/sw.js', {
            scope: '/',
            updateViaCache: 'none',
        });

        /*
         * navigator.serviceWorker.ready never settles when the worker script
         * fails to evaluate or its install is rejected (Chromium removes the
         * registration in that case). The race turns that into a readable
         * failure instead of a protocol timeout.
         */
        const ready = await Promise.race([
            navigator.serviceWorker.ready.then(() => 'ready'),
            new Promise((r) => setTimeout(() => r('timeout'), 30000)),
        ]);

        if (ready !== 'ready') {
            const registrations = await navigator.serviceWorker.getRegistrations();
            throw new Error(
                'the service worker did not activate within 30s; registrations: ' +
                JSON.stringify(registrations.map((r) => ({
                    installing: r.installing && r.installing.state,
                    waiting: r.waiting && r.waiting.state,
                    active: r.active && r.active.state,
                }))) +
                ' (the worker script may have failed to evaluate, or its install may have been rejected)'
            );
        }

        for (let i = 0; i < 200; i += 1) {
            if (navigator.serviceWorker.controller) break;
            await new Promise((r) => setTimeout(r, 100));
        }

        return {
            activeState: registration.active ? registration.active.state : null,
            controlled: Boolean(navigator.serviceWorker.controller),
            shellVersion: (await (await fetch('/sw-manifest.js', { cache: 'no-store' })).text())
                .slice(0, 200),
        };
    }, origin);
}

/** Trigger an update and wait for the browser to settle. */
async function triggerUpdate(page, timeoutMs = 20000) {
    return page.evaluate(async (timeoutMs) => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const activeBefore = registration.active;
        const controllerBefore = navigator.serviceWorker.controller;
        const events = [];

        registration.addEventListener('updatefound', () => events.push('updatefound'));

        /*
         * registration.update() is NOT awaited to the end: when an imported
         * script cannot be fetched, Chromium leaves the promise unsettled.
         * The test asserts the OUTCOME (which worker is in control), not the
         * promise.
         */
        let updateError = null;
        let updateSettled = false;
        const pending = registration.update().then(
            () => { updateSettled = true; },
            (error) => { updateError = String(error); updateSettled = true; }
        );

        await Promise.race([
            pending,
            new Promise((r) => setTimeout(r, 5000)),
        ]);

        const installing = registration.installing;
        if (installing) {
            installing.addEventListener('statechange', () => {
                events.push('installing:' + installing.state);
            });
        }

        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (!registration.installing && !registration.waiting) {
                await new Promise((r) => setTimeout(r, 300));
                if (!registration.installing && !registration.waiting) break;
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        return {
            events,
            updateError,
            updateSettled,
            activeChanged: registration.active !== activeBefore,
            activeState: registration.active ? registration.active.state : null,
            controllerChanged: navigator.serviceWorker.controller !== controllerBefore,
            installing: registration.installing ? registration.installing.state : null,
            waiting: registration.waiting ? registration.waiting.state : null,
            controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null,
        };
    }, timeoutMs);
}

/** What every service worker in the browser currently has in its global scope. */
async function workerGlobals() {
    const targets = browser.targets().filter((t) => t.type() === 'service_worker');
    const out = [];

    for (const target of targets) {
        try {
            const worker = await target.worker();
            const probe = await worker.evaluate(() => ({
                wireMedia: typeof self.WireMedia,
                hasDecryptChunkRange:
                    Boolean(self.WireMedia) && typeof self.WireMedia.decryptChunkRange === 'function',
                marker: self.WireMedia && self.WireMedia.__test_marker ? self.WireMedia.__test_marker : null,
            }));
            out.push(probe);
        } catch (error) {
            out.push({ error: String(error) });
        }
    }

    return out;
}

/** The shell bytes the page is served (the worker answers from its cache). */
async function servedShell(page) {
    return page.evaluate(async () => {
        const text = await (await fetch('/index.html', { cache: 'no-store' })).text();
        return text.includes('SW-BUNDLE-MARKER') ? 'marker' : 'plain';
    });
}

function skipWithoutBrowser(t) {
    if (browser) return false;
    t.skip(`BLOCKED: no Chromium available (${browserReason})`);
    return true;
}

// ------------------------------------------------------------------------ 0
test('public/sw.js imports the media bundle', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
    assert.match(
        source,
        /importScripts\('\/sw-media-bundle\.js'\)/,
        'public/sw.js must load the media bundle with importScripts()'
    );
});

// ------------------------------------------------------------------------ 1
test('a matching bundle activates and the worker uses it', async (t) => {
    if (skipWithoutBrowser(t)) return;

    const publicDir = copyPublic();
    const server = await startServer(publicDir);
    const page = await browser.newPage();

    try {
        await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
        const installed = await installWorker(page, server.origin);

        assert.equal(installed.activeState, 'activated', 'the worker must activate');
        assert.equal(installed.controlled, true, 'the worker must control the page');

        const globals = await workerGlobals();
        const withBundle = globals.filter((g) => g.hasDecryptChunkRange === true);
        assert.ok(
            withBundle.length >= 1,
            `the service worker must have the media bundle in its global scope, saw ${JSON.stringify(globals)}`
        );

        // The bundle is precached and hash-verified, so the cache holds exactly
        // the bytes the manifest pins.
        const cached = await page.evaluate(async (name) => {
            const names = await caches.keys();
            const cache = await caches.open(names.find((n) => n.startsWith('wire-shell-')));
            const hit = await cache.match(name);
            if (!hit) return { names, found: false };
            const bytes = new Uint8Array(await hit.arrayBuffer());
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return {
                names,
                found: true,
                sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
            };
        }, BUNDLE_NAME);

        assert.equal(cached.found, true, 'the bundle must be precached');
        assert.match(
            cached.sha256,
            /^[0-9a-f]{64}$/,
            'the precached bundle must have a SHA-256'
        );
    } finally {
        await page.close();
    }
});

// ------------------------------------------------------------------------ 2
test('a missing bundle keeps the old worker in control', async (t) => {
    if (skipWithoutBrowser(t)) return;

    const publicDir = copyPublic();
    const server = await startServer(publicDir);
    const page = await browser.newPage();

    try {
        await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
        const installed = await installWorker(page, server.origin);
        assert.equal(installed.activeState, 'activated');

        /*
         * The bundle disappears from the server: it is served once more (the
         * update check fetches the import) and 404s from then on (the install
         * fetches it again while precaching). The manifest changes too, so an
         * update is really attempted.
         */
        fs.appendFileSync(path.join(publicDir, 'index.html'), '<!-- SW-BUNDLE-MARKER -->\n');
        regenerateManifest(publicDir);
        server.state.serveBundle = false;
        server.state.bundleAllowance = 1;
        server.resetBundleRequests();

        const update = await triggerUpdate(page);
        const globals = await workerGlobals();
        const shell = await servedShell(page);

        assert.equal(
            update.controllerChanged,
            false,
            `the controller must not change, update was ${JSON.stringify(update)} ` +
            `(bundle requests: ${server.state.bundleRequests})`
        );
        assert.equal(
            update.activeChanged,
            false,
            `no new worker may take over, update was ${JSON.stringify(update)} ` +
            `(bundle requests: ${server.state.bundleRequests})`
        );
        assert.ok(
            update.events.includes('updatefound'),
            `the browser must have started an update, events were ${JSON.stringify(update.events)}`
        );
        assert.ok(
            update.events.includes('installing:redundant'),
            `the install must have been rejected (the new worker must go redundant), ` +
            `events were ${JSON.stringify(update.events)}`
        );
        assert.equal(
            shell,
            'plain',
            'the old shell (from the old worker cache) must still be served'
        );
        assert.ok(
            globals.every((g) => !g.marker),
            `no worker may run the new bundle, saw ${JSON.stringify(globals)}`
        );
    } finally {
        await page.close();
    }
});

// ------------------------------------------------------------------------ 3
test('a tampered bundle keeps the old worker in control', async (t) => {
    if (skipWithoutBrowser(t)) return;

    const publicDir = copyPublic();
    const server = await startServer(publicDir);
    const page = await browser.newPage();

    try {
        await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
        const installed = await installWorker(page, server.origin);
        assert.equal(installed.activeState, 'activated');

        // The manifest is regenerated from the CLEAN bundle, then the served
        // bundle is altered: the hash no longer matches.
        fs.appendFileSync(path.join(publicDir, 'index.html'), '<!-- SW-BUNDLE-MARKER -->\n');
        regenerateManifest(publicDir);

        const bundlePath = path.join(publicDir, 'sw-media-bundle.js');
        const clean = fs.readFileSync(bundlePath);
        const tampered = Buffer.from(clean);
        tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x0a ? 0x20 : 0x0a;
        fs.writeFileSync(bundlePath, tampered);

        const update = await triggerUpdate(page);
        const globals = await workerGlobals();
        const shell = await servedShell(page);

        assert.equal(
            update.controllerChanged,
            false,
            `the controller must not change, update was ${JSON.stringify(update)}`
        );
        assert.equal(
            update.activeChanged,
            false,
            `the install must be rejected, update was ${JSON.stringify(update)}`
        );
        assert.ok(
            update.events.includes('updatefound'),
            `the browser must have started an update, events were ${JSON.stringify(update.events)}`
        );
        assert.ok(
            update.events.includes('installing:redundant'),
            `the install must have been rejected (the new worker must go redundant), ` +
            `events were ${JSON.stringify(update.events)}`
        );
        assert.equal(
            shell,
            'plain',
            'the old shell (from the old worker cache) must still be served'
        );
        assert.ok(
            globals.every((g) => !g.marker),
            `no worker may run the new bundle, saw ${JSON.stringify(globals)}`
        );
    } finally {
        await page.close();
    }
});

// ------------------------------------------------------------------------ 4
test('a matching new bundle activates after an update', async (t) => {
    if (skipWithoutBrowser(t)) return;

    const publicDir = copyPublic();
    const server = await startServer(publicDir);
    const page = await browser.newPage();

    try {
        await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
        const installed = await installWorker(page, server.origin);
        assert.equal(installed.activeState, 'activated');

        // A new bundle (same code, one extra marker) and a manifest that
        // matches it: the update must roll out.
        const bundlePath = path.join(publicDir, 'sw-media-bundle.js');
        const next = fs.readFileSync(bundlePath, 'utf8') + "\nWireMedia.__test_marker = 'v2';\n";
        fs.writeFileSync(bundlePath, next);
        regenerateManifest(publicDir);

        const update = await triggerUpdate(page);
        const globals = await workerGlobals();

        assert.equal(
            update.updateError,
            null,
            `registration.update() must not fail: ${update.updateError}`
        );
        assert.ok(
            update.events.includes('updatefound'),
            `the browser must start an update, events were ${JSON.stringify(update.events)}`
        );
        assert.equal(
            update.activeChanged,
            true,
            `a new worker must take over, update was ${JSON.stringify(update)}`
        );
        assert.equal(
            update.controllerChanged,
            true,
            `the new worker must control the page, update was ${JSON.stringify(update)}`
        );

        const withMarker = globals.filter((g) => g.marker === 'v2');
        assert.ok(
            withMarker.length >= 1,
            `the new worker must run the new bundle, saw ${JSON.stringify(globals)}`
        );
    } finally {
        await page.close();
    }
});
