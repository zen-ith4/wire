// tests/groups/_browser-actor.mjs
//
// Simulates one real browser tab/device for the group round-trip
// test. Two actors (Alice, Bob) each get:
//
//  - their OWN copy of the public/js tree on disk, so importing
//    e.g. chat/group.js for Alice and chat/group.js for Bob gives
//    two entirely separate ES module instances (separate
//    module-scoped singletons: groupThreads Map, activeGroupId,
//    core/auth.js's currentUser/token, core/socket.js's socket
//    variable, etc.) — exactly as two different browser tabs would
//    never share JS heap state, without needing loader tricks.
//  - their OWN jsdom window/document (so DOM state doesn't leak
//    between actors).
//  - their OWN fake IndexedDB "browser profile" (sender-key-store.js
//    has no per-user partitioning in its schema, correctly, since a
//    real browser only ever holds one person's data — see
//    tests/groups/helpers.mjs's identical reasoning).
//  - their OWN Web Locks polyfill instance.
//
// Nothing about the application code is mocked or stubbed. The only
// things provided here are environment primitives a real browser
// gives you for free that a bare Node process doesn't: `document`,
// `window`, `indexedDB`, `navigator.locks`, and a `fetch` that can
// resolve the relative URLs core/api.js and identity-service.js
// build (a real browser resolves these against window.location;
// Node's fetch has no notion of "current page" to resolve against,
// so this supplies the test server's origin instead of altering any
// application code).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REAL_PUBLIC_JS = path.join(__dirname, '..', '..', 'public', 'js');

let copyCounter = 0;

/**
 * Copies the real public/js tree to a private scratch directory so
 * this actor gets its own module graph. Same source files, unmodified
 * — this is disk-level isolation standing in for "a different browser
 * process", not a fork of the code under test.
 */
function makeIsolatedCopy(label, actorKey) {
    const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), `wire-actor-${label}-${copyCounter++}-`)
    );
    fs.cpSync(REAL_PUBLIC_JS, dir, { recursive: true });

    // Two actors share one Node process, and `use()` can only make ONE
    // actor's `document`/`fetch`/... the global at a time. A Socket.IO
    // event for Bob is processed whenever it arrives, possibly while
    // Alice's globals are installed, and Bob's handler would then render
    // into ALICE's DOM. To make that impossible, every ES module in this
    // actor's private copy gets a header that shadows those names with
    // this actor's own objects, so app code always talks to its own
    // window regardless of which actor `use()` last selected. The
    // application logic in the files is unchanged; only the copy under
    // os.tmpdir() is prefixed. (vendor/ bundles are left alone.)
    const header =
        `const __A = globalThis.__actorGlobals[${JSON.stringify(actorKey)}];` +
        `const window = __A.window, document = __A.document, navigator = __A.navigator, ` +
        `localStorage = __A.localStorage, indexedDB = __A.indexedDB, IDBKeyRange = __A.IDBKeyRange, ` +
        `fetch = __A.fetch, HTMLElement = __A.window.HTMLElement, Element = __A.window.Element, ` +
        `Node = __A.window.Node;\n`;

    (function walk(d) {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) {
                if (ent.name !== 'vendor') walk(full);
            } else if (ent.name.endsWith('.js')) {
                const src = fs.readFileSync(full, 'utf8');
                if (/^\s*(import|export)\b/m.test(src)) {
                    fs.writeFileSync(full, header + src);
                }
            }
        }
    })(dir);

    return dir;
}

function makeLockPolyfill() {
    const queues = new Map();
    return {
        request(name, callback) {
            const previous = queues.get(name) || Promise.resolve();
            let release;
            const gate = new Promise((resolve) => { release = resolve; });
            queues.set(name, previous.then(() => gate));
            return previous.then(async () => {
                try {
                    return await callback();
                } finally {
                    release();
                }
            });
        },
    };
}

/**
 * Creates one isolated actor. Call `use()` immediately before running
 * any of this actor's code (including its own dynamic imports) and
 * awaiting it — this test never runs two actors' code concurrently,
 * only interleaved, so a single mutable `globalThis` is safe as long
 * as every await boundary that could let the OTHER actor's async
 * callbacks (e.g. an incoming Socket.IO packet) run is preceded by
 * that actor's own `use()`.
 */
export function createBrowserActor(label, serverOrigin, { profileOf = null } = {}) {
    const actorKey = `${label}#${copyCounter}`;
    const jsDir = makeIsolatedCopy(label, actorKey);

    const dom = new JSDOM(
        `<!doctype html><html><body><div id="content-area"></div></body></html>`,
        { url: `${serverOrigin}/`, pretendToBeVisual: true }
    );

    const window = dom.window;
    // profileOf: another actor whose browser PROFILE this one shares -- i.e.
    // a second TAB. Tabs have separate JS heaps (separate module graphs, as
    // always here) but share IndexedDB, localStorage and Web Locks. Omit it
    // for a genuinely separate browser/device.
    const idbFactory = profileOf ? profileOf.idbFactory : new IDBFactory();
    const locks = profileOf ? profileOf.locks : makeLockPolyfill();

    // A real browser's WebSocket implementation; jsdom doesn't ship
    // one, but Node itself (>=22) does (undici's, the same class
    // socket.io-client's browser bundle expects).
    window.WebSocket = globalThis.WebSocket;

    // Test-only observability, added for the Group/E2EE audit. Neither
    // touches application code:
    //  - fetchLog: every HTTP request this actor's app code makes, so a
    //    test can prove a UI update was driven by a Socket.IO event and
    //    NOT by an HTTP history fetch.
    //  - faults: one-shot network failures (a real browser can lose the
    //    network mid-request); the request never reaches the server.
    const fetchLog = [];
    const faults = [];

    function baseFetch(input, init) {
        let urlStr = typeof input === 'string' ? input : input?.url;
        if (urlStr && !/^https?:\/\//i.test(urlStr)) {
            urlStr = new URL(urlStr, serverOrigin).toString();
        }
        {
            const method = (init?.method || 'GET').toUpperCase();
            fetchLog.push({ method, url: urlStr, at: Date.now() });
            const i = faults.findIndex((f) => f.method === method && f.match.test(urlStr));
            if (i !== -1) {
                const fault = faults.splice(i, 1)[0];
                if (fault.delayMs) {
                    // Not a failure: hold this ONE request in flight for a while,
                    // so a test can change UI state while it is pending.
                    return new Promise((resolve, reject) => {
                        setTimeout(() => {
                            globalThis.__nodeFetch(urlStr, init).then(resolve, reject);
                        }, fault.delayMs);
                    });
                }
                return Promise.reject(new TypeError('Failed to fetch (injected network fault)'));
            }
        }
        // Avatar/banner images are cosmetic and irrelevant to the group
        // message round trip under test; short-circuit them to a fast
        // 404 (this test environment simply has none configured) rather
        // than pay for a real request whose result nothing here checks.
        if (/\/api\/me\/(avatar|banner)\//.test(urlStr)) {
            return Promise.resolve(new Response(JSON.stringify({ error: 'No avatar' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            }));
        }
        if (process.env.WIRE_TEST_DEBUG_FETCH) {
            console.error(`[fetch:${label}]`, init?.method || 'GET', urlStr);
        }
        return globalThis.__nodeFetch(urlStr, init).then((res) => {
            if (process.env.WIRE_TEST_DEBUG_FETCH) {
                console.error(`[fetch:${label}] <-`, res.status, urlStr);
            }
            return res;
        });
    }

    window.navigator.locks = locks;

    // jsdom has no <dialog> modal API; a browser primitive, so polyfilled here
    // (open/close only -- enough for the app's dialog helper to run).
    const DialogProto = window.HTMLDialogElement?.prototype;
    if (DialogProto && !DialogProto.showModal) {
        DialogProto.showModal = function () { this.setAttribute('open', ''); };
        DialogProto.show = DialogProto.showModal;
        DialogProto.close = function () {
            this.removeAttribute('open');
            this.dispatchEvent(new window.Event('close'));
        };
    }
    globalThis.__actorGlobals = globalThis.__actorGlobals || {};
    globalThis.__actorGlobals[actorKey] = {
        window,
        document: window.document,
        navigator: window.navigator,
        localStorage: profileOf ? profileOf.window.localStorage : window.localStorage,
        indexedDB: idbFactory,
        IDBKeyRange,
        fetch: baseFetch,
    };

    /** Still makes this actor's globals the process-wide ones, for the
     *  test's OWN code and any file that is not an actor module copy.
     *  App code no longer depends on it (see makeIsolatedCopy). */
    function use() {
        globalThis.window = window;
        globalThis.document = window.document;
        Object.defineProperty(globalThis, 'navigator', {
            value: window.navigator,
            configurable: true,
            writable: true,
        });
        globalThis.localStorage = profileOf ? profileOf.window.localStorage : window.localStorage;
        globalThis.indexedDB = idbFactory;
        globalThis.IDBKeyRange = IDBKeyRange;
        globalThis.fetch = baseFetch;
        // Deliberately NOT overriding Event/CustomEvent: Node's native
        // WebSocket needs Node's own classes.
        return window;
    }

    /** Dynamically imports one of THIS actor's own module copies. */
    async function importModule(relativePath) {
        const abs = path.join(jsDir, relativePath);
        return import(pathToFileURL(abs).href);
    }

    /** Fail the next matching request as if the network dropped. */
    function failNext(method, match) {
        faults.push({ method: method.toUpperCase(), match });
    }

    /** Hold the next matching request in flight for delayMs (then send it for real). */
    function delayNext(method, match, delayMs) {
        faults.push({ method: method.toUpperCase(), match, delayMs });
    }

    return { label, jsDir, window, use, importModule, fetchLog, failNext, delayNext, idbFactory, locks };
}
