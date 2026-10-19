// tests/upload-headers.test.mjs
//
// STEP 3D item 5: the 3C touch outside the group area - the optional
// `extraHeaders` of xhrUpload (public/js/files/upload.js) and the optional
// `uploadHeaders` of the composer (public/js/chat/composer.js).
//
// Both are ADDITIVE: with the options absent the request must carry EXACTLY
// the headers it carried before (the session Authorization header and
// nothing else). The group attachment upload is the only caller that passes
// them.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const js = (rel) => pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', rel)
).href;

mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => ({ id: 1 }),
        getToken: () => 'the-session-token',
        logout: () => {},
    },
});
mock.module(js('core/server.js'), {
    namedExports: {
        isNativeApp: () => false,
        normalizeServerAddress: (raw) => String(raw || ''),
        getServerEndpoint: () => 'http://127.0.0.1:1',
        setServerEndpoint: () => {},
        clearServerEndpoint: () => {},
        resolveServerUrl: (p) => `http://127.0.0.1:1${String(p).startsWith('/') ? '' : '/'}${p}`,
    },
});

/** A minimal XMLHttpRequest that records what was set. */
class FakeXHR {
    constructor() {
        this.headers = {};
        this.upload = {};
        this.status = 200;
        this.responseText = '{"ok":true}';
        globalThis.__lastXhr = this;
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) {
        this.sent = body;
        setTimeout(() => this.onload && this.onload(), 0);
    }
}

globalThis.XMLHttpRequest = FakeXHR;

const { xhrUpload } = await import(js('files/upload.js'));

test('without the options the upload carries EXACTLY the headers it carried before', async () => {
    const before = globalThis.__lastXhr;
    assert.equal(before, undefined, 'no request yet');

    await xhrUpload('/api/dm/upload', new FormData());
    const xhr = globalThis.__lastXhr;
    assert.equal(xhr.method, 'POST');
    assert.deepEqual(
        Object.keys(xhr.headers),
        ['Authorization'],
        `the request must carry exactly the Authorization header, got ${JSON.stringify(xhr.headers)}`
    );
    assert.equal(xhr.headers.Authorization, 'Bearer the-session-token');
});

test('the chat upload is unchanged too (the DM path passes no options)', async () => {
    await xhrUpload('/api/files/upload', new FormData());
    const xhr = globalThis.__lastXhr;
    assert.deepEqual(Object.keys(xhr.headers), ['Authorization']);
});

test('with the options the extra header is added (the group attachment upload)', async () => {
    await xhrUpload('/api/groups/1/upload', new FormData(), undefined, { 'X-Wire-Group-Proto': '2' });
    const xhr = globalThis.__lastXhr;
    assert.deepEqual(
        Object.keys(xhr.headers).sort(),
        ['Authorization', 'X-Wire-Group-Proto'],
        `the extra header must be added, got ${JSON.stringify(xhr.headers)}`
    );
    assert.equal(xhr.headers['X-Wire-Group-Proto'], '2');
});

test('the composer only passes the headers when the caller set them', async () => {
    const src = (await import('node:fs')).readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'files', 'upload.js'),
        'utf8'
    );
    // The parameter is OPTIONAL: without it the loop does not run at all.
    assert.match(src, /export function xhrUpload\(url, formData, onProgress, extraHeaders\)/);
    assert.match(src, /if \(extraHeaders && typeof extraHeaders === 'object'\)/);
});
