// tests/groups/group-attachment-download.test.mjs
//
// STEP 3E item 0: the ciphertext download must be BOUNDED.
//
// Before this step the client read the whole body into memory
// (`new Uint8Array(await res.arrayBuffer())`) and only then ran the
// length/hash checks. A hostile or compromised server could answer with an
// endless or multi-GB body (or lie about Content-Length) and the client
// would buffer all of it before rejecting it.
//
// The download is now bounded by the SIGNED size (the verified att_len):
//
//   (a) an endless stream -> the reader is cancelled as soon as it delivers
//       more than att_len + 16;
//   (b) a lying Content-Length (too big or too small) -> the request is
//       aborted BEFORE the body is read;
//   (c) a body that is too short -> mismatch;
//   (d) an att_len above the client's own maximum -> no request at all;
//   (e) an honest body -> the ciphertext is recovered;
//   (f) the nonce is unclaimed in every failure case (the decrypt - and with
//       it the nonce claim - is never reached).
//
// A hostile fetch stub; no browser needed.

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

// The decrypt is mocked so the test can COUNT it: the nonce is claimed
// inside the decrypt, so "the decrypt was never reached" IS "the nonce was
// never claimed".
let decryptCalls = 0;
mock.module(js('crypto/messages/attachment-crypto.js'), {
    namedExports: {
        encryptAttachmentForGroup: async () => ({ ivBase64: 'AAAAAAAAAAAAAAAA', ciphertext: new Uint8Array(16) }),
        decryptAttachmentForGroup: async () => {
            decryptCalls++;
            return new Uint8Array(8);
        },
        computeImageDimensions: async () => null,
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

const GCM = 16;

/** A hostile fetch stub. */
function stubFetch({ headers = {}, chunks = [], endless = false, ok = true, status = 200 } = {}) {
    const state = { called: 0, reads: 0, cancelled: false, bodyCreated: false, arrayBufferCalled: false, signal: null };
    globalThis.fetch = async (url, opts = {}) => {
        state.called++;
        state.signal = opts.signal || null;
        return {
            ok,
            status,
            headers: { get: (k) => (headers[String(k).toLowerCase()] ?? null) },
            body: {
                getReader() {
                    state.bodyCreated = true;
                    let i = 0;
                    return {
                        async read() {
                            state.reads++;
                            if (endless) return { done: false, value: new Uint8Array(1024) };
                            if (i >= chunks.length) return { done: true, value: undefined };
                            return { done: false, value: chunks[i++] };
                        },
                        async cancel() { state.cancelled = true; },
                    };
                },
            },
            async arrayBuffer() {
                state.arrayBufferCalled = true;
                return new Uint8Array(0);
            },
        };
    };
    return state;
}

function restoreFetch() {
    delete globalThis.fetch;
}

/** The download with the signed size. */
function download({ expectedBytes, maxBytes } = {}) {
    return ga.fetchGroupAttachmentCiphertext({
        groupId: 7,
        messageId: 11,
        expectedBytes,
        maxBytes,
    });
}

test('(a) an endless stream is cancelled as soon as it delivers more than the signed size', async () => {
    const state = stubFetch({ endless: true });
    try {
        await assert.rejects(
            () => download({ expectedBytes: 32 }),
            (e) => e?.reason === 'attachment-mismatch',
            'an endless body must be refused'
        );
        assert.equal(state.cancelled, true, 'the reader must be cancelled');
        assert.ok(state.reads <= 2, `the stream must not be read on, reads=${state.reads}`);
    } finally {
        restoreFetch();
    }
});

test('(b) a lying Content-Length aborts the request BEFORE the body is read', async () => {
    for (const declared of ['999999', '5', 'not-a-number']) {
        const state = stubFetch({ headers: { 'content-length': declared }, chunks: [new Uint8Array(64)] });
        try {
            await assert.rejects(
                () => download({ expectedBytes: 32 }),
                (e) => e?.reason === 'attachment-mismatch',
                `a Content-Length of ${declared} must be refused`
            );
            assert.equal(state.bodyCreated, false, `the body must not be touched (Content-Length ${declared})`);
            assert.equal(state.reads, 0, 'nothing may be read');
            assert.equal(state.signal?.aborted, true, 'the request must be aborted');
        } finally {
            restoreFetch();
        }
    }
});

test('(c) a body that is too short is a mismatch', async () => {
    const state = stubFetch({ chunks: [new Uint8Array(8), new Uint8Array(8)] });
    try {
        await assert.rejects(
            () => download({ expectedBytes: 32 }),
            (e) => e?.reason === 'attachment-mismatch'
        );
        // The stream simply ended: nothing more was read, and the bytes that
        // were delivered are far below the signed size.
        assert.equal(state.reads, 3, 'the stream must be read to its end, no further');
        assert.equal(state.arrayBufferCalled, false, 'the body must not be buffered a second time');
    } finally {
        restoreFetch();
    }
});

test('(d) an att_len above the client maximum is refused WITHOUT a request', async () => {
    const state = stubFetch({ endless: true });
    try {
        await assert.rejects(
            () => download({ expectedBytes: ga.MAX_GROUP_ATTACHMENT_PLAINTEXT_BYTES + 1 }),
            (e) => e?.reason === 'attachment-mismatch'
        );
        assert.equal(state.called, 0, 'no request may be sent');
        assert.equal(state.reads, 0, 'nothing may be read');
    } finally {
        restoreFetch();
    }
});

test('(e) an honest body is recovered', async () => {
    const body = new Uint8Array(32).fill(7);
    const state = stubFetch({ headers: { 'content-length': '32' }, chunks: [body.subarray(0, 10), body.subarray(10)] });
    try {
        const out = await download({ expectedBytes: 32 });
        assert.equal(out.length, 32);
        assert.deepEqual(Array.from(out), Array.from(body));
        assert.equal(state.cancelled, false, 'an honest body must not be cancelled');
    } finally {
        restoreFetch();
    }
});

test('(f) the nonce is unclaimed in every failure case (the decrypt is never reached)', async () => {
    const cases = [
        { name: 'endless stream', fetch: { endless: true } },
        { name: 'lying content-length', fetch: { headers: { 'content-length': '999999' } } },
        { name: 'too short', fetch: { chunks: [new Uint8Array(4)] } },
        { name: 'too big', fetch: { headers: { 'content-length': '999999' } } },
    ];
    for (const c of cases) {
        decryptCalls = 0;
        stubFetch(c.fetch);
        try {
            await assert.rejects(() => download({ expectedBytes: 32 }), (e) => e?.reason === 'attachment-mismatch');
            assert.equal(decryptCalls, 0, `${c.name}: the decrypt (and the nonce claim) must not be reached`);
        } finally {
            restoreFetch();
        }
    }

    // The positive control: an honest body DOES reach the decrypt.
    decryptCalls = 0;
    stubFetch({ headers: { 'content-length': '32' }, chunks: [new Uint8Array(32)] });
    try {
        await download({ expectedBytes: 32 });
        await ga.decryptGroupAttachmentBytes({
            groupId: 7, ciphertext: new Uint8Array(32), rowIvBase64: 'AAAAAAAAAAAAAAAA',
            binding: { iv: 'AAAAAAAAAAAAAAAA', ctHash: 'x', len: 16 }, senderKeyId: 'k', ref: 'att:1',
        });
        assert.equal(decryptCalls, 1, 'the control: the honest body reaches the decrypt');
    } finally {
        restoreFetch();
    }
});

test('the loader turns a bounded-download failure into the per-row placeholder (and retries nothing)', async () => {
    decryptCalls = 0;
    stubFetch({ endless: true });
    try {
        const el = { isConnected: true, innerHTML: '' };
        const node = { querySelector: (s) => (s.includes('"5"') ? el : null) };
        ga.stageGroupAttachment({
            id: 5, groupId: 7, raw: { id: 5, attachment_iv: 'AAAAAAAAAAAAAAAA' },
            binding: { iv: 'AAAAAAAAAAAAAAAA', ctHash: 'x', len: 16 }, senderKeyId: 'k',
            meta: { text: '', file: { name: 'a.png', mime: 'image/png' } }, size: 16,
        });
        ga.registerGroupAttachmentRow({ id: 5 }, node);
        ga.downloadGroupAttachment(5);
        // Let the download fail.
        for (let i = 0; i < 40 && ga.groupAttachmentRowState(5) === 'loading'; i++) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(ga.groupAttachmentRowState(5), 'mismatch', 'the row must be a permanent mismatch');
        assert.ok(el.innerHTML.includes('Attachment unavailable'), `the row must show the placeholder: ${el.innerHTML}`);
        assert.equal(decryptCalls, 0, 'the decrypt (and the nonce claim) must not be reached');
        ga.revokeAllGroupAttachments();
    } finally {
        restoreFetch();
    }
});
