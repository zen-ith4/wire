// tests/groups/group-attachment-repaint.test.mjs
//
// STEP 3F follow-up 3.A (node level): a thread repaint must not silently
// abort a download the user started.
//
// The bug (Linux, group-attachment-browser test 3): renderActiveGroupShell()
// replaced the message list and called abortDetachedGroupAttachments() right
// away, when EVERY row was detached - including the rows of the same group
// that the paint was about to re-register. An in-flight download was reset
// to 'idle' and the row kept its "Download" button with no error.
//
// The rule that stays: a row that really left the DOM (another group, a
// deleted message) is aborted. The fix runs the abort AFTER the paint
// (public/js/chat/group.js, openGroup and handleGroupUpdated).
//
// The browser half (a click during a forced repaint) is test 11 of
// tests/groups/group-attachment-browser.test.mjs.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const js = (rel) => pathToFileURL(path.join(ROOT, 'public', 'js', rel)).href;

// The same mocks as tests/groups/group-attachment-lazy.test.mjs.
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

const ga = await import(js('chat/group-attachments.js'));

const SIZE = 1024;

/** A rendered row: the attachment element and the message node holding it. */
function rendered(id) {
    const el = { isConnected: true, innerHTML: '' };
    const node = { querySelector: (sel) => (sel.includes(`"${id}"`) ? el : null) };
    return { el, node };
}

/** Stages and registers a row the way the decorate and the paint do. */
function stageAndRender(id, groupId = 7) {
    ga.stageGroupAttachment({
        id,
        groupId,
        raw: { id, attachment_iv: 'AAAAAAAAAAAAAAAA' },
        binding: { iv: 'AAAAAAAAAAAAAAAA', ctHash: 'x', len: SIZE },
        senderKeyId: 'k',
        meta: { text: '', file: { name: 'doc.pdf', mime: 'application/pdf' } },
        size: SIZE,
    });
    const r = rendered(id);
    ga.registerGroupAttachmentRow({ id }, r.node);
    return r;
}

/** A fetch the test releases by hand; records whether its signal was aborted. */
function stubControlledFetch() {
    const original = globalThis.fetch;
    const pending = [];
    globalThis.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
        const call = { url: String(url), signal: opts.signal, resolve, reject };
        pending.push(call);
        opts.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
        });
    });
    return {
        pending,
        /** Answers the request with the signed number of bytes (+ the GCM tag). */
        release(call) {
            const body = new Uint8Array(SIZE + 16);
            call.resolve(new Response(body, { status: 200, headers: { 'Content-Length': String(body.length) } }));
        },
        restore: () => { globalThis.fetch = original; },
    };
}

/** Polls an exact postcondition (never a fixed sleep). */
async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 5));
    }
    return false;
}

const TERMINAL = ['loaded', 'mismatch', 'error'];

test('a repaint of the SAME thread keeps an in-flight download: it is not aborted and it renders into the new element', async () => {
    ga.revokeAllGroupAttachments();
    const f = stubControlledFetch();
    try {
        const old = stageAndRender('rp1');
        assert.equal(ga.downloadGroupAttachment('rp1'), true, 'the click starts the download');
        assert.ok(await until(() => f.pending.length === 1), 'the request was sent');
        assert.equal(ga.groupAttachmentRowState('rp1'), 'loading');

        // The repaint: the shell replaces the list (the old element is gone),
        // the paint re-registers the row on a NEW element, THEN the detached
        // rows are aborted (the order of public/js/chat/group.js).
        old.el.isConnected = false;
        const fresh = rendered('rp1');
        ga.registerGroupAttachmentRow({ id: 'rp1' }, fresh.node);
        ga.abortDetachedGroupAttachments();

        assert.equal(f.pending[0].signal.aborted, false, 'the request must not be aborted');
        assert.equal(ga.groupAttachmentRowState('rp1'), 'loading', 'the row must stay in flight');
        assert.equal(ga.groupAttachmentDownloadsInFlight(), 1);

        // The response arrives: the row reaches a terminal state and renders
        // into the NEW element (the bytes here do not decrypt, so the
        // terminal state is the placeholder or the error - both are rendered).
        f.release(f.pending[0]);
        assert.ok(await until(() => TERMINAL.includes(ga.groupAttachmentRowState('rp1'))),
            `the row must reach a terminal state, got ${ga.groupAttachmentRowState('rp1')}`);
        assert.notEqual(fresh.el.innerHTML, '', 'the outcome is rendered into the new element');
        assert.equal(old.el.innerHTML, '', 'nothing is rendered into the detached element');
    } finally {
        f.restore();
        ga.revokeAllGroupAttachments();
    }
});

test('a row that did NOT come back after the repaint is still aborted (the rule "a row that left the DOM is aborted" stays)', async () => {
    ga.revokeAllGroupAttachments();
    const f = stubControlledFetch();
    try {
        const left = stageAndRender('rp2', 8);
        assert.equal(ga.downloadGroupAttachment('rp2'), true);
        assert.ok(await until(() => f.pending.length === 1));

        // The user switched groups: the row's element is gone and nothing
        // re-registers it.
        left.el.isConnected = false;
        ga.abortDetachedGroupAttachments();

        assert.equal(f.pending[0].signal.aborted, true, 'the request of a row that left the DOM is aborted');
        assert.ok(await until(() => ga.groupAttachmentDownloadsInFlight() === 0), 'the slot is freed');
        assert.equal(ga.groupAttachmentRowState('rp2'), 'idle');
    } finally {
        f.restore();
        ga.revokeAllGroupAttachments();
    }
});

test('positive control for the bug: aborting BEFORE the re-registration resets the download to idle (the pre-fix order)', async () => {
    ga.revokeAllGroupAttachments();
    const f = stubControlledFetch();
    try {
        const old = stageAndRender('rp3');
        ga.downloadGroupAttachment('rp3');
        assert.ok(await until(() => f.pending.length === 1));

        old.el.isConnected = false;
        ga.abortDetachedGroupAttachments();           // the old order: abort first ...
        const fresh = rendered('rp3');
        ga.registerGroupAttachmentRow({ id: 'rp3' }, fresh.node); // ... re-register after

        assert.equal(f.pending[0].signal.aborted, true);
        assert.ok(await until(() => ga.groupAttachmentDownloadsInFlight() === 0));
        assert.equal(ga.groupAttachmentRowState('rp3'), 'idle', 'this is the silent reset the fix removes');
    } finally {
        f.restore();
        ga.revokeAllGroupAttachments();
    }
});

test('group.js aborts the detached rows only AFTER the thread paint, never inside the shell render', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat', 'group.js'), 'utf8');
    const body = (name) => {
        const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
        assert.ok(start !== -1, `${name} must exist`);
        // The function ends at the first line that is exactly "}".
        const end = src.indexOf('\n}\n', start);
        return src.slice(start, end);
    };
    const code = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

    const shell = code(body('renderActiveGroupShell'));
    assert.ok(!shell.includes('abortDetachedGroupAttachments('), 'the shell render must not abort: every row is detached there');

    const open = code(body('openGroup'));
    const abortAt = open.lastIndexOf('abortDetachedGroupAttachments(');
    assert.ok(abortAt !== -1, 'openGroup must abort the rows that left');
    assert.ok(open.lastIndexOf('paintFromCache(') < abortAt, 'openGroup: the abort comes after paintFromCache()');
    assert.ok(open.lastIndexOf('loadRecent(') < abortAt, 'openGroup: the abort comes after loadRecent()');

    const updated = code(body('handleGroupUpdated'));
    const uAbort = updated.lastIndexOf('abortDetachedGroupAttachments(');
    assert.ok(uAbort !== -1, 'handleGroupUpdated must abort the rows that left');
    assert.ok(updated.lastIndexOf('paintFromCache(') < uAbort, 'handleGroupUpdated: the abort comes after paintFromCache()');
});
