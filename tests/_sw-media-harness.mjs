// tests/_sw-media-harness.mjs
//
// Helpers for the C2 Service Worker media-route tests. Not a test itself (no
// .test.mjs suffix, so scripts/run-tests.mjs does not pick it up).
//
// loadSwMediaHarness() evaluates the REAL public/sw.js in a node:vm context,
// with the REAL generated bundle and manifest, and stubs only the browser
// APIs the worker touches: fetch, clients, caches, timers and the event
// objects. The media flag is flipped only in the source string handed to the
// VM; public/sw.js on disk stays false.
//
// This is NOT a browser. It proves the worker's own fetch/message branches,
// the in-memory registry, the token wait and the ciphertext range/decrypt
// plumbing. Real Chromium behaviour (request.destination, clientId, playback)
// is covered by the browser suite, not here.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
export const SW_MEDIA_ORIGIN = 'https://wire.test';

const ENABLED_LINE = 'const MEDIA_STREAM_ENABLED = false;';
const ENABLED_TRUE = 'const MEDIA_STREAM_ENABLED = true;';

export function loadSwMediaHarness({ enabled = false } = {}) {
    let nowMs = 1000;
    let nextTimerId = 1;
    const timers = new Map();
    const clients = new Map();
    const posted = [];
    const resources = new Map();
    const requests = [];
    const cacheOps = [];
    const logs = [];
    const listeners = {};

    function fakeSetTimeout(fn, delay = 0) {
        const id = nextTimerId++;
        timers.set(id, { at: nowMs + Number(delay || 0), fn });
        return id;
    }

    function fakeClearTimeout(id) {
        timers.delete(id);
    }

    async function flush() {
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }

    function FakeDate(...args) {
        return new Date(...args);
    }
    FakeDate.now = () => nowMs;
    FakeDate.parse = Date.parse;
    FakeDate.UTC = Date.UTC;
    FakeDate.prototype = Date.prototype;

    function addClient(id) {
        if (!id) return null;
        if (clients.has(id)) return clients.get(id);
        const client = {
            id,
            postMessage(data) {
                posted.push({ clientId: id, data });
            },
        };
        clients.set(id, client);
        return client;
    }

    function setResource(resourcePath, bytes) {
        const normalized = new URL(resourcePath, SW_MEDIA_ORIGIN).pathname;
        resources.set(normalized, new Uint8Array(bytes));
    }

    function parseRangeHeader(value) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(String(value || ''));
        if (!match) return null;
        return { start: Number(match[1]), end: Number(match[2]) };
    }

    async function fetchMock(input, init = {}) {
        const url = new URL(typeof input === 'string' ? input : input.url, SW_MEDIA_ORIGIN);
        const headers = new Headers(init.headers || (input && input.headers) || {});
        const rangeHeader = headers.get('range');
        const range = parseRangeHeader(rangeHeader);
        const bytes = resources.get(url.pathname);
        requests.push({ url: url.href, pathname: url.pathname, search: url.search, rangeHeader });

        if (!bytes) {
            return new Response('not found', { status: 404 });
        }

        if (!range) {
            return new Response(bytes, {
                status: 200,
                headers: {
                    'Content-Length': String(bytes.length),
                    'Accept-Ranges': 'bytes',
                },
            });
        }

        if (range.start < 0 || range.end < range.start || range.end >= bytes.length) {
            return new Response(null, {
                status: 416,
                headers: { 'Content-Range': `bytes */${bytes.length}` },
            });
        }

        const body = bytes.subarray(range.start, range.end + 1);
        return new Response(body, {
            status: 206,
            headers: {
                'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}`,
                'Content-Length': String(body.length),
                'Accept-Ranges': 'bytes',
            },
        });
    }

    const caches = new Map();
    const sandbox = {
        console: {
            log: (...args) => logs.push(['log', ...args]),
            warn: (...args) => logs.push(['warn', ...args]),
            error: (...args) => logs.push(['error', ...args]),
        },
        crypto: globalThis.crypto,
        Date: FakeDate,
        setTimeout: fakeSetTimeout,
        clearTimeout: fakeClearTimeout,
        queueMicrotask,
        URL,
        URLSearchParams,
        Headers,
        Request,
        Response,
        Blob,
        AbortController,
        ReadableStream,
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Int32Array,
        ArrayBuffer,
        DataView,
        TextEncoder,
        TextDecoder,
        atob,
        btoa,
        fetch: fetchMock,
        importScripts: (p) => {
            const file = path.join(PUBLIC, String(p).replace(/^\//, ''));
            vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: p });
        },
        addEventListener: (type, fn) => {
            listeners[type] = fn;
        },
        skipWaiting: async () => {},
    };
    sandbox.self = sandbox;
    sandbox.location = { origin: SW_MEDIA_ORIGIN };
    sandbox.clients = {
        get: async (id) => clients.get(id),
        claim: async () => {},
    };
    sandbox.caches = {
        open: async (name) => {
            cacheOps.push(['open', name]);
            if (!caches.has(name)) caches.set(name, new Map());
            const entries = caches.get(name);
            return {
                match: async (key) => entries.get(String(key)),
                put: async (key, response) => {
                    cacheOps.push(['put', name, String(key)]);
                    entries.set(String(key), response);
                },
            };
        },
        keys: async () => {
            cacheOps.push(['keys']);
            return [...caches.keys()];
        },
        delete: async (name) => {
            cacheOps.push(['delete', name]);
            return caches.delete(name);
        },
    };

    vm.createContext(sandbox);

    let source = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
    if (enabled) {
        if (!source.includes(ENABLED_LINE)) {
            throw new Error('public/sw.js does not contain the expected MEDIA_STREAM_ENABLED = false line');
        }
        source = source.replace(ENABLED_LINE, ENABLED_TRUE);
    }
    vm.runInContext(source, sandbox, { filename: 'sw.js' });

    function dispatchFetch({
        url = '/__wire_media_stream/stream-1',
        method = 'GET',
        range = null,
        destination = 'video',
        clientId = 'client-a',
        headers = {},
    } = {}) {
        const requestHeaders = new Headers(headers);
        if (range != null) requestHeaders.set('range', range);
        const request = {
            url: new URL(url, SW_MEDIA_ORIGIN).href,
            method,
            headers: requestHeaders,
            destination,
            mode: 'cors',
            signal: new AbortController().signal,
        };

        let responded = false;
        let response = null;
        const waits = [];
        const event = {
            request,
            clientId,
            resultingClientId: '',
            respondWith(value) {
                responded = true;
                response = Promise.resolve(value);
            },
            waitUntil(value) {
                waits.push(Promise.resolve(value));
            },
        };

        listeners.fetch(event);
        return { event, responded, response, waits };
    }

    function dispatchMessage(data, {
        clientId = 'client-a',
        origin = SW_MEDIA_ORIGIN,
        ports = [],
    } = {}) {
        const source = clientId ? (clients.get(clientId) || null) : null;
        const waits = [];
        listeners.message({
            data,
            origin,
            source,
            ports,
            waitUntil(value) {
                waits.push(Promise.resolve(value));
            },
        });
        return { source, ports, waits };
    }

    async function advance(ms) {
        const target = nowMs + Number(ms || 0);
        for (;;) {
            await flush();
            let next = null;
            for (const [id, timer] of timers) {
                if (timer.at > target) continue;
                if (!next || timer.at < next.timer.at) next = { id, timer };
            }
            if (!next) break;
            timers.delete(next.id);
            nowMs = Math.max(nowMs, next.timer.at);
            next.timer.fn();
        }
        nowMs = target;
        await flush();
    }

    return {
        sandbox,
        listeners,
        addClient,
        clients,
        posted,
        setResource,
        resources,
        requests,
        cacheOps,
        logs,
        dispatchFetch,
        dispatchMessage,
        advance,
        flush,
        now: () => nowMs,
        cacheEntryCount: () => [...caches.values()].reduce((n, entries) => n + entries.size, 0),
    };
}
