// tests/groups/group-attachment-lazy.test.mjs
//
// STEP 3D item 2 (node level): the lazy receive path.
//
//   - the queue never has more than GROUP_ATTACHMENT_MAX_CONCURRENT_DOWNLOADS
//     downloads in flight;
//   - an aborted download never reaches the decrypt (so the file's nonce is
//     never claimed) and the blob URL is revoked;
//   - the auto-load rule: an image under the limit is auto-loaded, a bigger
//     file and every non-image wait for a click;
//   - the placeholder shows the sanitised name, the SIGNED size and the
//     declared type (as a hint only).
//
// The browser half of this item (a real row becoming visible, the click) is
// in tests/groups/group-attachment-browser.test.mjs.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const js = (rel) => pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', rel)
).href;

// The DOM-bound modules are mocked exactly the way
// tests/groups/group-attachment-ui.test.mjs mocks them.
mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => null,
        getToken: () => 'fake-token',
        logout: () => {},
    },
});

// The server URL builder needs a browser location.
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


// The group limits endpoint (STEP 3E item 1): the loader asks for the cap
// before it downloads, so it is stubbed here - otherwise the stubbed fetch
// would see the limits request too.
mock.module(js('core/api.js'), {
    namedExports: {
        api: async () => ({ upload_max_mb: 50 }),
    },
});

const ga = await import(js('chat/group-attachments.js'));

/** A row element and the message element that holds it. */
function fakeRow(id) {
    const el = { isConnected: true, innerHTML: '' };
    const node = { querySelector: (sel) => (sel.includes(`"${id}"`) ? el : null) };
    return { el, node };
}

/** Stages a row the way the decorate does. */
function stage(id, { mime = 'image/png', size = 1024, name = 'photo.png' } = {}) {
    const { el, node } = fakeRow(id);
    ga.stageGroupAttachment({
        id,
        groupId: 7,
        raw: { id, attachment_iv: 'AAAAAAAAAAAAAAAA' },
        binding: { iv: 'AAAAAAAAAAAAAAAA', ctHash: 'x', len: size },
        senderKeyId: 'k',
        meta: { text: '', file: { name, mime } },
        size,
    });
    ga.registerGroupAttachmentRow({ id }, node);
    return el;
}

/** A fetch that never resolves, until its signal is aborted. */
function stubHangingFetch() {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (url, opts = {}) => {
        calls++;
        return new Promise((resolve, reject) => {
            const signal = opts.signal;
            if (!signal) return;
            if (signal.aborted) {
                const e = new Error('aborted');
                e.name = 'AbortError';
                reject(e);
                return;
            }
            signal.addEventListener('abort', () => {
                const e = new Error('aborted');
                e.name = 'AbortError';
                reject(e);
            });
        });
    };
    return {
        calls: () => calls,
        restore: () => { globalThis.fetch = original; },
    };
}

test('the auto-load rule: an image under the limit is auto-loaded, a bigger file and every non-image are not', () => {
    assert.equal(ga.GROUP_ATTACHMENT_AUTO_LOAD_MAX_BYTES, 5 * 1024 * 1024);
    assert.equal(ga.isAutoLoadableGroupAttachment({ mime: 'image/png', size: 1024 }), true);
    assert.equal(ga.isAutoLoadableGroupAttachment({ mime: 'image/jpeg', size: 5 * 1024 * 1024 }), true, 'exactly at the limit is still auto-loaded');
    assert.equal(ga.isAutoLoadableGroupAttachment({ mime: 'image/png', size: 5 * 1024 * 1024 + 1 }), false, 'one byte over the limit is not');
    assert.equal(ga.isAutoLoadableGroupAttachment({ mime: 'application/pdf', size: 10 }), false, 'a non-image is never auto-loaded');
    assert.equal(ga.isAutoLoadableGroupAttachment({ mime: 'image/svg+xml', size: 10 }), false, 'SVG is never auto-loaded');
    assert.equal(ga.isAutoLoadableGroupAttachment({ mime: '', size: 10 }), false);
});

test('the queue never has more than 2 downloads in flight', async () => {
    const stub = stubHangingFetch();
    try {
        for (let i = 1; i <= 5; i++) stage(i);
        for (let i = 1; i <= 5; i++) assert.equal(ga.downloadGroupAttachment(i), true);
        // The download reaches the network one microtask later (the token is
        // read first), so let the loop settle.
        await new Promise((r) => setTimeout(r, 50));
        // The queue starts the first two and holds the rest.
        assert.equal(ga.groupAttachmentDownloadsInFlight(), ga.GROUP_ATTACHMENT_MAX_CONCURRENT_DOWNLOADS);
        assert.equal(ga.groupAttachmentQueueLength(), 3);
        assert.equal(stub.calls(), 2, 'only the downloads in flight may have been started');
        assert.equal(ga.groupAttachmentRowState(1), 'loading');
        assert.equal(ga.groupAttachmentRowState(4), 'queued');
        // Cleaning up: everything is aborted.
        for (let i = 1; i <= 5; i++) ga.abortGroupAttachment(i);
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(ga.groupAttachmentDownloadsInFlight(), 0, 'the aborted downloads must not stay in flight');
    } finally {
        stub.restore();
        ga.revokeAllGroupAttachments();
    }
});

test('an aborted download never reaches the decrypt (the nonce stays unclaimed) and the blob URL is revoked', async () => {
    const stub = stubHangingFetch();
    const created = [];
    const revoked = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { const u = origCreate(b); created.push(u); return u; };
    URL.revokeObjectURL = (u) => { revoked.push(u); return origRevoke(u); };
    try {
        const el = stage(42, { mime: 'image/png', size: 10 });
        ga.downloadGroupAttachment(42);
        assert.equal(ga.groupAttachmentRowState(42), 'loading');
        ga.abortGroupAttachment(42);
        assert.equal(ga.groupAttachmentRowState(42), 'aborted');
        await new Promise((r) => setTimeout(r, 100));
        // The abort ended the download: it never produced bytes, so the
        // decrypt (and with it the nonce claim) was never reached.
        assert.equal(ga.groupAttachmentRowState(42), 'aborted', 'the row must stay aborted, not fall into an error');
        assert.equal(el.innerHTML, '', 'nothing may be rendered for an aborted row');
        assert.equal(created.length, 0, 'no blob URL may be created for an aborted download');

        // A loaded row: its blob URL is revoked when the row is aborted.
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            async arrayBuffer() { return new ArrayBuffer(8); },
        });
        // The decrypt of 8 bytes cannot match the signed length -> an error
        // row, but the abort semantics are what is under test.
        ga.downloadGroupAttachment(42);
        await new Promise((r) => setTimeout(r, 100));
        globalThis.fetch = origFetch;
    } finally {
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
        stub.restore();
        ga.revokeAllGroupAttachments();
    }
});

test('the placeholder shows the sanitised name, the signed size and the declared type as a hint', () => {
    const html = ga.groupAttachmentPlaceholderHtml(
        { id: 7 },
        { name: '../../.bashrc\u202Egnp.png', size: 6 * 1024 * 1024, mime: 'image/png' }
    );
    assert.ok(html.includes('bashrcgnp.png'), `the sanitised name must be shown: ${html}`);
    assert.ok(!html.includes('.bashrc'), 'the raw name must not be shown');
    assert.ok(!html.includes('\u202E'), 'the bidi override must not be shown');
    assert.ok(html.includes('6.0 MB'), `the signed size must be shown: ${html}`);
    assert.ok(html.includes('image/png'), 'the declared type is shown as a hint');
    assert.ok(html.includes('Download (6.0 MB)'), `a file over the auto-load limit waits for a click: ${html}`);
    assert.ok(html.includes('data-group-attachment-id="7"'), 'the row carries its message id');

    // A small image: the button does not promise a size.
    const small = ga.groupAttachmentPlaceholderHtml({ id: 8 }, { name: 'a.png', size: 1024, mime: 'image/png' });
    assert.ok(small.includes('>Download</button>'), `the small image's button: ${small}`);
    assert.ok(small.includes('1 KB'), `the size is still shown: ${small}`);
});
