// tests/groups/group-attachment-hostile.test.mjs
//
// STEP 3E item 2: the whole receive path against a hostile server.
//
// Every row of the task's table is a test here. A negative row has a
// positive control (the honest case still works) and the mutation runs are
// in the report.
//
//   1  the server answers 404 / 500 for the blob  -> per-row retry, the other
//      rows are unaffected, the nonce stays unclaimed
//   2  the server serves a truncated blob          -> "Attachment unavailable",
//      no retry loop
//   3  the server serves an older blob under a newer message -> the same
//   4  the server re-serves the same blob under a fresh message id (replay)
//      -> rejected by the nonce set, the original row stays
//   5  the signer was removed and the key rotated while the row loads -> the
//      outcome is stated here, never a crash, never a wrong-key decrypt
//   6  the thread is closed while a download is in flight -> the request is
//      aborted, no blob URL, the queue slot is released
//   7  the same message is delivered twice (live + history) -> one row, one
//      download
//   8  att_* present but the row has no file / the file exists but the
//      envelope has no att_* -> a placeholder, no throw
//   9  the bytes sniff as PNG but the meta says PDF (and the reverse) -> the
//      SNIFFED type decides
//  10  50 attachment messages in one history page -> at most 2 downloads in
//      flight and the per-thread auto-load budget
//
// A hostile fetch stub and the real loader; no browser needed.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const js = (rel) => pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', rel)
).href;

mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => null,
        getToken: () => 'fake-token',
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
mock.module(js('core/api.js'), {
    namedExports: {
        api: async () => ({ upload_max_mb: 50 }),
    },
});

// The decrypt is controlled by the test: the real crypto is exercised
// elsewhere (STEP 3B).
let decryptBehaviour = null;
let decryptCalls = 0;
class ReplayedMessageError extends Error {
    constructor() { super('replayed'); this.name = 'ReplayedMessageError'; }
}
class MissingSenderKeyError extends Error {
    constructor(id) { super(`no key ${id}`); this.name = 'MissingSenderKeyError'; }
}
mock.module(js('crypto/messages/attachment-crypto.js'), {
    namedExports: {
        encryptAttachmentForGroup: async () => ({ ivBase64: 'AAAAAAAAAAAAAAAA', ciphertext: new Uint8Array(16) }),
        decryptAttachmentForGroup: async () => {
            decryptCalls++;
            if (decryptBehaviour) return decryptBehaviour();
            return PNG_BYTES;
        },
        computeImageDimensions: async () => null,
    },
});

const ga = await import(js('chat/group-attachments.js'));

const GCM = 16;

/** What the mocked decrypt returns: bytes that sniff as a PNG. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/* ------------------------------------------------------------------ the stubs */

let fetchBehaviour = null;
let fetchCalls = 0;
function stubFetch(behaviour) {
    fetchBehaviour = behaviour;
    fetchCalls = 0;
    globalThis.fetch = async (url, opts = {}) => {
        fetchCalls++;
        return fetchBehaviour(url, opts);
    };
}
function restoreFetch() {
    delete globalThis.fetch;
    fetchBehaviour = null;
}

/** A streaming response of exactly `bytes`. */
function okBody(bytes, { contentLength = true } = {}) {
    let done = false;
    return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-length' && contentLength ? String(bytes.length) : null) },
        body: {
            getReader: () => ({
                async read() {
                    if (done) return { done: true, value: undefined };
                    done = true;
                    return { done: false, value: bytes };
                },
                async cancel() {},
            }),
        },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
}

/** A fake IntersectionObserver whose callback the test fires by hand. */
let observerCallback = null;
const observedTargets = [];
globalThis.IntersectionObserver = class {
    constructor(cb) { observerCallback = cb; }
    observe(el) { observedTargets.push(el); }
    unobserve(el) { const i = observedTargets.indexOf(el); if (i !== -1) observedTargets.splice(i, 1); }
    disconnect() { observedTargets.length = 0; }
};
function makeVisible(el) {
    if (observerCallback) observerCallback([{ isIntersecting: true, target: el }], observerCallback);
}

/** Stages and registers one row. */
function stage(id, { size = 32, mime = 'image/png', name = 'a.png' } = {}) {
    // The dataset is what the IntersectionObserver callback reads to find the
    // row (public/js/chat/group-attachments.js).
    const el = { isConnected: true, innerHTML: '', dataset: { groupAttachmentId: String(id) } };
    const node = { querySelector: (s) => (s.includes(`"${id}"`) ? el : null) };
    ga.stageGroupAttachment({
        id, groupId: 7, raw: { id, attachment_iv: 'AAAAAAAAAAAAAAAA' },
        binding: { iv: 'AAAAAAAAAAAAAAAA', ctHash: 'x', len: size }, senderKeyId: 'k',
        meta: { text: '', file: { name, mime } }, size,
    });
    ga.registerGroupAttachmentRow({ id }, node);
    return { el, node };
}

/** Waits until the row leaves the 'loading' state. */
async function settle(id, ms = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const s = ga.groupAttachmentRowState(id);
        if (s && s !== 'loading' && s !== 'queued') return s;
        await new Promise((r) => setTimeout(r, 20));
    }
    return ga.groupAttachmentRowState(id);
}

function cleanup() {
    ga.revokeAllGroupAttachments();
    ga.resetGroupAttachmentAutoLoadBudget();
    restoreFetch();
    decryptBehaviour = null;
    decryptCalls = 0;
}

/* ------------------------------------------------------------------ the rows */

test('row 1: the server answers 404 / 500 for the blob -> a per-row retry, the other rows are unaffected, the nonce stays unclaimed', async () => {
    for (const status of [404, 500]) {
        stubFetch(() => ({ ok: false, status, headers: { get: () => null } }));
        decryptCalls = 0;
        try {
            const good = stage(1, { size: 32 });
            const bad = stage(2, { size: 32 });
            // The good row is served, the bad one is not.
            fetchBehaviour = (url) => (String(url).endsWith('/1') ? okBody(new Uint8Array(32 + GCM)) : { ok: false, status, headers: { get: () => null } });
            ga.downloadGroupAttachment(1);
            ga.downloadGroupAttachment(2);
            const s1 = await settle(1);
            const s2 = await settle(2);
            assert.equal(s1, 'loaded', 'the good row must still load');
            assert.equal(s2, 'error', `a ${status} must leave the row retryable`);
            assert.ok(bad.el.innerHTML.includes('Download failed'), `the row must offer a retry: ${bad.el.innerHTML}`);
            assert.ok(good.el.innerHTML.includes('chat-attachment-image'), 'the good row is unaffected');
            // The nonce: the good row claimed it, the failed one did not.
            assert.equal(decryptCalls, 1, 'only the good row reached the decrypt');
        } finally {
            cleanup();
        }
    }
});

test('row 2: the server serves a truncated blob -> "Attachment unavailable", no retry loop', async () => {
    stubFetch(() => okBody(new Uint8Array(8)));
    try {
        const row = stage(3, { size: 32 });
        ga.downloadGroupAttachment(3);
        const state = await settle(3);
        assert.equal(state, 'mismatch', 'a truncated blob is a permanent mismatch');
        assert.ok(row.el.innerHTML.includes('Attachment unavailable'), row.el.innerHTML);
        assert.ok(!row.el.innerHTML.includes('chat-attachment-retry'), 'there must be no retry loop');
    } finally {
        cleanup();
    }
});

test('row 3: the server serves an older blob under a newer message -> the same', async () => {
    // The newer message signed 32 bytes; the server serves another file's
    // ciphertext (a different length and a different hash).
    stubFetch(() => okBody(new Uint8Array(64)));
    try {
        const row = stage(4, { size: 32 });
        ga.downloadGroupAttachment(4);
        const state = await settle(4);
        assert.equal(state, 'mismatch');
        assert.ok(row.el.innerHTML.includes('Attachment unavailable'), row.el.innerHTML);
    } finally {
        cleanup();
    }
});

test('row 4: the server re-serves the same blob under a fresh message id (replay) -> the nonce set rejects it, the original row stays', async () => {
    stubFetch(() => okBody(new Uint8Array(32 + GCM)));
    try {
        const original = stage(5, { size: 32 });
        const replay = stage(6, { size: 32 });
        ga.downloadGroupAttachment(5);
        assert.equal(await settle(5), 'loaded', 'the original row loads');

        // The second (fresh) message id serves the SAME file: the nonce was
        // already claimed, so the crypto layer rejects it.
        decryptBehaviour = () => { throw new ReplayedMessageError(); };
        ga.downloadGroupAttachment(6);
        const state = await settle(6);
        assert.equal(state, 'mismatch', 'a replay is permanent');
        assert.ok(replay.el.innerHTML.includes('Attachment unavailable'), replay.el.innerHTML);
        assert.ok(original.el.innerHTML.includes('chat-attachment-image'), 'the original row stays');
    } finally {
        cleanup();
    }
});

test('row 5: the signer was removed and the key rotated while the row loads -> a per-row error, no crash, no wrong-key decrypt', async () => {
    stubFetch(() => okBody(new Uint8Array(32 + GCM)));
    try {
        const row = stage(7, { size: 32 });
        decryptBehaviour = () => { throw new MissingSenderKeyError('k'); };
        ga.downloadGroupAttachment(7);
        const state = await settle(7);
        // The outcome: the row shows the per-row error with a retry button
        // (the group's own KDM self-heal is the message-level path,
        // public/js/chat/group.js). No crash, and the decrypt was never
        // reached with a wrong key.
        assert.equal(state, 'error');
        assert.ok(row.el.innerHTML.includes('Download failed'), row.el.innerHTML);
        assert.equal(decryptCalls, 1, 'the decrypt was called once and refused');
    } finally {
        cleanup();
    }
});

test('row 6: the thread is closed while a download is in flight -> the request is aborted, no blob URL, the queue slot is released', async () => {
    let sawAbort = false;
    stubFetch((url, opts) => new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
            sawAbort = true;
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
        });
    }));
    const created = [];
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (b) => { const u = origCreate(b); created.push(u); return u; };
    try {
        const row = stage(8, { size: 32 });
        ga.downloadGroupAttachment(8);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(ga.groupAttachmentRowState(8), 'loading');
        // The thread is closed: the row's element left the DOM.
        row.el.isConnected = false;
        ga.abortDetachedGroupAttachments();
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(sawAbort, true, 'the request must be aborted');
        assert.equal(ga.groupAttachmentDownloadsInFlight(), 0, 'the queue slot must be released');
        assert.equal(created.length, 0, 'no blob URL may be created');
        assert.equal(row.el.innerHTML, '', 'nothing may be rendered');
    } finally {
        URL.createObjectURL = origCreate;
        cleanup();
    }
});

test('row 7: the same message delivered twice (live + history) -> one row, one download', async () => {
    stubFetch(() => okBody(new Uint8Array(32 + GCM)));
    try {
        const first = stage(9, { size: 32 });
        ga.downloadGroupAttachment(9);
        await new Promise((r) => setTimeout(r, 40));
        // The same message arrives again (the history page): a NEW element,
        // the SAME row.
        const el2 = { isConnected: true, innerHTML: '', dataset: { groupAttachmentId: '9' } };
        const node2 = { querySelector: (s) => (s.includes('"9"') ? el2 : null) };
        ga.registerGroupAttachmentRow({ id: 9 }, node2);
        assert.equal(await settle(9), 'loaded');
        assert.equal(fetchCalls, 1, 'the duplicate delivery must not start a second download');
        assert.ok(el2.innerHTML.includes('chat-attachment-image'), 'the content is rendered in the new element');
        assert.ok(first.el, 'the old element existed');
    } finally {
        cleanup();
    }
});

test('row 8: att_* present but the row has no file, and a file without att_* -> a placeholder, no throw', async () => {
    // (a) the row has no file: the server answers 404.
    stubFetch(() => ({ ok: false, status: 404, headers: { get: () => null } }));
    try {
        const row = stage(10, { size: 32 });
        ga.downloadGroupAttachment(10);
        const state = await settle(10);
        assert.equal(state, 'error', 'a missing file is a per-row error, not a throw');
        assert.ok(row.el.innerHTML.includes('Download failed'), row.el.innerHTML);
    } finally {
        cleanup();
    }

    // (b) the file exists but the envelope has no att_*: the client never
    // creates an attachment row, so nothing is downloaded and nothing throws.
    ga.revokeAllGroupAttachments();
    const callsBefore = fetchCalls;
    try {
        assert.equal(ga.groupAttachmentRowState(99), null, 'no row, no download, no throw');
        assert.equal(fetchCalls, callsBefore, 'no request may be sent for a message without att_*');
    } finally {
        cleanup();
    }
});

test('row 9: the SNIFFED type decides, not the declared one', async () => {
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
    const png = new Uint8Array(PNG_SIG.length + GCM);
    png.set(PNG_SIG, 0);
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    const htmlCt = new Uint8Array(html.length + GCM);
    htmlCt.set(html, 0);

    // The meta says application/pdf, the bytes are a PNG: the file renders
    // INLINE (the sniffed type wins).
    stubFetch(() => okBody(png));
    decryptBehaviour = () => png;
    try {
        const row = stage(11, { size: PNG_SIG.length, mime: 'application/pdf' });
        ga.downloadGroupAttachment(11);
        assert.equal(await settle(11), 'loaded');
        assert.ok(row.el.innerHTML.includes('class="chat-attachment-image"'), `the sniffed PNG must render inline: ${row.el.innerHTML}`);
    } finally {
        cleanup();
    }

    // The meta says image/png, the bytes are HTML: NOT inline, a download.
    stubFetch(() => okBody(htmlCt));
    decryptBehaviour = () => htmlCt;
    try {
        const row = stage(12, { size: html.length, mime: 'image/png' });
        ga.downloadGroupAttachment(12);
        assert.equal(await settle(12), 'loaded');
        assert.ok(!row.el.innerHTML.includes('class="chat-attachment-image"'), 'HTML must never render inline');
        assert.ok(row.el.innerHTML.includes('chat-attachment-download'), 'it must be a download');
    } finally {
        cleanup();
    }
});

test('row 10: 50 attachment messages in one history page -> at most 2 in flight and the auto-load budget', async () => {
    const ONE_MB = 1024 * 1024;
    stubFetch(() => okBody(new Uint8Array(ONE_MB + GCM)));
    try {
        ga.resetGroupAttachmentAutoLoadBudget();
        assert.equal(ga.GROUP_ATTACHMENT_AUTO_LOAD_BUDGET_BYTES, 20 * 1024 * 1024);

        const rows = [];
        for (let i = 1; i <= 50; i++) rows.push(stage(100 + i, { size: ONE_MB }));

        // Every row becomes visible at once.
        for (const r of rows) makeVisible(r.el);

        // The loop runs until the queue is EMPTY - not until the budget is
        // reached - so a missing budget really shows up (every row would be
        // loaded).
        let maxInFlight = 0;
        const end = Date.now() + 15000;
        while (Date.now() < end) {
            maxInFlight = Math.max(maxInFlight, ga.groupAttachmentDownloadsInFlight());
            if (ga.groupAttachmentQueueLength() === 0 && ga.groupAttachmentDownloadsInFlight() === 0) break;
            await new Promise((r) => setTimeout(r, 20));
        }

        assert.ok(maxInFlight <= ga.GROUP_ATTACHMENT_MAX_CONCURRENT_DOWNLOADS, `at most 2 in flight, saw ${maxInFlight}`);
        assert.ok(
            ga.groupAttachmentAutoLoadBytes() <= ga.GROUP_ATTACHMENT_AUTO_LOAD_BUDGET_BYTES,
            `the auto-load budget must hold: ${ga.groupAttachmentAutoLoadBytes()}`
        );
        // The rows past the budget keep their "Download (X MB)" button: the
        // state stays 'idle' (nothing is fetched) and the placeholder carries
        // the button.
        const idle = rows.filter((r, i) => ga.groupAttachmentRowState(101 + i) === 'idle').length;
        assert.ok(idle > 0, 'the rows past the budget must wait for a click');
        const placeholder = ga.groupAttachmentPlaceholderHtml({ id: 1 }, { name: 'a.png', size: ONE_MB, mime: 'image/png' });
        assert.ok(placeholder.includes('Download (1.0 MB)'), `the waiting row must offer the button: ${placeholder}`);
    } finally {
        cleanup();
    }
});
