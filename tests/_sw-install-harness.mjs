// tests/_sw-install-harness.mjs
//
// Helpers for tests/sw-manifest.test.mjs. Not a test itself (no .test.mjs suffix, so
// scripts/run-tests.mjs does not pick it up).
//
// runSwInstall() executes the REAL public/sw.js inside a node:vm context and fires its
// 'install' event. Only the browser APIs sw.js touches are stubbed: caches, fetch,
// Request, importScripts, addEventListener, skipWaiting, clients. The hashing is the
// real crypto.subtle.digest. This is NOT a browser: it proves what sw.js's own install
// code does with a given set of served bytes, not how Chromium schedules/updates workers.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/** Evaluate <dir>/sw-manifest.js the way importScripts() would and return WIRE_SHELL. */
export function readManifest(dir) {
    const ctx = {};
    ctx.self = ctx;
    vm.runInNewContext(fs.readFileSync(path.join(dir, 'sw-manifest.js'), 'utf8'), ctx);
    return JSON.parse(JSON.stringify(ctx.WIRE_SHELL));
}

/**
 * @param {string} root       directory acting as the web root (needs sw.js + sw-manifest.js)
 * @param {Record<string, Buffer>} [overrides]  url -> bytes the "server" sends instead of the file on disk
 * @returns {{ error: Error|null, skipWaitingCalled: boolean, cachedCount: number }}
 */
export async function runSwInstall(root, overrides = {}) {
    const caches = new Map(); // cache name -> Map(url -> Response)
    const listeners = {};
    let skipWaitingCalled = false;

    const sandbox = {
        console: { log() {}, error() {}, warn() {} }, // sw.js logs the (expected) install failure
        crypto: globalThis.crypto,
        Response,
        Request: class { constructor(url, init) { this.url = url; this.init = init; } },
        fetch: async (req) => {
            const body = overrides[req.url] ?? (() => {
                const p = path.join(root, req.url);
                return fs.existsSync(p) ? fs.readFileSync(p) : null;
            })();
            return body === null ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
        },
        caches: {
            open: async (name) => {
                if (!caches.has(name)) caches.set(name, new Map());
                const m = caches.get(name);
                return { match: async (u) => m.get(u), put: async (u, r) => { m.set(u, r); } };
            },
            keys: async () => [...caches.keys()],
            delete: async (n) => caches.delete(n),
        },
        importScripts: (p) => vm.runInContext(fs.readFileSync(path.join(root, p), 'utf8'), sandbox, { filename: p }),
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: async () => { skipWaitingCalled = true; },
        clients: { claim: async () => {} },
    };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), sandbox, { filename: 'sw.js' });

    let pending = Promise.resolve();
    listeners.install({ waitUntil: (p) => { pending = p; } });

    let error = null;
    try { await pending; } catch (e) { error = e; }
    const cachedCount = [...caches.values()].reduce((n, m) => n + m.size, 0);
    return { error, skipWaitingCalled, cachedCount };
}
